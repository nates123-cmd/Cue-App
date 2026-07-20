// Tests the REAL exported search core from src/lib/audioSeek.js — no re-impl.
//
// searchTranscript maps an anchor phrase (the last line you read on the Kindle) to
// a timestamp in the audiobook's forced-alignment transcript. It must: (a) find an
// exact phrase and return its segment's start time, (b) tolerate punctuation/case/
// smart-quote differences between what you type and the transcript, (c) reject weak
// matches so a common word doesn't seek to a random spot, (d) never throw on empty
// input. supabase is lazy-imported inside the data fns, so this file loads with no env.
import { describe, it, expect } from 'vitest'
import { searchTranscript, normalize, fmtClock } from '../src/lib/audioSeek.js'

const segments = [
  { t: 0, s: 'Slow productivity is a philosophy for organizing knowledge work.' },
  { t: 42.5, s: 'Do fewer things, work at a natural pace, obsess over quality.' },
  { t: 130, s: 'The ability to focus without distraction on a cognitively demanding task.' },
  { t: 205.9, s: 'Deep work is like a superpower in our increasingly competitive economy.' },
]

describe('searchTranscript — phrase -> audiobook timestamp', () => {
  it('finds an exact phrase and returns its segment start time', () => {
    const [top] = searchTranscript(segments, 'work at a natural pace')
    expect(top.startSec).toBe(42.5)
  })

  it('tolerates case, punctuation, and smart quotes in the query', () => {
    const [top] = searchTranscript(segments, '  Obsess OVER quality!! ')
    expect(top.startSec).toBe(42.5)
  })

  it('matches a phrase from a later segment', () => {
    const [top] = searchTranscript(segments, 'focus without distraction')
    expect(top.startSec).toBe(130)
  })

  it('rejects weak/insufficient matches (no false seek on a lone common word)', () => {
    expect(searchTranscript(segments, 'the')).toEqual([])
    expect(searchTranscript(segments, 'zzzz nonexistent phrase here')).toEqual([])
  })

  it('rejects short (<3 word) anchors even when they match', () => {
    // "deep work" appears verbatim but is only 2 words -> not distinctive enough
    expect(searchTranscript(segments, 'deep work')).toEqual([])
  })

  it('never throws on empty input', () => {
    expect(searchTranscript([], 'anything')).toEqual([])
    expect(searchTranscript(segments, '')).toEqual([])
    expect(searchTranscript(null, null)).toEqual([])
  })

  it('accepts alternate segment field names (start / start_sec / text)', () => {
    const segs = [{ start: 12, text: 'a natural pace matters most' }]
    const [top] = searchTranscript(segs, 'a natural pace')
    expect(top.startSec).toBe(12)
  })
})

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalize('  Deep-Work, is:  A “Superpower”! ')).toBe('deep work is a superpower')
  })
})

describe('fmtClock', () => {
  it('formats mm:ss under an hour', () => {
    expect(fmtClock(42.5)).toBe('0:42')
    expect(fmtClock(130)).toBe('2:10')
  })
  it('formats h:mm:ss over an hour', () => {
    expect(fmtClock(3661)).toBe('1:01:01')
  })
})
