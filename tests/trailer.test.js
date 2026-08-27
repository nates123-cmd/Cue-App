import { describe, it, expect } from 'vitest'
import { pickTrailerKey, youtubeSearchUrl } from '../src/lib/discover'

// TMDB returns every video it holds, in no useful order. These fixtures are
// trimmed from real /videos payloads (Fight Club 550, Game of Thrones 1399, and
// a current release that answered with 74 videos, none of the first eight a
// trailer) — the ordering below is TMDB's own.

const fightClub = [
  { site: 'YouTube', type: 'Featurette', official: false, size: 2160, key: 'V0Fqdb-smqo' },
  { site: 'YouTube', type: 'Trailer', official: true, size: 1080, key: 'dfeUzm6KF4g' },
  { site: 'YouTube', type: 'Featurette', official: true, size: 480, key: 'tiWCNtGDGEY' },
  { site: 'YouTube', type: 'Trailer', official: false, size: 1080, key: '6JnN1DmbqoU' },
  { site: 'YouTube', type: 'Trailer', official: true, size: 1080, key: 'BdJKm16Co6M' },
]

const gameOfThrones = [
  { site: 'YouTube', type: 'Trailer', official: true, size: 1080, key: 'KPLWWIOCOOQ' },
  { site: 'YouTube', type: 'Behind the Scenes', official: true, size: 1080, key: 'y2ZJ3lTaREY' },
  { site: 'YouTube', type: 'Opening Credits', official: true, size: 720, key: 's7L2PVdrb_8' },
  { site: 'YouTube', type: 'Trailer', official: true, size: 720, key: 'BpJYNVhGf1s' },
  { site: 'YouTube', type: 'Teaser', official: true, size: 720, key: 'hhqRmcsWqac' },
]

describe('pickTrailerKey', () => {
  it('skips the clips and featurettes TMDB leads with', () => {
    expect(pickTrailerKey(fightClub)).toBe('dfeUzm6KF4g')
  })

  it('never returns a non-trailer even when every video is one', () => {
    const noTrailers = [
      { site: 'YouTube', type: 'Clip', official: true, size: 1080, key: 'uJQUr6j5Zrg' },
      { site: 'YouTube', type: 'Featurette', official: true, size: 1080, key: 'FkR91Wdn1as' },
      { site: 'YouTube', type: 'Behind the Scenes', official: true, size: 1080, key: 'Zo-vSUkm7Ek' },
    ]
    expect(pickTrailerKey(noTrailers)).toBe(null)
  })

  it('prefers the official upload over a higher-resolution fan re-cut', () => {
    const fanFirst = [
      { site: 'YouTube', type: 'Trailer', official: false, size: 2160, key: 'fan' },
      { site: 'YouTube', type: 'Trailer', official: true, size: 720, key: 'official' },
    ]
    expect(pickTrailerKey(fanFirst)).toBe('official')
  })

  it('prefers a Trailer over a Teaser', () => {
    expect(pickTrailerKey(gameOfThrones)).toBe('KPLWWIOCOOQ')
    const teaserFirst = [
      { site: 'YouTube', type: 'Teaser', official: true, size: 2160, key: 'teaser' },
      { site: 'YouTube', type: 'Trailer', official: true, size: 480, key: 'trailer' },
    ]
    expect(pickTrailerKey(teaserFirst)).toBe('trailer')
  })

  it('breaks a tie on resolution', () => {
    const sameKind = [
      { site: 'YouTube', type: 'Trailer', official: true, size: 480, key: 'small' },
      { site: 'YouTube', type: 'Trailer', official: true, size: 1080, key: 'big' },
    ]
    expect(pickTrailerKey(sameKind)).toBe('big')
  })

  it('ignores non-YouTube sites, whose keys a watch URL cannot use', () => {
    const vimeo = [
      { site: 'Vimeo', type: 'Trailer', official: true, size: 1080, key: '12345' },
      { site: 'YouTube', type: 'Teaser', official: true, size: 360, key: 'yt' },
    ]
    expect(pickTrailerKey(vimeo)).toBe('yt')
  })

  it('survives the empty, missing and malformed payloads', () => {
    expect(pickTrailerKey([])).toBe(null)
    expect(pickTrailerKey(undefined)).toBe(null)
    expect(pickTrailerKey(null)).toBe(null)
    expect(pickTrailerKey([null, {}, { site: 'YouTube', type: 'Trailer' }])).toBe(null)
  })
})

describe('youtubeSearchUrl', () => {
  it('builds a search a title always resolves against', () => {
    expect(youtubeSearchUrl('Mutiny', 2026))
      .toBe('https://www.youtube.com/results?search_query=Mutiny%202026%20trailer')
  })

  it('drops a missing year rather than searching for "undefined"', () => {
    expect(youtubeSearchUrl('Mutiny', null))
      .toBe('https://www.youtube.com/results?search_query=Mutiny%20trailer')
  })

  it('escapes titles that would otherwise break the query', () => {
    expect(youtubeSearchUrl('Am I OK?', 2022))
      .toBe('https://www.youtube.com/results?search_query=Am%20I%20OK%3F%202022%20trailer')
  })
})
