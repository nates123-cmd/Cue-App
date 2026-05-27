-- Persist rating + notes on the recommendations row directly, in addition to
-- the media_entries log row written on finish. Lets the canonical queue row
-- carry the verdict without a most-recent-by-title join.
alter table public.recommendations
  add column if not exists rating int,
  add column if not exists notes text,
  add constraint recommendations_rating_range check (rating is null or rating between 1 and 3);
