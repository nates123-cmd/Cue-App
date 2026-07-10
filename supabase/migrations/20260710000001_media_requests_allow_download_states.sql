-- Widen media_requests.status to carry live download state fed back by the
-- Beelink media-bridge daemon (see bridge.py monitor_downloads). The status now
-- walks pending -> added(=searching) -> downloading -> downloaded, plus failed.
-- The DownloadTray in Cue reads these to render live progress.
--
-- Applied to remote xsmnfcmtbpeaccnyinkr 2026-07-10 via Supabase MCP.

alter table public.media_requests drop constraint if exists media_requests_status_check;

alter table public.media_requests add constraint media_requests_status_check
  check (status = any (array['pending', 'added', 'downloading', 'downloaded', 'failed']));
