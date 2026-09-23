"""Pins the "watch" push mode helpers in bridge.py: wait for a good copy (movie)
and follow the season (TV). No network: everything here is pure. Run from the
repo root: python3 beelink/test_watch_mode.py
"""
import os, json, importlib.util
from datetime import datetime, timezone
os.environ.update({
    "SUPABASE_URL": "http://x", "SUPABASE_SERVICE_KEY": "x", "RADARR_KEY": "x",
    "SONARR_KEY": "x", "PROWLARR_KEY": "x", "QBIT_USER": "x", "QBIT_PASS": "x",
    "OFFERS_PATH": "/dev/null"})
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bridge", os.path.join(here, "bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# --- mode parsing: watch is a real mode now, on movies and TV alike ----------
assert "watch" in b.PUSH_MODES
assert b._req_mode({"detail": json.dumps({"mode": "watch"})}) == "watch"
assert b._req_mode({"detail": json.dumps({"mode": "follow"})}) == "auto"   # not a mode
print("mode parsing: PASS")

# --- theater rips: the Coyote vs. Acme trap ---------------------------------
assert b._theater_rip("Coyote.vs.Acme.2026.1080p.DCPRIP.HEVC.x265.RMTeam")
assert b._theater_rip("Some.Movie.2026.1080p.HDCAM.x264")
assert b._theater_rip("Some Movie 2026 720p HDTS")
assert b._theater_rip("Some.Movie.2026.TELESYNC")
assert b._theater_rip("Movie (2026) [TS] 1080p")
assert not b._theater_rip("MobLand.S02E01.REPACK.1080p.AMZN.WEB-DL.DDP5.1.Atmos.H.264-FLUX")
assert not b._theater_rip("The.Arts.Of.War.2026.1080p.WEB-DL")      # "ARTS" must not read as TS
assert not b._theater_rip("Coyote vs. Acme (2026) WEBDL-1080p.mkv")  # Radarr's rename hides it
assert not b._theater_rip("")
assert not b._theater_rip(None)
print("theater rip detection: PASS")

# --- release date: earliest of digital/physical, or nothing ------------------
assert b._movie_release_on({"digitalRelease": "2026-09-29T00:00:00Z", "physicalRelease": "2026-11-09T00:00:00Z"}) == "2026-09-29"
assert b._movie_release_on({"physicalRelease": "2026-11-09T00:00:00Z"}) == "2026-11-09"
assert b._movie_release_on({"inCinemas": "2026-08-20T00:00:00Z"}) is None
assert b._movie_release_on({"digitalRelease": ""}) is None
assert b.watch_detail({"release_on": "2026-09-29", "rip_held": False}) == {"release_on": "2026-09-29"}
assert b.watch_detail({"release_on": None, "rip_held": True}) == {"release_on": None, "rip_held": True}
assert b._days_since("2026-01-01") > 200
assert b._days_since(None) is None and b._days_since("garbage") is None
print("release date: PASS")

# --- follow the season: the plan from Sonarr's episode list ------------------
now = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
def ep(n, air, has, season=2, monitored=True, eid=None):
    return {"id": eid or 600 + n, "seasonNumber": season, "episodeNumber": n,
            "airDateUtc": air, "hasFile": has, "monitored": monitored}
eps = [
    ep(1, "2026-09-18T07:00:00Z", True),
    ep(2, "2026-09-25T07:00:00Z", False),
    ep(3, "2026-10-02T07:00:00Z", False),
    ep(4, "2026-10-09T07:00:00Z", False),
    ep(7, "2026-01-01T07:00:00Z", True, season=1),       # other season: ignored
    ep(0, "2026-01-01T07:00:00Z", False, season=0),      # specials: ignored
    ep(5, "2026-10-16T07:00:00Z", False, monitored=False),  # unmonitored: ignored
]
plan = b._tv_watch_plan(eps, 2, now=now)
assert plan["on_disk"] == [1]
assert plan["missing"] == []
assert plan["total"] == 4
assert plan["detail"]["episodes"] == "1/4"
assert plan["detail"]["pct"] == 25.0
assert plan["detail"]["next_ep"] == "S02E02" and plan["detail"]["next_air"] == "2026-09-25"
assert not plan["complete"]
assert plan["tag"](3) == "S02E03"
print("season plan (mid-season): PASS")

# an aired episode with no file is "missing", not "next"
later = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)
plan = b._tv_watch_plan(eps, 2, now=later)
assert plan["missing"] == [(2, 602)]
assert plan["detail"]["next_ep"] == "S02E03"
assert plan["detail"]["episodes"] == "1/4"
print("season plan (missed episode): PASS")

# finale on disk, nothing left to air -> complete
done = [ep(1, "2026-09-18T07:00:00Z", True), ep(2, "2026-09-25T07:00:00Z", True)]
plan = b._tv_watch_plan(done, 2, now=later)
assert plan["complete"] and plan["detail"]["episodes"] == "2/2" and plan["detail"]["next_ep"] is None
# ...but not while an episode is still unaired, even with everything else on disk
plan = b._tv_watch_plan(done + [ep(3, "2026-10-02T07:00:00Z", False)], 2, now=later)
assert not plan["complete"]
# ...and not on an empty season (nothing monitored) -- an empty plan must not read as done
assert not b._tv_watch_plan([], 2, now=later)["complete"]
# no air date at all counts as aired (Sonarr does the same for "TBA" on old shows)
plan = b._tv_watch_plan([ep(1, None, False)], 2, now=later)
assert plan["missing"] == [(1, 601)]
# whole-show plan (season None) tags without the season prefix
plan = b._tv_watch_plan(eps, None, now=now)
assert plan["tag"](3) == "E03" and plan["total"] == 5   # S1E7 counted, specials + unmonitored still out
print("season plan (finale / edge cases): PASS")

print("ALL PASS")
