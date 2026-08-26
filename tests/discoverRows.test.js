import { describe, it, expect } from 'vitest'
import { tasteAnchors, tasteGenres, feedRows } from '../src/lib/discover'

// The personal half of the Discover feed is derived, not fetched — anchors,
// genres and the row list are pure functions of the library. Those are what
// these cover; the TMDB calls behind each row are not exercised here.

const item = (over = {}) => ({
  id: over.id || 'i1',
  title: over.title || 'Untitled',
  type: over.type || 'movie',
  status: over.status || 'done',
  rating: over.rating ?? null,
  finished_at: over.finished_at || null,
  extension: over.extension || {},
})

describe('tasteAnchors', () => {
  it('is empty on an empty library', () => {
    expect(tasteAnchors([])).toEqual([])
    expect(tasteAnchors(null)).toEqual([])
  })

  it('only anchors on loved screen items when any are rated', () => {
    const items = [
      item({ id: 'a', title: 'Loved One', rating: 5, finished_at: '2026-08-01' }),
      item({ id: 'b', title: 'Loved Two', rating: 4, finished_at: '2026-07-01' }),
      item({ id: 'c', title: 'Meh', rating: 2, finished_at: '2026-08-20' }),
      item({ id: 'd', title: 'A Book', type: 'book', rating: 5 }),
    ]
    const got = tasteAnchors(items, 2).map((i) => i.id).sort()
    expect(got).toEqual(['a', 'b'])
  })

  it('falls back to finished titles when nothing is rated', () => {
    const items = [
      item({ id: 'a', title: 'Watched', status: 'done', finished_at: '2026-08-01' }),
      item({ id: 'b', title: 'Queued', status: 'queued' }),
    ]
    expect(tasteAnchors(items, 2).map((i) => i.id)).toEqual(['a'])
  })

  it('never repeats an anchor within one feed', () => {
    const items = [
      item({ id: 'a', title: 'One', rating: 5 }),
      item({ id: 'b', title: 'Two', rating: 5 }),
      item({ id: 'c', title: 'Three', rating: 5 }),
    ]
    const ids = tasteAnchors(items, 3).map((i) => i.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('returns fewer anchors than asked rather than padding', () => {
    expect(tasteAnchors([item({ id: 'a', rating: 5 })], 2)).toHaveLength(1)
  })
})

describe('tasteGenres', () => {
  it('ranks by how often a genre shows up in loved items', () => {
    const items = [
      item({ id: 'a', rating: 5, extension: { genres: ['Thriller', 'Drama'] } }),
      item({ id: 'b', rating: 4, extension: { genres: ['Thriller'] } }),
      item({ id: 'c', rating: 5, extension: { genre: 'Comedy' } }),
      // Not loved — must not count, or the row reflects capture volume, not taste.
      item({ id: 'd', rating: 1, extension: { genres: ['Horror', 'Horror'] } }),
    ]
    expect(tasteGenres(items, 2)).toEqual(['Thriller', 'Drama'])
    expect(tasteGenres(items, 4)).not.toContain('Horror')
  })

  it('is empty when nothing loved carries a genre', () => {
    expect(tasteGenres([item({ id: 'a', rating: 5 })])).toEqual([])
  })
})

describe('feedRows', () => {
  it('renders only the generic rows for an empty library', () => {
    const keys = feedRows([]).map((r) => r.key)
    expect(keys[0]).toBe('trending')
    expect(keys).toContain('acclaimed')
    expect(keys).toContain('upcoming')
    expect(keys.some((k) => k.startsWith('because.'))).toBe(false)
    expect(keys).not.toContain('queue.streaming')
  })

  it('adds the personal rows in Netflix order once the library has taste', () => {
    const items = [
      item({ id: 'a', title: 'Heat', rating: 5, extension: { tmdb_id: 949, genres: ['Thriller'] } }),
      item({ id: 'q', title: 'Dune', status: 'queued', extension: { tmdb_id: 438631 } }),
    ]
    const keys = feedRows(items).map((r) => r.key)
    expect(keys[0]).toBe('trending')
    expect(keys[1]).toBe('queue.streaming')
    expect(keys[2]).toBe('because.a')
    expect(keys[3]).toBe('genre.Thriller')
    expect(keys.indexOf('acclaimed')).toBeLessThan(keys.indexOf('new.netflix'))
    expect(keys[keys.length - 1]).toBe('upcoming')
  })

  it('skips the streaming-now row when no queued title has a tmdb id', () => {
    const items = [item({ id: 'q', title: 'Dune', status: 'queued', extension: {} })]
    expect(feedRows(items).map((r) => r.key)).not.toContain('queue.streaming')
  })

  it('gives every row a title, kicker and fetcher', () => {
    for (const row of feedRows([item({ id: 'a', rating: 5, extension: { genres: ['Drama'] } })])) {
      expect(typeof row.title).toBe('string')
      expect(row.title.length).toBeGreaterThan(0)
      expect(typeof row.kicker).toBe('string')
      expect(typeof row.fetch).toBe('function')
    }
  })

  it('keys rows uniquely, so React does not reuse one row for another', () => {
    const items = [
      item({ id: 'a', title: 'One', rating: 5, extension: { genres: ['Drama'] } }),
      item({ id: 'b', title: 'Two', rating: 5, extension: { genres: ['Drama', 'Crime'] } }),
    ]
    const keys = feedRows(items).map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
