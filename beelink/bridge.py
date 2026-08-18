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
import json, os, time, io, re, zipfile, smtplib, difflib, urllib.request, urllib.error, urllib.parse
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
# KINDLE_EMAIL is the DEFAULT device only. Each requester can own a different
# Kindle: user_settings key "kindle_email" wins per user_id (see
# kindle_for_user). The household shares one sender, so a book Amanda asks for
# in Cue lands on Amanda's Kindle, not Nate's.
KINDLE_EMAIL       = os.environ.get("KINDLE_EMAIL", "")          # <random>@kindle.com
GMAIL_USER         = os.environ.get("GMAIL_USER", "")            # must be an Amazon-approved sender
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
KINDLE_MAX_MB      = float(os.environ.get("KINDLE_MAX_MB", "24"))  # gmail attachment ceiling
# KINDLE_EMAIL is ONE person's device. Everyone else needs their own
# `kindle_email` setting -- falling back would post their books to his Kindle.
# Blank = treat KINDLE_EMAIL as everyone's (single-user behaviour).
KINDLE_OWNER_ID    = os.environ.get("KINDLE_OWNER_ID", "")
R_PROFILE = int(os.environ.get("RADARR_PROFILE", "4"))
R_ROOT    = os.environ.get("RADARR_ROOT", "/data/media/movies")
S_PROFILE = int(os.environ.get("SONARR_PROFILE", "4"))
S_ROOT    = os.environ.get("SONARR_ROOT", "/data/media/shows")
INTERVAL  = int(os.environ.get("POLL_INTERVAL", "20"))
STALL_GRACE = int(os.environ.get("STALL_GRACE", "180"))  # secs a download may sit stalled before reaping
META_GRACE  = int(os.environ.get("META_GRACE", "600"))   # secs a magnet may sit at metaDL (DHT is slow)
DEAD_GRACE  = int(os.environ.get("DEAD_GRACE", "300"))   # secs a zero-seeder swarm gets before reaping

# Telegram push. Same bot as the rain alerts (@Nate_beelink_bot). SEND ONLY --
# OpenClaw long-polls this token, and a second getUpdates consumer would steal
# its messages. Anything conversational belongs in the OpenClaw media skill.
TG_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT  = os.environ.get("TG_CHAT_ID", "")
_tg_sent = {}                                            # dedupe key -> last send epoch
TG_REPEAT = int(os.environ.get("TG_REPEAT", "21600"))     # don't repeat the same alert for 6h


def tg(text, key=None):
    """Best-effort Telegram push. Never raises; the poll loop must not care."""
    if not TG_TOKEN or not TG_CHAT:
        return
    now = time.time()
    if key:
        if now - _tg_sent.get(key, 0) < TG_REPEAT:
            return
        _tg_sent[key] = now
    try:
        data = urllib.parse.urlencode({
            "chat_id": TG_CHAT, "text": text,
            "disable_web_page_preview": "true"}).encode()
        urllib.request.urlopen(
            urllib.request.Request(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                                   data=data), timeout=15).read()
    except Exception as e:
        log("telegram push failed", repr(e))

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


# The X4 belongs to one person. Other household members request books too, and
# their books must not land on his e-reader. Blank = queue everything, which is
# how this behaved before there was a second requester.
X4_OWNER_ID = os.environ.get("X4_OWNER_ID", "")


def queue_for_x4(path, rec_id=None, user_id=None):
    """Queue an imported epub for delivery to the Xteink X4. Best effort.

    Enqueue is idempotent on the source path, so a repeated tick is a no-op.
    """
    if not path or not os.path.exists(X4PUSH):
        return False
    if X4_OWNER_ID and user_id and user_id != X4_OWNER_ID:
        return False                        # someone else's book, not for this device
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


MATCH_MIN_SIM = float(os.environ.get("MATCH_MIN_SIM", "0.75"))
MATCH_AMBIG_DELTA = float(os.environ.get("MATCH_AMBIG_DELTA", "0.05"))


def _norm_title(s):
    """lowercase, drop punctuation/年-parens, collapse whitespace."""
    s = (s or "").lower()
    s = re.sub(r"\(\s*\d{4}\s*\)", " ", s)      # drop "(2021)"
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def _title_variants(title):
    """'Untold: Chess Mates' -> ['untold chess mates', 'untold'] (series before the colon)."""
    out, full = [], _norm_title(title)
    if full:
        out.append(full)
    for sep in (":", " - ", " \u2013 "):
        if sep in (title or ""):
            head = _norm_title((title or "").split(sep)[0])
            if head and head not in out:
                out.append(head)
            break
    return out


def _score(cand_title, variants):
    c = _norm_title(cand_title)
    if not c:
        return 0.0
    best = 0.0
    for v in variants:
        if c == v:
            return 1.0
        r = difflib.SequenceMatcher(None, c, v).ratio()
        # a candidate that fully contains the requested series name scores well
        if v and (c.startswith(v + " ") or c == v):
            r = max(r, 0.9)
        best = max(best, r)
    return best



def _lookup_terms(title):
    """Search terms to try, most specific first: full title, then series-only."""
    terms, t = [], (title or "").strip()
    if t:
        terms.append(t)
    for sep in (":", " - "):
        if sep in t:
            head = t.split(sep)[0].strip()
            if head and head not in terms:
                terms.append(head)
            break
    return terms


def best_match(results, title, year):
    """Title-first match. Returns None when nothing is confidently the request.

    Never falls back to results[0], and never matches on year alone: a
    wrong-but-plausible match silently downloads an entire wrong series
    (this is exactly how 'Untold: Chess Mates' became Soul Mate (2026)).

    Year is used only to break a tie between candidates that ALREADY match
    the title. If the title is ambiguous, we refuse and say so - a refused
    request is a message to a human; a wrong one is 8 episodes of garbage.
    """
    if not results:
        return None
    variants = _title_variants(title)
    if not variants:
        return None

    scored = sorted(((_score(r.get("title"), variants), r) for r in results),
                    key=lambda t: -t[0])
    top_s = scored[0][0]
    if top_s < MATCH_MIN_SIM:
        log(f"best_match: no confident match for {title!r} "
            f"(best {scored[0][1].get('title')!r} @ {top_s:.2f} < {MATCH_MIN_SIM})")
        return None

    contenders = [r for s, r in scored if top_s - s < MATCH_AMBIG_DELTA]
    if len(contenders) > 1:
        if year:
            by_year = [r for r in contenders if r.get("year") == year]
            if len(by_year) == 1:
                log(f"best_match: {title!r} -> {by_year[0].get('title')!r} "
                    f"({year}) @ {top_s:.2f} (year broke a {len(contenders)}-way tie)")
                return by_year[0]
        names = ", ".join(f"{r.get('title')!r} ({r.get('year')})" for r in contenders[:4])
        log(f"best_match: ambiguous for {title!r} - {len(contenders)} candidates "
            f"[{names}] - refusing to guess; set the provider id on the Cue card")
        return None

    log(f"best_match: {title!r} -> {contenders[0].get('title')!r} "
        f"({contenders[0].get('year')}) @ {top_s:.2f}")
    return contenders[0]


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
            raise RuntimeError(
                f"no confident Radarr match for {req['title']!r} - refusing to add a "
                f"guessed movie (set the tmdb id on the Cue card to force it)")
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


def _req_season(req):
    """The season number Cue asked for, or None for the whole show.

    Cue's season picker writes media_requests.season during TV enrichment. Old
    rows (and every movie/book) have no season at all, which has to keep meaning
    "everything" -- that was the only behaviour before the column existed.
    """
    raw = req.get("season")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _monitor_season(series_id, season, exclusive):
    """Monitor one season on an existing Sonarr series and search for it.

    `exclusive` is for a series we just added (monitor=none): every other season
    is switched off so only the requested one is wanted. For a series already in
    the library we ADD monitoring to the target season and leave the rest alone
    -- silently unmonitoring seasons Nate already asked for would be a rude way
    to answer "also get me season 3".
    """
    if series_id is None or season is None:
        return
    code, s = arr(SONARR, "GET", f"series/{series_id}")
    if code != 200 or not isinstance(s, dict):
        raise RuntimeError(f"sonarr series/{series_id} read {code}: {s}")
    found = False
    for sn in (s.get("seasons") or []):
        if sn.get("seasonNumber") == season:
            sn["monitored"] = True
            found = True
        elif exclusive:
            sn["monitored"] = False
    if not found:
        raise RuntimeError(f"season {season} not found on '{s.get('title')}'")
    s["monitored"] = True
    code, resp = arr(SONARR, "PUT", f"series/{series_id}", s)
    if code not in (200, 202):
        raise RuntimeError(f"sonarr monitor season {code}: {resp}")
    # SeasonSearch, not SeriesSearch: ask the indexers for this season only.
    code, resp = arr(SONARR, "POST", "command",
                     {"name": "SeasonSearch", "seriesId": series_id, "seasonNumber": season})
    if code not in (200, 201):
        raise RuntimeError(f"sonarr SeasonSearch {code}: {resp}")


def add_series(req):
    """Add a series to Sonarr. Returns (human_msg, sonarr_series_id | None).

    With req["season"] set, the add is deliberately inert -- monitor "none" and
    no search -- and _monitor_season then turns on exactly the one season and
    fires a SeasonSearch. Letting the add search first would pull the whole run
    before we ever narrowed it, which is the thing the season picker exists to
    stop.
    """
    season = _req_season(req)
    series = None
    for term in _lookup_terms(req["title"]):
        code, res = arr(SONARR, "GET", "series/lookup?term=" + urllib.parse.quote(term))
        if code != 200:
            raise RuntimeError(f"sonarr lookup {code}: {res}")
        series = best_match(res, req["title"], req.get("year"))
        if series:
            break
        log(f"sonarr lookup: no confident match on term {term!r}")
    if not series:
        raise RuntimeError(
            f"no confident Sonarr match for {req['title']!r} - refusing to add a "
            f"guessed series (set the tvdb id on the Cue card to force it)")
    whole_show = season is None
    series.update({"qualityProfileId": S_PROFILE, "rootFolderPath": S_ROOT,
                   "monitored": True, "seasonFolder": True,
                   "addOptions": {"searchForMissingEpisodes": whole_show,
                                  "monitor": "all" if whole_show else "none"}})
    code, resp = arr(SONARR, "POST", "series", series)
    if code in (200, 201):
        rid = resp.get("id") if isinstance(resp, dict) else None
        if season is not None:
            _monitor_season(rid, season, exclusive=True)
            return f"added to Sonarr: {series.get('title')} S{season}", rid
        return f"added to Sonarr: {series.get('title')}", rid
    if code == 400 and "already" in str(resp).lower():
        rid = None
        tvdb = series.get("tvdbId")
        if tvdb:
            c2, lib = arr(SONARR, "GET", f"series?tvdbId={tvdb}")
            if c2 == 200 and isinstance(lib, list) and lib:
                rid = lib[0].get("id")
        if season is not None and rid is not None:
            # Already in the library, but this season may never have been asked
            # for -- monitor it and search, so the push does something real.
            _monitor_season(rid, season, exclusive=False)
            return f"already in Sonarr: {series.get('title')} — searching S{season}", rid
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
    """Prowlarr answers /download with a 30x to magnet: for magnet-only indexers.

    LANDMINE: hooking redirect_request here does NOT work. urllib's
    HTTPRedirectHandler.http_error_30x validates the redirect target scheme and
    raises HTTPError for anything that is not http/https/ftp *before* it ever
    calls redirect_request -- so a magnet: target escapes as
    "HTTP Error 301: Moved Permanently - Redirection to url ..." and
    redirect_request is never reached. Hook the error methods instead.

    CPython itself aliases 301/303/307/308 to http_error_302, so delegating the
    non-magnet path to super().http_error_302 preserves stock behaviour.
    """
    def http_error_302(self, req, fp, code, msg, headers):
        newurl = headers.get("location") or headers.get("uri") or ""
        if newurl.startswith("magnet:"):
            raise _MagnetRedirect(newurl)
        return super().http_error_302(req, fp, code, msg, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


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
            log(f"libgen search {base} failed: {str(e)[:200]}")
            continue
        pick = _lg_pick(_lg_rows(html), title)
        if not pick:
            continue
        try:
            data = _lg_download(pick["md5"], base)
        except Exception as e:
            log(f"libgen download {pick['md5'][:8]} failed: {str(e)[:200]}")
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
        # Already on the shared shelf -> no torrent, no Libgen. Marked
        # imported so monitor_books mails it to this requester's Kindle on the
        # next tick, and shelved so it is not re-offered to CWA/Place/the X4,
        # which all saw it when the first copy landed.
        onshelf = shelf_copy(title, kind)
        if onshelf:
            grabbed[kind] = {"shelf": True, "imported": True, "shelved": True,
                             "path": onshelf if kind == "ebook" else None}
            log(f"book '{title}': {kind} already on shelf -> {onshelf}")
            continue
        rel = _pick_release(_search_books(title, author, cats), title, formats, require)
        if not rel:
            tried.append(f"no {kind} torrent")
            missing[kind] = "no torrent found"
            continue
        try:
            h = qbit_add(rel)
        except Exception as e:
            tried.append(f"{kind} grab failed: {str(e)[:200]}")
            missing[kind] = f"grab failed: {str(e)[:200]}"
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
            tried.append(f"libgen failed: {str(e)[:200]}")
            missing["ebook"] = f"libgen failed: {str(e)[:200]}"

    if not grabbed:
        raise RuntimeError("no book found (" + ", ".join(tried) + ")")
    fresh = sorted(k for k, v in grabbed.items() if not v.get("shelf"))
    onshelf = sorted(k for k, v in grabbed.items() if v.get("shelf"))
    parts = ([f"grabbed {' + '.join(fresh)}"] if fresh else []) + \
            ([f"already on shelf: {' + '.join(onshelf)}"] if onshelf else [])
    return f"{'; '.join(parts)} for {title}", {"books": grabbed, "missing": missing}


# --- import: hardlink finished torrents into the library --------------------

def _host_path(container_path):
    """qbit reports paths in ITS namespace (/data/torrents/...); translate to the host."""
    if container_path.startswith(BOOK_SAVE_CT):
        return TORRENT_HOST_DIR + container_path[len(BOOK_SAVE_CT):]
    return container_path


BOOK_EXT    = {".epub", ".mobi", ".azw", ".azw3", ".pdf", ".cbz", ".cbr", ".djvu", ".fb2"}
AUDIO_EXT   = {".m4b", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wav", ".wma"}
# Never hardlinked into the library, whatever the release claims to be. A book
# torrent whose only payload is an 850 MB .exe is malware wearing a book's name
# (2026-08-08: one reached the Audiobookshelf shelf as "The Stench of Honolulu").
HOSTILE_EXT = {".exe", ".scr", ".msi", ".bat", ".cmd", ".com", ".pif", ".vbs",
               ".vbe", ".js", ".jse", ".wsf", ".ps1", ".jar", ".apk", ".dmg",
               ".iso", ".lnk", ".reg", ".hta"}


def _ext(p):
    return os.path.splitext(p)[1].lower()


def _wanted_ext(kind):
    """Audiobook bundles routinely ship the ebook alongside, so accept both."""
    return BOOK_EXT if kind == "ebook" else (AUDIO_EXT | BOOK_EXT)


def _link_into(src_host, dest_dir, kind):
    """Hardlink src (file or dir) under dest_dir so the torrent keeps seeding.

    Returns (files_linked, hostile_paths). Refuses outright -- linking nothing,
    not even creating dest_dir -- if the release contains no file that is
    actually a book or audiobook. That empty-handed case is what let a fake
    release create a phantom library folder.
    """
    if os.path.isfile(src_host):
        pairs = [(src_host, dest_dir)]
    else:
        pairs = []
        for root, _dirs, files in os.walk(src_host):
            rel = os.path.relpath(root, src_host)
            out = dest_dir if rel == "." else os.path.join(dest_dir, rel)
            for fn in files:
                pairs.append((os.path.join(root, fn), out))
    hostile = [p for p, _ in pairs if _ext(p) in HOSTILE_EXT]
    if not any(_ext(p) in _wanted_ext(kind) for p, _ in pairs):
        return 0, hostile
    n = 0
    for src, out in pairs:
        if _ext(src) in HOSTILE_EXT:
            continue
        os.makedirs(out, exist_ok=True)
        dst = os.path.join(out, os.path.basename(src))
        if not os.path.exists(dst):
            os.link(src, dst)
            n += 1
    return n, hostile


def _safe_title(title):
    """The library folder name for a title. Must stay the ONE definition:
    the shelf lookup, the import and the Kindle send all have to agree."""
    return "".join(c for c in title if c.isalnum() or c in " -_'").strip() or "Unknown"


def _import_book(title, kind, tor, meta=None):
    """True on import, "rejected" if the release is junk, False if retryable."""
    dest_root = EBOOK_DIR if kind == "ebook" else AUDIOBOOK_DIR
    safe = _safe_title(title)
    dest = os.path.join(dest_root, safe)
    src = _host_path(tor.get("content_path") or tor.get("save_path") or "")
    if not src or not os.path.exists(src):
        log(f"import '{title}' {kind}: source missing on host ({src!r})")
        return False
    try:
        n, hostile = _link_into(src, dest, kind)
        if hostile:
            log(f"import '{title}' {kind}: BLOCKED executable(s) {[os.path.basename(h) for h in hostile][:3]}")
        if not n:
            log(f"import '{title}' {kind}: no {kind} files in the release, refusing")
            tg(f"Blocked a fake {kind}: {title}\n"
               f"The release had no book or audio files"
               + (" -- just a Windows executable." if hostile else ".")
               + "\nNothing was added to your library. Searching again.",
               key=f"junk:{title}:{kind}")
            return "rejected"
        log(f"imported {kind} '{title}' -> {dest} ({n} file(s))")
        if kind == "audiobook":
            nav = _audiobook_nav(dest)
            if nav:
                if meta is not None:
                    meta["nav"] = nav
                if nav["nav"] == "single":
                    log(f"audiobook '{title}': ONE file, no chapter markers -- "
                        f"no in-app navigation (Place's transcript map still seeks)")
                elif nav["nav"] == "chapters":
                    log(f"audiobook '{title}': {nav.get('chapters')} chapter markers")
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


def _has_audio(root):
    for _dp, _dd, files in os.walk(root):
        if any(_ext(f) in AUDIO_EXT for f in files):
            return True
    return False


# The only bad case is ONE audio file with no chapter markers: a 39 h scrub bar
# with nothing to jump to. Multi-file releases are navigable by track and need
# no probe at all. Measured on the real shelf: format does NOT predict this --
# The Fort Bragg Cartel is an .m4b with zero chapters, while Homo Deus is 61
# .mp3s and navigates fine. Only the file/chapter count tells you, and neither
# is published by any indexer at search time (Prowlarr reports files=None, and
# AudiobookBay sends a constant placeholder size), so this has to happen here.
#
# Advisory only. It runs AFTER the files are already in the library and must
# never delay or fail an import, so every failure path returns "unknown" and the
# caller carries on regardless.
NAV_PROBE_TIMEOUT = 15          # seconds; give up quick rather than hold a book


def _audiobook_nav(dest):
    """{'nav': tracks|chapters|single|unknown, ...} or None if there is no audio."""
    try:
        auds = []
        for dp, _dd, files in os.walk(dest):
            auds += [os.path.join(dp, f) for f in files if _ext(f) in AUDIO_EXT]
        if not auds:
            return None
        if len(auds) > 1:
            # More than one file: the player has track boundaries to seek by.
            return {"nav": "tracks", "files": len(auds)}

        # Exactly one file -- the only case that can be a blob. Ask ffprobe for
        # chapter markers. The box has no ffmpeg of its own; it lives in the
        # Jellyfin container, which mounts /srv/media/data/media at /media.
        import subprocess
        rel = auds[0].replace("/srv/media/data/media/", "", 1)
        out = subprocess.run(
            ["docker", "exec", "jellyfin", "/usr/lib/jellyfin-ffmpeg/ffprobe",
             "-v", "error", "-print_format", "json", "-show_chapters",
             "/media/" + rel],
            capture_output=True, text=True, timeout=NAV_PROBE_TIMEOUT)
        if out.returncode != 0:
            return {"nav": "unknown", "files": 1}
        chapters = len(json.loads(out.stdout or "{}").get("chapters") or [])
        return {"nav": "chapters" if chapters > 1 else "single",
                "files": 1, "chapters": chapters}
    except Exception:
        # Timeout, docker down, unreadable file -- all the same answer: we do not
        # know, and it is not worth holding the import to find out.
        return {"nav": "unknown", "files": None}


def shelf_copy(title, kind):
    """An already-shelved copy of this title, or None.

    One shelf, two readers: the second person to want a book should get the
    file that is already on disk rather than a fresh torrent. Returns the
    .epub path for an ebook (that is what the Kindle send needs) and the
    folder for an audiobook (Audiobookshelf reads the folder).

    Exact folder match first, then a normalised sweep, because the shelf folder
    was named from whatever title the FIRST request carried -- "Armageddon
    averted" vs "Armageddon Averted" is the same book. Matching is EQUALITY on
    the normalised title, never a similarity ratio: "the great movies" scores
    0.91 against "the great movies ii" and a false hit here mails out the wrong
    book with no download to inspect. A miss only costs a re-download.
    """
    root = EBOOK_DIR if kind == "ebook" else AUDIOBOOK_DIR
    exact = os.path.join(root, _safe_title(title))
    cands = [exact] if os.path.isdir(exact) else []
    if not cands:
        want = _norm_title(title)
        try:
            names = sorted(os.listdir(root))
        except OSError:
            names = []
        for name in names:
            d = os.path.join(root, name)
            if not os.path.isdir(d):
                continue
            if _norm_title(name) == want:
                cands.append(d)
    for d in cands:
        if kind == "ebook":
            # Only an .epub counts. A folder holding just a .pdf or .mobi is
            # no use to the Kindle send, so let that title download properly.
            p = _find_epub(d)
            if p:
                return p
        elif _has_audio(d):
            return d
    return None


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


_KINDLE_TTL = 600                      # secs a resolved address stays cached
_kindle_cache = {}                     # user_id -> (resolved_at, address)


def kindle_for_user(user_id):
    """The Send-to-Kindle address for whoever made the request.

    Two people share this stack and each owns a different Kindle, so the
    device is a property of the requester, not of the box. Their address
    lives in `user_settings` under key `kindle_email` (the same per-user
    settings table the apps use); KINDLE_EMAIL is the fallback for rows with
    no setting, which keeps Nate's own books working unchanged.

    Cached for _KINDLE_TTL because monitor_books re-resolves on every tick.
    A lookup failure falls back rather than raising -- a Supabase blip must
    not strand a finished book.

    NOTE: the From address stays GMAIL_USER for everyone. Amazon only accepts
    personal documents from senders on that account's approved list, so each
    person has to add GMAIL_USER on their own Amazon account once.
    """
    if not user_id:
        return KINDLE_EMAIL
    hit = _kindle_cache.get(user_id)
    if hit and (time.time() - hit[0]) < _KINDLE_TTL:
        return hit[1]
    # No setting of their own: only the owner inherits the env address.
    addr = KINDLE_EMAIL if (not KINDLE_OWNER_ID or user_id == KINDLE_OWNER_ID) else ""
    try:
        code, rows = sb("GET", f"user_settings?user_id=eq.{user_id}"
                               "&key=eq.kindle_email&select=value")
        if code == 200 and rows:
            val = (rows[0].get("value") or "").strip()
            if val:
                addr = val
    except Exception as e:
        log("kindle_email lookup failed", repr(e))
    _kindle_cache[user_id] = (time.time(), addr)
    return addr


def send_to_kindle(title, epub_path, to_addr=None):
    """Email an epub to a Send-to-Kindle address. Returns (ok, message)."""
    if to_addr is None:                     # unspecified -> the default device.
        to_addr = KINDLE_EMAIL              # "" means "this requester has none".
    if not (to_addr and GMAIL_USER and GMAIL_APP_PASSWORD):
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
    msg["To"] = to_addr
    msg["Subject"] = title                      # Amazon uses the attachment, not the body
    msg.set_content(f"{title} — sent by Cue")
    fname = os.path.basename(epub_path)
    msg.add_attachment(data, maintype="application", subtype="epub+zip", filename=fname)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=120) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.send_message(msg)
    return True, f"emailed {fname} ({mb:.1f}MB) to {to_addr.split('@')[0]}"


def _maybe_kindle(title, kind, meta, to_addr=None):
    """Email an imported ebook to the Kindle exactly once. Returns True if it acted.

    Audiobooks are served by Audiobookshelf and skipped here. The result is
    stamped onto meta['kindle'] so a book is never emailed twice. Works for both
    torrent-imported and Libgen-direct ebooks (Libgen has no torrent hash).
    """
    if kind != "ebook" or not meta.get("imported") or meta.get("kindle"):
        return False
    if to_addr is None:
        to_addr = KINDLE_EMAIL
    if not (GMAIL_USER and GMAIL_APP_PASSWORD):
        return False                            # not configured -> leave unstamped, retry later
    if not to_addr:
        # Requester owns no Kindle we know of. Say so on the card instead of
        # retrying every tick or mailing it to somebody else's device.
        meta["kindle"] = "failed: no Kindle address for requester"
        log(f"kindle '{title}': requester has no kindle_email setting")
        return True
    safe = _safe_title(title)
    epub = meta.get("path") or _find_epub(os.path.join(EBOOK_DIR, safe))
    if not epub or not os.path.exists(epub):
        meta["kindle"] = "no epub in release"
        log(f"kindle '{title}': no .epub found")
        return True
    try:
        ok, m = send_to_kindle(title, epub, to_addr)
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
    if meta.get("rejected"):                 # junk release, binned before import
        return {"state": "failed", "detail": "release contained no book files"}
    kindle = meta.get("kindle") or ""
    if kind == "ebook" and kindle:
        if kindle.startswith("failed") or kindle.startswith("no epub"):
            # The book IS on the shelf; only the email leg failed. Say that,
            # don't claim the whole ebook failed.
            return {"state": "downloaded", "detail": f"on shelf; kindle: {kindle}"}
        return {"state": "delivered", "kindle": kindle}
    if meta.get("imported"):
        if meta.get("shelf"):
            return {"state": "downloaded", "detail": "already on shelf"}
        return {"state": "downloaded"}
    if pct is not None:
        return {"state": "downloading", "pct": pct}
    return {"state": "searching"}


def monitor_books():
    """Push live progress for book rows, and import them once they finish."""
    code, rows = sb("GET", "media_requests?status=in.(added,downloading)&media_type=eq.book"
                           "&select=id,title,status,detail,rec_id,user_id&limit=50")
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
        kindle_to = kindle_for_user(r.get("user_id"))   # whose Kindle this book is for

        pcts, done_all, changed = [], True, False
        legs = {}                                       # per-leg stamp for the Cue card
        for kind, meta in books.items():
            t = tors.get(meta.get("hash"))
            if not t:                                   # no torrent: libgen direct dl, or
                pcts.append(100 if meta.get("imported") else 0)   # a completed torrent gone from qbit
                if _maybe_kindle(r["title"], kind, meta, kindle_to):
                    changed = True
                if not meta.get("imported"):
                    done_all = False
                legs[kind] = _leg_state(kind, meta, None)
                continue
            pct = round((t.get("progress") or 0) * 100, 1)
            pcts.append(pct)
            finished = (t.get("progress") or 0) >= 1.0
            if finished and not meta.get("imported") and not meta.get("rejected"):
                res = _import_book(r["title"], kind, t, meta)
                if res is True:
                    meta["imported"] = True
                    changed = True
                elif res == "rejected":     # junk release: stop retrying, bin it,
                    meta["rejected"] = True  # blocklist so the same file cannot return
                    changed = True
                    try:
                        qbit("torrents/delete",
                             {"hashes": meta.get("hash", ""), "deleteFiles": "true"})
                    except Exception as e:
                        log("could not remove rejected book torrent", repr(e))
            if _maybe_kindle(r["title"], kind, meta, kindle_to):  # ebook -> requester's Kindle
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
            _safe = _safe_title(r["title"])
            _epub = ebook.get("path") or _find_epub(os.path.join(EBOOK_DIR, _safe))
            if queue_for_x4(_epub, r.get("rec_id"), r.get("user_id")):
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

        # A book request has TWO legs but only one status column. Finishing a
        # half-failed request as "downloaded" strands it forever: the daemon
        # never revisits a finished row, and Cue's dedupe (App.jsx) only lets a
        # `failed` row be re-pushed -- so the only recovery was hand-deleting the
        # row from the DB. Let the terminal state carry the missing leg instead.
        # Per-leg detail still rides in `legs`/stamp_fulfillment, so the Cue card
        # keeps showing which half actually landed.
        if done_all and all(m.get("imported") for m in books.values()):
            new_status = "failed" if (d.get("missing") or {}) else "downloaded"
        else:
            new_status = "downloading"
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


def _tv_progress(target, arr_id, season=None):
    """(files, aired-monitored episodes, pct) for a series, or None.

    A series is finished when its episodes are on disk. Queue emptiness is a
    bad proxy: one dead torrent (or a whole wrong-show grab) pins the request
    at 'downloading' forever while every episode already landed.

    When the Cue request named a season, score only that season -- asking for
    season 3 and being told 71% because season 1 has holes is a wrong answer.
    """
    if season is not None:
        code, eps = arr(target, "GET", f"episode?seriesId={arr_id}")
        if code != 200 or not isinstance(eps, list):
            return None
        now = datetime.now(timezone.utc)
        have = total = 0
        for e in eps:
            if e.get("seasonNumber") != int(season) or not e.get("monitored"):
                continue
            air = e.get("airDateUtc")
            if air:                                  # unaired episodes are not owed to us
                try:
                    if datetime.fromisoformat(air.replace("Z", "+00:00")) > now:
                        continue
                except Exception:
                    pass
            total += 1
            if e.get("hasFile"):
                have += 1
        if not total:
            return None
        return have, total, round(have / total * 100, 1)
    code, obj = arr(target, "GET", f"series/{arr_id}")
    if code != 200 or not isinstance(obj, dict):
        return None
    st = obj.get("statistics") or {}
    have = st.get("episodeFileCount") or 0
    total = st.get("episodeCount") or 0
    if not total:
        return None
    return have, total, round(have / total * 100, 1)


def monitor_downloads():
    """Walk rows we've already added and push their live state back to Supabase."""
    code, rows = sb("GET",
                    "media_requests?status=in.(added,downloading)&media_type=in.(movie,tv)"
                    "&select=id,title,media_type,status,detail,tmdb_id,year,rec_id,season&limit=100")
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
        tv_pct = None
        if mt == "tv":
            tvp = _tv_progress(SONARR, arr_id, r.get("season"))
            if tvp is not None:
                have, total, tv_pct = tvp
                if d.get("episodes") != f"{have}/{total}":
                    d["episodes"] = f"{have}/{total}"
                    changed = True
        if tv_pct is not None and tv_pct >= 100:    # every aired episode on disk -> done,
            new_status = "downloaded"               # whatever junk is still in the queue
            if d.get("pct") != 100:
                d["pct"] = 100
                changed = True
        elif rec is not None:                       # actively downloading
            pct, eta = _progress(rec)
            if tv_pct is not None:
                pct = tv_pct                        # series progress beats one torrent's
            new_status = "downloading"
            if d.get("pct") != pct or d.get("eta") != eta or r["status"] != "downloading":
                d["pct"], d["eta"] = pct, eta
                changed = True
        elif mt == "tv":                             # nothing queued and episodes missing:
            if tv_pct is not None and d.get("pct") != tv_pct:   # still searching, not done
                d["pct"] = tv_pct
                changed = True
        else:                                        # not in queue: landed, or still searching
            if _has_file(target, "movie", arr_id):
                new_status = "downloaded"
                d["pct"] = 100
                changed = True
        if changed or new_status != r["status"]:
            sb("PATCH", f"media_requests?id=eq.{r['id']}",
               {"status": new_status, "detail": json.dumps(d)}, prefer="return=minimal")
            log(f"progress {mt} '{r['title']}' -> {new_status} {d.get('pct')}%")
            if new_status == "downloaded" and r["status"] != "downloaded":
                where = f" season {r['season']}" if r.get("season") else ""
                tg(f"Ready to watch: {r['title']}{where}", key=f"done:{r['id']}")
        # movie/tv carry a single leg; books fan out to three (see monitor_books)
        leg = {"state": "downloaded"} if new_status == "downloaded" else (
            {"state": "downloading", "pct": d.get("pct")} if rec is not None
            else {"state": "searching"})
        stamp_fulfillment(r.get("rec_id"), {"download": leg})


BLOCKLIST_TTL = int(os.environ.get("BLOCKLIST_TTL", str(7 * 86400)))  # secs a blocklisting lasts
_last_prune = {}                          # app_name -> last run, so one app cannot skip the other


def prune_blocklist(app_name, target):
    """Expire old blocklistings so a thin catalogue cannot be permanently burned.

    The reaper blocklists to stop Sonarr re-grabbing the same corpse on the very
    next search. But "no seeders right now" is not "bad release" -- and when an
    episode only has four candidates, blocklisting two of them makes it
    unobtainable forever. 2026-08-08: that is exactly what happened to Untold
    S06E04. So blocklistings expire and the release gets another chance later.
    """
    now = time.time()
    if now - _last_prune.get(app_name, 0) < 3600:     # hourly is plenty
        return
    _last_prune[app_name] = now
    code, b = arr(target, "GET", "blocklist?pageSize=200&sortKey=date&sortDirection=ascending")
    if code != 200 or not isinstance(b, dict):
        return
    for r in b.get("records", []):
        stamp = r.get("date") or ""
        try:
            age = now - datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        if age >= BLOCKLIST_TTL:
            arr(target, "DELETE", f"blocklist/{r['id']}")
            log(f"blocklist expired {app_name}: {(r.get('sourceTitle') or '?')[:50]}")


def _qbit_by_hash():
    """{lowercase hash -> torrent} for everything in qBittorrent."""
    try:
        infos = qbit("torrents/info") or []
    except Exception as e:
        log("qbit info error (reap)", repr(e))
        return {}
    return {(t.get("hash") or "").lower(): t for t in infos if isinstance(t, dict)}


def _is_dead(rec, qt):
    """Is this queue row a corpse? (reason, grace) or (None, 0).

    Sonarr's errorMessage is not enough on its own. The three states that
    actually burn hours here never say 'stalled':
      metaDL   at 0% -> magnet whose metadata never arrives
      queuedDL at 0% -> waiting on a slot, but only dead if the swarm is empty
      stalledDL      -> already covered by the message, kept for the no-message case
    NordVPN gives no forwarded port, so we only ever reach peers with open
    ports; a swarm reporting zero seeders will never start. Judge on
    num_complete (seeders the tracker knows) rather than num_seeds
    (seeders we happen to be connected to), which is 0 while queued.
    """
    msg = (rec.get("errorMessage") or "").lower()
    if "stall" in msg or "no connection" in msg:
        return "stalled", STALL_GRACE
    if not qt:
        return None, 0
    state = qt.get("state") or ""
    progress = qt.get("progress") or 0
    swarm = qt.get("num_complete")
    if swarm is None:
        swarm = -1
    if state in ("metaDL", "queuedDL", "stalledDL") and progress <= 0:
        if swarm == 0:
            return f"{state} with an empty swarm", DEAD_GRACE
        if state == "metaDL":
            return "metadata never arrived", META_GRACE
    return None, 0


def reap_stalled(app_name, target, search_cmd, id_field):
    """Remove + blocklist + re-search downloads that are going nowhere."""
    code, q = arr(target, "GET", "queue?pageSize=100")
    if code != 200 or not isinstance(q, dict):
        return
    now = time.time()
    stalled_now = set()
    qbt = _qbit_by_hash()
    for r in q.get("records", []):
        qt = qbt.get((r.get("downloadId") or "").lower())
        reason, grace = _is_dead(r, qt)
        if not reason:
            continue
        rid = r["id"]
        key = (app_name, rid)
        stalled_now.add(key)
        left = r.get("sizeleft")
        prev = _stall.get(key)
        if not prev or prev["left"] != left:        # progress moved (or first sight) -> reset clock
            _stall[key] = {"first": now, "left": left}
        elif now - prev["first"] >= grace:          # truly stuck -> reap
            arr(target, "DELETE", f"queue/{rid}?removeFromClient=true&blocklist=true")
            wanted_id = r.get(id_field)
            if wanted_id:
                arr(target, "POST", "command", {"name": search_cmd, f"{id_field}s": [wanted_id]})
            log(f"reaped {app_name} ({reason}): {(r.get('title') or '?')[:40]} -> blocklisted + re-searched")
            title = (r.get("title") or "?")[:70]
            tg(f"Dropped a dead download: {title}\nWhy: {reason}\n"
               f"Blocklisted it and searched again. Ask the bot for the download "
               f"status if it goes quiet.", key=f"reap:{title}")
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
                log("book " + repr(title) + ": re-grab failed: " + str(e)[:200])
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
    prune_blocklist("radarr", RADARR)
    prune_blocklist("sonarr", SONARR)


if __name__ == "__main__":
    log(f"media-bridge up; poll {SB_URL} every {INTERVAL}s; reap stalled > {STALL_GRACE}s")
    while True:
        try:
            tick()
        except Exception as e:
            log("tick error", repr(e))
        time.sleep(INTERVAL)
