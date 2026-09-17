-- "Show me options" on a movie push.
--
-- Cue's push popup now asks how to pick the file: auto (the bridge's speed-first
-- default), fastest (rules waived, no questions) or "show me options". For the
-- last one the media-bridge daemon searches Radarr, writes the best few releases
-- onto the row as detail.options (each with a token) and parks the request on
-- the new status 'choosing' instead of grabbing anything. Cue's tray and popup
-- list those options; tapping one writes its token into `choice`, and the bridge
-- grabs that exact release and moves the row to 'added'. The same tokens back
-- the Telegram tap-to-grab buttons, so a tap on the phone lands on the same row.
--
-- `choice` is its own column rather than a key in `detail` because the bridge
-- does a read-modify-write of `detail` on every tick and would clobber a value
-- Cue slipped in between reads.
--
-- Applied to remote xsmnfcmtbpeaccnyinkr 2026-09-17 via `supabase db query --linked`.

alter table public.media_requests
  add column if not exists choice text;

alter table public.media_requests drop constraint if exists media_requests_status_check;

alter table public.media_requests add constraint media_requests_status_check
  check (status = any (array['pending', 'added', 'downloading', 'downloaded', 'failed', 'cancelled', 'choosing']));
