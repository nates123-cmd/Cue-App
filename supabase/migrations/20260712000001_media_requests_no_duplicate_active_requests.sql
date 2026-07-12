-- One live request per title, per user.
--
-- Pushing a title that Radarr already has creates a zombie row: Radarr answers
-- "already in Radarr", so the bridge can't attach an arr_id and the row sits on
-- "Searching" forever, showing as a duplicate in Cue's download tray.
--
-- App.pushToRadarr checks for an existing row before inserting; this index closes
-- the double-tap race. Failed rows are excluded so a failure can be retried, and
-- deleting a row from the tray (swipe left) frees the title to be pushed again.
--
-- Applied to remote xsmnfcmtbpeaccnyinkr 2026-07-12 via Supabase MCP.
-- Existing duplicates were cleaned first (kept the row carrying the arr_id).

create unique index if not exists media_requests_one_active_per_title
  on public.media_requests (user_id, media_type, lower(title))
  where status <> 'failed';
