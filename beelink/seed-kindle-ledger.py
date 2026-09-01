#!/usr/bin/env python3
"""One-shot: build kindle-sent.json from everything already mailed.

The dedupe ledger `bridge.py` now consults is empty on first run, which would
let the next re-push of an already-delivered book mail it one final time. This
backfills it from the two records of what actually went out:

  1. `media_requests.detail.books.ebook.kindle` -- the stamp on rows that still
     exist, resolved to the requester's own Kindle address.
  2. the media-bridge journal -- the only record for books whose row was since
     deleted or rewritten (The Stench of Honolulu has three sends and no row).

Idempotent: re-running only ever adds keys. Run on the box, with bridge.env
sourced, then restart media-bridge:

    set -a; . /home/nate/media-bridge/bridge.env; set +a
    python3 seed-kindle-ledger.py
"""
import json, os, re, subprocess, sys, time, urllib.request

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_SERVICE_KEY"]
KINDLE_EMAIL = os.environ.get("KINDLE_EMAIL", "")
KINDLE_OWNER_ID = os.environ.get("KINDLE_OWNER_ID", "")
LEDGER = os.environ.get("KINDLE_LEDGER", "/home/nate/media-bridge/kindle-sent.json")
DRY = "--apply" not in sys.argv


def sb(path):
    req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}", headers={
        "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def key(to_addr, title):
    """Must stay identical to bridge.py's _kindle_key()."""
    t = re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()
    return f"{(to_addr or '').strip().lower()}|{t}"


# Every Kindle address the stack knows about, so a log line's "to <prefix>"
# can be resolved back to the full address the ledger keys on.
addr_by_user = {}
for row in sb("user_settings?key=eq.kindle_email&select=user_id,value"):
    v = (row.get("value") or "").strip()
    if v:
        addr_by_user[row["user_id"]] = v
known = set(addr_by_user.values()) | ({KINDLE_EMAIL} if KINDLE_EMAIL else set())
by_prefix = {a.split("@")[0]: a for a in known}


def addr_for(user_id):
    if user_id in addr_by_user:
        return addr_by_user[user_id]
    if not user_id or not KINDLE_OWNER_ID or user_id == KINDLE_OWNER_ID:
        return KINDLE_EMAIL
    return ""


try:
    with open(LEDGER) as f:
        ledger = json.load(f)
except Exception:
    ledger = {}
before = len(ledger)


def add(addr, title, msg, at):
    if not addr or not title:
        return
    k = key(addr, title)
    if k in ledger:                       # keep the earliest send we know of
        return
    ledger[k] = {"at": at, "title": title, "msg": msg}
    print(f"  + {at}  {addr.split('@')[0]:24} {title}")


# --- 1. rows that still exist -------------------------------------------------
print("from media_requests:")
for r in sb("media_requests?media_type=eq.book&select=title,user_id,detail,processed_at"):
    try:
        d = json.loads(r.get("detail") or "{}")
    except Exception:
        continue
    meta = ((d.get("books") or {}).get("ebook") or {})
    stamp = meta.get("kindle") or ""
    if not stamp.startswith("emailed"):        # failures and "no epub" don't count
        continue
    add(addr_for(r.get("user_id")), r.get("title"), stamp,
        (r.get("processed_at") or "")[:19] or time.strftime("%Y-%m-%dT%H:%M:%S"))

# --- 2. the journal, for rows that no longer exist ----------------------------
print("from the journal:")
LINE = re.compile(r"^(\w{3} \d{2} \d{2}:\d{2}:\d{2}).*kindle '(.+?)': (emailed .*? to (\S+))$")
try:
    out = subprocess.run(["journalctl", "-u", "media-bridge", "--no-pager"],
                         capture_output=True, text=True, timeout=120).stdout
except Exception as e:
    out = ""
    print("  (journal unreadable:", repr(e), ")")
year = time.strftime("%Y")
for line in out.splitlines():
    m = LINE.match(line)
    if not m:
        continue
    when, title, msg, who = m.groups()
    addr = KINDLE_EMAIL if who == "kindle" else by_prefix.get(who, "")
    if not addr:
        print(f"  ? unresolved recipient {who!r} for {title!r} -- skipped")
        continue
    try:                                       # journal stamps carry no year
        t = time.strptime(f"{year} {when}", "%Y %b %d %H:%M:%S")
        at = time.strftime("%Y-%m-%dT%H:%M:%S", t)
    except Exception:
        at = when
    add(addr, title, msg, at)

print(f"\n{before} -> {len(ledger)} entries", "(dry run, pass --apply to write)" if DRY else "")
if not DRY:
    tmp = LEDGER + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ledger, f, sort_keys=True, indent=0)
    os.replace(tmp, LEDGER)
    print("wrote", LEDGER)
