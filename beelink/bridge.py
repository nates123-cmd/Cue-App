#!/usr/bin/env python3
"""media-bridge: poll Supabase media_requests outbox, add titles to Radarr/Sonarr,
feed live download progress back, and self-heal stalled/dead downloads.

Cue (and any suite app) inserts a row into public.media_requests; this daemon
runs on the Beelink, reaches OUT to Supabase (no inbound exposure of the *arr
stack), pushes each pending request into local Radarr (movies) or Sonarr (TV),
then keeps updating that same row so the app can show a live download status:

    status: pending -> added(=searching) -> downloading -> downloaded | failed
    detail: JSON { "msg": str, "app": str, "arr_id": int, "pct": float, "eta": str }

It also reaps downloads that stall with no connections (blocklist + re-search the
next release). Pure stdlib so no venv/pip needed.
"""
import json, os, time, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone
# NB: import the class, not the module -- this file defines a function named http(),
# which would shadow the stdlib `http` package and break `http.cookiejar`.
from http.cookiejar import CookieJar

SB_URL   = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY   = os.environ["SUPABASE_SERVICE_KEY"]
RADARR   = (os.environ.get("RADARR_URL", "http://localhost:7878").rstrip("/"), os.environ["RADARR_KEY"])
SONARR   = (os.environ.get("SONARR_URL", "http://localhost:8989").rstrip("/"), os.environ["SONARR_KEY"])
PROWLARR = (os.environ.get("PROWLARR_URL", "http://localhost:9696").rstrip("/"), os.environ["PROWLARR_KEY"])

# Books have no *arr, so the bridge drives qBittorrent directly (see the book section).
QBIT_URL  = os.environ.get("QBIT_URL", "http://localhost:8080").rstrip("/")
QBIT_USER = os.environ["QBIT_USER"]
QBIT_PASS = os.environ["QBIT_PASS"]
BOOK_CATEGORY    = os.environ.get("BOOK_CATEGORY", "cue-books")
BOOK_SAVE_CT     = os.environ.get("BOOK_SAVE_CT", "/data/torrents/books")          # qbit's namespace
TORRENT_HOST_DIR = os.environ.get("TORRENT_HOST_DIR", "/srv/media/data/torrents/books")  # same dir, host side
AUDIOBOOK_DIR    = os.environ.get("AUDIOBOOK_DIR", "/srv/media/data/media/audiobooks")
EBOOK_DIR        = os.environ.get("EBOOK_DIR", "/srv/media/data/media/ebooks")
R_PROFILE = int(os.environ.get("RADARR_PROFILE", "4"))
R_ROOT    = os.environ.get("RADARR_ROOT", "/data/media/movies")
S_PROFILE = int(os.environ.get("SONARR_PROFILE", "4"))
S_ROOT    = os.environ.get("SONARR_ROOT", "/data/media/shows")
INTERVAL  = int(os.environ.get("POLL_INTERVAL", "20"))
STALL_GRACE = int(os.environ.get("STALL_GRACE", "180"))  # secs a download may sit stalled before reaping

# in-memory tracker for stalled queue items: {(app, id): {"first": ts, "left": sizeleft}}
_stall = {}


def http(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    rq = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as f:
            t = f.read().decode()
            return f.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def sb(method, path, body=None, prefer=None):
    h = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    return http(method, f"{SB_URL}/rest/v1/{path}", h, body)


def arr(target, method, path, body=None):
    base, key = target
    return http(method, f"{base}/api/v3/{path}", {"X-Api-Key": key, "Content-Type": "application/json"}, body)


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def best_match(results, title, year):
    if not results:
        return None
    if year:
        for r in results:
            if r.get("year") == year:
                return r
    tl = (title or "").lower()
    for r in results:
        if (r.get("title") or "").lower() == tl:
            return r
    return results[0]


def add_movie(req):
    """Add a movie to Radarr. Returns (human_msg, radarr_movie_id | None)."""
    tmdb = req.get("tmdb_id")
    if tmdb:
        code, m = arr(RADARR, "GET", f"movie/lookup/tmdb?tmdbId={tmdb}")
        if code != 200 or not m:
            raise RuntimeError(f"radarr tmdb lookup {code}: {m}")
        movie = m[0] if isinstance(m, list) else m
    else:
        code, res = arr(RADARR, "GET", "movie/lookup?term=" + urllib.parse.quote(req["title"]))
        if code != 200:
            raise RuntimeError(f"radarr lookup {code}: {res}")
        movie = best_match(res, req["title"], req.get("year"))
        if not movie:
            raise RuntimeError("no radarr match")
    movie.update({"qualityProfileId": R_PROFILE, "rootFolderPath": R_ROOT,
                  "monitored": True, "minimumAvailability": "released",
                  "addOptions": {"searchForMovie": True}})
    code, resp = arr(RADARR, "POST", "movie", movie)
    if code in (200, 201):
        rid = resp.get("id") if isinstance(resp, dict) else None
        return f"added to Radarr: {movie.get('title')} ({movie.get('year')})", rid
    if code == 400 and "already" in str(resp).lower():
        # Cue pushes usually carry NO tmdb_id, so fall back to the id off the
        # lookup result, then to a title match, or the row is untrackable.
        rid = _radarr_id(tmdb or movie.get("tmdbId"), movie.get("title"), movie.get("year"))
        return f"already in Radarr: {movie.get('title')}", rid
    raise RuntimeError(f"radarr add {code}: {resp}")


def _radarr_id(tmdb, title=None, year=None):
    if tmdb:
        code, lib = arr(RADARR, "GET", f"movie?tmdbId={tmdb}")
        if code == 200 and isinstance(lib, list) and lib:
            return lib[0].get("id")
    if not title:
        return None
    code, lib = arr(RADARR, "GET", "movie")          # title fallback (no tmdb on the row)
    if code != 200 or not isinstance(lib, list):
        return None
    tl = title.lower()
    hits = [m for m in lib if (m.get("title") or "").lower() == tl]
    if year:
        for m in hits:
            if m.get("year") == year:
                return m.get("id")
    return hits[0].get("id") if hits else None


def _sonarr_id(title):
    if not title:
        return None
    code, lib = arr(SONARR, "GET", "series")
    if code != 200 or not isinstance(lib, list):
        return None
    tl = title.lower()
    for s in lib:
        if (s.get("title") or "").lower() == tl:
            return s.get("id")
    return None


def add_series(req):
    """Add a series to Sonarr. Returns (human_msg, sonarr_series_id | None)."""
    code, res = arr(SONARR, "GET", "series/lookup?term=" + urllib.parse.quote(req["title"]))
    if code != 200:
        raise RuntimeError(f"sonarr lookup {code}: {res}")
    series = best_match(res, req["title"], req.get("year"))
    if not series:
        raise RuntimeError("no sonarr match")
    series.update({"qualityProfileId": S_PROFILE, "rootFolderPath": S_ROOT,
                   "monitored": True, "seasonFolder": True,
                   "addOptions": {"searchForMissingEpisodes": True, "monitor": "all"}})
    code, resp = arr(SONARR, "POST", "series", series)
    if code in (200, 201):
        rid = resp.get("id") if isinstance(resp, dict) else None
        return f"added to Sonarr: {series.get('title')}", rid
    if code == 400 and "already" in str(resp).lower():
        rid = None
        tvdb = series.get("tvdbId")
        if tvdb:
            c2, lib = arr(SONARR, "GET", f"series?tvdbId={tvdb}")
            if c2 == 200 and isinstance(lib, list) and lib:
                rid = lib[0].get("id")
        return f"already in Sonarr: {series.get('title')}", rid
    raise RuntimeError(f"sonarr add {code}: {resp}")


# ---------------------------------------------------------------------------
# books: Prowlarr search -> qBittorrent grab -> hardlink into the library
#
# There is no *arr for books on this box (Readarr is archived upstream, and
# Prowlarr is only an indexer manager -- it cannot download on its own). So the
# bridge does the job an *arr would: search, pick a release, hand it to
# qBittorrent, then import the finished files into the library itself.
# ---------------------------------------------------------------------------

EBOOK_CATS = [7000, 7020]      # Books, Books/EBook
AUDIO_CATS = [3030]            # Audio/Audiobook
EBOOK_FORMATS = ["epub", "mobi", "azw3", "pdf"]     # preference order
AUDIO_FORMATS = ["m4b", "mp3"]                      # preference order

STOPWORDS = {"the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for", "with"}


def prowlarr(method, path, body=None):
    base, key = PROWLARR
    return http(method, f"{base}/api/v1/{path}",
                {"X-Api-Key": key, "Content-Type": "application/json"}, body)


def _norm(s):
    return "".join(c if c.isalnum() or c.isspace() else " " for c in (s or "").lower())


def _sig_tokens(title):
    """Significant words a release title must contain to be considered a match."""
    return [w for w in _norm(title).split() if len(w) > 2 and w not in STOPWORDS]


def _fmt_rank(release_title, formats):
    """Index of the first matching format token, or None if none present."""
    t = _norm(release_title)
    for i, f in enumerate(formats):
        if f in t.split() or f in t.replace(" ", ""):
            return i
    return None


def _pick_release(results, want_title, formats, require_format):
    """Best release: must match the title's significant words; rank by format then seeders."""
    toks = _sig_tokens(want_title)
    scored = []
    for r in results or []:
        seeders = r.get("seeders") or 0
        if seeders < 1:
            continue
        rt = _norm(r.get("title") or "")
        if not all(tok in rt for tok in toks):      # kills foreign-language / wrong-book noise
            continue
        fr = _fmt_rank(r.get("title") or "", formats)
        if require_format and fr is None:
            continue
        scored.append(((fr if fr is not None else len(formats)), -seeders, r))
    if not scored:
        return None
    scored.sort(key=lambda x: (x[0], x[1]))
    return scored[0][2]


def _search_books(title, author, cats):
    q = f"{title} {author}".strip() if author else title
    qs = "search?query=" + urllib.parse.quote(q) + "".join(f"&categories={c}" for c in cats) + "&type=search"
    code, res = prowlarr("GET", qs)
    if code != 200 or not isinstance(res, list):
        log(f"prowlarr search {code} for {q!r}")
        return []
    return res


# --- qBittorrent -----------------------------------------------------------

_qb_opener = None


def qbit_login():
    global _qb_opener
    cj = CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    data = urllib.parse.urlencode({"username": QBIT_USER, "password": QBIT_PASS}).encode()
    rq = urllib.request.Request(f"{QBIT_URL}/api/v2/auth/login", data=data,
                                headers={"Referer": QBIT_URL})
    with op.open(rq, timeout=30) as f:
        f.read()
    _qb_opener = op
    return op


def qbit(path, data=None, retry=True):
    """GET (data=None) or POST against qBittorrent, re-logging in on a 403."""
    op = _qb_opener or qbit_login()
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    rq = urllib.request.Request(f"{QBIT_URL}/api/v2/{path}", data=body,
                                headers={"Referer": QBIT_URL})
    try:
        with op.open(rq, timeout=60) as f:
            t = f.read().decode()
            try:
                return json.loads(t)
            except Exception:
                return t
    except urllib.error.HTTPError as e:
        if e.code == 403 and retry:
            qbit_login()
            return qbit(path, data, retry=False)
        raise


def qbit_ensure_category():
    """qBittorrent only mounts /data/torrents -- a category pointing anywhere else
    (e.g. the pre-existing 'audiobooks' -> /data/media/audiobooks) writes into the
    container's ephemeral layer and the files never appear on the host."""
    try:
        cats = qbit("torrents/categories") or {}
    except Exception as e:
        log("qbit categories error", repr(e))
        return
    if BOOK_CATEGORY not in cats:
        qbit("torrents/createCategory",
             {"category": BOOK_CATEGORY, "savePath": BOOK_SAVE_CT})
        log(f"qbit: created category {BOOK_CATEGORY} -> {BOOK_SAVE_CT}")
    elif (cats[BOOK_CATEGORY] or {}).get("savePath") != BOOK_SAVE_CT:
        qbit("torrents/editCategory",
             {"category": BOOK_CATEGORY, "savePath": BOOK_SAVE_CT})
        log(f"qbit: repointed category {BOOK_CATEGORY} -> {BOOK_SAVE_CT}")


def _qbit_hashes():
    infos = qbit(f"torrents/info?category={urllib.parse.quote(BOOK_CATEGORY)}") or []
    return {t["hash"]: t for t in infos if isinstance(t, dict)}


class _MagnetRedirect(Exception):
    def __init__(self, url):
        self.url = url


class _CatchMagnet(urllib.request.HTTPRedirectHandler):
    """Prowlarr answers /download with a 302 to magnet: for magnet-only indexers,
    which urllib cannot follow (unknown scheme). Capture it instead."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if newurl.startswith("magnet:"):
            raise _MagnetRedirect(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _release_payload(rel):
    """Resolve a Prowlarr release to ('magnet', url) or ('file', torrent_bytes).

    Prowlarr hands out PROXIED urls (http://localhost:9696/<n>/download?apikey=...).
    qBittorrent runs inside gluetun's network namespace, where localhost is NOT
    Prowlarr -- so if we pass that url straight to qbit it silently fails
    (success_count 0). Radarr/Sonarr avoid this by fetching the torrent themselves
    and POSTing the bytes; the bridge does the same.
    """
    url = rel.get("magnetUrl") or rel.get("downloadUrl") or rel.get("guid") or ""
    if url.startswith("magnet:"):
        return "magnet", url
    if url.startswith("http"):
        op = urllib.request.build_opener(_CatchMagnet)
        try:
            with op.open(url, timeout=90) as f:
                data = f.read()
            if data[:1] == b"d":                     # bencoded .torrent file
                return "file", data
            txt = data.decode(errors="ignore").strip()
            if txt.startswith("magnet:"):
                return "magnet", txt
        except _MagnetRedirect as m:
            return "magnet", m.url
    ih = rel.get("infoHash")
    if ih:
        dn = urllib.parse.quote(rel.get("title") or "")
        return "magnet", f"magnet:?xt=urn:btih:{ih}&dn={dn}"
    raise RuntimeError("release has no usable magnet or .torrent")


def _qbit_add_file(data):
    """Upload raw .torrent bytes (multipart/form-data)."""
    boundary = "----mediabridge" + str(int(time.time() * 1000))

    def field(name, value):
        return (f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{name}"\r\n\r\n{value}\r\n').encode()

    body = field("category", BOOK_CATEGORY) + field("savepath", BOOK_SAVE_CT)
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"torrents\"; "
             f'filename="release.torrent"\r\n'
             f"Content-Type: application/x-bittorrent\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    op = _qb_opener or qbit_login()
    rq = urllib.request.Request(f"{QBIT_URL}/api/v2/torrents/add", data=body,
                                headers={"Referer": QBIT_URL,
                                         "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with op.open(rq, timeout=120) as f:
        return f.read().decode()


def _add_failed(resp):
    """qbit 5 answers /torrents/add with JSON counts; 'Ok.' on older builds."""
    if isinstance(resp, dict):
        return (resp.get("success_count") or 0) < 1
    return bool(resp) and str(resp).strip() not in ("Ok.", "")


def qbit_add(release):
    """Add a release to qBittorrent; return its infohash (matched after the add)."""
    kind, payload = _release_payload(release)
    before = set(_qbit_hashes())
    if kind == "magnet":
        resp = qbit("torrents/add", {"urls": payload, "category": BOOK_CATEGORY,
                                     "savepath": BOOK_SAVE_CT})
    else:
        resp = _qbit_add_file(payload)
        try:
            resp = json.loads(resp)
        except Exception:
            pass
    if _add_failed(resp):
        raise RuntimeError(f"qbit rejected the {kind}: {str(resp)[:100]}")
    for _ in range(20):                      # the add is async; wait for it to appear
        time.sleep(1)
        new = set(_qbit_hashes()) - before
        if new:
            return new.pop()
    raise RuntimeError("torrent did not appear in qbit after add")


def add_book(req):
    """Grab an ebook and/or an audiobook for this title. Returns (msg, detail_dict)."""
    title = req["title"]
    author = ""
    try:                                     # Cue packs {"author": ...} into detail on insert
        author = (json.loads(req.get("detail") or "{}") or {}).get("author") or ""
    except Exception:
        pass

    qbit_ensure_category()
    grabbed, tried = {}, []

    for kind, cats, formats, require in (
        ("ebook", EBOOK_CATS, EBOOK_FORMATS, True),      # must say epub/mobi/azw3/pdf
        ("audiobook", AUDIO_CATS, AUDIO_FORMATS, False), # category alone is enough
    ):
        rel = _pick_release(_search_books(title, author, cats), title, formats, require)
        if not rel:
            tried.append(f"no {kind}")
            continue
        try:
            h = qbit_add(rel)
        except Exception as e:
            tried.append(f"{kind} grab failed: {str(e)[:60]}")
            continue
        grabbed[kind] = {"hash": h, "release": (rel.get("title") or "")[:120],
                         "seeders": rel.get("seeders")}
        log(f"book '{title}': grabbed {kind} -> {rel.get('title')!r} ({rel.get('seeders')} seeders)")

    if not grabbed:
        raise RuntimeError("no book release found (" + ", ".join(tried) + ")")
    got = " + ".join(sorted(grabbed))
    return f"grabbed {got} for {title}", {"books": grabbed}


# --- import: hardlink finished torrents into the library --------------------

def _host_path(container_path):
    """qbit reports paths in ITS namespace (/data/torrents/...); translate to the host."""
    if container_path.startswith(BOOK_SAVE_CT):
        return TORRENT_HOST_DIR + container_path[len(BOOK_SAVE_CT):]
    return container_path


def _link_into(src_host, dest_dir):
    """Hardlink src (file or dir) under dest_dir so the torrent keeps seeding."""
    os.makedirs(dest_dir, exist_ok=True)
    if os.path.isfile(src_host):
        dst = os.path.join(dest_dir, os.path.basename(src_host))
        if not os.path.exists(dst):
            os.link(src_host, dst)
        return 1
    n = 0
    for root, _dirs, files in os.walk(src_host):
        rel = os.path.relpath(root, src_host)
        out = dest_dir if rel == "." else os.path.join(dest_dir, rel)
        os.makedirs(out, exist_ok=True)
        for fn in files:
            dst = os.path.join(out, fn)
            if not os.path.exists(dst):
                os.link(os.path.join(root, fn), dst)
                n += 1
    return n


def _import_book(title, kind, tor):
    dest_root = EBOOK_DIR if kind == "ebook" else AUDIOBOOK_DIR
    safe = "".join(c for c in title if c.isalnum() or c in " -_'").strip() or "Unknown"
    dest = os.path.join(dest_root, safe)
    src = _host_path(tor.get("content_path") or tor.get("save_path") or "")
    if not src or not os.path.exists(src):
        log(f"import '{title}' {kind}: source missing on host ({src!r})")
        return False
    try:
        n = _link_into(src, dest)
        log(f"imported {kind} '{title}' -> {dest} ({n} file(s))")
        return True
    except Exception as e:
        log(f"import '{title}' {kind} FAILED: {e!r}")
        return False


def monitor_books():
    """Push live progress for book rows, and import them once they finish."""
    code, rows = sb("GET", "media_requests?status=in.(added,downloading)&media_type=eq.book"
                           "&select=id,title,status,detail&limit=50")
    if code != 200 or not rows:
        return
    try:
        tors = _qbit_hashes()
    except Exception as e:
        log("qbit info error", repr(e))
        return

    for r in rows:
        try:
            d = json.loads(r.get("detail") or "{}")
            if not isinstance(d, dict):
                d = {}
        except Exception:
            d = {}
        books = d.get("books") or {}
        if not books:
            continue

        pcts, done_all, changed = [], True, False
        for kind, meta in books.items():
            t = tors.get(meta.get("hash"))
            if not t:                                   # torrent gone from qbit
                pcts.append(100 if meta.get("imported") else 0)
                continue
            pct = round((t.get("progress") or 0) * 100, 1)
            pcts.append(pct)
            finished = (t.get("progress") or 0) >= 1.0
            if finished and not meta.get("imported"):
                if _import_book(r["title"], kind, t):
                    meta["imported"] = True
                    changed = True
            if not finished:
                done_all = False

        pct = round(sum(pcts) / len(pcts), 1) if pcts else 0
        eta = None
        etas = [tors[m["hash"]].get("eta") for m in books.values()
                if m.get("hash") in tors and (tors[m["hash"]].get("eta") or 0) < 8640000]
        if etas:
            eta = f"{max(etas) // 60}m"

        new_status = "downloaded" if (done_all and all(m.get("imported") for m in books.values()))                      else "downloading"
        if d.get("pct") != pct or d.get("eta") != eta or r["status"] != new_status or changed:
            d["pct"], d["eta"] = pct, eta
            sb("PATCH", f"media_requests?id=eq.{r['id']}",
               {"status": new_status, "detail": json.dumps(d)}, prefer="return=minimal")
            log(f"progress book '{r['title']}' -> {new_status} {pct}%")


def process(req):
    """Returns (status, msg, detail_dict).

    Anything that is not a movie used to fall through to add_series(), so a book
    push was handed to Sonarr and looked up as a TV show. Route explicitly and
    fail loudly on a type we don't handle.
    """
    mt = req["media_type"]
    if mt == "movie":
        msg, rid = add_movie(req)
        return "added", msg, {"app": "Radarr", "arr_id": rid}
    if mt == "tv":
        msg, rid = add_series(req)
        return "added", msg, {"app": "Sonarr", "arr_id": rid}
    if mt == "book":
        msg, extra = add_book(req)
        return "added", msg, {"app": "Prowlarr", **extra}
    raise RuntimeError(f"unsupported media_type {mt!r}")


# ---------------------------------------------------------------------------
# live progress feedback
# ---------------------------------------------------------------------------

def _queue_index(target, id_field):
    """Map {arr_id -> queue record} for the given *arr app."""
    code, q = arr(target, "GET", "queue?pageSize=200")
    idx = {}
    if code == 200 and isinstance(q, dict):
        for r in q.get("records", []):
            k = r.get(id_field)
            if k is not None:
                idx.setdefault(k, r)
    return idx


def _progress(rec):
    size = rec.get("size") or 0
    left = rec.get("sizeleft")
    pct = None
    if size and left is not None:
        pct = round((size - left) / size * 100, 1)
    return pct, rec.get("timeleft")


def _has_file(target, path, arr_id):
    code, obj = arr(target, "GET", f"{path}/{arr_id}")
    if code != 200 or not isinstance(obj, dict):
        return False
    if path == "movie":
        return bool(obj.get("hasFile"))
    st = obj.get("statistics") or {}
    return (st.get("episodeFileCount") or 0) > 0


def monitor_downloads():
    """Walk rows we've already added and push their live state back to Supabase."""
    code, rows = sb("GET",
                    "media_requests?status=in.(added,downloading)&media_type=in.(movie,tv)"
                    "&select=id,title,media_type,status,detail,tmdb_id,year&limit=100")
    if code != 200 or not rows:
        return
    qidx = {"movie": _queue_index(RADARR, "movieId"),
            "tv": _queue_index(SONARR, "seriesId")}
    for r in rows:
        try:
            d = json.loads(r.get("detail") or "{}")
            if not isinstance(d, dict):
                d = {}
        except Exception:
            d = {}
        mt = r["media_type"]
        target = RADARR if mt == "movie" else SONARR
        arr_id = d.get("arr_id")
        resolved = False
        if arr_id is None:                          # row we couldn't link at add time -> resolve now
            if mt == "movie":
                arr_id = _radarr_id(r.get("tmdb_id"), r.get("title"), r.get("year"))
            else:
                arr_id = _sonarr_id(r.get("title"))
            if arr_id is not None:
                d["arr_id"] = arr_id
                resolved = True                    # persist it so we don't re-scan every tick
        if arr_id is None:
            continue
        rec = qidx[mt].get(arr_id)
        new_status = r["status"]
        changed = resolved
        if rec is not None:                         # actively downloading
            pct, eta = _progress(rec)
            new_status = "downloading"
            if d.get("pct") != pct or d.get("eta") != eta or r["status"] != "downloading":
                d["pct"], d["eta"] = pct, eta
                changed = True
        else:                                        # not in queue: landed, or still searching
            path = "movie" if mt == "movie" else "series"
            if _has_file(target, path, arr_id):
                new_status = "downloaded"
                d["pct"] = 100
                changed = True
        if changed or new_status != r["status"]:
            sb("PATCH", f"media_requests?id=eq.{r['id']}",
               {"status": new_status, "detail": json.dumps(d)}, prefer="return=minimal")
            log(f"progress {mt} '{r['title']}' -> {new_status} {d.get('pct')}%")


def reap_stalled(app_name, target, search_cmd, id_field):
    """Remove + blocklist + re-search downloads stuck stalled past STALL_GRACE."""
    code, q = arr(target, "GET", "queue?pageSize=100")
    if code != 200 or not isinstance(q, dict):
        return
    now = time.time()
    stalled_now = set()
    for r in q.get("records", []):
        msg = (r.get("errorMessage") or "").lower()
        is_stalled = "stall" in msg or "no connection" in msg
        if not is_stalled:
            continue
        rid = r["id"]
        key = (app_name, rid)
        stalled_now.add(key)
        left = r.get("sizeleft")
        prev = _stall.get(key)
        if not prev or prev["left"] != left:        # progress moved (or first sight) -> reset clock
            _stall[key] = {"first": now, "left": left}
        elif now - prev["first"] >= STALL_GRACE:    # truly stuck -> reap
            arr(target, "DELETE", f"queue/{rid}?removeFromClient=true&blocklist=true")
            wanted_id = r.get(id_field)
            if wanted_id:
                arr(target, "POST", "command", {"name": search_cmd, f"{id_field}s": [wanted_id]})
            log(f"reaped stalled {app_name}: {(r.get('title') or '?')[:40]} -> blocklisted + re-searched")
            _stall.pop(key, None)
            stalled_now.discard(key)
    for key in list(_stall):                         # forget items no longer stalled
        if key[0] == app_name and key not in stalled_now:
            _stall.pop(key, None)


def tick():
    code, rows = sb("GET", "media_requests?status=eq.pending&order=requested_at.asc&limit=20")
    if code != 200:
        log("supabase poll error", code, rows)
    else:
        for req in (rows or []):
            try:
                status, msg, det = process(req)
                detail = json.dumps({"msg": msg, **det})
            except Exception as e:
                status, detail = "failed", json.dumps({"msg": str(e)[:300]})
            sb("PATCH", f"media_requests?id=eq.{req['id']}",
               {"status": status, "detail": detail,
                "processed_at": datetime.now(timezone.utc).isoformat()},
               prefer="return=minimal")
            log(f"{req['media_type']} '{req['title']}' -> {status}: {detail}")
    # feed live download progress back to the app
    monitor_downloads()
    monitor_books()
    # self-heal dead downloads
    reap_stalled("radarr", RADARR, "MoviesSearch", "movieId")
    reap_stalled("sonarr", SONARR, "SeriesSearch", "seriesId")


if __name__ == "__main__":
    log(f"media-bridge up; poll {SB_URL} every {INTERVAL}s; reap stalled > {STALL_GRACE}s")
    while True:
        try:
            tick()
        except Exception as e:
            log("tick error", repr(e))
        time.sleep(INTERVAL)
