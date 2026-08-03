-- Cue ratings go from a 3-point scale to 1..5.
--
-- These two tables already disagreed: Ink's `media_entries` has been
-- CHECK (rating >= 1 AND rating <= 5) all along, while `recommendations` was
-- CHECK (rating IS NULL OR (rating >= 1 AND rating <= 3)). Cue's finish action
-- writes BOTH, so a Cue "3 = loved it" was landing in Ink's log as a middling
-- 3 out of 5. Widening recommendations makes the two scales agree.
--
-- Widening only -- every existing value (1, 2, 3) still satisfies the new
-- constraint, so no row can fail and nothing needs rewriting here. Rescaling
-- the meaning of the old 1..3 values is a separate, deliberate data decision.

alter table public.recommendations
  drop constraint if exists recommendations_rating_range;

alter table public.recommendations
  add constraint recommendations_rating_range
  check (rating is null or (rating >= 1 and rating <= 5));

comment on column public.recommendations.rating is
  'Cue rating, 1..5. Matches media_entries.rating so the two stay comparable.';
