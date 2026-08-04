// Tests the REAL exported functions behind the TV season picker — no
// re-implementation, no network. Every case here exercises a code path that
// runs entirely offline: dedupeRows is pure, and pickSeason(card, null) returns
// before it would ever reach TMDB.
import { describe, it, expect } from 'vitest'
import { dedupeRows } from '../src/lib/downloads.js'
import { toSeason } from '../src/lib/items.js'
import { pickSeason } from '../src/lib/enrichment.js'

// ---------------------------------------------------------------------------
// toSeason — the guard between "no season" and "season 0". Number(null) is 0
// and Number('') is 0, so the naive check turns a whole-show request into a
// request for Specials. Every caller (enrich, pickSeason, pushToRadarr) routes
// through here, so these cases are the whole contract.
// ---------------------------------------------------------------------------
describe('toSeason — whole show vs a real season number', () => {
  it('treats null, undefined and empty string as the whole show', () => {
    expect(toSeason(null)).toBeNull()
    expect(toSeason(undefined)).toBeNull()
    expect(toSeason('')).toBeNull()
  })

  it('passes real season numbers through, including from strings', () => {
    expect(toSeason(1)).toBe(1)
    expect(toSeason(12)).toBe(12)
    expect(toSeason('3')).toBe(3)
  })

  it('keeps 0 as a genuine season number when it is actually given', () => {
    expect(toSeason(0)).toBe(0)
  })

  it('rejects junk rather than coercing it', () => {
    expect(toSeason('two')).toBeNull()
    expect(toSeason(NaN)).toBeNull()
    expect(toSeason({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// dedupeRows — the tray collapses duplicate pushes of one title. Season is part
// of a request's identity, so two seasons of one show must survive as two rows.
// Getting this wrong hides half of what's downloading.
// ---------------------------------------------------------------------------
describe('dedupeRows — season is part of a request identity', () => {
  const row = (over) => ({
    id: 'x', title: 'Severance', media_type: 'tv', season: null,
    status: 'downloading', detail: null, ...over,
  })

  it('keeps two different seasons of the same show as separate rows', () => {
    const out = dedupeRows([
      row({ id: 'a', season: 1 }),
      row({ id: 'b', season: 2 }),
    ])
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.season).sort()).toEqual([1, 2])
  })

  it('still collapses genuine duplicates of the SAME season', () => {
    const out = dedupeRows([
      row({ id: 'a', season: 2, status: 'added' }),
      row({ id: 'b', season: 2, status: 'downloading', detail: JSON.stringify({ arr_id: 7 }) }),
    ])
    expect(out).toHaveLength(1)
    // The row that actually tracks a download wins, and carries both ids so a
    // swipe-delete removes the zombie too.
    expect(out[0].id).toBe('b')
    expect(out[0].ids.sort()).toEqual(['a', 'b'])
  })

  it('treats a whole-show request as distinct from any numbered season', () => {
    const out = dedupeRows([row({ id: 'a', season: null }), row({ id: 'b', season: 1 })])
    expect(out).toHaveLength(2)
  })

  it('does not confuse two shows that share a season number', () => {
    const out = dedupeRows([
      row({ id: 'a', title: 'Severance', season: 1 }),
      row({ id: 'b', title: 'Andor', season: 1 }),
    ])
    expect(out).toHaveLength(2)
  })

  it('survives legacy rows with no season field at all', () => {
    const legacy = { id: 'a', title: 'Dune', media_type: 'movie', status: 'downloading', detail: null }
    expect(() => dedupeRows([legacy])).not.toThrow()
    expect(dedupeRows([legacy])).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// pickSeason(card, null) — "back to whole show". Must strip every season-scoped
// field, because extension.season is exactly what App.pushToRadarr sends to
// Sonarr. A leftover season here means the download manager keeps hunting a
// season the user just deselected.
// ---------------------------------------------------------------------------
describe('pickSeason — clearing back to the whole show', () => {
  const seasonCard = () => ({
    title: 'Severance',
    type: 'tv',
    synopsis: 'Season two picks up right where the severed floor left off.',
    image_url: 'https://img/s2.jpg',
    _show: { synopsis: 'Mark works for Lumon.', image_url: 'https://img/show.jpg' },
    extension: {
      tmdb_id: 95396,
      network_or_service: 'Apple TV+',
      seasons: 2,
      season: 2,
      season_name: 'Season 2',
      season_episodes: 10,
      season_year: 2025,
    },
  })

  it('removes every season-scoped extension field', async () => {
    const out = await pickSeason(seasonCard(), null)
    expect(out.extension.season).toBeUndefined()
    expect(out.extension.season_name).toBeUndefined()
    expect(out.extension.season_episodes).toBeUndefined()
    expect(out.extension.season_year).toBeUndefined()
  })

  it('keeps the show-level facts intact', async () => {
    const out = await pickSeason(seasonCard(), null)
    expect(out.extension.seasons).toBe(2)
    expect(out.extension.tmdb_id).toBe(95396)
    expect(out.extension.network_or_service).toBe('Apple TV+')
  })

  it('restores the show synopsis and poster from the snapshot', async () => {
    const out = await pickSeason(seasonCard(), null)
    expect(out.synopsis).toBe('Mark works for Lumon.')
    expect(out.image_url).toBe('https://img/show.jpg')
  })

  it('keeps synopsis and enrichment.synopsis in lockstep — the save path reads the nested one', async () => {
    const out = await pickSeason(seasonCard(), null)
    expect(out.enrichment.synopsis).toBe(out.synopsis)
  })

  it('leaves non-TV cards completely alone', async () => {
    const movie = { title: 'Dune', type: 'movie', extension: { release_year: 2021 } }
    expect(await pickSeason(movie, null)).toBe(movie)
  })

  it('does not mutate the card it was given', async () => {
    const card = seasonCard()
    await pickSeason(card, null)
    expect(card.extension.season).toBe(2)
    expect(card.synopsis).toContain('Season two')
  })
})
