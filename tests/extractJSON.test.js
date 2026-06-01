// Tests the REAL exported extractJSON from src/lib/claude.js — no re-impl.
//
// extractJSON is the defensive parser between Claude's raw text and the
// enrichment pipeline. enrich() does: parsed = extractJSON(raw); if (!parsed) fallback.
// It must (a) never throw on garbage, (b) strip ```json fences, (c) recover an
// embedded JSON value from prose, (d) return null (not undefined / not a throw)
// when there's nothing parseable.
import { describe, it, expect } from 'vitest'
import { extractJSON } from '../src/lib/claude.js'

describe('extractJSON — defensive parse (never throws; null on failure)', () => {
  it('parses clean JSON object', () => {
    expect(extractJSON('{"title":"Dune","year":1965}')).toEqual({ title: 'Dune', year: 1965 })
  })

  it('strips ```json fences', () => {
    const raw = '```json\n{"a":1}\n```'
    expect(extractJSON(raw)).toEqual({ a: 1 })
  })

  it('strips bare ``` fences', () => {
    expect(extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('recovers a JSON object embedded in prose', () => {
    const raw = 'Sure! Here is the data: {"title":"Heat","rt":94} — hope that helps.'
    expect(extractJSON(raw)).toEqual({ title: 'Heat', rt: 94 })
  })

  it('parses a JSON array', () => {
    expect(extractJSON('[{"label":"IMDb"}]')).toEqual([{ label: 'IMDb' }])
  })

  it('recovers an array embedded in prose', () => {
    expect(extractJSON('Here you go: [1,2,3]')).toEqual([1, 2, 3])
  })

  it('when both an object and array appear, picks whichever comes first', () => {
    // array first
    expect(extractJSON('x [1,2] then {"a":1}')).toEqual([1, 2])
    // object first
    expect(extractJSON('x {"a":1} then [1,2]')).toEqual({ a: 1 })
  })

  const JUNK = [
    ['null input', null],
    ['undefined input', undefined],
    ['non-string (number)', 42],
    ['non-string (object)', { already: 'object' }],
    ['empty string', ''],
    ['pure prose, no JSON', 'I cannot help with that.'],
    ['unbalanced/broken braces', '{"title": "oops"'],
  ]

  it.each(JUNK)('returns null without throwing for %s', (_label, val) => {
    let out
    expect(() => { out = extractJSON(val) }).not.toThrow()
    expect(out).toBeNull()
  })

  it('handles multiline JSON with nested structures (typical enrichment payload)', () => {
    const raw = '```json\n' + JSON.stringify({
      title: 'The Bear',
      synopsis: 'A chef returns home.',
      extension: { seasons: 3, streaming_on: ['Hulu', 'Disney+'] },
      image_tone: ['#0e2533', '#3a7da3'],
      links: [{ label: 'JustWatch' }],
    }, null, 2) + '\n```'
    const parsed = extractJSON(raw)
    expect(parsed.title).toBe('The Bear')
    expect(parsed.extension.streaming_on).toEqual(['Hulu', 'Disney+'])
    expect(parsed.links[0].label).toBe('JustWatch')
  })

  it('documents a known edge: trailing prose after a balanced object is swallowed by the greedy match', () => {
    // The regex /\{[\s\S]*\}/ is greedy. For a single object followed by prose,
    // direct JSON.parse fails (trailing text) then the greedy match grabs
    // from first { to last } — which here is still just the object, so it parses.
    expect(extractJSON('{"a":1} trailing words')).toEqual({ a: 1 })
  })
})
