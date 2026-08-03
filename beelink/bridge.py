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
import json, os, time, io, re, zipfile, smtplib, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone
from email.message import EmailMessage
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

# Ebooks get emailed to the Kindle once they land. Blank = feature off (books
# still download and land in EBOOK_DIR, they just don't get sent).
KINDLE_EMAIL       = os.environ.get("KINDLE_EMAIL", "")          # <random>@kindle.com
GMAIL_USER         = os.environ.get("GMAIL_USER", "")            # must be an Amazon-approved sender
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
KINDLE_MAX_MB      = float(os.environ.get("KINDLE_MAX_MB", "24"))  # gmail attachment ceiling
R_PROFILE = int(os.environ.get("RADARR_PROFILE", "4"))
R_ROOT    = os.environ.get("RADARR_ROOT", "/data/media/movies")
S_PROFILE = int(os.environ.get("SONARR_PROFILE", "4"))
S_ROOT    = os.environ.get("SONARR_ROOT", "/data/media/shows")
INTERVAL  = int(os.environ.get("POLL_INTERVAL", "20"))
STALL_GRACE = int(os.environ.get("STALL_GRACE", "180"))  # secs a download may sit stalled before reaping

# Audiobookshelf: the bridge writes a listen position when Cue's "resume in audio"
# feature fires (audio_seek_requests outbox). Blank token = feature off.
ABS_URL   = os.environ.get("ABS_URL", "http://localhost:13378").rstrip("/")
ABS_TOKEN = os.environ.get("ABS_TOKEN", "")

# in-memory tracker for stalled queue items: {(app, id): {"first": ts, "left": sizeleft}}
_stall = {}


def http(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    rq = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as f:
            t = f.read().decode()
            if not t.strip():
                return f.status, None
            try:
                return f.status, json.loads(t)          # JSON body -> parsed
            except json.JSONDecodeError:
                return f.status, t                       # non-JSON 200 (e.g. ABS PATCH) -> raw text, don't crash
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


def absapi(method, path, body=None):
    return http(method, f"{ABS_URL}/api/{path}",
                {"Authorization": f"Bearer {ABS_TOKEN}", "Content-Type": "application/json"}, body)


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------
# sticky fulfillment: stamp the Cue card, not just the outbox row
#
# media_requests is transient -- Cue's tray hides finished rows after a day and
# a swipe-delete drops them outright. "Is this book on my Kindle?" is a question
# Nate asks weeks later, so the durable answer belongs on the library card:
# recommendations.fulfillment, keyed by the rec_id Cue writes onto the request.
#
# Every write is a read-modify-write of a jsonb, so merge per LEG rather than
# replacing the object -- the reading-sync daemon owns the `place` leg and must
# not lose it to a download tick (the same clobber that once re-sent a book to
# the Kindle). Best-effort throughout: a failed stamp must never fail a download.
# ---------------------------------------------------------------------------

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def stamp_fulfillment(rec_id, legs):
    """Merge {leg: {...}} into recommendations.fulfillment. Returns True if written."""
    if not rec_id or not legs:
        return False
    try:
        code, rows = sb("GET", f"recommendations?id=eq.{rec_id}&select=fulfillment")
        if code != 200 or not rows:
            return False
        cur = rows[0].get("fulfillment")
        if not isinstance(cur, dict):
            cur = {}
        changed = False
        for leg, patch in legs.items():
            old = cur.get(leg) if isinstance(cur.get(leg), dict) else {}
            new = dict(old)
            new.update(patch)
            if new.get("state") != old.get("state"):
                new["at"] = _now_iso()
            if new != old:
                cur[leg] = new
                changed = True
        if not changed:
            return False
        code, resp = sb("PATCH", f"recommendations?id=eq.{rec_id}",
                        {"fulfillment": cur}, prefer="return=minimal")
        if code >= 300:
            log(f"fulfillment stamp failed {code}: {str(resp)[:120]}")
            return False
        return True
    except Exception as e:                      # never let bookkeeping kill a download
        log(f"fulfillment stamp error: {e!r}")
        return False


# CWA (the OPDS shelf the X4 pulls from) picks up new epubs on a 10-minute cron.
# That's fine unattended but means a book Nate just pushed isn't on the device
# shelf for up to 10 minutes. Poke the same script the cron runs -- it takes the
# same flock, so a concurrent cron run is a no-op rather than a double ingest.
CWA_INGEST = os.environ.get("CWA_INGEST", "/home/nate/apps/calibre-web-automated/autoingest.sh")
CWA_LOCK   = os.environ.get("CWA_LOCK", "/home/nate/apps/calibre-web-automated/.ingest.lock")


def kick_cwa_ingest():
    """Fire the CWA shelf sweep now instead of waiting for the cron. Best effort."""
    if not os.path.exists(CWA_INGEST):
        return False
    try:
        import subprocess
        subprocess.Popen(["/usr/bin/flock", "-n", CWA_LOCK, CWA_INGEST],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log("cwa: kicked shelf ingest")
        return True
    except Exception as e:
        log(f"cwa ingest kick failed: {e!r}")
        return False


# The X4 cannot be delivered to on demand: it is an ESP32 whose WiFi is powered
# down while idle, and its upload server only runs on the File Transfer screen.
# So we record the intent and let ~/apps/x4push drain it on a short cron the next
# time the device actually appears on the LAN.
X4PUSH = os.environ.get("X4PUSH", "/home/nate/apps/x4push/x4push.py")


def queue_for_x4(path, rec_id=None):
    """Queue an imported epub for delivery to the Xteink X4. Best effort.

    Enqueue is idempotent on the source path, so a repeated tick is a no-op.
    """
    if not path or not os.path.exists(X4PUSH):
        return False
    try:
        import subprocess
        cmd = [X4PUSH, "enqueue", path] + ([rec_id] if rec_id else [])
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30, check=False)
        log(f"x4: queued {os.path.basename(path)}")
        return True
    except Exception as e:                      # never let delivery kill a download
        log(f"x4 queue failed: {e!r}")
        return False


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


# --- Libgen: direct-download ebook fallback --------------------------------
#
# Torrent indexers barely carry books, and recent nonfiction (e.g. a 2024
# title) is often absent entirely -- but it's on Libgen. Libgen is a direct
# HTTP download, not a torrent, so this path fetches the epub bytes itself and
# writes them straight into EBOOK_DIR, bypassing qBittorrent. Used only when the
# torrent ebook search comes up empty.

LIBGEN_MIRRORS = [m for m in
                  os.environ.get("LIBGEN_MIRRORS", "https://libgen.li,https://libgen.la").split(",")
                  if m.strip()]
_LG_UA = "Mozilla/5.0 (X11; Linux x86_64) media-bridge/1.0"


def _lg_get(url, timeout=60, referer=None):
    h = {"User-Agent": _LG_UA}
    if referer:
        h["Referer"] = referer
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as f:
        return f.read()


def _lg_rows(html):
    """Parse Libgen result rows into {md5, ext, size_mb, text} dicts, order preserved."""
    out = []
    for m in re.finditer(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        row = m.group(1)
        md5m = re.search(r"md5=([A-Fa-f0-9]{32})", row)
        if not md5m:
            continue
        extm = re.search(r">\s*(epub|mobi|azw3|pdf)\s*<", row, re.I)
        sizem = re.search(r">\s*([\d.]+)\s*(KB|MB|GB)\s*<", row, re.I)
        size_mb = None
        if sizem:
            v = float(sizem.group(1))
            u = sizem.group(2).upper()
            size_mb = v / 1024 if u == "KB" else v * 1024 if u == "GB" else v
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", row)).strip().lower()
        out.append({"md5": md5m.group(1), "ext": (extm.group(1).lower() if extm else "?"),
                    "size_mb": size_mb, "text": text})
    return out


def _lg_pick(rows, title):
    """Prefer an English epub of sane size that matches the title's words."""
    toks = _sig_tokens(title)
    FOREIGN = (" (nl)", " (de)", " (fr)", " (es)", " (it)", " (ru)", "russian",
               "german", "french", "spanish", "italian", " method ")
    cand = []
    for r in rows:
        if r["ext"] != "epub":
            continue
        if not all(t in r["text"] for t in toks):
            continue
        if any(f in r["text"] for f in FOREIGN):
            continue
        if r["size_mb"] and r["size_mb"] > KINDLE_MAX_MB:
            continue
        cand.append(r)
    return cand[0] if cand else None


def _lg_download(md5, base):
    """ads.php -> session key -> get.php (follows to a CDN) -> epub bytes."""
    ads = _lg_get(f"{base}/ads.php?md5={md5}", timeout=40).decode("utf-8", "ignore")
    km = re.search(r'href="(get\.php\?md5=[A-Fa-f0-9]{32}&key=[A-Za-z0-9]+)"', ads)
    if not km:
        raise RuntimeError("no get-key on ads page")
    data = _lg_get(f"{base}/{km.group(1)}", timeout=120, referer=f"{base}/ads.php?md5={md5}")
    if data[:2] != b"PK":                       # epub is a zip; anything else is an error page
        raise RuntimeError("libgen returned non-epub bytes")
    return data


def libgen_ebook(title, author):
    """Find + download an epub from Libgen, write it into EBOOK_DIR. Returns meta or None."""
    query = urllib.parse.quote(f"{title} {author}".strip())
    for base in LIBGEN_MIRRORS:
        try:
            html = _lg_get(f"{base}/index.php?req={query}", timeout=30).decode("utf-8", "ignore")
        except Exception as e:
            log(f"libgen search {base} failed: {str(e)[:60]}")
            continue
        pick = _lg_pick(_lg_rows(html), title)
        if not pick:
            continue
        try:
            data = _lg_download(pick["md5"], base)
        except Exception as e:
            log(f"libgen download {pick['md5'][:8]} failed: {str(e)[:60]}")
            continue
        safe = "".join(c for c in title if c.isalnum() or c in " -_'").strip() or "Unknown"
        dest = os.path.join(EBOOK_DIR, safe)
        os.makedirs(dest, exist_ok=True)
        path = os.path.join(dest, f"{safe}.epub")
        with open(path, "wb") as f:
            f.write(data)
        log(f"libgen: downloaded '{title}' epub -> {path} ({len(data)/1e6:.1f}MB)")
        return {"source": "libgen", "imported": True, "path": path,
                "release": f"libgen {pick['md5'][:8]} ({len(data)/1e6:.1f}MB)"}
    return None


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
    # Per-leg reason a leg never started, so the Cue card can say "no audiobook
    # found" instead of leaving that pill stuck on "searching" forever.
    missing = {}

    for kind, cats, formats, require in (
        ("ebook", EBOOK_CATS, EBOOK_FORMATS, True),      # must say epub/mobi/azw3/pdf
        ("audiobook", AUDIO_CATS, AUDIO_FORMATS, False), # category alone is enough
    ):
        rel = _pick_release(_search_books(title, author, cats), title, formats, require)
        if not rel:
            tried.append(f"no {kind} torrent")
            missing[kind] = "no torrent found"
            continue
        try:
            h = qbit_add(rel)
        except Exception as e:
            tried.append(f"{kind} grab failed: {str(e)[:60]}")
            missing[kind] = f"grab failed: {str(e)[:60]}"
            continue
        grabbed[kind] = {"hash": h, "release": (rel.get("title") or "")[:120],
                         "seeders": rel.get("seeders")}
        log(f"book '{title}': grabbed {kind} -> {rel.get('title')!r} ({rel.get('seeders')} seeders)")

    # No ebook torrent? Libgen almost certainly has it. Download directly.
    if "ebook" not in grabbed:
        try:
            lg = libgen_ebook(title, author)
            if lg:
                grabbed["ebook"] = lg
                missing.pop("ebook", None)
            else:
                tried.append("no ebook on libgen")
                missing["ebook"] = "not on torrents or Libgen"
        except Exception as e:
            tried.append(f"libgen failed: {str(e)[:60]}")
            missing["ebook"] = f"libgen failed: {str(e)[:60]}"

    if not grabbed:
        raise RuntimeError("no book found (" + ", ".join(tried) + ")")
    got = " + ".join(sorted(grabbed))
    return f"grabbed {got} for {title}", {"books": grabbed, "missing": missing}


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


# ---------------------------------------------------------------------------
# ebook -> Kindle
#
# Audiobooks are served by Audiobookshelf off /media/audiobooks. Ebooks are
# read on a Kindle, so after an ebook lands we email it to the Send-to-Kindle
# address. Amazon converts EPUB server-side, which is what puts the book in the
# Kindle Library with Whispersync -- so send the EPUB as-is. Do NOT convert to
# AZW3/KF8 first: Amazon refuses those by email.
# ---------------------------------------------------------------------------

def _find_epub(root):
    """Largest .epub under root (torrents often ship samples/readme junk alongside)."""
    best, best_sz = None, -1
    for dirpath, _d, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(".epub"):
                p = os.path.join(dirpath, fn)
                sz = os.path.getsize(p)
                if sz > best_sz:
                    best, best_sz = p, sz
    return best


def _epub_repair(path):
    """Return repaired epub bytes.

    Torrent-sourced EPUBs get rejected by Amazon for two boring reasons:
      * no <dc:language> in the OPF          -> error E999, book silently dropped
      * XHTML with no charset declaration    -> Amazon assumes ISO-8859-1, mojibake
    Both are cheap to fix in-place; an epub is just a zip. (This is the same
    repair calibre/kindle-epub-fix do -- done here to keep bridge.py stdlib-only.)
    """
    buf = io.BytesIO()
    fixed_lang = fixed_charset = 0
    with zipfile.ZipFile(path) as zin:
        items = zin.infolist()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
            for it in items:
                data = zin.read(it.filename)
                low = it.filename.lower()

                if low.endswith(".opf"):
                    txt = data.decode("utf-8", "ignore")
                    if "<dc:language" not in txt and "<language" not in txt:
                        # inject into the metadata block Amazon reads
                        for tag in ("</metadata>", "</opf:metadata>"):
                            if tag in txt:
                                txt = txt.replace(
                                    tag, "  <dc:language>en</dc:language>\n" + tag, 1)
                                fixed_lang += 1
                                break
                    data = txt.encode("utf-8")

                elif low.endswith((".xhtml", ".html", ".htm")):
                    txt = data.decode("utf-8", "ignore")
                    head = txt[:600].lower()
                    if "charset" not in head:
                        if "<head>" in txt:
                            txt = txt.replace(
                                "<head>", '<head>\n<meta charset="utf-8"/>', 1)
                            fixed_charset += 1
                        elif "<head " in txt:            # head with attributes
                            i = txt.index("<head ")
                            j = txt.index(">", i)
                            txt = txt[:j + 1] + '\n<meta charset="utf-8"/>' + txt[j + 1:]
                            fixed_charset += 1
                    data = txt.encode("utf-8")

                zout.writestr(it, data)
    if fixed_lang or fixed_charset:
        log(f"epub repair: +{fixed_lang} language tag, +{fixed_charset} charset decl")
    return buf.getvalue()


def send_to_kindle(title, epub_path):
    """Email an epub to the Send-to-Kindle address. Returns (ok, message)."""
    if not (KINDLE_EMAIL and GMAIL_USER and GMAIL_APP_PASSWORD):
        return False, "kindle not configured"
    try:
        data = _epub_repair(epub_path)
    except Exception as e:                      # a broken zip is still worth trying raw
        log(f"epub repair failed ({e!r}); sending original")
        data = open(epub_path, "rb").read()

    mb = len(data) / 1e6
    if mb > KINDLE_MAX_MB:                      # gmail caps attachments ~25MB
        return False, f"too big for email ({mb:.1f}MB > {KINDLE_MAX_MB}MB)"

    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = KINDLE_EMAIL
    msg["Subject"] = title                      # Amazon uses the attachment, not the body
    msg.set_content(f"{title} — sent by Cue")
    fname = os.path.basename(epub_path)
    msg.add_attachment(data, maintype="application", subtype="epub+zip", filename=fname)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=120) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.send_message(msg)
    return True, f"emailed {fname} ({mb:.1f}MB) to kindle"


def _maybe_kindle(title, kind, meta):
    """Email an imported ebook to the Kindle exactly once. Returns True if it acted.

    Audiobooks are served by Audiobookshelf and skipped here. The result is
    stamped onto meta['kindle'] so a book is never emailed twice. Works for both
    torrent-imported and Libgen-direct ebooks (Libgen has no torrent hash).
    """
    if kind != "ebook" or not meta.get("imported") or meta.get("kindle"):
        return False
    if not (KINDLE_EMAIL and GMAIL_USER and GMAIL_APP_PASSWORD):
        return False                            # not configured -> leave unstamped, retry later
    safe = "".join(c for c in title if c.isalnum() or c in " -_'").strip() or "Unknown"
    epub = meta.get("path") or _find_epub(os.path.join(EBOOK_DIR, safe))
    if not epub or not os.path.exists(epub):
        meta["kindle"] = "no epub in release"
        log(f"kindle '{title}': no .epub found")
        return True
    try:
        ok, m = send_to_kindle(title, epub)
        meta["kindle"] = m if ok else f"failed: {m}"
        log(f"kindle '{title}': {m}")
    except Exception as e:
        meta["kindle"] = f"failed: {str(e)[:80]}"
        log(f"kindle '{title}' FAILED: {e!r}")
    return True


def _leg_state(kind, meta, pct):
    """One book leg's row in `detail.books` -> the state the Cue card shows.

    Order matters: a Kindle send only happens after an import, and an import only
    after a finished download, so check the furthest-along facts first. `dead`
    (set by the reaper when a swarm has no live seeders) outranks all of them --
    it's the one state that needs Nate.
    """
    if meta.get("dead"):
        return {"state": "failed", "detail": "no live seeders left"}
    kindle = meta.get("kindle") or ""
    if kind == "ebook" and kindle:
        if kindle.startswith("failed") or kindle.startswith("no epub"):
            # The book IS on the shelf; only the email leg failed. Say that,
            # don't claim the whole ebook failed.
            return {"state": "downloaded", "detail": f"on shelf; kindle: {kindle}"}
        return {"state": "delivered", "kindle": kindle}
    if meta.get("imported"):
        return {"state": "downloaded"}
    if pct is not None:
        return {"state": "downloading", "pct": pct}
    return {"state": "searching"}


def monitor_books():
    """Push live progress for book rows, and import them once they finish."""
    code, rows = sb("GET", "media_requests?status=in.(added,downloading)&media_type=eq.book"
                           "&select=id,title,status,detail,rec_id&limit=50")
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
        legs = {}                                       # per-leg stamp for the Cue card
        for kind, meta in books.items():
            t = tors.get(meta.get("hash"))
            if not t:                                   # no torrent: libgen direct dl, or
                pcts.append(100 if meta.get("imported") else 0)   # a completed torrent gone from qbit
                if _maybe_kindle(r["title"], kind, meta):
                    changed = True
                if not meta.get("imported"):
                    done_all = False
                legs[kind] = _leg_state(kind, meta, None)
                continue
            pct = round((t.get("progress") or 0) * 100, 1)
            pcts.append(pct)
            finished = (t.get("progress") or 0) >= 1.0
            if finished and not meta.get("imported"):
                if _import_book(r["title"], kind, t):
                    meta["imported"] = True
                    changed = True
            if _maybe_kindle(r["title"], kind, meta):   # ebook -> Kindle once imported
                changed = True
            if not finished:
                done_all = False
            legs[kind] = _leg_state(kind, meta, pct)

        # A leg that never found a source stays failed rather than "searching".
        for kind, why in (d.get("missing") or {}).items():
            if kind not in books:
                legs[kind] = {"state": "failed", "detail": why}

        # The moment an epub is on disk, hand it to the two things that read from
        # EBOOK_DIR: CWA (the OPDS shelf the X4 pulls from, otherwise up to 10
        # minutes away on cron) and the reading-sync poller, which indexes the
        # epub and publishes it to `reading_books` so Place can push a position.
        ebook = books.get("ebook") or {}
        if ebook.get("imported") and not ebook.get("shelved"):
            kick_cwa_ingest()
            _safe = "".join(c for c in r["title"] if c.isalnum() or c in " -_'").strip() or "Unknown"
            _epub = ebook.get("path") or _find_epub(os.path.join(EBOOK_DIR, _safe))
            if queue_for_x4(_epub, r.get("rec_id")):
                # Deliberately not "delivered" -- the book only reaches the X4
                # when Nate next opens File Transfer, which may be days away.
                legs["x4"] = {"state": "pending", "detail": "queued for X4"}
            ebook["shelved"] = True
            changed = True
            legs["place"] = {"state": "pending", "detail": "indexing for Place"}

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
        stamp_fulfillment(r.get("rec_id"), legs)


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
                    "&select=id,title,media_type,status,detail,tmdb_id,year,rec_id&limit=100")
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
        # movie/tv carry a single leg; books fan out to three (see monitor_books)
        leg = {"state": "downloaded"} if new_status == "downloaded" else (
            {"state": "downloading", "pct": d.get("pct")} if rec is not None
            else {"state": "searching"})
        stamp_fulfillment(r.get("rec_id"), {"download": leg})


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


def process_seeks():
    """Cue 'resume in audio': write a listen position into Audiobookshelf.

    Cue searches the aligned transcript client-side, then inserts an
    audio_seek_requests row {abs_item_id, current_time_sec}. We PATCH the ABS
    listen progress for that item so the user just opens ABS and hits play.
    """
    if not ABS_TOKEN:
        return
    code, rows = sb("GET", "audio_seek_requests?status=eq.pending&order=created_at.asc&limit=20")
    if code != 200:
        log("seek poll error", code, rows)
        return
    for r in (rows or []):
        item = r["abs_item_id"]
        secs = float(r["current_time_sec"])
        try:
            sc, resp = absapi("PATCH", f"me/progress/{item}", {"currentTime": secs})
            status, msg = ("done", f"seeked to {secs:.0f}s") if sc == 200 \
                else ("failed", f"abs {sc}: {str(resp)[:200]}")
        except Exception as e:
            status, msg = "failed", str(e)[:200]
        sb("PATCH", f"audio_seek_requests?id=eq.{r['id']}",
           {"status": status, "detail": msg,
            "processed_at": datetime.now(timezone.utc).isoformat()},
           prefer="return=minimal")
        log(f"seek '{r.get('book_title') or item}' -> {status}: {msg}")


BOOK_STALL_GRACE = int(os.environ.get("BOOK_STALL_GRACE", "1800"))  # secs a book may sit at 0 bytes
_book_stall = {}   # {infohash: ts first seen making no progress}


def reap_stalled_books():
    """Reap book torrents that land in a dead swarm.

    Books bypass Radarr/Sonarr and go straight Prowlarr -> qBittorrent, so
    reap_stalled() never sees them: a stuck book sits at 0% forever while the
    request still reads downloading. That is how the audiobook for Nothing to
    See Here sat dead for six days (found 2026-07-21) while its ebook half
    succeeded, so nothing looked wrong from the app.

    Root cause: Prowlarr seeder counts are scraped from the indexer page and go
    stale, so a release can advertise seeders (that one claimed 7), pass
    _pick_release seeders >= 1, and still have an empty swarm. Trust
    qBittorrent live num_complete instead. On a dead swarm, re-grab a different
    release and remember the dead one so it is never picked twice.
    """
    code, rows = sb("GET", "media_requests?status=in.(added,downloading)&media_type=eq.book"
                           "&select=id,title,status,detail,rec_id&limit=50")
    if code != 200 or not rows:
        return
    try:
        tors = _qbit_hashes()
    except Exception as e:
        log("qbit info error (book reap)", repr(e))
        return

    now = time.time()
    live = set()
    for r in rows:
        try:
            d = json.loads(r.get("detail") or "{}")
            if not isinstance(d, dict):
                continue
        except Exception:
            continue
        books = d.get("books") or {}
        author = d.get("author") or ""
        title = r["title"]
        changed = False

        for kind, meta in list(books.items()):
            h = meta.get("hash")
            t = tors.get(h) if h else None
            if not t or meta.get("imported"):
                continue
            moving = (t.get("downloaded") or 0) > 0 or (t.get("progress") or 0) > 0
            seeded = (t.get("num_complete") or 0) > 0
            if moving or seeded:
                _book_stall.pop(h, None)      # real peers or real bytes: leave it alone
                continue

            live.add(h)
            first = _book_stall.setdefault(h, now)
            waited = int(now - first)
            if waited < BOOK_STALL_GRACE:
                continue

            dead = meta.get("release") or ""
            tried = list(meta.get("tried") or [])
            if dead and dead not in tried:
                tried.append(dead)
            log("book " + repr(title) + ": " + kind + " dead swarm after "
                + str(waited) + "s, reaping " + repr(dead[:60]))
            try:
                qbit("torrents/delete", {"hashes": h, "deleteFiles": "true"})
            except Exception as e:
                log("qbit delete failed", repr(e))
            _book_stall.pop(h, None)
            live.discard(h)

            if kind == "ebook":
                cats, formats, require = EBOOK_CATS, EBOOK_FORMATS, True
            else:
                cats, formats, require = AUDIO_CATS, AUDIO_FORMATS, False
            fresh = [x for x in _search_books(title, author, cats)
                     if (x.get("title") or "") not in tried]
            rel = _pick_release(fresh, title, formats, require)
            meta["tried"] = tried
            changed = True
            if not rel:
                meta["hash"] = None
                meta["dead"] = True
                log("book " + repr(title) + ": no live " + kind + " release left ("
                    + str(len(tried)) + " tried)")
                continue
            try:
                nh = qbit_add(rel)
            except Exception as e:
                meta["dead"] = True
                log("book " + repr(title) + ": re-grab failed: " + str(e)[:60])
                continue
            meta["hash"] = nh
            meta["release"] = (rel.get("title") or "")[:120]
            meta["seeders"] = rel.get("seeders")
            meta["dead"] = False
            log("book " + repr(title) + ": re-grabbed " + kind + " -> "
                + repr(rel.get("title")) + " (" + str(rel.get("seeders")) + " seeders)")

        if changed:
            sb("PATCH", "media_requests?id=eq." + str(r["id"]),
               {"detail": json.dumps(d)}, prefer="return=minimal")

    for h in list(_book_stall):                   # forget hashes no longer stuck
        if h not in live:
            _book_stall.pop(h, None)


def _push_legs(req, status, msg, det):
    """First stamp after a push: which legs actually started.

    Cue already stamped every leg 'searching' optimistically when Nate tapped the
    button, so this exists to correct that picture as soon as we know better --
    a book with no audiobook anywhere shouldn't sit on 'Audiobook searching'
    until the heat death of the universe.
    """
    book = req.get("media_type") == "book"
    if status == "failed":
        if book:
            return {k: {"state": "failed", "detail": msg} for k in ("ebook", "audiobook", "place")}
        return {"download": {"state": "failed", "detail": msg}}
    if not book:
        return {"download": {"state": "searching"}}
    legs = {}
    for kind in ("ebook", "audiobook"):
        if kind in (det.get("books") or {}):
            legs[kind] = {"state": "downloading", "pct": 0}
        else:
            legs[kind] = {"state": "failed",
                          "detail": (det.get("missing") or {}).get(kind, "no source found")}
    if legs.get("ebook", {}).get("state") == "failed":
        # Place syncs off the epub; no epub, nothing to sync.
        legs["place"] = {"state": "failed", "detail": "no ebook to index"}
    return legs


def tick():
    code, rows = sb("GET", "media_requests?status=eq.pending&order=requested_at.asc&limit=20")
    if code != 200:
        log("supabase poll error", code, rows)
    else:
        for req in (rows or []):
            det = {}
            try:
                status, msg, det = process(req)
                detail = json.dumps({"msg": msg, **det})
            except Exception as e:
                msg = str(e)[:300]
                status, detail = "failed", json.dumps({"msg": msg})
            sb("PATCH", f"media_requests?id=eq.{req['id']}",
               {"status": status, "detail": detail,
                "processed_at": datetime.now(timezone.utc).isoformat()},
               prefer="return=minimal")
            log(f"{req['media_type']} '{req['title']}' -> {status}: {detail}")
            stamp_fulfillment(req.get("rec_id"), _push_legs(req, status, msg, det))
    # feed live download progress back to the app
    monitor_downloads()
    monitor_books()
    # Cue "resume in audio" -> write listen position into Audiobookshelf
    process_seeks()
    # self-heal dead downloads
    reap_stalled("radarr", RADARR, "MoviesSearch", "movieId")
    reap_stalled("sonarr", SONARR, "SeriesSearch", "seriesId")
    reap_stalled_books()


if __name__ == "__main__":
    log(f"media-bridge up; poll {SB_URL} every {INTERVAL}s; reap stalled > {STALL_GRACE}s")
    while True:
        try:
            tick()
        except Exception as e:
            log("tick error", repr(e))
        time.sleep(INTERVAL)
