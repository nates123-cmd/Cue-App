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
import json, os, time, io, re, zipfile, smtplib, difflib, threading, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone
from email.message import EmailMessage
# NB: import the class, not the module -- this file defines a function named http(),
# which would shadow the stdlib `http` package and break `http.cookiejar`.
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


def tg(text, key=None, buttons=None, repeat=None):
    """Best-effort Telegram push. Never raises; the poll loop must not care.

    `buttons` is a list of (label, url) pairs rendered as an inline keyboard.
    URL buttons only -- callback buttons would need getUpdates, which belongs
    to OpenClaw (see the note above). Returns True if a message went out.
    """
    if not TG_TOKEN or not TG_CHAT:
        return False
    now = time.time()
    if key:
        if now - _tg_sent.get(key, 0) < (TG_REPEAT if repeat is None else repeat):
            return False
        _tg_sent[key] = now
    try:
        fields = {"chat_id": TG_CHAT, "text": text,
                  "disable_web_page_preview": "true"}
        if buttons:
            fields["reply_markup"] = json.dumps(
                {"inline_keyboard": [[{"text": lbl, "url": url}] for lbl, url in buttons]})
        data = urllib.parse.urlencode(fields).encode()
        urllib.request.urlopen(
            urllib.request.Request(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                                   data=data), timeout=15).read()
        return True
    except Exception as e:
        log("telegram push failed", repr(e))
        return False

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


def _age_secs(iso):
    """Seconds since an ISO timestamp we wrote ourselves, or 0 if unreadable."""
    try:
        return (datetime.now(timezone.utc)
                - datetime.fromisoformat(str(iso).replace("Z", "+00:00"))).total_seconds()
    except Exception:
        return 0


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
                  # When the bridge picks (SPEED_FIRST), Radarr must NOT search on
                  # add or it grabs its own quality-ranked choice first and we end
                  # up racing it with two queue rows for one movie.
                  "addOptions": {"searchForMovie": not SPEED_FIRST}})
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


def _monitor_episodes(series_id, on_seasons, exclusive):
    """Write episode-level monitoring for whole seasons. Returns episodes turned on.

    `PUT /series/{id}` only writes the SEASON flags. Sonarr does not cascade
    them down to the episode rows, and an automatic search asks the indexers
    for MONITORED EPISODES -- never for a monitored season. Skip this call and
    a season reads "monitored" in the UI while every search comes back empty
    and history stays blank. That is exactly what happened to Better Call Saul
    on 2026-08-28: season 1 monitored, all 63 episodes unmonitored, SeasonSearch
    fired, 0 rows of history, and the request sat at "searching" forever.

    Season 0 is never touched -- TVDB hangs hundreds of promo shorts off it
    (233 on Better Call Saul alone) and none of them are wanted.
    """
    code, eps = arr(SONARR, "GET", f"episode?seriesId={series_id}")
    if code != 200 or not isinstance(eps, list):
        raise RuntimeError(f"sonarr episode list {code}: {eps}")
    want = {int(s) for s in on_seasons}
    on  = [e["id"] for e in eps if e.get("seasonNumber") in want]
    off = [e["id"] for e in eps
           if e.get("seasonNumber") not in want and e.get("seasonNumber", 0) >= 1
           and e.get("monitored")]
    if not on:
        raise RuntimeError(f"series {series_id}: no episodes in seasons {sorted(want)}")
    if exclusive and off:
        arr(SONARR, "PUT", "episode/monitor", {"episodeIds": off, "monitored": False})
    code, resp = arr(SONARR, "PUT", "episode/monitor",
                     {"episodeIds": on, "monitored": True})
    if code not in (200, 202):
        raise RuntimeError(f"sonarr episode/monitor {code}: {resp}")
    return len(on)


def _monitor_all(series_id):
    """Monitor every real season of a series and search for the lot.

    Used when a whole-show push lands on a series already in the library. That
    series may have been added season-scoped, in which case every other season
    is switched off and "already in Sonarr" would otherwise be a lie.
    """
    code, s = arr(SONARR, "GET", f"series/{series_id}")
    if code != 200 or not isinstance(s, dict):
        raise RuntimeError(f"sonarr series/{series_id} read {code}: {s}")
    seasons = [sn["seasonNumber"] for sn in (s.get("seasons") or [])
               if sn.get("seasonNumber", 0) >= 1]
    for sn in (s.get("seasons") or []):
        sn["monitored"] = sn.get("seasonNumber", 0) >= 1
    s["monitored"] = True
    code, resp = arr(SONARR, "PUT", f"series/{series_id}", s)
    if code not in (200, 202):
        raise RuntimeError(f"sonarr monitor series {code}: {resp}")
    n = _monitor_episodes(series_id, seasons, exclusive=False)
    code, resp = arr(SONARR, "POST", "command",
                     {"name": "SeriesSearch", "seriesId": series_id})
    if code not in (200, 201):
        raise RuntimeError(f"sonarr SeriesSearch {code}: {resp}")
    return n


def _monitor_season(series_id, season, exclusive, search=True):
    """Monitor one season on an existing Sonarr series and search for it.

    `search=False` is for SPEED_FIRST: the bridge is about to pick the releases
    itself, and letting Sonarr fire a SeasonSearch first means it grabs its own
    quality-ranked choice and we race it with two grabs per episode.

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
    # The season flag above is cosmetic on its own -- the search only wants
    # MONITORED EPISODES, so write those too before asking.
    _monitor_episodes(series_id, [season], exclusive)
    if not search:
        return
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
                   "addOptions": {"searchForMissingEpisodes": whole_show and not SPEED_FIRST,
                                  "monitor": "all" if whole_show else "none"}})
    code, resp = arr(SONARR, "POST", "series", series)
    if code in (200, 201):
        rid = resp.get("id") if isinstance(resp, dict) else None
        if season is not None:
            _monitor_season(rid, season, exclusive=True, search=not SPEED_FIRST)
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
            _monitor_season(rid, season, exclusive=False, search=not SPEED_FIRST)
            return f"already in Sonarr: {series.get('title')} — searching S{season}", rid
        if rid is not None:
            # Whole-show push onto a series already on the shelf. This used to
            # return "already in Sonarr" and do nothing whatsoever, so re-pushing
            # a show that had been added season-scoped (every other season
            # switched off) was a silent no-op that reported success.
            n = _monitor_all(rid)
            return (f"already in Sonarr: {series.get('title')} — monitoring "
                    f"{n} episodes and searching"), rid
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


def _prowlarr_search(q, cats):
    """One query. Never raises: a search is now several queries, and one slow
    indexer timing out must not take the whole leg down with it."""
    qs = "search?query=" + urllib.parse.quote(q) + "".join(f"&categories={c}" for c in cats) + "&type=search"
    try:
        code, res = prowlarr("GET", qs)
    except Exception as e:
        log(f"prowlarr search failed for {q!r}: {type(e).__name__}: {str(e)[:120]}")
        return []
    if code != 200 or not isinstance(res, list):
        log(f"prowlarr search {code} for {q!r}")
        return []
    return res


def _rel_key(r):
    return (r.get("infoHash") or r.get("guid") or r.get("downloadUrl")
            or r.get("title") or "")


def _search_books(title, author, cats, kind="ebook"):
    """Every query worth asking for this book, de-duplicated.

    A single "<title> <author>" query is what we used to send, and it cannot
    find an audiobook that ships inside an omnibus: "Ursula K. Le Guin Audiobook
    Collection" contains the author and not the title, so the indexer returns
    nothing and the leg reports "no torrent found" -- which is what happened to
    The Lathe of Heaven twice, while a 98-seeder pack holding three narrations
    of it sat one query away.

    Author-only queries are ONLY added for the audiobook leg. Ebooks have Libgen
    as a direct fallback and do not need pack-harvesting, and an author query on
    the ebook side mostly drags in mislabelled bundles.
    """
    queries = []
    if author:
        queries.append(f"{title} {author}".strip())
    queries.append(title)
    if kind == "audiobook" and author:
        queries.append(f"{author} audiobook")

    out, seen = [], set()
    for q in queries:
        for r in _prowlarr_search(q, cats):
            k = _rel_key(r)
            if k and k not in seen:
                seen.add(k)
                out.append(r)
    return out


# --- harvesting one book out of a collection torrent -----------------------
#
# Author omnibuses are how a lot of older audiobooks actually circulate. The
# release name carries the author only, so both of our gates reject it: the
# query never surfaces it, and _pick_release insists every significant word of
# the wanted title appear in the release name.
#
# The book's title IS in the torrent's file paths though, so the pack can be
# added paused, inspected, and stripped down to the one book before a byte of
# the rest is fetched. The Le Guin pack is 26.4 GB; the Lathe of Heaven files
# inside it are 198 MB.

PACK_WORDS = ("collection", "collections", "anthology", "omnibus", "pack",
              "megapack", "mega pack", "complete", "library", "audiobooks",
              "bundle", "box set", "boxset", "discography")
PACK_MIN_BYTES = 1_000_000_000      # 1 GB: below this it is not an omnibus
PACK_MIN_SEEDERS = 3
PACK_MAX_TRIES = 3
PACK_META_WAIT = 120                # seconds to wait for metadata


def _pick_collections(results, want_title, author):
    """Pack releases that might contain want_title, best-seeded first."""
    if not author:
        return []
    atoks = [t for t in _sig_tokens(author) if len(t) > 2]
    if not atoks:
        return []
    ttoks = _sig_tokens(want_title)
    out = []
    for r in results or []:
        seeders = r.get("seeders") or 0
        if seeders < PACK_MIN_SEEDERS:
            continue
        rt = _norm(r.get("title") or "")
        if all(tok in rt for tok in ttoks):
            continue                      # a direct hit; _pick_release owns it
        if not all(tok in rt for tok in atoks):
            continue                      # not this author's pack
        big = (r.get("size") or 0) >= PACK_MIN_BYTES
        named = any(w in rt for w in PACK_WORDS)
        if big or named:
            out.append((-seeders, r))
    out.sort(key=lambda x: x[0])
    return [r for _s, r in out]


def _match_files(files, want_title, exts):
    """Indices of files inside a pack that belong to want_title.

    Matched on the whole relative path, not the basename: the title usually
    lives in the containing folder ("1971 - The Lathe of Heaven (Guidall)/Lathe
    of Heaven 01.mp3") and sometimes only there.
    """
    ttoks = _sig_tokens(want_title)
    hits = []
    for f in files:
        name = f.get("name") or ""
        if _ext(name) not in exts:
            continue
        if all(tok in _norm(name) for tok in ttoks):
            hits.append(f)
    return hits


def _best_edition(hits):
    """One folder's worth of files -- packs often carry several narrations.

    Grouped by containing folder and the largest total wins, which is a proxy
    for the highest bitrate rip. In the Le Guin pack that picks Guidall (188 MB,
    64 kbps) over Kane (94.8 MB, 32 kbps).
    """
    groups = {}
    for f in hits:
        groups.setdefault((f.get("name") or "").rsplit("/", 1)[0], []).append(f)
    best = max(groups.values(), key=lambda g: sum(x.get("size") or 0 for x in g))
    return best, len(groups)


def _pack_by_name(release):
    """Hash of a torrent already in qBittorrent matching this release's name."""
    want = _norm(release.get("title") or "")
    if not want:
        return None
    try:
        infos = qbit("torrents/info") or []
    except Exception:
        return None
    for t in infos:
        if isinstance(t, dict) and _norm(t.get("name") or "") == want:
            return t["hash"]
    return None


def _existing_pack(release):
    """Hash of this release if qBittorrent already holds it, else None.

    Checked across every category, not just BOOK_CATEGORY: a pack may have been
    added by hand, and re-adding it raises HTTP 409.
    """
    ih = (release.get("infoHash") or "").lower()
    if not ih:
        return None
    try:
        infos = qbit("torrents/info") or []
    except Exception:
        return None
    for t in infos:
        if isinstance(t, dict) and (t.get("hash") or "").lower() == ih:
            return t["hash"]
    return None


def qbit_add_selective(release, want_title, exts):
    """Add a pack, keep only want_title's files, return (hash, note).

    Returns (None, reason) and removes the torrent again if the pack turns out
    not to contain the book -- the file list is the first honest evidence either
    way, and it costs only the metadata fetch to look.
    """
    # A pack already in the client is the NORMAL case once a second book is
    # harvested from it -- qBittorrent answers a duplicate add with 409, which
    # would otherwise fail the leg. Reuse it and widen the file selection
    # instead, keeping whatever the earlier book selected.
    h, reused = _existing_pack(release), False
    if h:
        reused = True
        log(f"pack already in qbit ({h[:8]}); extending its file selection")
    else:
        kind, payload = _release_payload(release)
        before = set(_qbit_hashes())
        add = {"category": BOOK_CATEGORY, "savepath": BOOK_SAVE_CT,
               "paused": "true", "stopped": "true"}
        try:
            if kind == "magnet":
                resp = qbit("torrents/add", dict(add, urls=payload))
            else:
                resp = _qbit_add_file(payload, extra=add)
                try:
                    resp = json.loads(resp)
                except Exception:
                    pass
        except urllib.error.HTTPError as e:
            # 409 = qBittorrent already holds this torrent. Indexers like 1337x
            # publish no infoHash, so _existing_pack could not have known;
            # recover by finding it under its release name.
            if e.code != 409:
                raise
            resp, h = None, _pack_by_name(release)
            if not h:
                raise RuntimeError("qbit says duplicate but the pack is not listed")
            reused = True
            log(f"pack already in qbit by name ({h[:8]}); extending its selection")
        if h is None and _add_failed(resp):
            raise RuntimeError(f"qbit rejected the pack {kind}: {str(resp)[:100]}")

        for _ in range(20):
            if h:
                break
            time.sleep(1)
            new = set(_qbit_hashes()) - before
            if new:
                h = new.pop()
                break
        if not h:
            raise RuntimeError("pack did not appear in qbit after add")

    files = []
    for _ in range(PACK_META_WAIT):
        files = qbit(f"torrents/files?hash={h}")
        if isinstance(files, list) and files:
            break
        time.sleep(1)
    if not files:
        _qbit_drop(h)
        return None, "no metadata"

    hits = _match_files(files, want_title, exts)
    if not hits:
        if not reused:
            _qbit_drop(h)
        return None, f"pack has no files matching {want_title!r} ({len(files)} files)"

    keep, n_editions = _best_edition(hits)
    keep_ids = {str(f["index"]) for f in keep}
    if reused:
        keep_ids |= {str(f["index"]) for f in files if f.get("priority")}
    drop_ids = [str(f["index"]) for f in files if str(f["index"]) not in keep_ids]

    # Priorities go out in batches: one id-per-file string for a 1,870-file pack
    # is long enough to trip qBittorrent's request limits.
    for i in range(0, len(drop_ids), 300):
        qbit("torrents/filePrio", {"hash": h, "id": "|".join(drop_ids[i:i + 300]),
                                   "priority": "0"})
    qbit("torrents/filePrio", {"hash": h, "id": "|".join(sorted(keep_ids)),
                               "priority": "7"})

    got = qbit(f"torrents/files?hash={h}")
    sel = [f for f in got if f.get("priority")] if isinstance(got, list) else []
    if len(sel) != len(keep_ids):
        if not reused:
            _qbit_drop(h)          # never delete a pack another book is using
        return None, f"priority set did not stick ({len(sel)} != {len(keep_ids)})"

    qbit("torrents/start", {"hashes": h})
    mb = sum(f.get("size") or 0 for f in keep) / 1e6
    note = (f"{len(keep)} file(s), {mb:.0f} MB of "
            f"{(release.get('size') or 0) / 1e9:.1f} GB"
            + (f", {n_editions} editions offered" if n_editions > 1 else ""))
    return h, note


def _qbit_drop(h):
    try:
        qbit("torrents/delete", {"hashes": h, "deleteFiles": "true"})
    except Exception as e:
        log(f"could not remove pack {h}: {e!r}")


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


def _qbit_add_file(data, extra=None):
    """Upload raw .torrent bytes (multipart/form-data).

    `extra` overrides or adds form fields -- collection harvesting needs the
    torrent to arrive paused so its file list can be pruned before any of the
    pack downloads.
    """
    boundary = "----mediabridge" + str(int(time.time() * 1000))

    def field(name, value):
        return (f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{name}"\r\n\r\n{value}\r\n').encode()

    fields = {"category": BOOK_CATEGORY, "savepath": BOOK_SAVE_CT}
    fields.update(extra or {})
    body = b"".join(field(k, v) for k, v in fields.items())
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
        results = _search_books(title, author, cats, kind)
        rel = _pick_release(results, title, formats, require)

        if not rel and kind == "audiobook":
            # Nothing named for this book -- it may still be sitting inside an
            # author omnibus. Inspecting a pack costs only its metadata fetch.
            picked = None
            for pack in _pick_collections(results, title, author)[:PACK_MAX_TRIES]:
                try:
                    ph, note = qbit_add_selective(pack, title, _wanted_ext(kind))
                except Exception as e:
                    log(f"book '{title}': pack {pack.get('title')!r} failed: {e!r}")
                    continue
                if ph:
                    picked = (ph, note, pack)
                    break
                log(f"book '{title}': pack {pack.get('title')!r} skipped -- {note}")
            if picked:
                ph, note, pack = picked
                grabbed[kind] = {"hash": ph, "release": (pack.get("title") or "")[:120],
                                 "seeders": pack.get("seeders"), "from_collection": True,
                                 "note": note}
                log(f"book '{title}': harvested {kind} from pack "
                    f"{pack.get('title')!r} -- {note}")
                continue

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


# ---------------------------------------------------------------------------
# The Kindle send ledger
#
# meta['kindle'] used to be the only record that a book had been mailed, and it
# lives inside `media_requests.detail` -- which process() rewrites from scratch
# every time a book is pushed. Push a book that is *already on the shelf* and
# shelf_copy() hands back a brand-new leg with imported=True and no 'kindle'
# key, so the next monitor tick mails it again. That is how The Odyssey and
# Armageddon Averted arrived twice and The Stench of Honolulu three times.
#
# So keep the fact outside the row: a small JSON file keyed by
# (kindle address, normalised title). It survives detail rewrites, re-pushes,
# restarts and row deletes. Scoped by address on purpose -- one shelf, two
# readers, and the second person to want a book still gets their own copy.
KINDLE_LEDGER = os.environ.get("KINDLE_LEDGER",
                               "/home/nate/media-bridge/kindle-sent.json")


def _kindle_key(to_addr, title):
    """(address, title) -> ledger key. Normalised so punctuation or case drift
    between two releases of the same book can't sneak a second copy past."""
    t = re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()
    return f"{(to_addr or '').strip().lower()}|{t}"


def _kindle_ledger():
    try:
        with open(KINDLE_LEDGER) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:                          # an unreadable ledger must
        log("kindle ledger read failed", repr(e))   # never strand a finished book
        return {}


def kindle_already_sent(to_addr, title):
    """The ledger entry for this address + title, or None."""
    return _kindle_ledger().get(_kindle_key(to_addr, title))


def _kindle_record(to_addr, title, msg):
    """Record the send. Written through a temp file and renamed, because the
    alternative failure is a truncated ledger and a fresh round of duplicates."""
    d = _kindle_ledger()
    d[_kindle_key(to_addr, title)] = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "title": title, "msg": msg,
    }
    tmp = KINDLE_LEDGER + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(d, f, sort_keys=True, indent=0)
        os.replace(tmp, KINDLE_LEDGER)
    except Exception as e:
        log("kindle ledger write failed", repr(e))


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


def _maybe_kindle(title, kind, meta, to_addr=None, force=False):
    """Email an imported ebook to the Kindle exactly once. Returns True if it acted.

    Audiobooks are served by Audiobookshelf and skipped here. The result is
    stamped onto meta['kindle'] so a book is never emailed twice, and onto the
    ledger so a *re-push* of the same book doesn't either -- the stamp lives in
    a detail blob process() rewrites, the ledger doesn't. Works for both
    torrent-imported and Libgen-direct ebooks (Libgen has no torrent hash).

    `force` (detail.force_kindle) mails it anyway: deleting a book off the
    device and asking for it again is a real thing to want.
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
    prior = None if force else kindle_already_sent(to_addr, title)
    if prior:
        # Already on this device. Stamp the card with the original send so the
        # card reads "delivered" instead of re-mailing or looking stuck.
        meta["kindle"] = prior.get("msg") or "already sent to this Kindle"
        log(f"kindle '{title}': already sent {prior.get('at')} -> skipping")
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
        if ok:
            _kindle_record(to_addr, title, m)   # before the row write, which can be lost
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
        kindle_force = bool(d.get("force_kindle"))      # deliberate re-send, ledger aside

        pcts, done_all, changed = [], True, False
        legs = {}                                       # per-leg stamp for the Cue card
        for kind, meta in books.items():
            t = tors.get(meta.get("hash"))
            if not t:                                   # no torrent: libgen direct dl, or
                pcts.append(100 if meta.get("imported") else 0)   # a completed torrent gone from qbit
                if _maybe_kindle(r["title"], kind, meta, kindle_to, kindle_force):
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
            if _maybe_kindle(r["title"], kind, meta, kindle_to, kindle_force):  # -> requester's Kindle
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
        mode = _req_mode(req)
        d = {"app": "Radarr", "arr_id": rid, "mode": mode}
        label = req.get("title") or "?"
        path = f"release?movieId={rid}"
        if rid and mode == "options":
            opts = []
            try:
                opts = build_options("radarr", RADARR, path, label, req["id"])
            except Exception as e:
                log("options search failed, falling back to auto", repr(e))
            if opts:
                d["options"] = opts
                d["choose_since"] = _now_iso()
                return "choosing", "%s -- %d copies to choose from" % (msg, len(opts)), d
            # Nothing worth choosing between: behave like auto rather than park
            # a request on a list with nothing in it.
            log("options: nothing to offer for %s, taking the auto path" % label)
            d["mode"] = mode = "auto"
            d["options_fallback"] = True
        if rid and mode == "fastest":
            picked = None
            try:
                picked = choose_fastest(RADARR, path, label)
            except Exception as e:
                log("fastest failed, falling back to Radarr search", repr(e))
            if picked is None:
                arr(RADARR, "POST", "command", {"name": "MoviesSearch", "movieIds": [rid]})
            return "added", msg, d
        if rid and mode == "watch":
            # "Wait for a good copy": no search of any kind until Radarr's own
            # availability gate flips on the digital date. If it is already
            # out (or a real copy is already on disk) there is nothing to wait
            # for, so fall through to the auto path below.
            st = watch_movie_state(rid)
            if st is not None and not st["available"] and not st["real_file"]:
                d.update(watch_detail(st))
                d["watch_since"] = _now_iso()
                if st.get("rip_held"):
                    tg("%s: a theater rip is on disk. Holding it back and waiting for "
                       "the WEB copy (%s)." % (label, st.get("release_on") or "no date yet"),
                       key="riphold:%s" % rid)
                return "watching", "%s -- waiting for release %s" % (
                    msg, st.get("release_on") or "(no digital date yet)"), d
            log("watch: %s is already available, taking the auto path" % label)
            d["mode"] = mode = "auto"
            d["watch_fallthrough"] = True
        if SPEED_FIRST and rid:
            picked = None
            try:
                picked = choose_release("radarr", RADARR, f"release?movieId={rid}",
                                        req.get("title") or "?")
            except Exception as e:
                log("speed-first failed, falling back to Radarr search", repr(e))
            if picked == "asked":
                d["asked_at"] = _now_iso()
            elif picked is None:
                # Nothing chosen: hand it back to Radarr rather than leaving the
                # request with no search running at all.
                arr(RADARR, "POST", "command", {"name": "MoviesSearch", "movieIds": [rid]})
        return "added", msg, d
    if mt == "tv":
        mode = _req_mode(req)
        if mode == "watch" and _req_season(req) is None:
            # "Follow the season" with no season picked = the latest one. Pin it
            # on the request copy so add_series narrows to that season, and on
            # the detail so the follower scores the right episodes.
            latest = _latest_season(req["title"])
            if latest is not None:
                req = dict(req, season=latest)
        msg, rid = add_series(req)
        d = {"app": "Sonarr", "arr_id": rid}
        if mode == "watch":
            d["mode"] = "watch"
            if _req_season(req) is not None:
                d["season"] = _req_season(req)
        if SPEED_FIRST and rid:
            picked = None
            try:
                picked = choose_tv(rid, _req_season(req), req.get("title") or "?")
            except Exception as e:
                log("tv speed-first failed, falling back to Sonarr search", repr(e))
            if picked == "asked":
                d["asked_at"] = _now_iso()
            elif picked is None:
                # Hand it back rather than leaving the request with no search
                # running at all. Season-scoped if we know the season.
                sn = _req_season(req)
                if sn is None:
                    arr(SONARR, "POST", "command",
                        {"name": "SeriesSearch", "seriesId": rid})
                else:
                    arr(SONARR, "POST", "command",
                        {"name": "SeasonSearch", "seriesId": rid, "seasonNumber": sn})
        if mode == "watch" and rid:
            # Aired episodes are being grabbed exactly as auto would; the
            # difference is the row stays alive for the rest of the season.
            summ = tv_watch_summary(rid, _req_season(req))
            if summ is not None and summ["complete"]:
                log("watch: %s season already complete on disk, taking the auto path" % req["title"])
                d["watch_fallthrough"] = True
                return "added", msg, d
            if summ is not None:
                d.update(summ["detail"])
                d["on_disk"] = summ["on_disk"]
            d["watch_since"] = _now_iso()
            return "watching", "%s -- following the season" % msg, d
        return "added", msg, d
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


def _is_cancelled(target, mt, arr_id):
    """Has a human called this request off?

    "Unmonitored, with no file" is the one signal every route agrees on: the
    Radarr/Sonarr UI, the OpenClaw /cancel verb, and a tap in any *arr client
    all produce it. Radarr only unmonitors a movie by itself AFTER an import,
    and then hasFile is true -- so the pair is unambiguous.

    Why this exists: on 2026-09-07 Nate told OpenClaw to stop American Hustle
    because it was too slow. Nothing in the stack could express that. The only
    stop verb was media-helper /drop, which defaults research=true, so every
    "stop" blocklisted a release and immediately grabbed another. Eight grabs,
    eight failures, then 4,518 indexer searches over 33 hours for a film he had
    already given up on. A request nobody wants any more has to be able to die.
    """
    code, obj = arr(target, "GET", f"{'movie' if mt == 'movie' else 'series'}/{arr_id}")
    if code != 200 or not isinstance(obj, dict):
        return False
    if obj.get("monitored"):
        return False
    if mt == "movie":
        return not obj.get("hasFile")
    st = obj.get("statistics") or {}
    return (st.get("episodeFileCount") or 0) == 0


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
        # Nothing queued and nothing on disk = the search found nothing it would
        # take. Give it a grace period (indexers and RSS are not instant), then
        # say so rather than leaving the row at "searching" indefinitely.
        if rec is None and new_status not in ("downloaded", "failed") \
                and _is_cancelled(target, mt, arr_id):
            # Called off. Leave the arr alone (it is already unmonitored) and
            # drop the row out of status in.(added,downloading) so the reaper,
            # the escalator and the offer machinery all stop seeing it.
            #
            # "cancelled" is a real status as of the 2026-09-08 constraint
            # widening; before that this had to write "failed", which claimed
            # the stack had lost when in fact nobody wanted the title any more.
            # Cue reads it as "Stopped" and lets the title be requested again.
            d["outcome"] = "cancelled"
            d["cancelled_at"] = _now_iso()
            code, resp = sb("PATCH", f"media_requests?id=eq.{r['id']}",
                            {"status": "cancelled", "detail": json.dumps(d)},
                            prefer="return=minimal")
            if code not in (200, 204):
                # Swallowing this is how the first cut of this branch "worked":
                # it logged a cancel, the PATCH 400'd on the check constraint,
                # the row stayed active, and the escalator kept going. A write
                # that decides whether a loop terminates must never fail quietly.
                log(f"cancel PATCH failed {code} for '{r.get('title')}': {str(resp)[:180]}")
                continue
            log(f"cancelled {mt} '{r.get('title')}': unmonitored with no file")
            tg(f"Stopped looking for {r.get('title')}.", key=f"cancelled:{arr_id}")
            continue
        if rec is None and d.get("asked_at") and _age_secs(d["asked_at"]) > ASK_GRACE:
            # He was offered a choice and did not tap. A request must never sit
            # parked on a decision -- speed is the whole point -- so take the
            # safe in-rules copy and tell him that is what happened.
            if mt == "movie":
                try:
                    code, rels = arr(target, "GET", "release?movieId=%s" % arr_id)
                    ok, _ = _speed_split(rels if isinstance(rels, list) else [])
                except Exception as e:
                    log("ask-timeout re-search failed", repr(e))
                    ok = []
                if ok and _force_grab(target, ok[0],
                                      "no tap in %dm, took the safe one" % (ASK_GRACE // 60)):
                    tg("No pick for %s, so I took the in-rules copy: %s"
                       % (r.get("title"), _describe(ok[0])), key="asktimeout:%s" % arr_id)
            else:
                # TV is only ever ASKED about when nothing passed the rules for
                # the whole season, so there is no "safe copy" waiting to be
                # taken. Hand it back to Sonarr rather than inventing one --
                # `release?seriesId=` without a seasonNumber is not a valid
                # search and would 400 every time this fired.
                season = r.get("season")
                if season is None:
                    arr(SONARR, "POST", "command", {"name": "SeriesSearch", "seriesId": arr_id})
                else:
                    arr(SONARR, "POST", "command",
                        {"name": "SeasonSearch", "seriesId": arr_id, "seasonNumber": season})
                log("no tap in %dm for %s, handed back to Sonarr"
                    % (ASK_GRACE // 60, r.get("title")))
            d.pop("asked_at", None)
            changed = True
        if rec is None and new_status not in ("downloaded", "failed"):
            since = d.get("stuck_since")
            if not since:
                d["stuck_since"] = _now_iso()
                changed = True
            elif _escalate_due(d):
                try:
                    escalate_stuck(r, mt, arr_id)
                except Exception as e:
                    log("escalate failed", r.get("title"), repr(e))
                # Stamp the ATTEMPT, not the send. escalate_stuck returns the
                # result of tg(), which goes False the moment the 24h dedupe key
                # bites -- so keying off it meant escalated_at never got set and
                # this branch re-ran on every 20s poll. Each run fires a LIVE
                # indexer search: 4,518 of them for one 2013 movie across
                # 2026-09-07/08, all for a title Nate had already given up on.
                d["escalated_at"] = _now_iso()
                d["escalate_n"] = int(d.get("escalate_n") or 0) + 1
                changed = True
        elif d.pop("stuck_since", None) is not None:
            d.pop("escalated_at", None)
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


# ---------------------------------------------------------------------------
# "watch" push mode: wait for a good copy (movie) / follow the season (TV)
#
# Both park the request on status 'watching'. Nothing here grabs anything for
# a movie: Radarr's minimumAvailability=released gate plus its RSS sync is the
# whole mechanism, and this code only watches the date, moves the row to
# 'added' when the gate flips (so monitor_downloads takes over), and stops a
# theater rip from satisfying the request. For TV, Sonarr's RSS grabs each
# episode as it airs; this counts them onto the row, pings per episode and
# closes the row after the finale.
# ---------------------------------------------------------------------------

WATCH_NO_DATE_DAYS = int(os.environ.get("WATCH_NO_DATE_DAYS", "45"))   # in cinemas this long with no digital date -> say so
WATCH_EP_GRACE = int(os.environ.get("WATCH_EP_GRACE", "21600"))       # secs an aired episode may be missing before a nudge search

# Words in a release/file name that mean "filmed off a screen or ripped from a
# cinema package", none of which Nate wants to keep. Matched as whole tokens on
# the dot/dash/space-split name, so "TS" cannot hit inside "ARTS".
_RIP_TOKENS = {"CAM", "HDCAM", "CAMRIP", "TS", "HDTS", "TELESYNC", "TC", "HDTC",
               "TELECINE", "DCPRIP", "DCP", "SCR", "SCREENER", "DVDSCR", "WORKPRINT", "WP"}


def _theater_rip(name):
    """True if a release or file name says it came from a cinema, not a stream."""
    if not name:
        return False
    toks = re.split(r"[.\-_ \[\]()]+", str(name).upper())
    return any(t in _RIP_TOKENS for t in toks)


def _movie_release_on(movie):
    """The earliest of Radarr's digital/physical dates as YYYY-MM-DD, or None."""
    days = []
    for k in ("digitalRelease", "physicalRelease"):
        v = movie.get(k)
        if isinstance(v, str) and len(v) >= 10:
            days.append(v[:10])
    return min(days) if days else None


def _days_since(iso_day):
    if not iso_day:
        return None
    try:
        d = datetime.fromisoformat(str(iso_day)[:10]).replace(tzinfo=timezone.utc)
    except Exception:
        return None
    return (datetime.now(timezone.utc) - d).days


def watch_movie_state(arr_id):
    """One read of Radarr for a watched movie: dates, availability, what is on disk.

    Returns None when Radarr cannot be read. `real_file` means a copy that is
    not a theater rip is on disk. A theater rip that Radarr scored at or above
    the WEB cutoff is relabelled TELECINE here (`rip_held`), because otherwise
    Radarr believes the cutoff is met and never replaces it -- that is exactly
    what happened with Coyote vs. Acme on 2026-09-20.
    """
    code, m = arr(RADARR, "GET", f"movie/{arr_id}")
    if code != 200 or not isinstance(m, dict):
        return None
    st = {"arr_id": arr_id, "title": m.get("title"), "monitored": bool(m.get("monitored")),
          "available": bool(m.get("isAvailable")), "has_file": bool(m.get("hasFile")),
          "release_on": _movie_release_on(m), "in_cinemas": (m.get("inCinemas") or "")[:10] or None,
          "real_file": False, "rip_held": False}
    if not st["has_file"]:
        return st
    code, files = arr(RADARR, "GET", f"moviefile?movieId={arr_id}")
    if code != 200 or not isinstance(files, list) or not files:
        return st
    f = files[0]
    name = " ".join(str(f.get(k) or "") for k in ("sceneName", "originalFilePath", "relativePath"))
    q = ((f.get("quality") or {}).get("quality") or {})
    if _theater_rip(name) or (q.get("source") in ("cam", "telesync", "telecine", "workprint")):
        st["rip_held"] = True
        if q.get("source") not in ("cam", "telesync", "telecine", "workprint"):
            f["quality"]["quality"] = {"id": 27, "name": "TELECINE", "source": "telecine",
                                       "resolution": q.get("resolution") or 1080, "modifier": "none"}
            c2, resp = arr(RADARR, "PUT", f"moviefile/{f['id']}", f)
            log("watch: relabelled theater rip on '%s' as TELECINE -> %s" % (st["title"], c2))
        return st
    st["real_file"] = True
    return st


def watch_detail(st):
    """The keys Cue's tray reads off a watching movie row."""
    d = {"release_on": st.get("release_on")}
    if st.get("rip_held"):
        d["rip_held"] = True
    return d


def _latest_season(title):
    """Highest real season number Sonarr knows for a show, or None."""
    for term in _lookup_terms(title):
        code, res = arr(SONARR, "GET", "series/lookup?term=" + urllib.parse.quote(term))
        if code != 200:
            continue
        s = best_match(res, title, None)
        if s:
            nums = [x.get("seasonNumber") for x in (s.get("seasons") or []) if (x.get("seasonNumber") or 0) > 0]
            return max(nums) if nums else None
    return None


def _tv_watch_plan(eps, season, now=None):
    """Pure: from Sonarr's episode list, what a followed season looks like.

    Counts every monitored episode of the season, aired or not, so the tray can
    say 3/10. `next_ep`/`next_air` is the first unaired one. `complete` is every
    monitored episode on disk with none left to air. `missing` are aired ones
    with no file (RSS missed them, or they aired before the push).
    """
    now = now or datetime.now(timezone.utc)
    on_disk, missing, unaired = [], [], []
    for e in eps:
        if season is not None and e.get("seasonNumber") != int(season):
            continue
        if not e.get("monitored") or (e.get("seasonNumber") or 0) == 0:
            continue
        n = e.get("episodeNumber")
        air = e.get("airDateUtc")
        aired = True
        if air:
            try:
                aired = datetime.fromisoformat(air.replace("Z", "+00:00")) <= now
            except Exception:
                aired = True
        if e.get("hasFile"):
            on_disk.append(n)
        elif aired:
            missing.append((n, e.get("id")))
        else:
            unaired.append((air or "9999", n, e.get("id")))
    unaired.sort()
    total = len(on_disk) + len(missing) + len(unaired)
    sn = int(season) if season is not None else None
    tag = (lambda n: "S%02dE%02d" % (sn, n)) if sn is not None else (lambda n: "E%02d" % n)
    detail = {"episodes": "%d/%d" % (len(on_disk), total),
              "pct": round(len(on_disk) / total * 100, 1) if total else 0}
    if unaired:
        detail["next_ep"] = tag(unaired[0][1])
        detail["next_air"] = str(unaired[0][0])[:10]
    else:
        detail["next_ep"] = None
        detail["next_air"] = None
    return {"on_disk": sorted(on_disk), "missing": missing, "unaired": unaired,
            "total": total, "detail": detail, "tag": tag,
            "complete": bool(total) and not missing and not unaired}


def tv_watch_summary(series_id, season):
    code, eps = arr(SONARR, "GET", f"episode?seriesId={series_id}")
    if code != 200 or not isinstance(eps, list):
        return None
    return _tv_watch_plan(eps, season)


def monitor_watching():
    """Walk the 'watching' rows: flip a movie when its date arrives, count a
    followed season onto its row, close either when it is really done."""
    code, rows = sb("GET",
                    "media_requests?status=eq.watching&media_type=in.(movie,tv)"
                    "&select=id,title,media_type,status,detail,tmdb_id,year,rec_id,season&limit=100")
    if code != 200 or not rows:
        return
    qidx = None
    for r in rows:
        d = _detail_dict(r)
        mt = r["media_type"]
        target = RADARR if mt == "movie" else SONARR
        arr_id = d.get("arr_id")
        changed = False
        if arr_id is None:
            arr_id = (_radarr_id(r.get("tmdb_id"), r.get("title"), r.get("year")) if mt == "movie"
                      else _sonarr_id(r.get("title")))
            if arr_id is None:
                continue
            d["arr_id"] = arr_id
            changed = True
        new_status = "watching"
        leg = {"state": "searching"}
        try:
            if _is_cancelled(target, mt, arr_id):
                d["outcome"] = "cancelled"
                d["cancelled_at"] = _now_iso()
                code, resp = sb("PATCH", f"media_requests?id=eq.{r['id']}",
                                {"status": "cancelled", "detail": json.dumps(d)}, prefer="return=minimal")
                if code in (200, 204):
                    log(f"cancelled watched {mt} '{r.get('title')}'")
                    tg(f"Stopped watching for {r.get('title')}.", key=f"cancelled:{arr_id}")
                else:
                    log(f"cancel PATCH failed {code} for '{r.get('title')}': {str(resp)[:180]}")
                continue
            if mt == "movie":
                st = watch_movie_state(arr_id)
                if st is None:
                    continue
                for k, v in watch_detail(st).items():
                    if d.get(k) != v:
                        d[k] = v
                        changed = True
                if not st["rip_held"]:
                    d.pop("rip_held", None)
                if st["real_file"]:
                    new_status = "downloaded"
                    d["pct"] = 100
                    leg = {"state": "downloaded"}
                elif st["available"]:
                    # The gate flipped. Hand the row to the normal pipeline;
                    # Radarr's RSS is already on it, and one explicit search
                    # closes the gap between RSS runs.
                    new_status = "added"
                    d["watch_released"] = _now_iso()
                    d.pop("stuck_since", None)
                    arr(RADARR, "POST", "command", {"name": "MoviesSearch", "movieIds": [arr_id]})
                    tg("%s is out digitally. Grabbing the WEB copy now." % r.get("title"),
                       key="released:%s" % arr_id)
                elif not st["release_on"]:
                    since = _days_since(st.get("in_cinemas"))
                    if since is not None and since >= WATCH_NO_DATE_DAYS and not d.get("no_date_told"):
                        tg("%s has been in cinemas %d days and TMDB still lists no digital date. "
                           "Still watching by RSS; worth a look at TMDB." % (r.get("title"), since),
                           key="nodate:%s" % arr_id)
                        d["no_date_told"] = _now_iso()
                        changed = True
                if st["rip_held"] and d.get("rip_told") is None:
                    tg("%s: a theater rip landed. Holding it back and waiting for the WEB copy (%s)."
                       % (r.get("title"), st.get("release_on") or "no date yet"), key="riphold:%s" % arr_id)
                    d["rip_told"] = _now_iso()
                    changed = True
            else:
                season = r.get("season") if r.get("season") is not None else d.get("season")
                plan = tv_watch_summary(arr_id, season)
                if plan is None:
                    continue
                for k, v in plan["detail"].items():
                    if d.get(k) != v:
                        d[k] = v
                        changed = True
                before = set(d.get("on_disk") or [])
                landed = [n for n in plan["on_disk"] if n not in before]
                if landed:
                    d["on_disk"] = plan["on_disk"]
                    changed = True
                    if before:      # the push tick seeds on_disk; only later arrivals get a ping
                        for n in landed:
                            tg("%s %s is ready." % (r.get("title"), plan["tag"](n)),
                               key="ep:%s:%s" % (r["id"], n))
                # what is in flight right now, so the tray can say "grabbing E3"
                if qidx is None:
                    qidx = _queue_index(SONARR, "seriesId")
                rec = qidx.get(arr_id)
                grabbing = None
                if rec is not None:
                    ep = (rec.get("episode") or {})
                    if ep.get("episodeNumber") is not None:
                        grabbing = plan["tag"](ep["episodeNumber"])
                    else:
                        grabbing = "an episode"
                if d.get("grabbing") != grabbing:
                    d["grabbing"] = grabbing
                    changed = True
                # An aired episode with no file and nothing in flight: RSS
                # missed it (or it aired before the push and the season search
                # lost it). One nudge per episode per grace period.
                if rec is None and plan["missing"]:
                    searched = d.get("searched") or {}
                    for n, eid in plan["missing"]:
                        last = searched.get(str(n))
                        if eid and (not last or _age_secs(last) > WATCH_EP_GRACE):
                            arr(SONARR, "POST", "command", {"name": "EpisodeSearch", "episodeIds": [eid]})
                            searched[str(n)] = _now_iso()
                            changed = True
                    d["searched"] = searched
                if plan["complete"]:
                    new_status = "downloaded"
                    d["pct"] = 100
                    leg = {"state": "downloaded"}
                elif rec is not None:
                    leg = {"state": "downloading", "pct": d.get("pct")}
        except Exception as e:
            log("watch tick failed for '%s': %r" % (r.get("title"), e))
            continue
        if changed or new_status != r["status"]:
            sb("PATCH", f"media_requests?id=eq.{r['id']}",
               {"status": new_status, "detail": json.dumps(d)}, prefer="return=minimal")
            log(f"watch {mt} '{r['title']}' -> {new_status} {d.get('release_on') or d.get('episodes') or ''}")
            if new_status == "downloaded":
                where = f" season {season}" if mt == "tv" and season is not None else ""
                tg(f"Ready to watch: {r['title']}{where}" + (" (whole season on disk)" if mt == "tv" else ""),
                   key=f"done:{r['id']}")
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
    ports; a swarm reporting zero seeders will never start.

    But num_complete is only MEANINGFUL once the torrent has announced to a
    tracker, and that has not happened in two of these three states:

      queuedDL  qBittorrent has not started it at all (queueing is on,
                max_active_downloads=6). No announce, so num_complete is 0
                because nothing was ever asked. Reaping here punishes a torrent
                for waiting its turn -- and the wait is usually caused by dead
                torrents holding the slots, so reaping the QUEUED one is exactly
                backwards.
      metaDL    magnet with no metadata yet, so no tracker list to announce to.
                Same false zero. It gets META_GRACE and is judged on nothing
                else.
      stalledDL running, announced, and the tracker says nobody has the file.
                Here a zero is real.

    2026-09-08: 67 of the last 81 reaps were "queuedDL with an empty swarm" and
    8 more were metaDL. 75 of 81 drops rested on a number that cannot mean what
    the old code read it to mean. That is the "it stalls and drops downloads all
    the time" complaint, and Gone Baby Gone's first grab died this way at 5m48s.
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
    if progress > 0:
        return None, 0                       # it is moving; never our business
    if state == "queuedDL":
        return None, 0                       # not started -> nothing to judge
    if state == "metaDL":
        return "metadata never arrived", META_GRACE
    if state == "stalledDL" and swarm == 0:
        return "stalled with an empty swarm", DEAD_GRACE
    return None, 0


def _pick_replacement(rels):
    """Choose the healthiest replacement release. Returns (release, waived) or (None, False).

    Approved releases win, ranked by seeders -- every quality, size and codec
    rule still applies and nothing is waived.

    If NOTHING is approved we fall back to releases that only trip a soft rule
    (size floor/ceiling, quality tier outside the profile), the same test the
    Telegram offer uses. Without this fallback the reaper would blocklist a
    stalled download, find no approved replacement, and go quiet -- stranding
    the episode with its one usable release burned. That is exactly what
    happened to Better Call Saul S01E03 and S01E07, three times each: their only
    good option was a 1080p x265 encode sitting under the min-size floor, so
    there was never an approved release to fall back to.

    A blocklisted release can never be picked: "Release is blocklisted" is not a
    soft rejection, so `_offerable` rejects it and we cannot re-grab the corpse
    we just reaped.
    """
    ok = [x for x in rels
          if x.get("approved") and x.get("guid") and x.get("indexerId") is not None]
    waived = False
    if not ok:
        ok = [x for x in rels if _offerable(x)]
        waived = bool(ok)
    if not ok:
        return None, False
    # Rank by seeders-per-GB, not raw seeders: a 40-seeder 26 GB remux is a
    # worse replacement than a 6-seeder 5 GB WEB-DL, and picking the corpse's
    # successor on raw count is how a "healthy" replacement still takes a day.
    best = max(ok, key=_speed_key)
    if (best.get("seeders") or 0) <= 0:
        return None, False
    return best, waived


def _grab_best_seeded(app_name, target, rec):
    """Pick the replacement download by SEEDERS instead of letting the app choose.

    Sonarr/Radarr treat seeders as a minimum threshold only - their ranking is
    quality tier -> custom format score -> indexer priority - so a plain
    re-search can hand back another dead release. Here we choose the healthiest
    release ourselves (see _pick_replacement) and grab it via the manual-grab
    endpoint.

    Returns a short description of what it grabbed, or None to fall back to the
    normal re-search.
    """
    if app_name == "radarr":
        ident = rec.get("movieId")
        path = "release?movieId=%s" % ident if ident else None
    else:
        ident = rec.get("episodeId")
        path = "release?episodeId=%s" % ident if ident else None
    if not path:
        return None
    code, rels = arr(target, "GET", path)
    if code != 200 or not isinstance(rels, list):
        return None
    best, waived = _pick_replacement(rels)
    if best is None:
        return None
    code, _ = arr(target, "POST", "release",
                  {"guid": best["guid"], "indexerId": best["indexerId"]})
    if code not in (200, 201, 202):
        return None
    why = ""
    if waived:
        # Say so out loud: this grab deliberately broke a rule Nate set.
        why = " -- waived: %s" % "; ".join(best.get("rejections") or [])[:70]
    return "%s (%s seeders)%s" % ((best.get("title") or "?")[:40],
                                  best.get("seeders"), why)


# ---------------------------------------------------------------------------
# Speed-first selection
#
# Radarr and Sonarr rank quality tier -> custom-format score -> indexer
# priority. Seeders are a MINIMUM only, never a sort key, and no setting
# changes that: it has been an open feature request for years (Radarr #7667,
# #9928). So the app cannot be configured into picking the way Nate picks.
#
# Nate picks the way a person actually picks: the most seeders for the least
# size, because that is what predicts "on the TV tonight". So the bridge does
# the choosing, and the app is demoted to what it is genuinely good at --
# matching, renaming, hardlinking and telling Jellyfin.
#
# The app's size floor (1080p min lowered 15 -> 8 MB/min on 2026-09-08) stops
# being a ban and becomes the ASK-ME LINE:
#     above it -> approved -> grab the fastest, silently
#     below it -> soft-rejected -> offer it, Nate taps to accept the tradeoff
# The default therefore never lands him with a mushy file, but the fast option
# is one tap away instead of invisible. Before this, a 75-seeder 1.6 GB copy of
# Gone Baby Gone was rejected outright while a 4-seeder 5.5 GB copy crawled at a
# 22-hour ETA; the rejected one later imported in 21 minutes.
# ---------------------------------------------------------------------------

SPEED_FIRST = os.environ.get("SPEED_FIRST", "1") not in ("0", "false", "no")
ASK_MULTIPLE = float(os.environ.get("ASK_MULTIPLE", "1.5"))   # how much faster the
                                                              # below-floor option must
                                                              # be before interrupting
ASK_GRACE = int(os.environ.get("ASK_GRACE", "1200"))          # secs to wait for a tap
                                                              # before taking the safe one

# The Cue push popup (2026-09-17) lets Nate say per push how the file gets
# picked: auto (the speed-first flow above), fastest (rules waived, no asking)
# or options (list the best few, grab nothing until he taps one in Cue or on
# Telegram). The mode rides in the JSON Cue packs into `detail` on insert.
CHOOSE_GRACE = int(os.environ.get("CHOOSE_GRACE", "86400"))   # secs an "options" row may wait for a pick
MAX_CHOICES  = int(os.environ.get("MAX_CHOICES", "6"))        # rows in the options list

PUSH_MODES = ("auto", "fastest", "options", "watch")


def _req_mode(req):
    """auto | fastest | options | watch. Anything unparseable or unknown is auto."""
    try:
        d = json.loads(req.get("detail") or "{}")
    except Exception:
        return "auto"
    m = d.get("mode") if isinstance(d, dict) else None
    return m if m in PUSH_MODES else "auto"


def _per_gb(rel):
    """Seeders per gigabyte -- the number Nate judges on.

    30 seeders on a 26 GB remux is a worse bet than 6 on a 5 GB WEB-DL, and raw
    seeder count hides that. Indexer counts are also inflated (Gone Baby Gone
    advertised 75 seeders; the real swarm was 15), so this is for RANKING only.
    Never present the absolute number as truth.
    """
    gb = (rel.get("size") or 0) / 1e9
    return ((rel.get("seeders") or 0) / gb) if gb > 0 else 0.0


def _speed_key(rel):
    """Sort key: seeders per GB, then raw seeders.

    The tiebreak is not cosmetic. Some indexers return releases with no `size`,
    and `_per_gb` is 0 for all of those -- without a second term the "fastest"
    pick among them collapses to whichever happened to be first in the list.
    Falling back to seeders means an unsized release is still ranked sanely.
    """
    return (_per_gb(rel), rel.get("seeders") or 0)


def _norm_title(t):
    """Collapse a release title for duplicate detection across indexers."""
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def _grabbable(rel):
    return bool(rel.get("guid")) and rel.get("indexerId") is not None


def _speed_split(rels):
    """(approved fastest-first, below-the-line fastest-first)."""
    ok = sorted([r for r in rels if r.get("approved") and _grabbable(r)],
                key=_speed_key, reverse=True)
    below = sorted([r for r in rels if not r.get("approved") and _offerable(r)],
                   key=_speed_key, reverse=True)
    return ok, below


def _uploaded(rel):
    """The day the release was first posted (Radarr/Sonarr `publishDate`), as
    YYYY-MM-DD, or '' when the indexer did not say. Nate reads this to tell a
    fresh rip from a decade-old swarm; the seeder count alone hides that."""
    p = rel.get("publishDate") or ""
    return p[:10] if len(p) >= 10 else ""


def _describe(rel):
    s = "%.1f GB, %s seeders, %.0f seed/GB" % (
        (rel.get("size") or 0) / 1e9, rel.get("seeders") or 0, _per_gb(rel))
    up = _uploaded(rel)
    return s + (", up %s" % up if up else "")


def _force_grab(target, rel, why):
    """Grab one exact release through the manual endpoint, bypassing ranking."""
    code, _ = arr(target, "POST", "release",
                  {"guid": rel["guid"], "indexerId": rel["indexerId"]})
    if code not in (200, 201, 202):
        log("speed-first grab failed %s: %s" % (code, (rel.get("title") or "?")[:55]))
        return False
    log("speed-first %s: %s (%s)" % (why, (rel.get("title") or "?")[:50], _describe(rel)))
    return True


def choose_release(app_name, target, path, label):
    """Grab the fastest acceptable release, or ask when speed costs quality.

    Returns "grabbed", "asked", or None. None means "fall back to the app's own
    search" -- that fallback must always stay, because a bug in here must never
    mean nothing gets downloaded at all.
    """
    code, rels = arr(target, "GET", path)
    if code != 200 or not isinstance(rels, list) or not rels:
        return None
    ok, below = _speed_split(rels)
    best = ok[0] if ok else None
    fast = below[0] if below else None

    # Only interrupt him when the tradeoff is REAL: the below-the-line option
    # has to be meaningfully faster, not faster by a rounding error.
    worth_asking = fast is not None and (
        best is None or _per_gb(fast) > _per_gb(best) * ASK_MULTIPLE)

    if best is not None and not worth_asking:
        return "grabbed" if _force_grab(target, best, "grabbed for %s" % label) else None
    if worth_asking:
        return "asked" if _ask_which(app_name, target, path, label, best, below) else None
    return None


def _ask_which(app_name, target, path, label, best, below):
    """Push the real choice to Telegram as tap-to-grab buttons.

    `best` (if any) is listed first so "just take the good one" is always
    available; the rest are the faster copies that sit under the size floor.
    """
    cands = ([best] if best is not None else [])
    # The same release comes back from several indexers. Offering it twice
    # burns a button on a choice that is not a choice -- the dry run on
    # Untold S06 offered the identical 720p file as options 1 and 2.
    seen = {_norm_title(r.get("title")) for r in cands}
    for r in below:
        if r is best:
            continue
        k = _norm_title(r.get("title"))
        if k in seen:
            continue
        seen.add(k)
        cands.append(r)
        if len(cands) >= MAX_OFFERS:
            break
    lines = ["%s: the fastest copy costs some quality." % label, ""]
    buttons = []
    for i, r in enumerate(cands, 1):
        # Say the REAL reason. A hardcoded "under the size floor" was wrong for
        # every release rejected for being too LARGE or out of profile, which is
        # most of them -- it told Nate the opposite of the truth.
        tag = ("within your rules" if r is best
               else "; ".join(str(x) for x in (r.get("rejections") or []))[:70]
               or "outside your rules")
        lines.append("%d. %s" % (i, (r.get("title") or "?")[:62]))
        lines.append("   %s  -- %s" % (_describe(r), tag))
        lbl, url = _offer(app_name, r, path)
        buttons.append(("%d. %s" % (i, lbl), url))
    if best is not None:
        lines += ["", "No tap within %d min and I take #1." % (ASK_GRACE // 60)]
    else:
        lines += ["", "Nothing here passes your rules, so nothing downloads until you tap."]
    _offers_save()
    log("asked which release for %s: %d options" % (label, len(cands)))
    return tg("\n".join(lines), key="choose:%s:%s" % (app_name, label),
              buttons=buttons, repeat=ESCALATE_REPEAT)


def choose_fastest(target, path, label):
    """Cue's "Fastest": the most seeders per GB, soft rules waived, nobody asked.

    The line between waivable and wrong is still `_offerable`: a release that is
    the wrong movie, blocklisted, Cyrillic, under 720p or in a thin swarm never
    qualifies however fast it looks. Returns "grabbed" or None (= fall back to
    Radarr's own search).
    """
    code, rels = arr(target, "GET", path)
    if code != 200 or not isinstance(rels, list) or not rels:
        return None
    ok, below = _speed_split(rels)
    cands = sorted(ok + below, key=_speed_key, reverse=True)
    if not cands:
        return None
    best = cands[0]
    why = "fastest for %s" % label
    if not best.get("approved"):
        why += " -- waived: %s" % "; ".join(str(x) for x in (best.get("rejections") or []))[:70]
    return "grabbed" if _force_grab(target, best, why) else None


def _option_dict(tok, rel, app_name, search_path):
    """What Cue renders for one candidate, plus enough to grab it on its own
    if offers.json ever loses the token."""
    q = ((rel.get("quality") or {}).get("quality") or {}).get("name")
    return {"tok": tok, "title": (rel.get("title") or "?")[:120],
            "gb": round((rel.get("size") or 0) / 1e9, 2),
            "seeders": rel.get("seeders") or 0,
            "per_gb": round(_per_gb(rel), 1),
            "uploaded": _uploaded(rel),
            "quality": q, "indexer": rel.get("indexer"),
            "ok": bool(rel.get("approved")),
            "why": "" if rel.get("approved")
                   else ("; ".join(str(x) for x in (rel.get("rejections") or []))[:90]
                         or "outside your rules"),
            "guid": rel.get("guid"), "indexerId": rel.get("indexerId"),
            "app": app_name, "search": search_path}


def pick_options(rels):
    """The candidates worth listing: in-rules copies first (fastest-first), then
    the fastest copies that only trip a soft rule, deduped across indexers,
    capped at MAX_CHOICES. Pure, so test_offer.py can pin it."""
    ok, below = _speed_split(rels)
    cands, seen = [], set()
    for r in ok + below:
        k = _norm_title(r.get("title"))
        if k in seen:
            continue
        seen.add(k)
        cands.append(r)
        if len(cands) >= MAX_CHOICES:
            break
    return cands


def build_options(app_name, target, path, label, req_id):
    """Cue's "Show me options": list the best few, grab nothing.

    Every entry gets an offer token so the same list is tappable from Cue
    (writes `choice`) and from a Telegram button (hits the grab server); both
    paths end in _settle_choice. Returns the option dicts written onto the
    row, [] if there was nothing to choose between.
    """
    code, rels = arr(target, "GET", path)
    if code != 200 or not isinstance(rels, list) or not rels:
        return []
    cands = pick_options(rels)
    if not cands:
        return []
    opts, buttons = [], []
    lines = ["%s: pick a copy." % label, ""]
    for i, r in enumerate(cands, 1):
        tok = _offer_token(app_name, r, path, req_id=req_id)
        opts.append(_option_dict(tok, r, app_name, path))
        tag = ("within your rules" if r.get("approved")
               else "; ".join(str(x) for x in (r.get("rejections") or []))[:70]
               or "outside your rules")
        lines.append("%d. %s" % (i, (r.get("title") or "?")[:62]))
        lines.append("   %s  -- %s" % (_describe(r), tag))
        buttons.append(("%d. %s" % (i, _offer_label(r)), _offer_url(tok)))
    lines += ["", "Tap one here or in Cue. Nothing downloads until you do; after %dh "
                  "I take the fastest in-rules copy." % (CHOOSE_GRACE // 3600)]
    _offers_save()
    log("options for %s: %d candidates" % (label, len(opts)))
    tg("\n".join(lines), key="options:%s:%s" % (app_name, req_id),
       buttons=buttons, repeat=ESCALATE_REPEAT)
    return opts


# --- TV -------------------------------------------------------------------
#
# Movies are one list and one grab. TV is not: a season search returns season
# PACKS and individual episodes mixed together, and the request may be one
# season or a whole run.
#
# The saving grace is that Sonarr tags every release with `fullSeason` and
# `mappedEpisodeNumbers`, so ONE season search covers every episode in it. Doing
# this per episode would fire an indexer search per episode, which is how the
# 4,518-search runaway started.


def _wanted_episodes(series_id, season=None):
    """(season, episode, id) for monitored, aired, file-less episodes."""
    code, eps = arr(SONARR, "GET", "episode?seriesId=%s" % series_id)
    if code != 200 or not isinstance(eps, list):
        return []
    now = datetime.now(timezone.utc)
    out = []
    for e in eps:
        if not e.get("monitored") or e.get("hasFile"):
            continue
        sn = e.get("seasonNumber") or 0
        if sn < 1 or (season is not None and sn != int(season)):
            continue
        air = e.get("airDateUtc")
        if not air:
            continue                       # never aired: nothing to look for
        try:
            if datetime.fromisoformat(air.replace("Z", "+00:00")) > now:
                continue                   # future episode, not missing yet
        except Exception:
            pass
        out.append((sn, e.get("episodeNumber"), e.get("id")))
    return sorted(out)


def _season_plan(rels, wanted_nums):
    """(best full-season pack, {episode number -> fastest single release}).

    Multi-episode files are skipped: they are neither a clean per-episode pick
    nor a full season, and treating one as either double-grabs episodes.
    """
    packs = sorted([r for r in rels if r.get("fullSeason")
                    and r.get("approved") and _grabbable(r)],
                   key=_speed_key, reverse=True)
    singles = {}
    for r in rels:
        if r.get("fullSeason") or not r.get("approved") or not _grabbable(r):
            continue
        nums = r.get("mappedEpisodeNumbers") or r.get("episodeNumbers") or []
        if len(nums) != 1 or nums[0] not in wanted_nums:
            continue
        cur = singles.get(nums[0])
        if cur is None or _speed_key(r) > _speed_key(cur):
            singles[nums[0]] = r
    return (packs[0] if packs else None), singles


def _choose_one_season(series_id, season, wanted, label):
    """Grab a whole season the fastest way available. Returns "grabbed"/"asked"/None."""
    nums = {n for _, n, _ in wanted}
    code, rels = arr(SONARR, "GET",
                     "release?seriesId=%s&seasonNumber=%s" % (series_id, season))
    if code != 200 or not isinstance(rels, list) or not rels:
        return None
    pack, singles = _season_plan(rels, nums)

    # A season is only finished when its SLOWEST episode is, so a per-episode
    # plan is judged on its worst link rather than its average.
    plan_speed = min((_per_gb(r) for r in singles.values()), default=0.0)
    complete = bool(singles) and set(singles) >= nums

    if complete and (pack is None or _per_gb(pack) <= plan_speed * ASK_MULTIPLE):
        # Individual episodes also mean E01 starts now instead of after the
        # whole pack lands, which is the thing Nate is actually optimising for.
        got = sum(1 for n in sorted(singles)
                  if _force_grab(SONARR, singles[n],
                                 "grabbed %s S%02dE%02d" % (label, season, n)))
        return "grabbed" if got else None
    if pack is not None:
        return "grabbed" if _force_grab(
            SONARR, pack, "grabbed %s S%02d season pack" % (label, season)) else None
    if singles:
        got = sum(1 for n in sorted(singles)
                  if _force_grab(SONARR, singles[n],
                                 "grabbed %s S%02dE%02d" % (label, season, n)))
        if got:
            missing = sorted(nums - set(singles))
            log("%s S%02d: %d episode(s) with no in-rules release: %s"
                % (label, season, len(missing), missing))
            return "grabbed"
        return None

    # Nothing passes the rules for this season at all. Offer the fastest
    # below-the-line options once, rather than per episode.
    below = sorted([r for r in rels if not r.get("approved") and _offerable(r)],
                   key=_speed_key, reverse=True)
    if below:
        return "asked" if _ask_which("sonarr", SONARR,
                                     "release?seriesId=%s&seasonNumber=%s" % (series_id, season),
                                     "%s S%02d" % (label, season), None, below) else None
    return None


def choose_tv(series_id, season, label):
    """Speed-first selection for a season, or for every season of a whole-show push."""
    wanted = _wanted_episodes(series_id, season)
    if not wanted:
        return None
    seasons = {}
    for sn, n, eid in wanted:
        seasons.setdefault(sn, []).append((sn, n, eid))
    results = []
    for sn in sorted(seasons):
        try:
            results.append(_choose_one_season(series_id, sn, seasons[sn], label))
        except Exception as e:
            log("tv speed-first failed on S%02d" % sn, repr(e))
            results.append(None)
    if "grabbed" in results:
        return "grabbed"
    if "asked" in results:
        return "asked"
    return None


# --- let episode 1 land first ----------------------------------------------
#
# Grabbing a season starts every episode at once, so N episodes share one line
# and all finish at roughly the same late moment. Nate cannot start watching
# until nearly the whole season is done, which defeats the point of optimising
# for speed at all. Holding the later ones back lets the earliest episode land
# in a fraction of the time, and the rest follow behind it.
#
# LANDMINE: qBittorrent 5.x RENAMED pause/resume to stop/start.
# `torrents/pause` 404s on 5.2.2 (webapi 2.15.1) -- silently, if you do not
# check the code. A stopped torrent reports state `stoppedDL`, which `_is_dead`
# does not consider, so the reaper cannot mistake a deliberately held episode
# for a corpse.

FIRST_EP_FIRST = os.environ.get("FIRST_EP_FIRST", "1") not in ("0", "false", "no")
FIRST_EP_MAX = int(os.environ.get("FIRST_EP_MAX", "5400"))   # never hold one back longer

_held = {}          # torrent hash -> when we stopped it


def prioritise_first_episodes():
    """Run the earliest incomplete episode of a season alone; release the rest after.

    Idempotent and re-evaluated every poll: it only ever stops torrents that are
    behind the current leader, and always starts them again once the leader is
    done, is gone, or has been holding things up for FIRST_EP_MAX.
    """
    if not FIRST_EP_FIRST:
        return
    code, q = arr(SONARR, "GET", "queue?pageSize=200&includeEpisode=true")
    if code != 200 or not isinstance(q, dict):
        return
    try:
        tor = _qbit_by_hash()
    except Exception as e:
        log("qbit info error (first-episode)", repr(e))
        return
    now = time.time()
    groups = {}
    for r in q.get("records", []):
        ep = r.get("episode") or {}
        n = ep.get("episodeNumber")
        h = (r.get("downloadId") or "").lower()
        if n is None or h not in tor:
            continue
        groups.setdefault((r.get("seriesId"), ep.get("seasonNumber")), []).append((n, h))

    for (sid, season), items in groups.items():
        if len(items) < 2:
            continue                       # a season pack, or a single episode
        items.sort()
        leader = next(((n, h) for n, h in items if (tor[h].get("progress") or 0) < 1), None)
        held = [h for _, h in items if h in _held]

        # Let everything go when the leader has landed, or when we have been
        # holding the rest long enough that the wait is worse than the wait.
        if leader is None or any(now - _held.get(h, now) > FIRST_EP_MAX for h in held):
            if held:
                qbit("torrents/start", {"hashes": "|".join(held)})
                for h in held:
                    _held.pop(h, None)
                log("first-episode hold released on series %s S%s (%d torrents)"
                    % (sid, season, len(held)))
            continue

        leader_n, leader_h = leader
        # The new leader is usually one WE stopped: when E01 finishes, E02 is
        # promoted while still held. Without starting it here the season
        # deadlocks until FIRST_EP_MAX and nothing downloads at all.
        if leader_h in _held or (tor[leader_h].get("state") or "").startswith("stopped"):
            qbit("torrents/start", {"hashes": leader_h})
            _held.pop(leader_h, None)
            log("first-episode: S%02dE%02d promoted, starting it" % (season or 0, leader_n))
        stop = [h for n, h in items
                if h != leader_h
                and (tor[h].get("progress") or 0) < 1
                and not (tor[h].get("state") or "").startswith("stopped")]
        if stop:
            qbit("torrents/stop", {"hashes": "|".join(stop)})
            for h in stop:
                _held[h] = now
            qbit("torrents/topPrio", {"hashes": leader_h})
            log("holding %d later episode(s) so S%02dE%02d lands first"
                % (len(stop), season or 0, leader_n))


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
            arr(target, "DELETE",
                f"queue/{rid}?removeFromClient=true&blocklist=true"
                f"&skipRedownload=true")   # we pick the replacement ourselves
            wanted_id = r.get(id_field)
            picked = _grab_best_seeded(app_name, target, r)
            if not picked and wanted_id:
                arr(target, "POST", "command", {"name": search_cmd, f"{id_field}s": [wanted_id]})
            how = f"seeder-first grab: {picked}" if picked else "re-searched"
            log(f"reaped {app_name} ({reason}): {(r.get('title') or '?')[:40]} -> blocklisted + {how}")
            title = (r.get("title") or "?")[:70]
            if picked:
                tg(f"Dropped a dead download: {title}\nWhy: {reason}\n"
                   f"Replacement: {picked}.", key=f"reap:{title}")
            else:
                # Nothing left to try. This is the case that used to pass in
                # silence and strand an episode, so it gets its own alert with a
                # short repeat window rather than sharing the routine reap key.
                tg(f"Stuck: {title}\nDropped it ({reason}) and there is no usable "
                   f"replacement on any indexer -- not even one worth waiving a rule "
                   f"for. Re-searched anyway, but this one probably needs a look.",
                   key=f"stranded:{title}", repeat=3600)
            _stall.pop(key, None)
            stalled_now.discard(key)
    for key in list(_stall):                         # forget items no longer stalled
        if key[0] == app_name and key not in stalled_now:
            _stall.pop(key, None)


# ---------------------------------------------------------------------------
# "one rule away": offer a rule-rejected release over Telegram, grab it on a tap
#
# Radarr/Sonarr reject releases on hard rules -- size floor/ceiling, quality
# tier not in the profile. Usually right. But sometimes the only thing the
# indexers hold for a title trips one of those rules, and then the request just
# sits at "searching" forever with nothing to show for it. Nate wants to be
# ASKED in that case rather than left waiting.
#
# The bot token is long-polled by OpenClaw, so the bridge cannot read replies
# or callback buttons without stealing OpenClaw's updates (see the tg() note).
# So each offer ships as a URL button pointing at a small HTTP listener on this
# box: tapping it from the phone force-grabs that exact release through the
# manual-grab endpoint, which bypasses every rule by design.
# ---------------------------------------------------------------------------

GRAB_PORT   = int(os.environ.get("GRAB_PORT", "8770"))
# Host used to BUILD the button URL only. The listener binds 0.0.0.0: binding
# the tailnet address directly would fail on a cold boot, where tailscale0 comes
# up minutes after the services that want it.
GRAB_HOST   = os.environ.get("GRAB_HOST", "100.111.77.98")
GRAB_BASE   = os.environ.get("GRAB_BASE", f"http://{GRAB_HOST}:{GRAB_PORT}").rstrip("/")
OFFERS_PATH = os.environ.get("OFFERS_PATH",
                             os.path.join(os.path.dirname(os.path.abspath(__file__)), "offers.json"))
ESCALATE_GRACE  = int(os.environ.get("ESCALATE_GRACE", "1800"))    # stuck this long before paging
ESCALATE_REPEAT = int(os.environ.get("ESCALATE_REPEAT", "86400"))  # don't re-ask about a title for a day
# 30m, 2h, 6h, then once a day. Every escalation costs a live indexer search
# across every configured indexer, so the ladder must get steep fast.
ESCALATE_BACKOFF = (1800, 7200, 21600, 86400)


def _escalate_due(d):
    """Is this stuck request due for another look?

    First look after ESCALATE_GRACE, then the backoff ladder. Anything that
    keeps this returning True on consecutive polls burns an indexer search
    every 20 seconds, so it is deliberately conservative.
    """
    since = d.get("stuck_since")
    if not since:
        return False
    last = d.get("escalated_at")
    if not last:
        return _age_secs(since) > ESCALATE_GRACE
    # escalate_n counts escalations ALREADY DONE, so the gap after the first is
    # BACKOFF[0]. Indexing by n straight would skip the 30m rung entirely.
    n = max(int(d.get("escalate_n") or 0) - 1, 0)
    return _age_secs(last) > ESCALATE_BACKOFF[min(n, len(ESCALATE_BACKOFF) - 1)]
OFFER_TTL       = int(os.environ.get("OFFER_TTL", str(14 * 86400)))
MIN_OFFER_SEEDERS = int(os.environ.get("MIN_OFFER_SEEDERS", "5"))
MAX_OFFERS      = int(os.environ.get("MAX_OFFERS", "3"))

# Rejections worth asking about. Everything else (unknown series, wrong season,
# multi-season pack, custom-format score, "wasn't requested") is a reason the
# release is WRONG, not merely outside a preference, and must never be offered.
SOFT_REJECT = ("is smaller than minimum allowed",
               "is larger than maximum allowed",
               "is not wanted in profile")

_offers = {}          # token -> {app, guid, indexerId, title, seeders, why, made, grabbed}


def _offers_load():
    global _offers
    try:
        with open(OFFERS_PATH) as f:
            _offers = json.load(f)
    except Exception:
        _offers = {}
    _offers_expire()
    _offers_compact()


def _offers_expire():
    now = time.time()
    for tok in [t for t, o in _offers.items() if now - o.get("made", 0) > OFFER_TTL]:
        _offers.pop(tok, None)


def _offers_compact():
    """Collapse duplicate offers for the same release; newest token wins.

    Repairs a file already bloated by the pre-2026-09-08 _offer(), which minted
    a fresh token on every poll of a stuck title: offers.json reached 11,963
    rows holding 6 distinct releases. A grabbed row always beats an ungrabbed
    one, so a button Nate already tapped cannot come back as a live offer.

    Dropped tokens make the buttons in older Telegram messages read "Link
    expired", which is honest -- those messages were duplicates of each other.
    """
    best = {}
    for tok, o in _offers.items():
        k = (o.get("app"), o.get("guid"))
        cur = best.get(k)
        if cur is None:
            best[k] = tok
            continue
        a, b = _offers[cur], o
        if (bool(b.get("grabbed")), b.get("made", 0)) > (bool(a.get("grabbed")), a.get("made", 0)):
            best[k] = tok
    keep = set(best.values())
    dropped = len(_offers) - len(keep)
    if dropped:
        for tok in [t for t in _offers if t not in keep]:
            _offers.pop(tok, None)
        log(f"offers compacted: dropped {dropped} duplicate rows, {len(_offers)} left")
        _offers_save()


def _offers_save():
    try:
        tmp = OFFERS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_offers, f)
        os.replace(tmp, OFFERS_PATH)                 # atomic: a torn file would kill every link
    except Exception as e:
        log("offer save failed", repr(e))


def _offerable(rel):
    """True if this release is good but for a rule Nate might waive."""
    rej = [str(x).lower() for x in (rel.get("rejections") or [])]
    if not rej:
        return False
    if not all(any(s in x for s in SOFT_REJECT) for x in rej):
        return False
    if (rel.get("seeders") or 0) < MIN_OFFER_SEEDERS:
        return False
    title = rel.get("title") or ""
    if re.search(r"[Ѐ-ӿ]", title):         # Cyrillic: hard-rejected by policy, never offer
        return False
    if not re.search(r"(720p|1080p|2160p|4k)", title, re.I):   # 480p/SDTV is not a waiver, it's junk
        return False
    return rel.get("guid") and rel.get("indexerId") is not None


def _offer_token(app_name, rel, search_path, req_id=None):
    """Register one release as tappable and return its token.

    `search_path` is stored so a tap can rebuild the release cache -- a guid is
    only grabbable while the app still holds that search result, and these
    buttons are meant to survive until Nate reads his phone.

    One token per (app, guid). Minting a fresh one per call looked harmless
    because tg() dedupes the MESSAGE anyway -- but the row is written before
    that check ever runs, so a stuck title grew the file on every poll forever.
    Reusing the token also keeps an offer Nate already tapped from quietly
    reappearing as a fresh, ungrabbed one.

    `req_id` ties the offer to a media_requests row parked on 'choosing', so a
    tap moves that row on (see _settle_choice).
    """
    import secrets
    guid = rel["guid"]
    for t, o in _offers.items():
        if o.get("app") == app_name and o.get("guid") == guid and not o.get("grabbed"):
            o["search"] = search_path              # keep the cache-rebuild path fresh
            o["seeders"] = rel.get("seeders") or 0
            o["made"] = time.time()                # a still-live offer should not age out
            if req_id:
                o["req_id"] = req_id
            return t
    tok = secrets.token_urlsafe(12)
    _offers[tok] = {"app": app_name, "guid": guid, "indexerId": rel["indexerId"],
                    "title": (rel.get("title") or "?")[:120],
                    "seeders": rel.get("seeders") or 0,
                    "why": "; ".join(rel.get("rejections") or [])[:200],
                    "search": search_path,
                    "made": time.time(), "grabbed": False}
    if req_id:
        _offers[tok]["req_id"] = req_id
    return tok


def _offer_label(rel):
    gb = (rel.get("size") or 0) / 1e9
    return f"Grab {gb:.1f} GB / {rel.get('seeders') or 0} seeders"


def _offer_url(tok):
    return f"{GRAB_BASE}/grab?t={tok}"


def _offer(app_name, rel, search_path, req_id=None):
    """Register one release as tappable and return (label, url)."""
    tok = _offer_token(app_name, rel, search_path, req_id=req_id)
    return _offer_label(rel), _offer_url(tok)


def _grab_offer(o):
    """POST the manual grab for one offer, surviving a release-cache miss.

    The guid outlives the app's release cache (it holds only the last search),
    so on "cache" re-run the stored search to repopulate it and try once more
    -- otherwise every button goes dead within the hour. Returns (code, resp).
    """
    target = RADARR if o["app"] == "radarr" else SONARR
    body = {"guid": o["guid"], "indexerId": o["indexerId"]}
    code, resp = arr(target, "POST", "release", body)
    if code not in (200, 201, 202) and "cache" in str(resp).lower() and o.get("search"):
        log("grab: release cache miss, re-searching")
        arr(target, "GET", o["search"])
        code, resp = arr(target, "POST", "release", body)
    return code, resp


def _detail_dict(row):
    try:
        d = json.loads(row.get("detail") or "{}")
    except Exception:
        return {}
    return d if isinstance(d, dict) else {}


def _settle_choice(o, via):
    """A grab went through for this offer: mark it, and move its request row on.

    The row is only touched while it still reads 'choosing' -- a tap on an old
    Telegram message for a request that has since moved on must not drag it
    back. Cue's own pick and the Telegram button both land here, so whichever
    comes second finds the row already settled and does nothing.
    """
    o["grabbed"] = True
    _offers_save()
    rid = o.get("req_id")
    if not rid:
        return
    code, rows = sb("GET", f"media_requests?id=eq.{rid}&select=id,status,detail")
    if code != 200 or not rows:
        return
    r = rows[0]
    if r.get("status") != "choosing":
        return
    d = _detail_dict(r)
    for k in ("options", "choose_since", "choice_error"):
        d.pop(k, None)
    d["chosen"] = o["title"]
    d["chosen_via"] = via
    d["msg"] = "grabbing your pick: %s" % o["title"][:60]
    code, resp = sb("PATCH", f"media_requests?id=eq.{rid}",
                    {"status": "added", "detail": json.dumps(d)}, prefer="return=minimal")
    if code not in (200, 204):
        log(f"settle PATCH failed {code} for request {rid}: {str(resp)[:180]}")


def process_choices():
    """Cue wrote a pick onto a 'choosing' row: grab exactly that release."""
    code, rows = sb("GET", "media_requests?status=eq.choosing&choice=not.is.null"
                           "&select=id,title,detail,choice&limit=20")
    if code != 200 or not rows:
        return
    for r in rows:
        tok = r.get("choice") or ""
        o = _offers.get(tok)
        if o is None:
            # offers.json lost the token (or a restart raced the save): the row
            # carries enough to grab on its own.
            d = _detail_dict(r)
            opt = next((x for x in (d.get("options") or []) if isinstance(x, dict)
                        and x.get("tok") == tok and x.get("guid")), None)
            if opt is None:
                log(f"choice {tok!r} on '{r.get('title')}' matches no option; clearing it")
                sb("PATCH", f"media_requests?id=eq.{r['id']}",
                   {"choice": None}, prefer="return=minimal")
                continue
            o = _offers[tok] = {"app": opt.get("app") or "radarr", "guid": opt["guid"],
                                "indexerId": opt.get("indexerId"), "title": opt.get("title") or "?",
                                "seeders": opt.get("seeders") or 0, "why": opt.get("why") or "",
                                "search": opt.get("search"), "made": time.time(),
                                "grabbed": False, "req_id": r["id"]}
        o.setdefault("req_id", r["id"])
        if o.get("grabbed"):
            _settle_choice(o, "cue")                  # Telegram got there first; just move the row
            continue
        code, resp = _grab_offer(o)
        if code in (200, 201, 202):
            log(f"grabbed Cue pick for '{r.get('title')}': {o['title'][:60]}")
            _settle_choice(o, "cue")
            tg(f"Grabbing your pick for {r.get('title')}: {o['title'][:80]}", key=None)
            continue
        # Leave the row on 'choosing' with the pick cleared so he can choose
        # another; say why in detail so the tray shows it.
        log(f"Cue pick grab failed {code}: {str(resp)[:200]}")
        d = _detail_dict(r)
        d["choice_error"] = f"Radarr said {code} for that copy; pick another"
        sb("PATCH", f"media_requests?id=eq.{r['id']}",
           {"choice": None, "detail": json.dumps(d)}, prefer="return=minimal")
        tg(f"Could not grab that copy of {r.get('title')} ({code}). Pick another.", key=None)


def expire_choices():
    """An 'options' request nobody answered for CHOOSE_GRACE: take the auto path.

    A request must not sit parked on a decision forever, and a day-old list is
    stale anyway (guids rot, swarms change). Falls into choose_release, the
    same speed-first flow an 'auto' push gets, and says so.
    """
    code, rows = sb("GET", "media_requests?status=eq.choosing&choice=is.null&media_type=eq.movie"
                           "&select=id,title,detail&limit=20")
    if code != 200 or not rows:
        return
    for r in rows:
        d = _detail_dict(r)
        since = d.get("choose_since")
        if not since or _age_secs(since) < CHOOSE_GRACE:
            continue
        rid = d.get("arr_id")
        if not rid:
            continue
        label = r.get("title") or "?"
        path = f"release?movieId={rid}"
        picked = None
        try:
            picked = choose_release("radarr", RADARR, path, label)
        except Exception as e:
            log("choice-expiry pick failed", repr(e))
        if picked is None:
            arr(RADARR, "POST", "command", {"name": "MoviesSearch", "movieIds": [rid]})
        for k in ("options", "choose_since", "choice_error"):
            d.pop(k, None)
        d["mode"] = "auto"
        d["options_expired"] = True
        if picked == "asked":
            d["asked_at"] = _now_iso()
        d["msg"] = "no pick in %dh, took the auto path" % (CHOOSE_GRACE // 3600)
        sb("PATCH", f"media_requests?id=eq.{r['id']}",
           {"status": "added", "detail": json.dumps(d)}, prefer="return=minimal")
        log(f"options expired for '{label}': {picked or 'handed back to Radarr'}")
        tg(f"No pick for {label} in {CHOOSE_GRACE // 3600}h, so I went ahead the usual way.",
           key=f"choiceexpired:{r['id']}")


class _GrabHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass                                          # the bridge has its own log

    def _page(self, code, head, body=""):
        html = (f"<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                f"<body style='font:16px/1.5 system-ui;margin:2rem;max-width:34rem'>"
                f"<h2>{head}</h2><p>{body}</p></body>").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/grab":
            return self._page(404, "Not found")
        tok = urllib.parse.parse_qs(u.query).get("t", [""])[0]
        o = _offers.get(tok)
        if not o:
            return self._page(404, "Link expired", "Push the title again from Cue.")
        if o.get("grabbed"):
            return self._page(200, "Already grabbed", o["title"])
        code, resp = _grab_offer(o)
        if code not in (200, 201, 202):
            log(f"manual grab failed {code}: {str(resp)[:200]}")
            return self._page(502, "Grab failed",
                              f"{o['app']} said {code}. The release may be gone from the "
                              f"indexer now. Push the title again from Cue.")
        _settle_choice(o, "telegram")
        log(f"manual grab via Telegram: {o['title']}")
        tg(f"Grabbing: {o['title']}" + (f"\nRule waived: {o['why']}" if o.get("why") else ""),
           key=None)
        return self._page(200, "Grabbing it", o["title"])


def start_grab_server():
    """Listener for the Telegram grab buttons. Failure must not stop the bridge."""
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", GRAB_PORT), _GrabHandler)
    except Exception as e:
        log("grab server failed to bind", repr(e))
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"grab server on :{GRAB_PORT} (buttons point at {GRAB_BASE})")


def _first_missing_episode(series_id, season=None):
    """Episode id of the earliest aired, monitored, file-less episode."""
    code, eps = arr(SONARR, "GET", f"episode?seriesId={series_id}")
    if code != 200 or not isinstance(eps, list):
        return None
    now = datetime.now(timezone.utc)
    best = None
    for e in eps:
        if e.get("hasFile") or not e.get("monitored"):
            continue
        if e.get("seasonNumber", 0) < 1:
            continue
        if season is not None and e.get("seasonNumber") != int(season):
            continue
        air = e.get("airDateUtc")
        if air:                                       # unaired episodes are not owed to us
            try:
                if datetime.fromisoformat(air.replace("Z", "+00:00")) > now:
                    continue
            except Exception:
                pass
        if best is None or (e.get("seasonNumber"), e.get("episodeNumber")) < \
                           (best.get("seasonNumber"), best.get("episodeNumber")):
            best = e
    return best.get("id") if best else None


def _monitored_count(series_id, season=None):
    code, eps = arr(SONARR, "GET", f"episode?seriesId={series_id}")
    if code != 200 or not isinstance(eps, list):
        return None
    return sum(1 for e in eps
               if e.get("monitored") and e.get("seasonNumber", 0) >= 1
               and (season is None or e.get("seasonNumber") == int(season)))


def escalate_stuck(row, mt, arr_id):
    """A request with nothing queued and nothing landing. Say why, and offer a way out.

    Two outcomes worth a message:
      * nothing is even MONITORED -- the search had nothing to ask for. Self-heal
        it (this is the Better Call Saul failure) and say so.
      * releases exist but every one trips a rule -- offer the best few as
        tap-to-grab buttons.
    Returns True if Nate was messaged.
    """
    title = row.get("title") or "?"
    season = row.get("season")
    where = f" S{season}" if season else ""
    target = RADARR if mt == "movie" else SONARR
    app_name = "radarr" if mt == "movie" else "sonarr"

    if mt == "tv":
        n = _monitored_count(arr_id, season)
        if n == 0 and _is_cancelled(target, mt, arr_id):
            return False        # deliberately called off -- do NOT re-monitor it
        if n == 0:
            try:
                fixed = _monitor_all(arr_id)
            except Exception as e:
                log("self-heal monitor failed", repr(e))
                fixed = 0
            return tg(f"{title}{where} was never actually searched for: Sonarr had no "
                      f"monitored episodes, so there was nothing to look for.\n"
                      f"Fixed it -- monitoring {fixed} episodes and searching now.",
                      key=f"unmonitored:{arr_id}", repeat=ESCALATE_REPEAT)
        ep = _first_missing_episode(arr_id, season)
        path = f"release?episodeId={ep}" if ep else None
    else:
        path = f"release?movieId={arr_id}"
    if not path:
        return False

    code, rels = arr(target, "GET", path)
    if code != 200 or not isinstance(rels, list):
        return False
    if any(r.get("approved") for r in rels):
        return False                                  # something is grabbable; let the app get on with it
    cands = sorted([r for r in rels if _offerable(r)],
                   key=lambda r: -(r.get("seeders") or 0))[:MAX_OFFERS]
    if not cands:
        return tg(f"{title}{where} is stuck: {len(rels)} releases on the indexers, none of "
                  f"them usable (wrong show, wrong season, or nothing above 480p). "
                  f"Nothing worth waiving a rule for.",
                  key=f"nothing:{app_name}:{arr_id}", repeat=ESCALATE_REPEAT)

    lines = [f"{title}{where} is stuck -- nothing passes the rules.",
             "Closest matches, each breaks one:", ""]
    buttons = []
    for i, r in enumerate(cands, 1):
        lines.append(f"{i}. {(r.get('title') or '?')[:70]}")
        lines.append(f"   {_describe(r)}")
        lines.append(f"   {'; '.join(r.get('rejections') or [])[:120]}")
        label, url = _offer(app_name, r, path)
        buttons.append((f"{i}. {label}", url))
    lines += ["", "Tap one to download it anyway."]
    _offers_save()
    return tg("\n".join(lines), key=f"offer:{app_name}:{arr_id}:{season}",
              buttons=buttons, repeat=ESCALATE_REPEAT)


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
    # Cue "show me options": act on a pick, or give up waiting for one
    process_choices()
    expire_choices()
    # feed live download progress back to the app
    monitor_downloads()
    monitor_watching()
    monitor_books()
    # Cue "resume in audio" -> write listen position into Audiobookshelf
    process_seeks()
    # self-heal dead downloads
    prioritise_first_episodes()
    reap_stalled("radarr", RADARR, "MoviesSearch", "movieId")
    reap_stalled("sonarr", SONARR, "SeriesSearch", "seriesId")
    reap_stalled_books()
    prune_blocklist("radarr", RADARR)
    prune_blocklist("sonarr", SONARR)
    _offers_expire()


if __name__ == "__main__":
    log(f"media-bridge up; poll {SB_URL} every {INTERVAL}s; reap stalled > {STALL_GRACE}s")
    _offers_load()
    start_grab_server()
    while True:
        try:
            tick()
        except Exception as e:
            log("tick error", repr(e))
        time.sleep(INTERVAL)
