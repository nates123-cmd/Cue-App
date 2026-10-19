import { describe, it, expect } from 'vitest'
import { parseTypes, parsePartner, prefsFromRows, typesRestricted } from '../src/lib/settings'
import { TYPE_ORDER, PARTNER } from '../src/lib/meta'

describe('parseTypes (user_settings.cue_types)', () => {
  it('absent / empty / garbage -> every type', () => {
    expect(parseTypes(undefined)).toEqual(TYPE_ORDER)
    expect(parseTypes(null)).toEqual(TYPE_ORDER)
    expect(parseTypes('')).toEqual(TYPE_ORDER)
    expect(parseTypes('   ')).toEqual(TYPE_ORDER)
    expect(parseTypes('[]')).toEqual(TYPE_ORDER)
    expect(parseTypes('["restaurant"]')).toEqual(TYPE_ORDER)
    expect(parseTypes('{"book":true}')).toEqual(TYPE_ORDER)
    expect(parseTypes(42)).toEqual(TYPE_ORDER)
  })

  it('JSON array narrows to known types in registry order', () => {
    expect(parseTypes('["book"]')).toEqual(['book'])
    expect(parseTypes('["movie","book"]')).toEqual(['book', 'movie'])
    expect(parseTypes('["Book", " TV "]')).toEqual(['book', 'tv'])
  })

  it('comma list works too, unknown names dropped', () => {
    expect(parseTypes('book, article, nonsense')).toEqual(['book', 'article'])
    expect(parseTypes('book')).toEqual(['book'])
  })

  it('a real array passes straight through', () => {
    expect(parseTypes(['podcast', 'book'])).toEqual(['book', 'podcast'])
  })
})

describe('parsePartner (user_settings.cue_partner)', () => {
  it('absent -> the historical default', () => {
    expect(parsePartner(undefined)).toBe(PARTNER)
    expect(parsePartner(null)).toBe(PARTNER)
  })
  it('off switches -> null', () => {
    for (const v of ['', '  ', 'none', 'NONE', 'off', 'null', 'false']) expect(parsePartner(v)).toBeNull()
  })
  it('a name is kept, trimmed', () => {
    expect(parsePartner('  Sam ')).toBe('Sam')
  })
})

describe('prefsFromRows', () => {
  it('builds prefs from the rows the one-shot read returns', () => {
    expect(prefsFromRows([
      { key: 'cue_types', value: '["book"]' },
      { key: 'cue_partner', value: '' },
      { key: 'kindle_email', value: 'x@kindle.com' },
    ])).toEqual({ types: ['book'], partner: null })
  })
  it('no rows -> defaults', () => {
    expect(prefsFromRows([])).toEqual({ types: TYPE_ORDER, partner: PARTNER })
    expect(prefsFromRows(null)).toEqual({ types: TYPE_ORDER, partner: PARTNER })
  })
})

describe('typesRestricted', () => {
  it('only true for a strict subset', () => {
    expect(typesRestricted(TYPE_ORDER)).toBe(false)
    expect(typesRestricted(['book'])).toBe(true)
    expect(typesRestricted(null)).toBe(false)
  })
})
