-- Backfill: give existing library cards their pipeline history.
--
-- Everything Nate has ever pushed already recorded what happened, but only in
-- `media_requests.detail` — which no card reads and the tray forgets. Without
-- this, sticky status would start blank and only fill in for titles pushed from
-- today onward, which reads as "nothing was ever delivered".
--
-- Applied to the remote 2026-07-31. Idempotent: it only links requests whose
-- title matches exactly ONE recommendation (an ambiguous title is left alone
-- rather than guessed at), and only writes cards whose fulfillment is still {}.

-- 1. Link old requests back to their card.
with u as (
  select lower(title) k, media_type mt,
         (array_agg(id order by created_at desc))[1] rec_id,
         count(*) n
  from public.recommendations
  group by 1, 2
)
update public.media_requests m
set rec_id = u.rec_id
from u
where m.rec_id is null
  and lower(m.title) = u.k
  and m.media_type = u.mt
  and u.n = 1;                       -- exactly one candidate; never guess

-- 2. Derive each leg from what the bridge recorded at the time.
with d as (
  select distinct on (m.rec_id)
         m.rec_id, m.media_type, m.status,
         -- legacy rows carry a plain human string here, not JSON
         case when m.detail ~ '^\s*\{' then m.detail::jsonb else '{}'::jsonb end as j
  from public.media_requests m
  where m.rec_id is not null
  order by m.rec_id, m.requested_at desc
),
legs as (
  select rec_id,
    case when media_type = 'book' then
      jsonb_strip_nulls(jsonb_build_object(
        'ebook', case
          when j #>> '{books,ebook,kindle}' like 'emailed%'
            then jsonb_build_object('state', 'delivered', 'kindle', j #>> '{books,ebook,kindle}')
          when j #> '{books,ebook,imported}' = 'true'::jsonb
            then jsonb_build_object('state', 'downloaded')
          when j ? 'books' and not (j -> 'books') ? 'ebook'
            then jsonb_build_object('state', 'failed', 'detail', 'no ebook found')
          else null end,
        'audiobook', case
          when j #> '{books,audiobook,imported}' = 'true'::jsonb
            then jsonb_build_object('state', 'downloaded')
          when j #> '{books,audiobook,dead}' = 'true'::jsonb
            then jsonb_build_object('state', 'failed', 'detail', 'no live seeders left')
          when j ? 'books' and not (j -> 'books') ? 'audiobook'
            then jsonb_build_object('state', 'failed', 'detail', 'no audiobook found')
          else null end,
        -- Deliberately 'pending', not 'ready': whether Place can actually sync a
        -- book is a fact about a parseable epub on disk, and only the
        -- reading-sync poller can establish that. It picks these up within 30s
        -- and promotes them itself.
        'place', case
          when j #> '{books,ebook,imported}' = 'true'::jsonb
            then jsonb_build_object('state', 'pending', 'detail', 'indexing for Place')
          else null end
      ))
    else
      jsonb_build_object('download', jsonb_build_object('state',
        case when status = 'downloaded' then 'downloaded'
             when status = 'failed' then 'failed'
             else 'searching' end))
    end as f
  from d
)
update public.recommendations r
set fulfillment = legs.f
from legs
where r.id = legs.rec_id
  and r.fulfillment = '{}'::jsonb    -- never overwrite a live stamp
  and legs.f <> '{}'::jsonb;
