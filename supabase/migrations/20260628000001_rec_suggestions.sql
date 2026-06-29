-- Cue recommendations engine — ephemeral generated suggestions.
--
-- Kept OUT of `recommendations` deliberately: these are model/DB-generated draft
-- recs that must NOT leak into the Library or sync to Ink. Only when the user
-- taps Confirm does a row get promoted into `recommendations` (recommended_by =
-- 'Cue…') via the normal capture flow; the rec_suggestions row is then cleared.
--
-- NOTE (2026-06-28): the app currently persists the last batch + soft-dismissals
-- in localStorage so it works with zero schema changes (and stays truly
-- ephemeral). This table is the optional server-sync path — apply it if/when the
-- batch should follow the user across devices. The engine in src/lib/recs.js
-- already round-trips through a storage abstraction, so switching the backing
-- store to this table is a localized change.

create table if not exists public.rec_suggestions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  batch_id      uuid not null,
  seed_kind     text not null check (seed_kind in ('nl', 'surprise', 'item')),
  seed_ref      text,                    -- query string (nl) or source item id (item)
  title         text not null,
  type          text not null,           -- book|tv|movie|article|video|podcast|music
  source        text not null,           -- tmdb|tastedive|backlog|claude
  facts         jsonb default '{}'::jsonb,
  availability  jsonb default '[]'::jsonb,
  checked_on    date,
  why           text,                    -- null until the card is tapped (lazy)
  dismissed     boolean not null default false,
  created_at    timestamptz not null default now()
);

-- A lightweight marker row supporting "manual refresh persists / last batch
-- survives". One row per user; updated whenever a fresh batch is generated.
create table if not exists public.rec_batches (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  batch_id       uuid not null,
  seed_kind      text not null,
  seed_ref       text,
  last_refreshed timestamptz not null default now()
);

-- Soft negatives — passive only, read at the exclude step. No retraining; taste
-- itself is read in-prompt from existing ratings/tags.
create table if not exists public.rec_dismissals (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title_key  text not null,             -- lower(title) || '|' || type
  created_at timestamptz not null default now(),
  primary key (user_id, title_key)
);

alter table public.rec_suggestions enable row level security;
alter table public.rec_batches      enable row level security;
alter table public.rec_dismissals   enable row level security;

-- Per-user RLS, consistent with the rest of the suite (auth.uid() = user_id).
create policy "own rec_suggestions" on public.rec_suggestions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rec_batches" on public.rec_batches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rec_dismissals" on public.rec_dismissals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists rec_suggestions_user_batch
  on public.rec_suggestions (user_id, batch_id);
