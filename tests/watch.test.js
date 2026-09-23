// The "watch" push mode as Cue sees it: the sheet's option lists per type and
// the tray's reading of a 'watching' row. Pure; the bridge writes the detail
// keys asserted here (release_on, rip_held, episodes, next_ep, next_air,
// grabbing).
import { describe, it, expect } from 'vitest'
import { statusView, isActive, dedupeRows, shortDay } from '../src/lib/downloads.js'
import { PUSH_MODES, TV_PUSH_MODES, modesFor } from '../src/components/PushModeSheet.jsx'

const row = (status, detail, extra = {}) => ({ status, detail: detail ? JSON.stringify(detail) : null, ...extra })

describe('modesFor — which sheet a type gets', () => {
  it('movies get all four, ending in watch', () => {
    expect(modesFor('movie')).toBe(PUSH_MODES)
    expect(PUSH_MODES.map((m) => m.key)).toEqual(['auto', 'fastest', 'options', 'watch'])
  })
  it('tv gets auto + follow (the same watch mode)', () => {
    expect(modesFor('tv')).toBe(TV_PUSH_MODES)
    expect(TV_PUSH_MODES.map((m) => m.key)).toEqual(['auto', 'watch'])
  })
  it('books never see a sheet', () => {
    expect(modesFor('book')).toBeNull()
    expect(modesFor('article')).toBeNull()
  })
})

describe('shortDay — a bare day string, never through Date()', () => {
  it('renders month + day', () => {
    expect(shortDay('2026-09-29')).toBe('Sep 29')
    expect(shortDay('2026-10-02T07:00:00Z')).toBe('Oct 2')
  })
  it('returns null on junk', () => {
    expect(shortDay(null)).toBeNull()
    expect(shortDay('soon')).toBeNull()
    expect(shortDay('2026-13-01')).toBeNull()
  })
})

describe('statusView — watching', () => {
  it('is an active status, ranked like a search', () => {
    expect(isActive('watching')).toBe(true)
    const a = { id: 1, title: 'X', media_type: 'movie', status: 'pending', detail: null }
    const b = { id: 2, title: 'X', media_type: 'movie', status: 'watching', detail: JSON.stringify({ arr_id: 9 }) }
    expect(dedupeRows([a, b])[0].id).toBe(2)
  })

  it('movie: shows the release date, calmly', () => {
    const v = statusView(row('watching', { release_on: '2026-09-29' }, { media_type: 'movie' }))
    expect(v).toMatchObject({ label: 'Waiting · Sep 29', tone: 'wait', pct: null })
    expect(v.msg).toBeUndefined()
  })

  it('movie: says when there is no date to wait on', () => {
    const v = statusView(row('watching', { release_on: null }, { media_type: 'movie' }))
    expect(v.label).toBe('Waiting for release')
    expect(v.msg).toBe('no digital date yet')
  })

  it('movie: a held theater rip is still waiting, and says so', () => {
    const v = statusView(row('watching', { release_on: '2026-09-29', rip_held: true }, { media_type: 'movie' }))
    expect(v.label).toBe('Waiting · Sep 29')
    expect(v.msg).toBe('theater rip held back')
    expect(v.tone).not.toBe('fail')
  })

  it('tv: next episode, count on disk, progress bar', () => {
    const v = statusView(row('watching', { episodes: '1/10', pct: 10, next_ep: 'S02E02', next_air: '2026-09-25' }, { media_type: 'tv' }))
    expect(v).toMatchObject({ label: 'Following · next S02E02 Sep 25', tone: 'wait', pct: 10, msg: '1/10 on disk' })
  })

  it('tv: an episode in flight beats the next-air line', () => {
    const v = statusView(row('watching', { episodes: '1/10', pct: 10, next_ep: 'S02E03', next_air: '2026-10-02', grabbing: 'S02E02' }, { media_type: 'tv' }))
    expect(v.label).toBe('Following · grabbing S02E02')
  })

  it('tv: nothing left to air but not yet complete', () => {
    const v = statusView(row('watching', { episodes: '9/10', pct: 90, next_ep: null, next_air: null }, { media_type: 'tv' }))
    expect(v.label).toBe('Following · waiting on the finale')
  })
})
