-- Cue: the "Up Next" shortlist.
--
-- The queue is a ~108-row flat pile; status ('queued'/'active'/'done') is a
-- lifecycle, not a priority, so ordering can't ride on it. queue_rank is an
-- explicit, orthogonal ordering: NULL means "in the backlog, unranked", and a
-- non-null integer means "on the shortlist, at this position (ascending)".
--
-- Additive and nullable, so Ink -- which owns this table and writes 'saved'
-- rows -- is unaffected and needs no change.

alter table public.recommendations
  add column if not exists queue_rank integer;

comment on column public.recommendations.queue_rank is
  'Cue "Up Next" shortlist position, ascending. NULL = not on the shortlist.';

-- Partial index: the shortlist is a handful of rows out of hundreds, and it is
-- read ordered on every Active-tab render.
create index if not exists recommendations_queue_rank_idx
  on public.recommendations (queue_rank)
  where queue_rank is not null;
