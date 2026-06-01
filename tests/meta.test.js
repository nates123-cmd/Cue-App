// Tests the REAL exported functions from src/lib/meta.js — no re-implementation.
import { describe, it, expect } from 'vitest'
import {
  metaFor,
  TYPE_META,
  TYPE_ORDER,
  editionForHour,
  formatClock,
  PARTNER,
} from '../src/lib/meta.js'

// ---------------------------------------------------------------------------
// metaFor() — #1 risk. Defensive type lookup that MUST NOT throw on legacy
// rows with surprise / unknown `type` values. Callers do metaFor(item.type).spine
// unguarded, so a thrown error or undefined return would crash the renderer.
// ---------------------------------------------------------------------------
describe('metaFor — defensive lookup (must never throw / never return undefined)', () => {
  const KNOWN = ['book', 'tv', 'movie', 'article', 'video']

  it('returns the correct meta object for each of the known types', () => {
    for (const t of KNOWN) {
      const m = metaFor(t)
      expect(m).toBe(TYPE_META[t])
      expect(m).toHaveProperty('label')
      expect(m).toHaveProperty('plural')
      expect(m).toHaveProperty('spine')
    }
  })

  it('every known type resolves to a non-empty 2-char spine (CueBar/primitives render .spine)', () => {
    for (const t of KNOWN) {
      const { spine } = metaFor(t)
      expect(typeof spine).toBe('string')
      expect(spine.length).toBeGreaterThan(0)
    }
  })

  // The crux: feed it everything weird a legacy row could carry.
  const SURPRISE = [
    ['unknown string', 'restaurant'], // legacy type moved to Ink
    ['film alias not in registry', 'film'],
    ['empty string', ''],
    ['arbitrary garbage', 'banana'],
    ['uppercase known type', 'BOOK'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { weird: true }],
    ['array', ['movie']],
    ['boolean', true],
    ['NaN', NaN],
  ]

  it.each(SURPRISE)('does not throw and returns a usable meta object for %s', (_label, val) => {
    let m
    expect(() => { m = metaFor(val) }).not.toThrow()
    expect(m).toBeDefined()
    expect(m).not.toBeNull()
    // Caller immediately reads .spine / .label — they must exist and be strings.
    expect(typeof m.spine).toBe('string')
    expect(typeof m.label).toBe('string')
    expect(typeof m.plural).toBe('string')
  })

  it('unknown types fall back to the neutral placeholder (label "Item")', () => {
    expect(metaFor('banana').label).toBe('Item')
    expect(metaFor(null).label).toBe('Item')
    expect(metaFor(undefined).spine).toBe('··')
  })

  // REGRESSION (fixed) — src/lib/meta.js:16
  //   was:   return TYPE_META[type] || FALLBACK_META
  //   now:   return Object.hasOwn(TYPE_META, type) ? TYPE_META[type] : FALLBACK_META
  // Because TYPE_META is a plain object literal, a `type` matching an
  // Object.prototype member name ('constructor', 'toString', 'valueOf',
  // 'hasOwnProperty', '__proto__', ...) used to resolve via the prototype chain
  // to a truthy function, so the `|| FALLBACK_META` guard NEVER fired. metaFor()
  // returned the Object constructor and callers reading `.spine` / `.label`
  // (CueBar.jsx:23, primitives.jsx:85/131/...) got `undefined` — rendering a
  // literal "undefined" and risking a throw on any `.spine.length` access.
  // The own-property-gated lookup now makes these fall back like any other
  // unknown type. These assertions pin the FIXED behavior.
  const PROTO_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty']
  it.each(PROTO_NAMES)('prototype-member type name %s falls back to FALLBACK_META (deep-equal)', (name) => {
    const r = metaFor(name)
    // Deep-equals the neutral placeholder, not the Object constructor / junk.
    expect(r).toEqual({ label: 'Item', plural: 'Items', spine: '··' })
    // And is the singleton fallback object the module returns for any unknown.
    expect(r).toBe(metaFor('banana'))
    expect(typeof r.label).toBe('string')
    expect(typeof r.spine).toBe('string')
    expect(() => metaFor(name)).not.toThrow()
  })

  it('a real valid type still returns its own meta (unchanged by the fix)', () => {
    expect(metaFor('book')).toBe(TYPE_META.book)
    expect(metaFor('book')).toEqual({ label: 'Book', plural: 'Books', spine: 'BK' })
  })

  it('an unknown plain string still returns FALLBACK_META (deep-equal)', () => {
    expect(metaFor('banana')).toEqual({ label: 'Item', plural: 'Items', spine: '··' })
  })
})

// ---------------------------------------------------------------------------
// The 6-rec-type story: spec says 6, shipped registry is media-only with 5
// (restaurants moved to Ink). Pin the actual shipped contract.
// ---------------------------------------------------------------------------
describe('type registry — TYPE_META / TYPE_ORDER', () => {
  it('registry has exactly the five media types (restaurants moved to Ink)', () => {
    expect(Object.keys(TYPE_META).sort()).toEqual(
      ['article', 'book', 'movie', 'tv', 'video'].sort()
    )
  })

  it('TYPE_ORDER lists every registry key exactly once and nothing extra', () => {
    expect([...TYPE_ORDER].sort()).toEqual(Object.keys(TYPE_META).sort())
    expect(new Set(TYPE_ORDER).size).toBe(TYPE_ORDER.length)
  })

  it('every entry has unique, sensible labels/plurals/spines', () => {
    const spines = Object.values(TYPE_META).map((m) => m.spine)
    expect(new Set(spines).size).toBe(spines.length) // spines unique
    for (const m of Object.values(TYPE_META)) {
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.plural.length).toBeGreaterThan(0)
      expect(m.spine.length).toBeGreaterThan(0)
    }
  })

  it('PARTNER is the co-viewing partner constant', () => {
    expect(PARTNER).toBe('Amanda')
  })
})

// ---------------------------------------------------------------------------
// editionForHour — drives the day/night theme & masthead. Boundary-heavy.
// ---------------------------------------------------------------------------
describe('editionForHour — boundaries & full 24h coverage', () => {
  it('maps the documented ranges', () => {
    expect(editionForHour(5).edition).toBe('morning')   // lower boundary
    expect(editionForHour(10).edition).toBe('morning')
    expect(editionForHour(11).edition).toBe('afternoon') // boundary
    expect(editionForHour(16).edition).toBe('afternoon')
    expect(editionForHour(17).edition).toBe('evening')   // boundary
    expect(editionForHour(20).edition).toBe('evening')
    expect(editionForHour(21).edition).toBe('night')     // boundary
    expect(editionForHour(0).edition).toBe('night')
    expect(editionForHour(4).edition).toBe('night')      // just before morning
  })

  it('isPaper flag is true for day editions, false for evening/night', () => {
    expect(editionForHour(8).isPaper).toBe(true)
    expect(editionForHour(13).isPaper).toBe(true)
    expect(editionForHour(18).isPaper).toBe(false)
    expect(editionForHour(23).isPaper).toBe(false)
  })

  it('returns a fully-formed object for every hour 0-23 (no gap, no undefined)', () => {
    for (let h = 0; h < 24; h++) {
      const e = editionForHour(h)
      expect(e).toMatchObject({
        edition: expect.any(String),
        label: expect.any(String),
        isPaper: expect.any(Boolean),
      })
    }
  })
})

// ---------------------------------------------------------------------------
// formatClock — masthead time. 12h conversion + zero-padding.
// ---------------------------------------------------------------------------
describe('formatClock', () => {
  const at = (h, m) => formatClock(new Date(2026, 0, 1, h, m))

  it('renders midnight as 12:00a and noon as 12:00p', () => {
    expect(at(0, 0)).toBe('12:00a')
    expect(at(12, 0)).toBe('12:00p')
  })

  it('pads minutes to two digits', () => {
    expect(at(9, 5)).toBe('9:05a')
    expect(at(9, 0)).toBe('9:00a')
  })

  it('converts afternoon hours to 12h with p suffix', () => {
    expect(at(13, 30)).toBe('1:30p')
    expect(at(23, 59)).toBe('11:59p')
  })

  it('11am stays am, 1am stays am', () => {
    expect(at(11, 15)).toBe('11:15a')
    expect(at(1, 1)).toBe('1:01a')
  })
})
