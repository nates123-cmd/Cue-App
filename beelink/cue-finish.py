#!/usr/bin/env python3
"""cue-finish: let the devices tell Cue what Nate actually read and watched.

    KOReader on the Kindle  -> kosync row (percentage) + sidecar "Mark as finished"
    Jellyfin                -> UserData.Played / LastPlayedDate for movies and series

Both feed one loop. A Cue card that is still `queued` / `saved` / `active`
flips to `done` the moment a device says the title is finished, and from
`queued` to `active` the moment it says reading / watching has begun. Cue's
own "Finish" action is mirrored exactly: `recommendations` gets status /
finished_at / consumed_at, and a `media_entries` row is inserted so Ink's log
stays coherent. Rating and review stay empty for Nate to add in the app.

Signals
  book, finished   sidecar summary.status == "complete" (KOReader's Mark as
                   finished), read over ssh whenever the Kindle answers on
                   :2222; or the Kindle's kosync percentage >= FINISH_PCT
  book, started    kosync percentage >= START_PCT
  movie, finished  Jellyfin UserData.Played on the movie
  movie, started   a resume position on the movie
  tv, finished     every episode Jellyfin holds for the series is played
  tv, started      at least one episode played or resumable

Guards
  - the device event must postdate the Cue card (created_at): a title watched
    months ago and queued last week is a re-watch wish, not a finish
  - a card is never moved backwards (done -> active) and never re-finished for
    an event it already acted on: `fulfillment.progress.event_at` remembers the
    device timestamp that moved the card, so Nate can undo in Cue without the
    daemon undoing his undo on the next tick
  - a media_entries row with the same title already on the log = no second row

Config (env; reads media-bridge/bridge.env, reading-sync/reading-sync.env and
its own cue-finish.env, later files win):
  SUPABASE_URL, SUPABASE_SERVICE_KEY
  CUE_USER_ID        the recommendations.user_id whose cards these devices speak for
  JELLYFIN_URL       default http://127.0.0.1:8096
  JELLYFIN_TOKEN     API key
  JELLYFIN_USER_ID   the Jellyfin user whose play state counts (the household
                     watches as `root`, not `nate`)
  KOSYNC_DB, KOSYNC_USER, KINDLE_DEVICE_ID / KINDLE_DEVICE_NAME, EBOOK_DIR
  KINDLE_HOST, KINDLE_SSH_PORT, KINDLE_SSH_KEY   sidecar read (optional)
  FINISH_PCT (0.99)  START_PCT (0.02)  POLL_SECONDS (120)  KINDLE_EVERY (600)

    cue-finish.py             # loop (systemd user unit cue-finish.service)
    cue-finish.py --once      # one pass
    cue-finish.py --dry-run   # one pass, say what would move, move nothing

stdlib only, like the rest of the box.
"""
import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, 'finish-state.json')


# ---------------------------------------------------------------------------
# env + tiny http

def load_env(paths):
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        for line in open(p):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip().strip('"').strip("'")


def env(name, default=''):
    return os.environ.get(name, default)


def log(*a):
    print(datetime.now(timezone.utc).strftime('%H:%M:%S'), *a, flush=True)


def http(method, url, headers, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    rq = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as f:
            t = f.read().decode()
            if not t.strip():
                return f.status, None
            try:
                return f.status, json.loads(t)
            except json.JSONDecodeError:
                return f.status, t
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def sb(method, path, body=None, prefer=None):
    key = env('SUPABASE_SERVICE_KEY')
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    if prefer:
        h['Prefer'] = prefer
    return http(method, f"{env('SUPABASE_URL').rstrip('/')}/rest/v1/{path}", h, body)


def jf(path):
    url = f"{env('JELLYFIN_URL', 'http://127.0.0.1:8096').rstrip('/')}{path}"
    return http('GET', url, {'Authorization': f"MediaBrowser Token={env('JELLYFIN_TOKEN')}"})


def notify(text):
    script = os.path.join(os.path.expanduser('~/apps/reading-sync'), 'notify_tg.py')
    if not os.path.exists(script):
        return
    try:
        subprocess.run(['python3', script], input=text.encode(), timeout=20)
    except Exception as e:
        log(f'notify failed: {e!r}')


# ---------------------------------------------------------------------------
# pure helpers (covered by test_cue_finish.py)

def fold(s):
    """Alphanumerics only, lower-case: the same key reading-sync uses so a Cue
    title and an ebook folder name meet even after the bridge strips punctuation."""
    return ''.join(c for c in (s or '').lower() if c.isalnum())


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_ts(s):
    """ISO (any precision, Z or offset) or epoch ms -> aware datetime, else None."""
    if s is None or s == '':
        return None
    if isinstance(s, (int, float)):
        return datetime.fromtimestamp(float(s) / 1000.0, tz=timezone.utc)
    s = str(s).strip()
    if s.isdigit():
        return datetime.fromtimestamp(int(s) / 1000.0, tz=timezone.utc)
    s = s.replace('Z', '+00:00')
    # Jellyfin writes 7 fractional digits; fromisoformat wants <= 6.
    m = re.match(r'^(.*T\d\d:\d\d:\d\d)\.(\d+)(.*)$', s)
    if m:
        s = f'{m.group(1)}.{m.group(2)[:6]}{m.group(3)}'
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        try:
            d = datetime.strptime(s[:10], '%Y-%m-%d')
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def iso(d):
    return d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def document_id(filename):
    """kosync document id in FILENAME mode: md5 of the basename (same as epubpos)."""
    return hashlib.md5(filename.rsplit('/', 1)[-1].encode()).hexdigest()


def rec_kind(rec):
    t = (rec.get('media_type') or '').lower()
    return 'movie' if t in ('movie', 'film') else t


def rec_tmdb(rec):
    ext = rec.get('extension')
    if not isinstance(ext, dict):
        return None
    v = ext.get('tmdb_id')
    return str(v) if v not in (None, '') else None


def main_title(s):
    """Title with any subtitle dropped: 'Gone Girl: A Novel' -> 'Gone Girl'."""
    return (s or '').split(':', 1)[0]


def titles_agree(a, b):
    fa, fb = fold(a), fold(b)
    if not fa or not fb:
        return False
    return fa == fb or fold(main_title(a)) == fb or fa == fold(main_title(b))


def match_event(rec, events):
    """The device event that speaks for this card, or None.

    tmdb id wins when both sides have one. Otherwise the folded title must be
    equal (a subtitle on either side is ignored: Audiobookshelf says
    "Gone Girl: A Novel", the card says "Gone Girl"), and the years must agree
    when both are known. Books have no ids, so they always match on title; the
    folder name the bridge made is the same fold of the same Cue title. Among
    several book events the newest wins, so a stale Kindle row never outvotes
    the audiobook you listened to this morning.
    """
    kind = rec_kind(rec)
    tmdb = rec_tmdb(rec)
    year = rec.get('year')
    best = None
    for ev in events:
        if ev['kind'] != kind:
            continue
        if tmdb and ev.get('tmdb'):
            if str(ev['tmdb']) == tmdb:
                return ev
            continue
        if not titles_agree(rec.get('title'), ev.get('title')):
            continue
        if year and ev.get('year') and int(year) != int(ev['year']):
            continue
        if best is None:
            best = ev
        elif ev.get('finished') and not best.get('finished'):
            best = ev
        elif bool(ev.get('finished')) == bool(best.get('finished')):
            a, b = parse_ts(ev.get('at')), parse_ts(best.get('at'))
            if a and b and a > b:
                best = ev
    return best


def decide(rec, ev, finish_pct=0.99):
    """What a matched event should do to the card: 'finish', 'start' or None."""
    status = (rec.get('status') or '').lower()
    if status == 'done' or rec.get('finished_at'):
        return None
    created = parse_ts(rec.get('created_at'))
    at = parse_ts(ev.get('at'))
    if created and at and at < created:
        return None                       # watched / read before it was queued
    prog = (rec.get('fulfillment') or {}).get('progress') if isinstance(rec.get('fulfillment'), dict) else None
    prog = prog if isinstance(prog, dict) else {}
    if ev.get('finished') or (ev.get('pct') is not None and ev['pct'] >= finish_pct):
        if prog.get('state') == 'done' and prog.get('event_at') == ev.get('at'):
            return None                   # already acted on this very event; Nate undid it
        return 'finish'
    if ev.get('started') and status in ('queued', 'saved', ''):
        if prog.get('event_at') == ev.get('at'):
            return None
        return 'start'
    return None


def progress_leg(ev, state):
    leg = {'state': state, 'source': ev['source'], 'event_at': ev.get('at')}
    if ev.get('pct') is not None:
        leg['pct'] = round(float(ev['pct']) * 100)
    if ev.get('detail'):
        leg['detail'] = ev['detail']
    return leg


def merge_leg(fulfillment, key, leg):
    cur = dict(fulfillment) if isinstance(fulfillment, dict) else {}
    old = cur.get(key) if isinstance(cur.get(key), dict) else {}
    new = dict(old)
    new.update(leg)
    if new.get('state') != old.get('state') or new.get('event_at') != old.get('event_at'):
        new['at'] = now_iso()
    cur[key] = new
    return cur


# ---------------------------------------------------------------------------
# Jellyfin -> events

def jellyfin_events():
    uid = env('JELLYFIN_USER_ID')
    if not uid or not env('JELLYFIN_TOKEN'):
        return []
    out = []
    code, d = jf(f'/Users/{uid}/Items?Recursive=true&IncludeItemTypes=Movie'
                 '&Fields=ProviderIds&Limit=2000')
    if code != 200 or not isinstance(d, dict):
        log(f'jellyfin movies {code}: {str(d)[:120]}')
        return []
    for x in d.get('Items', []):
        ud = x.get('UserData') or {}
        played = bool(ud.get('Played'))
        resumed = int(ud.get('PlaybackPositionTicks') or 0) > 0
        if not (played or resumed):
            continue
        out.append({
            'kind': 'movie', 'source': 'jellyfin',
            'title': x.get('Name'), 'year': x.get('ProductionYear'),
            'tmdb': (x.get('ProviderIds') or {}).get('Tmdb'),
            'finished': played, 'started': True,
            'at': ud.get('LastPlayedDate') or now_iso(),
            'detail': 'Watched on Jellyfin' if played else 'Started on Jellyfin',
        })

    code, d = jf(f'/Users/{uid}/Items?Recursive=true&IncludeItemTypes=Series'
                 '&Fields=ProviderIds&Limit=2000')
    if code != 200 or not isinstance(d, dict):
        log(f'jellyfin series {code}: {str(d)[:120]}')
        return out
    series = {x['Id']: x for x in d.get('Items', [])}

    # Played + resumable episodes, grouped by series: how many, and when last.
    seen = {}
    for flt in ('IsPlayed', 'IsResumable'):
        code, d = jf(f'/Users/{uid}/Items?Recursive=true&IncludeItemTypes=Episode'
                     f'&Filters={flt}&Fields=SeriesId&Limit=5000')
        if code != 200 or not isinstance(d, dict):
            continue
        for ep in d.get('Items', []):
            sid = ep.get('SeriesId')
            if not sid:
                continue
            ud = ep.get('UserData') or {}
            s = seen.setdefault(sid, {'played': 0, 'last': None})
            if flt == 'IsPlayed':
                s['played'] += 1
            last = parse_ts(ud.get('LastPlayedDate'))
            if last and (s['last'] is None or last > s['last']):
                s['last'] = last
    for sid, s in seen.items():
        x = series.get(sid)
        if not x:
            continue
        ud = x.get('UserData') or {}
        unplayed = ud.get('UnplayedItemCount')
        finished = bool(ud.get('Played')) or (s['played'] > 0 and unplayed == 0)
        out.append({
            'kind': 'tv', 'source': 'jellyfin',
            'title': x.get('Name'), 'year': x.get('ProductionYear'),
            'tmdb': (x.get('ProviderIds') or {}).get('Tmdb'),
            'finished': finished, 'started': True,
            'at': iso(s['last']) if s['last'] else now_iso(),
            'detail': ('Every episode watched on Jellyfin' if finished
                       else f"{s['played']} episode{'s' if s['played'] != 1 else ''} watched on Jellyfin"
                       if s['played'] else 'An episode in progress on Jellyfin'),
        })
    return out


# ---------------------------------------------------------------------------
# Kindle -> events

def shelf_titles():
    """{document_id: title} for every epub on the shelf (what kindlepush sent)."""
    out = {}
    root = env('EBOOK_DIR', '/srv/media/data/media/ebooks')
    if not os.path.isdir(root):
        return out
    for t in os.listdir(root):
        d = os.path.join(root, t)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.lower().endswith('.epub'):
                out[document_id(f)] = t
    return out


def koinsight_titles(con):
    out = {}
    try:
        for md5, title in con.execute('select md5, title from book'):
            if md5 and title:
                out[md5] = title
    except sqlite3.Error:
        pass
    return out


def kosync_rows():
    """{document: (pct, updated_ms)} -- the newest kosync row per book across
    every device: the Kindle's own row and the `reading-sync` row that
    reading-follow writes when the audiobook moves. A Kindle row from three
    days ago must not outvote this morning's listening."""
    db = env('KOSYNC_DB', '/home/nate/apps/kosync/data/prod.sqlite3')
    if not os.path.exists(db):
        return {}, {}
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    try:
        q = ('select p.document, p.percentage, p.updated_at from progress p '
             'join user u on u.id = p.user_id where u.username = ?')
        rows = con.execute(q, (env('KOSYNC_USER'),)).fetchall()
        titles = koinsight_titles(con)
    finally:
        con.close()
    out = {}
    for doc, pct, upd in rows:
        try:
            ms = int(upd)
        except (TypeError, ValueError):
            d = parse_ts(upd)
            ms = int(d.timestamp() * 1000) if d else 0
        if doc not in out or ms > out[doc][1]:
            out[doc] = (float(pct or 0), ms)
    return out, titles


# ---------------------------------------------------------------------------
# Audiobookshelf -> events

def abs_title(item_id, state):
    cache = state.setdefault('abs_titles', {})
    if item_id in cache:
        return cache[item_id]
    code, d = http('GET', f"{env('ABS_URL').rstrip('/')}/api/items/{item_id}",
                   {'Authorization': f"Bearer {env('ABS_TOKEN')}"})
    title = None
    if code == 200 and isinstance(d, dict):
        title = ((d.get('media') or {}).get('metadata') or {}).get('title')
    cache[item_id] = title
    return title


def abs_events(state):
    """One event per audiobook with progress: finished when ABS says so or the
    position is past ABS_FINISH_PCT (credits and an afterword sit after 97%)."""
    if not env('ABS_URL') or not env('ABS_TOKEN'):
        return []
    code, me = http('GET', f"{env('ABS_URL').rstrip('/')}/api/me",
                    {'Authorization': f"Bearer {env('ABS_TOKEN')}"})
    if code != 200 or not isinstance(me, dict):
        log(f'abs /api/me {code}: {str(me)[:120]}')
        return []
    finish_pct = float(env('ABS_FINISH_PCT', '0.97'))
    start_pct = float(env('START_PCT', '0.02'))
    out = []
    for p in me.get('mediaProgress') or []:
        pct = float(p.get('progress') or 0)
        finished = bool(p.get('isFinished')) or pct >= finish_pct
        if not finished and pct < start_pct:
            continue
        title = abs_title(p.get('libraryItemId'), state)
        if not title:
            continue
        ms = p.get('finishedAt') if finished and p.get('finishedAt') else p.get('lastUpdate')
        out.append({
            'kind': 'book', 'source': 'audiobookshelf', 'title': title, 'year': None, 'tmdb': None,
            'finished': finished, 'started': True, 'pct': min(pct, 1.0),
            'at': iso(parse_ts(ms)) if ms else now_iso(),
            'detail': 'Finished on Audiobookshelf' if finished else f'{round(pct * 100)}% listened on Audiobookshelf',
        })
    return out


def kindle_up():
    host, port = env('KINDLE_HOST'), int(env('KINDLE_SSH_PORT', '2222'))
    if not host:
        return False
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except OSError:
        return False


# One line per sidecar: "<book file basename>|<status>|<modified>|<mtime>".
# Sidecar = <name>.sdr/metadata.<ext>.lua for the book <name>.<ext>.
SIDECAR_SH = r'''
for d in /mnt/us/documents/*.sdr; do
  for f in "$d"/metadata.*.lua; do
    [ -f "$f" ] || continue
    n=$(basename "$d" .sdr); e=$(basename "$f" .lua); e=${e#metadata.}
    s=$(grep -o '\["status"\] = "[a-z]*"' "$f" | head -1 | sed 's/.*"\([a-z]*\)"$/\1/')
    m=$(grep -o '\["modified"\] = "[0-9-]*"' "$f" | head -1 | sed 's/.*"\([0-9-]*\)"$/\1/')
    t=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    echo "$n.$e|$s|$m|$t"
  done
done
'''


def read_sidecars():
    """{document_id: {'status','modified','mtime'}} straight off the Kindle, or None if unreachable."""
    if not kindle_up():
        return None
    cmd = ['ssh', '-p', env('KINDLE_SSH_PORT', '2222'),
           '-i', os.path.expanduser(env('KINDLE_SSH_KEY', '~/.ssh/kindle_ed25519')),
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
           '-o', 'StrictHostKeyChecking=accept-new',
           f"root@{env('KINDLE_HOST')}", 'sh', '-c', json.dumps(SIDECAR_SH)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
    except Exception as e:
        log(f'sidecar ssh failed: {e!r}')
        return None
    if r.returncode != 0:
        log(f'sidecar ssh rc={r.returncode}: {r.stderr.strip()[:120]}')
        return None
    out = {}
    for line in r.stdout.splitlines():
        parts = line.strip().split('|')
        if len(parts) != 4:
            continue
        name, status, modified, mtime = parts
        out[document_id(name)] = {'name': name, 'status': status, 'modified': modified,
                                  'mtime': int(mtime or 0)}
    return out


def kindle_events(state, force_sidecar=False):
    rows, ko_titles = kosync_rows()
    titles = shelf_titles()
    titles.update({k: v for k, v in ko_titles.items() if k not in titles})

    every = int(env('KINDLE_EVERY', '600'))
    last = float(state.get('sidecar_read_at') or 0)
    if force_sidecar or time.time() - last >= every:
        side = read_sidecars()
        if side is not None:
            state['sidecars'] = side
            state['sidecar_read_at'] = time.time()
            log(f'sidecars: read {len(side)} off the Kindle')
    sidecars = state.get('sidecars') or {}
    for doc, sc in sidecars.items():
        if sc.get('name') and doc not in titles:
            titles[doc] = os.path.splitext(sc['name'])[0]

    start_pct = float(env('START_PCT', '0.02'))
    out = []
    docs = set(rows) | {d for d, sc in sidecars.items() if sc.get('status') == 'complete'}
    for doc in docs:
        title = titles.get(doc)
        if not title:
            continue
        pct, ms = rows.get(doc, (None, 0))
        sc = sidecars.get(doc) or {}
        complete = sc.get('status') == 'complete'
        if complete:
            when = parse_ts(sc.get('modified')) if sc.get('modified') else None
            if sc.get('mtime'):
                mt = datetime.fromtimestamp(sc['mtime'], tz=timezone.utc)
                when = mt if when is None or mt.date() == when.date() else when
            at = iso(when) if when else now_iso()
            detail = 'Marked finished in KOReader'
        else:
            at = iso(parse_ts(ms)) if ms else now_iso()
            detail = f'{round(pct * 100)}% read on the Kindle' if pct is not None else None
        out.append({
            'kind': 'book', 'source': 'kindle', 'title': title, 'year': None, 'tmdb': None,
            'finished': complete, 'started': pct is not None and pct >= start_pct,
            'pct': pct, 'at': at, 'detail': detail,
        })
    return out


# ---------------------------------------------------------------------------
# apply

def load_recs():
    uid = env('CUE_USER_ID')
    if not uid:
        raise SystemExit('CUE_USER_ID is required')
    code, rows = sb('GET', 'recommendations?select=id,title,media_type,status,extension,'
                           'created_at,started_at,finished_at,year,fulfillment'
                           f'&user_id=eq.{uid}&status=in.(queued,saved,active)&limit=1000')
    if code != 200 or not isinstance(rows, list):
        raise RuntimeError(f'recommendations GET {code}: {str(rows)[:120]}')
    return rows


def media_entry_exists(uid, title):
    # Anything that is not a letter or digit becomes a wildcard, so punctuation
    # differences never hide an existing row; the fold() compare below is exact.
    pat = re.sub(r'[^A-Za-z0-9]+', '*', title).strip('*')
    q = urllib.request.quote(f'*{pat}*', safe='')
    code, rows = sb('GET', f'media_entries?select=id,title&user_id=eq.{uid}&title=ilike.{q}&limit=10')
    if code != 200 or not isinstance(rows, list):
        return False
    return any(fold(r.get('title')) == fold(title) for r in rows)


def apply(rec, ev, action, dry=False):
    uid = env('CUE_USER_ID')
    kind = rec_kind(rec)
    at = ev.get('at') or now_iso()
    leg = progress_leg(ev, 'done' if action == 'finish' else 'started')
    patch = {'fulfillment': merge_leg(rec.get('fulfillment'), 'progress', leg)}
    if action == 'finish':
        patch.update({'status': 'done', 'finished_at': at, 'consumed_at': at})
        if not rec.get('started_at'):
            patch['started_at'] = at
    else:
        patch.update({'status': 'active'})
        if not rec.get('started_at'):
            patch['started_at'] = at
    verb = 'finished' if action == 'finish' else 'started'
    line = f"{verb}: {rec.get('title')!r} ({kind}) via {ev['source']} - {ev.get('detail') or ''}".rstrip(' -')
    if dry:
        log('DRY ' + line)
        return None
    code, resp = sb('PATCH', f"recommendations?id=eq.{rec['id']}", patch, prefer='return=minimal')
    if code >= 300:
        log(f'patch failed {code}: {str(resp)[:160]}')
        return None
    if action == 'finish':
        if media_entry_exists(uid, rec.get('title') or ''):
            log(f"media_entries: {rec.get('title')!r} already logged, no second row")
        else:
            code, resp = sb('POST', 'media_entries', {
                'title': rec.get('title'),
                'format': 'film' if kind == 'movie' else kind,
                'consumed_date': at[:10],
                'rating': None, 'note': None, 'user_id': uid,
            }, prefer='return=minimal')
            if code >= 300:
                log(f'media_entries insert failed {code}: {str(resp)[:160]}')
    log(line)
    return line


def tick(state, dry=False, force_sidecar=False):
    recs = load_recs()
    events = (jellyfin_events() + kindle_events(state, force_sidecar=force_sidecar)
              + abs_events(state))
    finish_pct = float(env('FINISH_PCT', '0.99'))
    lines = []
    for rec in recs:
        ev = match_event(rec, events)
        if not ev:
            continue
        action = decide(rec, ev, finish_pct)
        if not action:
            continue
        line = apply(rec, ev, action, dry=dry)
        if line:
            lines.append(line)
    # One Telegram per tick, not one per card: the first pass after a deploy
    # can move thirty cards at once.
    if lines:
        finished = sum(1 for l in lines if l.startswith('finished'))
        head = f"Cue synced from your devices: {finished} finished, {len(lines) - finished} started"
        tail = '\nAdd ratings in Cue when you get a minute.' if finished else ''
        notify(head + '\n' + '\n'.join('- ' + l for l in lines[:40]) + tail)
    return len(recs), len(events), len(lines)


def load_state():
    try:
        return json.load(open(STATE_PATH))
    except Exception:
        return {}


def save_state(st):
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(st, fh)
    os.replace(tmp, STATE_PATH)


def main():
    load_env([os.path.expanduser('~/media-bridge/bridge.env'),
              os.path.expanduser('~/apps/reading-sync/reading-sync.env'),
              os.path.join(HERE, 'cue-finish.env')])
    once = '--once' in sys.argv or '--dry-run' in sys.argv
    dry = '--dry-run' in sys.argv
    poll = int(env('POLL_SECONDS', '120'))
    state = load_state()
    if '--done' in sys.argv:
        # cue-finish.py --done "Gone Girl" "Search Party": Nate says so, no
        # device needed. Same write path as a device finish, source 'manual'.
        titles = sys.argv[sys.argv.index('--done') + 1:]
        recs = load_recs()
        lines = []
        for t in titles:
            hits = [r for r in recs if titles_agree(r.get('title'), t)]
            if not hits:
                log(f'--done: no open card matches {t!r}')
                continue
            for rec in hits:
                ev = {'kind': rec_kind(rec), 'source': 'manual', 'title': rec.get('title'),
                      'finished': True, 'started': True, 'at': now_iso(),
                      'detail': 'Marked done by Nate'}
                line = apply(rec, ev, 'finish', dry=dry)
                if line:
                    lines.append(line)
        if lines:
            notify('Cue: marked done\n' + '\n'.join('- ' + l for l in lines))
        return
    log(f"cue-finish up: user {env('CUE_USER_ID')[:8]}, jellyfin user {env('JELLYFIN_USER_ID')[:8]}, "
        f"kindle {env('KINDLE_HOST') or 'off'}, poll {poll}s{' DRY RUN' if dry else ''}")
    while True:
        try:
            n_recs, n_ev, moved = tick(state, dry=dry, force_sidecar=once)
            log(f'tick: {n_recs} open cards, {n_ev} device events, {moved} moved')
            if not dry:
                save_state(state)
        except Exception:
            log('tick failed:\n' + traceback.format_exc())
        if once:
            break
        time.sleep(poll)


if __name__ == '__main__':
    main()
