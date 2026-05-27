-- Cue adopts Ink's `recommendations` as its queue table. Additive only:
-- new columns are nullable so Ink's existing writes continue unchanged.
--
-- Pre-existing Ink columns (do not depend on names beyond what's used here):
--   id uuid pk, title text, creator text, year int, media_type text,
--   summary text, where_to_find jsonb, raw_input text, source_query text,
--   status text, created_at timestamptz, consumed_at timestamptz.
--
-- Cue also reads media_entries (consumption log, linked via source_entry_id
-- to entries) and restaurant_visits (multi-visit log), both owned by Ink.

alter table public.recommendations
  add column if not exists tags text[] not null default '{}',
  add column if not exists recommended_by text not null default 'me',
  add column if not exists "with" text[] not null default '{}',
  add column if not exists extension jsonb not null default '{}'::jsonb,
  add column if not exists cover_kind text,
  add column if not exists image_tone text[],
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;

-- Status is free text (not enum). Cue treats 'saved' and 'queued' as
-- equivalent on read, but new Cue inserts use 'queued' for clarity.
