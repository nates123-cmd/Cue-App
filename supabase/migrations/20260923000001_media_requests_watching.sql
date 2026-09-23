-- "Wait for a good copy" (movies) / "Follow the season" (TV) on a Cue push.
--
-- Both ride the push mode `watch` in detail.mode and park the row on the new
-- status 'watching' instead of 'added'. A movie waits, with no search at all,
-- until Radarr's own availability gate flips on the digital release date; the
-- bridge then moves it to 'added' and the normal pipeline takes over. A show
-- stays 'watching' across the whole season: Sonarr's RSS grabs each episode as
-- it airs, the bridge counts them onto the row (detail.episodes, next_ep,
-- next_air) and pings Telegram per episode, and the row goes 'downloaded' once
-- the last episode is on disk.
--
-- Applied to remote xsmnfcmtbpeaccnyinkr 2026-09-23 via `supabase db query --linked`.

alter table public.media_requests drop constraint if exists media_requests_status_check;

alter table public.media_requests add constraint media_requests_status_check
  check (status = any (array['pending', 'added', 'downloading', 'downloaded', 'failed', 'cancelled', 'choosing', 'watching']));
