-- Sticky per-card fulfillment status.
--
-- `media_requests` is a transient outbox: the tray hides finished rows after a
-- day and a swipe-delete drops them entirely, so it can't answer "did this book
-- ever reach my Kindle?" six weeks later. Park the durable answer on the
-- library card itself.
--
-- Shape (all keys optional; absent leg == never attempted):
--   {
--     "request_id": "<media_requests uuid>",
--     "ebook":     {"state":"searching|downloading|downloaded|delivered|failed",
--                   "pct": 42, "kindle": "emailed x.epub (1.9MB) to kindle",
--                   "detail": "...", "at": "2026-07-31T12:00:00Z"},
--     "audiobook": {"state":"...", "pct": 0, "at": "..."},
--     "place":     {"state":"pending|ready|failed", "book_key":"Pachinko",
--                   "document_id":"<md5>", "at":"..."}
--   }
--
-- Deliberately its OWN column, not a key inside `extension`: the Beelink daemons
-- write this with the service key while the app writes `extension` from enrich
-- and inline edits. Both sides do read-modify-write on a jsonb, so sharing one
-- column would let a download stamp clobber an edit (exactly the landmine that
-- re-sent a book to the Kindle when a media_requests.detail write raced a tick).
alter table public.recommendations
  add column if not exists fulfillment jsonb not null default '{}'::jsonb;

-- Lets the daemons stamp the right card. The bridge only ever sees the
-- media_requests row, and matching back by title is fuzzy (the importer
-- sanitizes punctuation out of folder names, Prowlarr release titles differ
-- again). Carry the id explicitly.
alter table public.media_requests
  add column if not exists rec_id uuid;

create index if not exists media_requests_rec_id_idx
  on public.media_requests (rec_id)
  where rec_id is not null;
