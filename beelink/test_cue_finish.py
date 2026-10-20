"""Pins the pure decision logic in cue-finish.py: how a device event is matched
to a Cue card and what it is allowed to do to it. No network, no sqlite.
Run from the repo root: python3 beelink/test_cue_finish.py
"""
import os, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cf", os.path.join(here, "cue-finish.py"))
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)

# --- folding + timestamps ---------------------------------------------------
assert cf.fold("Nothing to See Here!") == cf.fold("Nothing to See Here")
assert cf.fold("O Brother, Where Art Thou?") == "obrotherwhereartthou"
assert cf.parse_ts("2026-10-18T22:55:40.7666498Z").isoformat() == "2026-10-18T22:55:40.766649+00:00"
assert cf.parse_ts(1792441580159).year == 2026
assert cf.parse_ts("1792441580159").year == 2026
assert cf.parse_ts("2026-10-19").day == 19
assert cf.parse_ts(None) is None and cf.parse_ts("garbage") is None
assert cf.document_id("/x/y/Gone Girl.epub") == cf.document_id("Gone Girl.epub")
print("fold/timestamps: PASS")

# --- matching -----------------------------------------------------------------
movie = {"kind": "movie", "source": "jellyfin", "title": "The Iron Giant", "year": 1999,
         "tmdb": "10386", "finished": True, "started": True, "at": "2026-10-18T22:55:40Z"}
other = {"kind": "movie", "source": "jellyfin", "title": "Frankenweenie", "year": 2012,
         "tmdb": "62214", "finished": True, "started": True, "at": "2026-10-17T19:50:13Z"}
show = {"kind": "tv", "source": "jellyfin", "title": "Fleabag", "year": 2016, "tmdb": "67070",
        "finished": False, "started": True, "at": "2026-10-12T23:10:15Z"}
book = {"kind": "book", "source": "kindle", "title": "Vera or Faith", "year": None, "tmdb": None,
        "finished": False, "started": True, "pct": 0.31, "at": "2026-10-16T02:00:00Z"}
events = [movie, other, show, book]

# tmdb id wins, even when the card's title is spelled differently
assert cf.match_event({"media_type": "movie", "title": "Iron Giant, The",
                       "extension": {"tmdb_id": 10386}}, events) is movie
# a card with an id matches only on that id -- never falls through to a title hit
assert cf.match_event({"media_type": "movie", "title": "The Iron Giant",
                       "extension": {"tmdb_id": 999}}, events) is None
# no id: folded title, year must agree when both known
assert cf.match_event({"media_type": "movie", "title": "The Iron Giant!", "year": 1999}, events) is movie
assert cf.match_event({"media_type": "movie", "title": "The Iron Giant", "year": 2024}, events) is None
assert cf.match_event({"media_type": "movie", "title": "The Iron Giant", "year": None}, events) is movie
# kinds never cross: a film called Fleabag is not the series
assert cf.match_event({"media_type": "movie", "title": "Fleabag"}, events) is None
assert cf.match_event({"media_type": "tv", "title": "Fleabag"}, events) is show
assert cf.match_event({"media_type": "film", "title": "Frankenweenie"}, events) is other
assert cf.match_event({"media_type": "book", "title": "Vera or Faith"}, events) is book
# subtitles on either side are ignored (Audiobookshelf says "Gone Girl: A Novel")
assert cf.titles_agree("Gone Girl", "Gone Girl: A Novel")
assert cf.titles_agree("Slow Productivity: The Lost Art of Accomplishment Without Burnout", "Slow Productivity")
assert not cf.titles_agree("Gone Girl", "Gone Girl 2")
# several book events for one card: a finished one beats an unfinished one,
# and among equals the newest wins -- a stale Kindle row never outvotes the audiobook
stale_kindle = dict(book, title="Gone Girl", pct=0.31, at="2026-10-16T00:00:00Z")
fresh_abs = dict(book, source="audiobookshelf", title="Gone Girl: A Novel", pct=0.89, at="2026-10-19T00:00:00Z")
done_abs = dict(fresh_abs, finished=True, pct=1.0, at="2026-10-01T00:00:00Z")
gg = {"media_type": "book", "title": "Gone Girl"}
assert cf.match_event(gg, [stale_kindle, fresh_abs]) is fresh_abs
assert cf.match_event(gg, [fresh_abs, stale_kindle]) is fresh_abs
assert cf.match_event(gg, [fresh_abs, done_abs, stale_kindle]) is done_abs
print("matching: PASS")

# --- decisions ------------------------------------------------------------------
queued = {"status": "queued", "created_at": "2026-09-01T00:00:00Z", "finished_at": None, "fulfillment": {}}
assert cf.decide(queued, movie) == "finish"
assert cf.decide(dict(queued, status="active"), movie) == "finish"
assert cf.decide(dict(queued, status="saved"), movie) == "finish"
# done is final: the daemon never moves a card backwards or re-finishes it
assert cf.decide(dict(queued, status="done"), movie) is None
assert cf.decide(dict(queued, finished_at="2026-09-02T00:00:00Z"), movie) is None
# watched BEFORE the card existed = a re-watch wish, not a finish
assert cf.decide(dict(queued, created_at="2026-10-19T00:00:00Z"), movie) is None
# started events move queued -> active only
assert cf.decide(queued, show) == "start"
assert cf.decide(dict(queued, status="active"), show) is None
assert cf.decide(queued, book) == "start"
# a Kindle percentage past the line counts as finished even without Mark as finished
assert cf.decide(queued, dict(book, pct=0.995)) == "finish"
assert cf.decide(queued, dict(book, pct=0.95)) == "start"
assert cf.decide(queued, dict(book, pct=0.95), finish_pct=0.9) == "finish"
# below START_PCT the daemon says nothing (caller sets started=False)
assert cf.decide(queued, dict(book, pct=0.01, started=False)) is None
# undo guard: the same device event never acts twice, so Nate's revert sticks
acted = dict(queued, fulfillment={"progress": {"state": "done", "source": "jellyfin",
                                              "event_at": movie["at"]}})
assert cf.decide(acted, movie) is None
assert cf.decide(acted, dict(movie, at="2026-10-20T00:00:00Z")) == "finish"   # a NEW play counts
acted_start = dict(queued, fulfillment={"progress": {"state": "started", "event_at": show["at"]}})
assert cf.decide(acted_start, show) is None
print("decisions: PASS")

# --- fulfillment merge: other daemons' legs survive --------------------------------
cur = {"ebook": {"state": "delivered", "at": "x"}, "place": {"state": "ready"}}
leg = cf.progress_leg(dict(book, pct=0.31), "started")
assert leg == {"state": "started", "source": "kindle", "event_at": book["at"], "pct": 31,
               "detail": None} or leg["pct"] == 31
merged = cf.merge_leg(cur, "progress", leg)
assert merged["ebook"] == cur["ebook"] and merged["place"] == cur["place"]
assert merged["progress"]["state"] == "started" and merged["progress"]["pct"] == 31
assert "at" in merged["progress"]
# same state + same event = no new `at` stamp
again = cf.merge_leg(merged, "progress", leg)
assert again["progress"]["at"] == merged["progress"]["at"]
done = cf.merge_leg(merged, "progress", cf.progress_leg(dict(book, finished=True, pct=1.0,
                                                           detail="Marked finished in KOReader"), "done"))
assert done["progress"]["state"] == "done" and done["progress"]["detail"] == "Marked finished in KOReader"
print("merge: PASS")
print("ALL PASS")
