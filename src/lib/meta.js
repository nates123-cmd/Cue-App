// Type registry. Cue is media-only as of 2026-05-27 — restaurants moved to Ink.
export const TYPE_META = {
  book:    { label: 'Book',    plural: 'Books',    spine: 'BK' },
  tv:      { label: 'TV',      plural: 'TV',       spine: 'TV' },
  movie:   { label: 'Movie',   plural: 'Movies',   spine: 'MV' },
  article: { label: 'Article', plural: 'Articles', spine: 'AR' },
  video:   { label: 'Video',   plural: 'Videos',   spine: 'VD' },
}

export const TYPE_ORDER = ['book', 'tv', 'movie', 'article', 'video']

// Defensive lookup — unknown types fall back to a neutral placeholder so the
// renderer never throws on legacy data with surprise type values.
const FALLBACK_META = { label: 'Item', plural: 'Items', spine: '··' }
export function metaFor(type) {
  return Object.hasOwn(TYPE_META, type) ? TYPE_META[type] : FALLBACK_META
}

// Co-viewing partner. Distinct from `recommended_by`.
export const PARTNER = 'Amanda'

// Edition + time helpers — drives the auto day/night theme and the masthead.
export function editionForHour(h) {
  if (h >= 5 && h < 11)  return { edition: 'morning',   label: 'morning',   isPaper: true  }
  if (h >= 11 && h < 17) return { edition: 'afternoon', label: 'afternoon', isPaper: true  }
  if (h >= 17 && h < 21) return { edition: 'evening',   label: 'evening',   isPaper: false }
  return { edition: 'night', label: 'night', isPaper: false }
}

export function formatClock(d) {
  let h = d.getHours()
  const m = d.getMinutes()
  const ap = h >= 12 ? 'p' : 'a'
  h = h % 12; if (h === 0) h = 12
  return `${h}:${m.toString().padStart(2, '0')}${ap}`
}
