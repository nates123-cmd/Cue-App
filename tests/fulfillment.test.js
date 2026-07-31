// Tests the REAL exported helpers from src/lib/fulfillment.js.
//
// This module is the only thing standing between a jsonb blob written by two
// separate daemons on the Beelink and what a card claims about a book. The
// daemons are stdlib-Python and will happily write a leg this app has never
// seen, so the contract is: unknown shapes degrade to something harmless,
// absent legs render nothing (never "unknown"), and a landed leg never reads
// as in-flight.
import { describe, it, expect } from 'vitest'
import {
  fulfillmentBadges, hasFulfillment, initialFulfillment, isFullyFulfilled, legBadge,
} from '../src/lib/fulfillment.js'

describe('legBadge — one pipeline leg → one badge', () => {
  it('returns null for a leg that was never attempted', () => {
    expect(legBadge('ebook', undefined)).toBeNull()
    expect(legBadge('ebook', null)).toBeNull()
    expect(legBadge('ebook', {})).toBeNull() // no state = nothing to say
  })

  it('reads Kindle delivery off the ebook leg', () => {
    const b = legBadge('ebook', { state: 'delivered', kindle: 'emailed x.epub (1.9MB) to kindle' })
    expect(b.label).toBe('Ebook delivered')
    expect(b.tone).toBe('done')
    expect(b.title).toContain('emailed')
  })

  it('keeps "downloaded" distinct from "delivered"', () => {
    // On the shelf (so Place and the X4 can reach it) but NOT on the Kindle.
    const b = legBadge('ebook', { state: 'downloaded' })
    expect(b.label).toBe('Ebook downloaded')
    expect(b.tone).toBe('done')
  })

  it('shows percent while downloading and clamps nonsense', () => {
    expect(legBadge('audiobook', { state: 'downloading', pct: 42 }).label).toBe('Audiobook 42%')
    expect(legBadge('audiobook', { state: 'downloading', pct: 999 }).pct).toBe(100)
    expect(legBadge('audiobook', { state: 'downloading', pct: -5 }).pct).toBe(0)
    expect(legBadge('audiobook', { state: 'downloading', pct: 'x' }).label).toBe('Audiobook downloading')
  })

  it('marks in-flight legs with a non-done tone', () => {
    expect(legBadge('ebook', { state: 'searching' }).tone).toBe('wait')
    expect(legBadge('place', { state: 'pending' }).tone).toBe('wait')
    expect(legBadge('audiobook', { state: 'downloading' }).tone).toBe('go')
  })

  it('surfaces the failure reason rather than a bare "failed"', () => {
    const b = legBadge('audiobook', { state: 'failed', detail: 'dead swarm (0 seeders)' })
    expect(b.tone).toBe('fail')
    expect(b.title).toBe('dead swarm (0 seeders)')
  })

  it('does not crash on a state this app has never heard of', () => {
    const b = legBadge('ebook', { state: 'quantum' })
    expect(b.tone).toBe('wait')
    expect(b.label).toBe('Ebook quantum')
  })

  it('place reads as synced when the poller has indexed the epub', () => {
    const b = legBadge('place', { state: 'ready', book_key: 'Pachinko', document_id: 'b5f4' })
    expect(b.label).toBe('Place synced')
    expect(b.tone).toBe('done')
  })
})

describe('fulfillmentBadges — the card view', () => {
  it('is empty for a title that was never pushed', () => {
    expect(fulfillmentBadges({})).toEqual([])
    expect(fulfillmentBadges({ fulfillment: {} })).toEqual([])
    expect(hasFulfillment({ fulfillment: {} })).toBe(false)
  })

  it('survives a fulfillment that is not an object', () => {
    expect(fulfillmentBadges({ fulfillment: 'oops' })).toEqual([])
    expect(fulfillmentBadges({ fulfillment: null })).toEqual([])
  })

  it('orders legs the same way every render', () => {
    const item = {
      fulfillment: {
        place: { state: 'ready' },
        audiobook: { state: 'downloading', pct: 10 },
        ebook: { state: 'delivered' },
      },
    }
    expect(fulfillmentBadges(item).map((b) => b.key)).toEqual(['ebook', 'audiobook', 'place'])
  })

  it('ignores bookkeeping keys that are not legs', () => {
    const item = { fulfillment: { request_id: 'abc-123', ebook: { state: 'delivered' } } }
    expect(fulfillmentBadges(item)).toHaveLength(1)
  })

  it('is only fully fulfilled when every attempted leg landed', () => {
    const done = { fulfillment: { ebook: { state: 'delivered' }, place: { state: 'ready' } } }
    const partial = { fulfillment: { ebook: { state: 'delivered' }, audiobook: { state: 'downloading' } } }
    const failed = { fulfillment: { ebook: { state: 'delivered' }, audiobook: { state: 'failed' } } }
    expect(isFullyFulfilled(done)).toBe(true)
    expect(isFullyFulfilled(partial)).toBe(false)
    expect(isFullyFulfilled(failed)).toBe(false)
    expect(isFullyFulfilled({ fulfillment: {} })).toBe(false) // never pushed ≠ complete
  })
})

describe('initialFulfillment — the optimistic stamp on push', () => {
  it('opens all three legs for a book', () => {
    const f = initialFulfillment('book')
    expect(Object.keys(f).sort()).toEqual(['audiobook', 'ebook', 'place'])
    expect(f.place.state).toBe('pending')
  })

  it('opens a single leg for movie/tv', () => {
    expect(Object.keys(initialFulfillment('movie'))).toEqual(['download'])
    expect(Object.keys(initialFulfillment('tv'))).toEqual(['download'])
  })

  it('renders as in-flight, never as landed', () => {
    expect(isFullyFulfilled({ fulfillment: initialFulfillment('book') })).toBe(false)
    expect(fulfillmentBadges({ fulfillment: initialFulfillment('book') })).toHaveLength(3)
  })
})
