"""Pins the Cue push-mode pickers in bridge.py against a real captured search
(113 Better Call Saul releases, 2026-08-29). No network: everything here is
pure. Run from the repo root: python3 beelink/test_push_modes.py
"""
import os, json, importlib.util
os.environ.update({
    "SUPABASE_URL": "http://x", "SUPABASE_SERVICE_KEY": "x", "RADARR_KEY": "x",
    "SONARR_KEY": "x", "PROWLARR_KEY": "x", "QBIT_USER": "x", "QBIT_PASS": "x",
    "OFFERS_PATH": "/dev/null"})
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bridge", os.path.join(here, "bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

rels = json.load(open(os.path.join(here, "testdata-releases.json")))

# --- mode parsing: the JSON Cue packs into detail on insert -----------------
assert b._req_mode({"detail": None}) == "auto"
assert b._req_mode({"detail": "not json"}) == "auto"
assert b._req_mode({"detail": json.dumps({"author": "x"})}) == "auto"      # a book row
assert b._req_mode({"detail": json.dumps({"mode": "fastest"})}) == "fastest"
assert b._req_mode({"detail": json.dumps({"mode": "options"})}) == "options"
assert b._req_mode({"detail": json.dumps({"mode": "yolo"})}) == "auto"
print("mode parsing: PASS")

# --- "show me options": the list Cue and Telegram render --------------------
opts = b.pick_options(rels)
assert 0 < len(opts) <= b.MAX_CHOICES, len(opts)
titles = [b._norm_title(r.get("title")) for r in opts]
assert len(titles) == len(set(titles)), "same release offered twice"
# in-rules copies lead, and inside each group the fastest (seed/GB) is first
ok_flags = [bool(r.get("approved")) for r in opts]
assert ok_flags == sorted(ok_flags, reverse=True), "an out-of-rules copy ranked above an in-rules one"
for grp in (True, False):
    keys = [b._speed_key(r) for r in opts if bool(r.get("approved")) == grp]
    assert keys == sorted(keys, reverse=True), "group not fastest-first"
for r in opts:
    if not r.get("approved"):
        assert b._offerable(r), "a hard-rejected release made the list"
        rj = " ".join(r.get("rejections") or []).lower()
        assert "unknown series" not in rj and "wrong season" not in rj and "multi-season" not in rj
        assert (r.get("seeders") or 0) >= b.MIN_OFFER_SEEDERS
print("options list: PASS (%d candidates, %d in rules)" % (len(opts), sum(ok_flags)))

d = b._option_dict("tok123", opts[0], "radarr", "release?movieId=1")
for k in ("tok", "title", "gb", "seeders", "per_gb", "uploaded", "ok", "why", "guid", "indexerId", "app", "search"):
    assert k in d, k
assert d["tok"] == "tok123" and d["app"] == "radarr"
assert (d["ok"] and d["why"] == "") or (not d["ok"] and d["why"])
print("option dict: PASS")

# --- upload date: shown as a day in every line and on the Cue option ---------
dated = dict(opts[0], publishDate="2012-08-15T22:00:00Z")
assert b._uploaded(dated) == "2012-08-15"
assert b._describe(dated).endswith(", up 2012-08-15")
assert b._option_dict("t", dated, "radarr", "x")["uploaded"] == "2012-08-15"
undated = dict(opts[0]); undated.pop("publishDate", None)
assert b._uploaded(undated) == "" and "up " not in b._describe(undated)   # no date, no noise
assert b._uploaded(dict(opts[0], publishDate="bad")) == ""
print("upload date: PASS")

# --- "fastest": rules waived, but never a wrong or junk release -------------
ok, below = b._speed_split(rels)
cands = sorted(ok + below, key=b._speed_key, reverse=True)
assert cands, "nothing grabbable"
fastest = cands[0]
assert b._grabbable(fastest)
assert fastest.get("approved") or b._offerable(fastest)
assert all(b._speed_key(cands[i]) >= b._speed_key(cands[i + 1]) for i in range(len(cands) - 1))
hard = [r for r in rels if not r.get("approved") and not b._offerable(r)]
assert not any(r is fastest for r in hard), "fastest picked a hard-rejected release"
print("fastest: PASS  (%s -- %s)" % ((fastest.get("title") or "?")[:50], b._describe(fastest)))

# --- offer tokens carry the request id so a Telegram tap settles the row ----
b._offers.clear()
t1 = b._offer_token("radarr", opts[0], "release?movieId=1", req_id="req-1")
t2 = b._offer_token("radarr", opts[0], "release?movieId=1", req_id="req-1")
assert t1 == t2, "one token per (app, guid)"
assert b._offers[t1]["req_id"] == "req-1"
lbl, url = b._offer("radarr", opts[0], "release?movieId=1")
assert url.endswith("t=" + t1) and lbl.startswith("Grab ")
print("offer tokens: PASS")
print("\nALL PASS")
