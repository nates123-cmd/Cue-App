-- Season-specific TV requests.
--
-- Sonarr was being handed a bare series title and told to monitor "all", so a
-- push for "the one season Nate actually wants" grabbed the entire run. Cue now
-- resolves a season during TV enrichment (TMDB /tv/{id}/season/{n}) and writes
-- the number here; the media-bridge daemon monitors only that season and fires
-- a SeasonSearch instead of searchForMissingEpisodes.
--
-- null season = whole show (movies and books are always null).
--
-- The one-active-request-per-title index has to widen with it: S1 and S2 of the
-- same show are two legitimate live requests, not a duplicate. coalesce(-1)
-- keeps the whole-show row distinct from any numbered season (0 is a real
-- season number in Sonarr — specials).
--
-- Applied to remote xsmnfcmtbpeaccnyinkr 2026-08-04 via Supabase MCP.

alter table public.media_requests
  add column if not exists season integer;

drop index if exists media_requests_one_active_per_title;

create unique index if not exists media_requests_one_active_per_title
  on public.media_requests (user_id, media_type, lower(title), coalesce(season, -1))
  where status <> 'failed';
