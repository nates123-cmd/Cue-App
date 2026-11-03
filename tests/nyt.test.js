import { describe, it, expect } from 'vitest'
import { pickSearchMatch, shortDate, nytLine, nytRows } from '../src/lib/discover'
import NYT_PICKS from '../src/data/nyt-picks.json'

describe('pickSearchMatch', () => {
  const tv = (id, name, first_air_date) => ({ id, name, first_air_date })
  it('prefers exact title in the pick year over an older exact title', () => {
    const r = [tv(1, 'Carrie', '2002-11-04'), tv(2, 'Carrie', '2026-10-07')]
    expect(pickSearchMatch(r, { title: 'Carrie', type: 'tv', year: 2026 }).id).toBe(2)
  })
  it('prefers exact title over a fuzzy first result', () => {
    const r = [tv(1, 'War of the Worlds', '2019-10-28'), tv(2, 'War', '2026-10-01')]
    expect(pickSearchMatch(r, { title: 'War', type: 'tv', year: 2026 }).id).toBe(2)
  })
  it('ignores punctuation and case', () => {
    const r = [tv(9, 'avatar - seven havens', '2026-10-09')]
    expect(pickSearchMatch(r, { title: 'Avatar: Seven Havens', type: 'tv', year: 2026 }).id).toBe(9)
  })
  it('falls back to the first result, and null on nothing', () => {
    expect(pickSearchMatch([tv(5, 'Something', '2020-01-01')], { title: 'X', type: 'tv' }).id).toBe(5)
    expect(pickSearchMatch([], { title: 'X', type: 'tv' })).toBe(null)
  })
  it('uses release_date and title for movies', () => {
    const r = [{ id: 1, title: 'Tenzing', release_date: '1990-01-01' }, { id: 2, title: 'Tenzing', release_date: '2026-10-16' }]
    expect(pickSearchMatch(r, { title: 'Tenzing', type: 'movie', year: 2026 }).id).toBe(2)
  })
})

describe('nyt formatting', () => {
  it('shortDate never shifts the day', () => {
    expect(shortDate('2026-10-01')).toBe('Oct 1')
    expect(shortDate('bad')).toBe(null)
  })
  it('nytLine shows season only past S1', () => {
    expect(nytLine({ service: 'Hulu', season: 2, date: '2026-10-14' })).toBe('Hulu · S2 · Oct 14')
    expect(nytLine({ service: 'Peacock', season: 1, date: '2026-10-15' })).toBe('Peacock · Oct 15')
  })
})

describe('nytRows', () => {
  it('newest month first, capped at three', () => {
    const b = (month) => ({ month, label: month, picks: [] })
    const rows = nytRows([b('2026-08'), b('2026-11'), b('2026-09'), b('2026-10')])
    expect(rows.map((r) => r.key)).toEqual(['nyt.2026-11', 'nyt.2026-10', 'nyt.2026-09'])
  })
  it('shipped data is well formed', () => {
    for (const block of NYT_PICKS) {
      expect(block.month).toMatch(/^\d{4}-\d{2}$/)
      for (const p of block.picks) {
        expect(['movie', 'tv']).toContain(p.type)
        expect(p.title && p.note && p.service).toBeTruthy()
        expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })
})
