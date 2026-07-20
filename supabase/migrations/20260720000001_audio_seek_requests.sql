-- Cue "resume in audio" outbox: the app inserts a pending seek; the Beelink
-- media-bridge polls it and writes the position into Audiobookshelf via
-- /api/me/progress. Applied to remote (ref xsmnfcmtbpeaccnyinkr) 2026-07-20.
create table if not exists public.audio_seek_requests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid(),
  abs_item_id      text not null,                       -- Audiobookshelf libraryItemId
  current_time_sec double precision not null,           -- absolute seconds into the audiobook
  book_title       text,                                -- for logging / display
  anchor_phrase    text,                                -- the text the user pasted (audit)
  status           text not null default 'pending',     -- pending | done | failed
  detail           text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);

create index if not exists audio_seek_requests_pending_idx
  on public.audio_seek_requests (status, created_at)
  where status = 'pending';

alter table public.audio_seek_requests enable row level security;

-- per-user RLS (auth.uid() = user_id); the bridge uses the service key -> bypasses RLS.
create policy audio_seek_sel on public.audio_seek_requests
  for select using (auth.uid() = user_id);
create policy audio_seek_ins on public.audio_seek_requests
  for insert with check (auth.uid() = user_id);
create policy audio_seek_upd on public.audio_seek_requests
  for update using (auth.uid() = user_id);
