// Google Books lookup for books. Free, no key required for basic volume reads,
// CORS-enabled (no proxy). Richer than Open Library on description, categories,
// and cover art — used as the primary book facts source, OL backfills gaps.
// Returns a partial enrichment: title, author, year, page count, genre,
// synopsis, cover image URL.

const VOLUMES_URL = 'https://www.googleapis.com/books/v1/volumes'

// Keyless reads share a global anonymous quota that exhausts fast (429). A free
// Books API key (no billing, ~1k req/day) gets a private quota. Read-only +
// referrer-restrictable, so safe to ship client-side. Without it we still try,
// then degrade to Open Library + Claude on the 429.
const API_KEY = import.meta.env.VITE_GOOGLE_BOOKS_KEY || ''

// "0-306-40615-2" / "9780306406157" / "978 0 306 40615 7" → digits+X only.
function asIsbn(input) {
  const cleaned = (input || '').replace(/[\s-]/g, '')
  return /^(\d{9}[\dX]|\d{13})$/i.test(cleaned) ? cleaned : null
}

// Google's thumbnails come back http with a curled edge + tiny zoom. Force
// https, drop the page-curl, bump to a usable size.
function cleanCover(url) {
  if (!url) return null
  return url
    .replace(/^http:/, 'https:')
    .replace(/&edge=curl/, '')
    .replace(/&zoom=\d/, '&zoom=1')
}

// volumeInfo → the partial-enrichment shape the merge layer expects.
function volumeToFacts(v) {
  if (!v) return null
  // publishedDate is "2007", "2007-03", or "2007-03-01" — first 4 = year.
  const year = v.publishedDate ? parseInt(String(v.publishedDate).slice(0, 4), 10) || null : null
  return {
    title: v.title || null,
    author: Array.isArray(v.authors) ? v.authors[0] : null,
    published_year: year,
    page_count: v.pageCount || null,
    genre: Array.isArray(v.categories) ? v.categories[0] : null,
    synopsis: v.description || null,
    image_url: cleanCover(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail),
  }
}

export async function googleBooksLookup(title) {
  const t = (title || '').trim()
  if (!t) return null
  const isbn = asIsbn(t)
  const q = isbn ? `isbn:${isbn}` : t
  try {
    const params = new URLSearchParams({ q, maxResults: '1', printType: 'books' })
    if (API_KEY) params.set('key', API_KEY)
    const res = await fetch(`${VOLUMES_URL}?${params}`)
    if (!res.ok) return null
    const data = await res.json()
    return volumeToFacts(data?.items?.[0]?.volumeInfo)
  } catch {
    return null
  }
}

// Top-N candidate matches for the disambiguation picker. Same fact shape as
// googleBooksLookup, one per distinct volume. Empty array on miss/429.
export async function googleBooksSearch(title, n = 6) {
  const t = (title || '').trim()
  if (!t) return []
  const isbn = asIsbn(t)
  const q = isbn ? `isbn:${isbn}` : t
  try {
    const params = new URLSearchParams({ q, maxResults: String(n), printType: 'books' })
    if (API_KEY) params.set('key', API_KEY)
    const res = await fetch(`${VOLUMES_URL}?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return (data?.items || []).map((it) => volumeToFacts(it?.volumeInfo)).filter(Boolean)
  } catch {
    return []
  }
}
