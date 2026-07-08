-- Cue can now push books to the home *arr stack (routed to "Prowler" by the
-- Beelink poller). Widen the media_requests media_type check to allow 'book'
-- alongside the existing 'movie'/'tv'. Book rows carry no tmdb_id; the author
-- is packed into `detail` as JSON to help the book resolver.

alter table public.media_requests
  drop constraint if exists media_requests_media_type_check;

alter table public.media_requests
  add constraint media_requests_media_type_check
  check (media_type = any (array['movie'::text, 'tv'::text, 'book'::text]));
