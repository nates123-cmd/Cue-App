// Tests the REAL exported functions behind the download tray. All pure: no
// network, no Supabase. The cases are anchored to the 2026-09-08 incident in
// which a request Nate had called off had no way to say so.
import { describe, it, expect } from 'vitest'
import { statusView, isActive, dedupeRows, optionsOf } from '../src/lib/downloads.js'

const row = (status, detail) => ({ status, detail: detail ? JSON.stringify(detail) : null })

describe('statusView — every status the bridge can write', () => {
  it('maps the working statuses', () => {
    expect(statusView(row('pending'))).toMatchObject({ label: 'Queued', tone: 'wait' })
    expect(statusView(row('added'))).toMatchObject({ label: 'Searching', tone: 'wait' })
    expect(statusView(row('downloaded'))).toMatchObject({ label: 'Done', tone: 'done', pct: 100 })
  })

  it('shows a percentage while downloading, and copes without one', () => {
    expect(statusView(row('downloading', { pct: 42 }))).toMatchObject({ label: 'Downloading 42%', pct: 42 })
    expect(statusView(row('downloading'))).toMatchObject({ label: 'Downloading', pct: null })
  })

  it('clamps a nonsense percentage rather than rendering it', () => {
    expect(statusView(row('downloading', { pct: 1200 })).pct).toBe(100)
    expect(statusView(row('downloading', { pct: -5 })).pct).toBe(0)
  })

  it('surfaces the reason on a failure', () => {
    expect(statusView(row('failed', { msg: 'no seeders' })))
      .toMatchObject({ label: 'Failed', tone: 'fail', msg: 'no seeders' })
  })

  // The point of the whole change: "Nate stopped this" is not "the stack lost".
  // Before the status existed the bridge had to write 'failed', which read as an
  // error for something that was a deliberate choice.
  it('renders a cancelled request as stopped, not as a failure', () => {
    const v = statusView(row('cancelled', { outcome: 'cancelled' }))
    expect(v.label).toBe('Stopped')
    expect(v.tone).not.toBe('fail')   // muted, so the tray does not cry error
    expect(v.msg).toBeUndefined()     // nothing went wrong, so there is nothing to explain
  })

  it('falls through to the raw status for anything unknown', () => {
    expect(statusView(row('something-new'))).toMatchObject({ label: 'something-new', tone: 'wait' })
    expect(statusView(row(null)).label).toBe('Unknown')
  })

  it('survives a detail column that is not JSON', () => {
    expect(() => statusView({ status: 'downloading', detail: 'not json' })).not.toThrow()
  })
})

describe('isActive — what the tray keeps polling', () => {
  it('polls only the in-flight statuses', () => {
    expect(['pending', 'added', 'downloading'].every(isActive)).toBe(true)
  })

  it('stops polling a cancelled request', () => {
    // A cancelled row that still counted as active would keep the tray spinning
    // on something nobody is waiting for.
    expect(isActive('cancelled')).toBe(false)
    expect(isActive('failed')).toBe(false)
    expect(isActive('downloaded')).toBe(false)
  })
})

describe('dedupeRows — a dead row must not outrank a live one', () => {
  const mk = (id, status, extra = {}) =>
    ({ id, title: 'American Hustle', media_type: 'movie', season: null, status, ...extra })

  it('keeps the live request when a cancelled one shares the title', () => {
    const out = dedupeRows([mk(1, 'cancelled'), mk(2, 'downloading')])
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('downloading')
    expect(out[0].ids.sort()).toEqual([1, 2])
  })

  it('ranks cancelled level with failed, below anything in flight', () => {
    expect(dedupeRows([mk(1, 'cancelled'), mk(2, 'pending')])[0].status).toBe('pending')
    expect(dedupeRows([mk(1, 'failed'), mk(2, 'cancelled')])[0].ids).toHaveLength(2)
  })

  it('still separates seasons of the same show', () => {
    const s1 = { id: 1, title: 'Show', media_type: 'tv', season: 1, status: 'cancelled' }
    const s2 = { id: 2, title: 'Show', media_type: 'tv', season: 2, status: 'downloading' }
    expect(dedupeRows([s1, s2])).toHaveLength(2)
  })
})

// "Show me options" (2026-09-17): the bridge parks a movie push on 'choosing'
// with the candidate list in detail.options, and Cue writes the pick to `choice`.
describe('choosing — a push waiting on a pick', () => {
  const opts = [
    { tok: 'a', title: 'Movie 1080p WEB-DL', gb: 2.1, seeders: 40, ok: true, why: '' },
    { tok: 'b', title: 'Movie 1080p x265', gb: 1.2, seeders: 90, ok: false, why: 'is smaller than minimum allowed' },
  ]

  it('is active, so the tray badge counts it', () => {
    expect(isActive('choosing')).toBe(true)
  })

  it('asks for a pick until one is written, then reads as grabbing', () => {
    const waiting = statusView({ status: 'choosing', detail: JSON.stringify({ options: opts }) })
    expect(waiting).toMatchObject({ label: 'Pick a copy', tone: 'ask' })
    const picked = statusView({ status: 'choosing', choice: 'a', detail: JSON.stringify({ options: opts }) })
    expect(picked).toMatchObject({ label: 'Grabbing…', tone: 'go' })
  })

  it('surfaces a failed grab so another copy can be picked', () => {
    const v = statusView({ status: 'choosing', detail: JSON.stringify({ options: opts, choice_error: 'Radarr said 500' }) })
    expect(v.msg).toBe('Radarr said 500')
  })

  it('lists the options the bridge wrote, and nothing on rows without them', () => {
    expect(optionsOf({ detail: JSON.stringify({ options: opts }) })).toHaveLength(2)
    expect(optionsOf({ detail: JSON.stringify({ options: [{ title: 'no token' }] }) })).toEqual([])
    expect(optionsOf({ detail: 'legacy string' })).toEqual([])
    expect(optionsOf({ detail: null })).toEqual([])
  })

  it('keeps a choosing row over a pending duplicate', () => {
    const rows = dedupeRows([
      { id: 1, title: 'X', media_type: 'movie', status: 'pending', detail: null },
      { id: 2, title: 'X', media_type: 'movie', status: 'choosing', detail: JSON.stringify({ arr_id: 7, options: opts }) },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(2)
    expect(rows[0].ids).toEqual([1, 2])
  })
})
