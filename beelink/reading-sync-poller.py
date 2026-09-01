#!/usr/bin/env python3
"""Drain reading_sync_requests and push the resolved position to the devices.

The PWA is served over HTTPS while KoInsight and the ebook library are plain
HTTP on the LAN, so the browser cannot reach them directly. The app therefore
writes a request row to Supabase and this daemon does the work on the LAN --
the same outbox shape media-bridge already uses for audio_seek_requests.

Flow per row:
    anchor (phrase | percent)
      -> resolve against the EPUB           (epubpos)
      -> push to kosync                     (kosync)  -> X4 + reMarkable
      -> write the resolved position back into `result` for the PWA to show

Deliberately a separate service from media-bridge: that daemon owns acquiring
media and has bitten us repeatedly, and a reading-position failure must not be
able to take downloads with it.

stdlib only, matching bridge.py's no-venv/no-pip property.
"""

import json
import os
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import absclient
from audiomap import audio_text_fraction, push_audio
from epubpos import Book, document_id
from kosync import Kosync, KosyncError, push_position
from sync import find_books, load_env

HERE = os.path.dirname(os.path.abspath(__file__))
POLL_SECONDS = int(os.environ.get('POLL_SECONDS', '10'))
ALIGN_DIR = os.environ.get('ALIGN_DIR', '/srv/media/reading-align')

_cache = {}

# One box, several readers. Both device legs are single-identity, so each is
# pinned to an owner and everyone else is served from their own credential.
# LANDMINE: main() calls load_env() AFTER this module body runs, so anything
# read from os.environ at import is empty. These gates were written that way
# first and silently allowed a second reader to push to the owner's X4.
# Read config at CALL time in this file, always.
def _x4_owner():
    return os.environ.get('X4_OWNER_ID', '')        # the only person with an X4


def _abs_owner():
    return os.environ.get('ABS_OWNER_ID', '')       # whose account ABS_TOKEN is


def _abs_token_path():
    return os.environ.get('ABS_USER_TOKENS',
                          '/home/nate/media-bridge/abs-users.json')


def abs_token_for(user_id):
    """(token, why_not) for this requester's Audiobookshelf account.

    token None + why_not None means 'use the default ABS_TOKEN'. A token is
    NEVER inherited: without one of their own, a second reader gets why_not
    and the audiobook leg is skipped, because the alternative is silently
    moving the owner's listening position.
    """
    abs_owner = _abs_owner()
    if not abs_owner or user_id == abs_owner:
        return None, None
    try:
        with open(_abs_token_path()) as fh:
            tok = (json.load(fh) or {}).get(user_id)
    except FileNotFoundError:
        tok = None
    except Exception as e:
        log(f'abs token map unreadable: {e!r}')
        tok = None
    if tok:
        return tok, None
    return None, 'no Audiobookshelf account linked for this login'


def log(msg):
    print(f'[reading-sync] {msg}', flush=True)


def sb(method, path, body=None, prefer=None):
    """Supabase REST call using the service key (bypasses RLS, like bridge.py)."""
    url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/' + path
    key = os.environ['SUPABASE_SERVICE_KEY']
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
    }
    if prefer:
        headers['Prefer'] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode()[:300]}


def get_book(path):
    """Parse+index an EPUB, cached until the file changes."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    book = Book(path)
    _cache[path] = (mtime, book)
    return book


def resolve_resume(path, book, doc, source_pref, allow_x4=True, allow_abs=True):
    """"Continue on Kindle": read the current position off the X4 (kosync) and
    the audiobook (ABS), take whichever is furthest, and hand back a phrase to
    search on the Kindle.

    The Kindle can be neither read from nor written to, but it HAS full-text
    search -- so a distinctive phrase is the fastest way to land on it. This is
    the reverse of a normal sync: instead of pushing a position out, we pull the
    furthest one in.
    """
    sources = {}  # name -> text fraction 0-1

    # X4 / reMarkable: kosync stores the last position the device synced.
    if allow_x4 and source_pref in ('auto', 'x4'):
        try:
            ks = Kosync()
            if ks.user and ks.key and ks.authorized():
                prog = ks.get_progress(doc)
                if prog:
                    off = book.offset_for_xpath(prog.get('progress'))
                    if off is None and prog.get('percentage') is not None:
                        # Fall back to the byte-weighted percentage the device
                        # also sends.
                        off = book.position_at_percent(
                            float(prog['percentage']), scale='device')['offset']
                    if off is not None:
                        sources['x4'] = off / max(len(book.text), 1)
        except Exception as e:
            log(f'  resume: kosync read failed: {e}')

    # Audiobook: ABS currentTime mapped back through the chapter map.
    if allow_abs and source_pref in ('auto', 'abs'):
        try:
            hit = audio_text_fraction(path, book)
            if hit:
                sources['abs'] = hit[0]
        except Exception as e:
            log(f'  resume: ABS read failed: {e}')

    if not sources:
        return ('not_found', None,
                ('no synced position yet -- listen in Audiobookshelf first'
                 if not allow_x4 else
                 'no synced position yet -- read on the X4 (and sync) or listen '
                 'in Audiobookshelf first'))

    # Furthest wins: you want to resume where you last left off across devices.
    picked_src = max(sources, key=sources.get)
    frac = sources[picked_src]
    offset = int(frac * max(len(book.text) - 1, 0))
    pos = book.position_at(offset)

    result = {
        'book': path.split('/')[-2],
        'from': 'the X4' if picked_src == 'x4' else 'the audiobook',
        'text_percent': round(frac, 6),
        'chapter': pos.get('chapter'),
        # The phrase to type into Kindle search, chosen to be unique.
        'kindle_phrase': book.searchable_quote(offset),
        'quote': pos.get('quote'),
        'sources': {k: round(v, 4) for k, v in sources.items()},
    }
    return 'done', result, None


def finish(row_id, status, result=None, detail=None):
    body = {'status': status, 'processed_at': 'now()'}
    if result is not None:
        body['result'] = result
    if detail is not None:
        body['detail'] = detail[:500]
    code, resp = sb('PATCH', f'reading_sync_requests?id=eq.{row_id}', body)
    if code >= 300:
        log(f'  ! failed to mark row {row_id}: {code} {resp}')


def resolve_row(row):
    """Turn one request row into a pushed position. Returns (status, result, detail)."""
    key = (row.get('book_key') or '').strip()
    books = find_books()
    path = books.get(key.lower())
    if not path:
        matches = [p for name, p in books.items() if key.lower() in name]
        if len(matches) == 1:
            path = matches[0]
    if not path:
        return 'failed', None, f'no ebook matching {key!r}'

    book = get_book(path)
    doc = document_id(path)
    near = row.get('near')

    user_id = row.get('user_id') or ''
    allow_x4 = (not _x4_owner()) or user_id == _x4_owner()
    abs_token, abs_why_not = abs_token_for(user_id)
    absclient.use_token(abs_token)

    if row['anchor_type'] == 'resume':
        return resolve_resume(path, book, doc, row.get('anchor_value') or 'auto',
                              allow_x4=allow_x4, allow_abs=not abs_why_not)

    if row['anchor_type'] == 'phrase':
        pos, alts = book.find_phrase(row['anchor_value'], near=near)
        if not pos:
            # A miss is nearly always a typo, so hand back what the reader
            # probably meant rather than a dead end. Each suggestion carries
            # the book's OWN wording, so tapping one resubmits as an exact hit.
            try:
                sugg = book.near_matches(row['anchor_value'])
            except Exception as e:                # a failed guess must not mask the miss
                log(f'near_matches failed: {e!r}')
                sugg = []
            detail = ('phrase not found -- did you mean one of these?' if sugg
                      else 'phrase not found in this book')
            return 'not_found', {'suggestions': sugg} if sugg else None, detail
    else:
        try:
            pct = float(str(row['anchor_value']).strip().rstrip('%'))
        except ValueError:
            return 'failed', None, f'bad percent {row["anchor_value"]!r}'
        if pct > 1.0:
            pct /= 100.0
        # A percentage a human typed is on the TEXT ruler, never the device's
        # byte-weighted one -- they differ by up to 22% of a book.
        pos = book.position_at_percent(pct, scale='text')
        alts = []

    result = {
        'book': path.split('/')[-2],
        'document': doc,
        'spine': pos['spine'],
        'paragraph': pos['paragraph'],
        'xpath': pos['xpath'],
        'percent_device': pos['percent'],
        'text_percent': pos['text_percent'],
        'occurrences': pos.get('occurrences'),
        'context': pos['context'],
        # The offline route: the X4 will not always have Wi-Fi, so the app has
        # to be able to tell the user how to reach the spot by hand. Its only
        # tools are the table of contents and a go-to-percent slider -- and
        # that slider is on the DEVICE ruler, which is why percent_device is
        # the number to show here, not text_percent.
        'chapter': pos.get('chapter'),
        'quote': pos.get('quote'),
        'alternatives': [
            {'text_percent': a['text_percent'], 'context': a['context'][:120]}
            for a in alts[:4]
        ],
    }

    targets = list(row.get('targets') or ['x4'])
    pushed = []
    skipped = {}

    # The app asks for both legs by default; the box decides what this reader
    # actually owns. Dropping a target is normal, not a failure.
    if 'x4' in targets and not allow_x4:
        targets.remove('x4')
        skipped['x4'] = 'no X4 on this account'
    if 'abs' in targets and abs_why_not:
        targets.remove('abs')
        skipped['abs'] = abs_why_not
    if skipped:
        result['skipped'] = skipped

    if 'x4' in targets:
        ks = Kosync()
        if not ks.user or not ks.key:
            return 'failed', result, 'kosync not configured on the box'
        if not ks.authorized():
            return 'failed', result, f'kosync auth failed for {ks.user!r}'
        try:
            _, warning = push_position(ks, doc, pos)
        except KosyncError as e:
            return 'failed', result, str(e)
        pushed.append('x4')
        if warning:
            result['warning'] = warning

    if 'abs' in targets:
        try:
            result.update(push_audio(path, book, pos))
            if result.get('abs_seconds') is not None:
                pushed.append('abs')
            # "Actively working on it" = you just synced its audiobook. If it
            # isn't aligned yet, kick that off in the background so every later
            # sync is sentence-exact. This one used chapter interpolation.
            if result.get('abs_precision') in ('chapter', 'linear'):
                maybe_align(path, doc)
        except Exception as e:
            result['abs'] = f'{type(e).__name__}: {e}'

    result['pushed'] = pushed
    if not pushed and skipped:
        # Nothing to push to, but the position itself resolved -- still worth
        # showing, since the Kindle phrase is the useful half for that reader.
        return 'done', result, '; '.join(skipped.values())
    return 'done', result, None


def maybe_align(path, doc):
    """Fire aeneas alignment for a book in the background, at most once.

    Non-blocking: the current sync already returned a (coarse) position; the
    alignment just makes subsequent syncs exact. A lock file stops a second
    launch while one is running or after it has produced a map.
    """
    align_json = os.path.join(ALIGN_DIR, f'{doc}.align.json')
    lock = os.path.join(ALIGN_DIR, f'{doc}.aligning')
    if os.path.exists(align_json) or os.path.exists(lock):
        return
    try:
        os.makedirs(ALIGN_DIR, exist_ok=True)
        open(lock, 'w').close()
        book_key = path.split('/')[-2]
        # Detached: outlives this tick. align.py removes the lock is our job on
        # completion, so wrap it to clear the lock either way.
        subprocess.Popen(
            ['bash', '-c',
             f'python3 {os.path.join(HERE, "align.py")} {json.dumps(book_key)}; '
             f'rm -f {json.dumps(lock)}'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        log(f'started background alignment for {book_key!r}')
    except Exception as e:
        log(f'could not start alignment: {e}')
        try:
            os.remove(lock)
        except OSError:
            pass


_last_catalog = [0.0]
CATALOG_EVERY = 600


def publish_catalog(force=False):
    """Publish the ebook library so the PWA can render a book picker.

    The books live on the box behind plain HTTP, which the HTTPS app cannot
    reach; this is just the index. Cheap enough to redo every 10 minutes, and
    it picks up whatever media-bridge has downloaded since.
    """
    now = time.time()
    if not force and now - _last_catalog[0] < CATALOG_EVERY:
        return
    _last_catalog[0] = now

    rows = []
    for key, path in find_books().items():
        try:
            book = get_book(path)
        except Exception as e:
            log(f'catalog: skipping {key!r}: {type(e).__name__}: {e}')
            continue
        rows.append({
            'book_key': path.split('/')[-2],
            'title': path.split('/')[-2],
            'document_id': document_id(path),
            'spine_count': len(book.spines),
            'char_count': len(book.text),
            'updated_at': 'now()',
        })
    if not rows:
        return
    code, resp = sb('POST', 'reading_books?on_conflict=book_key', rows,
                    prefer='resolution=merge-duplicates')
    if code >= 300:
        log(f'catalog publish failed: {code} {resp}')
    else:
        log(f'catalog: published {len(rows)} books')


_last_place = [0.0]
PLACE_EVERY = 30


def _match_key(s):
    """Fold a title down to something that survives the trip through the box.

    media-bridge names an ebook's folder by stripping punctuation out of the Cue
    title, so "Nothing to See Here!" becomes "Nothing to See Here". Comparing on
    alphanumerics only is what makes the two sides meet.
    """
    return ''.join(c for c in (s or '').lower() if c.isalnum())


def stamp_place_ready(force=False):
    """Close the last leg of a Cue book push: "Place sync established".

    media-bridge stamps fulfillment.place = pending the moment an epub lands in
    EBOOK_DIR, but pending is a promise, not a fact -- the epub still has to
    parse, index, and reach `reading_books` before the PWA can push a position
    to the X4. This daemon owns that leg because it owns the indexer, and it
    only says ready once it has actually opened the file.
    """
    now = time.time()
    if not force and now - _last_place[0] < PLACE_EVERY:
        return
    _last_place[0] = now

    code, recs = sb('GET', 'recommendations?select=id,title,fulfillment'
                           '&fulfillment->place->>state=eq.pending')
    if code >= 300 or not recs:
        return

    # A book is only just-downloaded once; republish so it's in reading_books
    # (the PWA's picker) in seconds rather than on the next 10-minute sweep.
    publish_catalog(force=True)
    books = {_match_key(key): path for key, path in find_books().items()}

    for rec in recs:
        path = books.get(_match_key(rec.get('title')))
        if not path:
            continue                      # epub not on disk yet; try again next pass
        try:
            book = get_book(path)
            place = {
                'state': 'ready',
                'book_key': path.split('/')[-2],
                'document_id': document_id(path),
                'spine_count': len(book.spines),
            }
        except Exception as e:
            place = {'state': 'failed', 'detail': f'{type(e).__name__}: {e}'[:120]}
            log(f'place: {rec.get("title")!r} failed to index: {e!r}')

        cur = rec.get('fulfillment')
        if not isinstance(cur, dict):
            cur = {}
        old = dict(cur.get('place')) if isinstance(cur.get('place'), dict) else {}
        if place['state'] == 'ready':
            old.pop('detail', None)     # "indexing for Place" is stale once it IS indexed
        place['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        cur['place'] = {**old, **place}
        # Merge into whatever media-bridge has written since we read the row --
        # the two daemons share this column and only ever touch their own legs.
        code, resp = sb('PATCH', f'recommendations?id=eq.{rec["id"]}',
                        {'fulfillment': cur}, prefer='return=minimal')
        if code >= 300:
            log(f'place stamp failed: {code} {resp}')
        else:
            log(f'place: {rec.get("title")!r} -> {cur["place"]["state"]}')


def tick():
    publish_catalog()
    stamp_place_ready()
    code, rows = sb('GET',
                    'reading_sync_requests?status=eq.pending&order=created_at.asc&limit=20')
    if code >= 300:
        log(f'poll failed: {code} {rows}')
        return
    for row in rows or []:
        rid = row['id']
        log(f'{rid[:8]} {row.get("book_key")!r} {row["anchor_type"]}={row["anchor_value"]!r}')
        try:
            status, result, detail = resolve_row(row)
        except Exception as e:
            traceback.print_exc()
            status, result, detail = 'failed', None, f'{type(e).__name__}: {e}'
        finally:
            absclient.use_token(None)   # identity must not leak to the next row
        log(f'  -> {status}' + (f' ({detail})' if detail else ''))
        finish(rid, status, result, detail)


def main():
    load_env(os.path.join(HERE, 'reading-sync.env'))
    # Supabase credentials are shared with media-bridge rather than duplicated.
    load_env('/home/nate/media-bridge/bridge.env')
    for required in ('SUPABASE_URL', 'SUPABASE_SERVICE_KEY'):
        if not os.environ.get(required):
            log(f'missing {required}; set it in reading-sync.env or bridge.env')
            return 1
    log(f'started; polling every {POLL_SECONDS}s')
    while True:
        try:
            tick()
        except Exception:
            traceback.print_exc()
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    sys.exit(main() or 0)
