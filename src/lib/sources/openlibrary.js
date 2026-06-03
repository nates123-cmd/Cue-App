// Open Library lookup for books. Free, no key required, no proxy needed
// (CORS-enabled). Returns a partial enrichment: title, author, first publish
// year, page count, genre subject, cover image URL.

const SEARCH_URL = 'https://openlibrary.org/search.json'
const COVER_URL = (id, size = 'L') => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`

// search.json doc → the partial-enrichment shape the merge layer expects.
function docToFacts(doc) {
  if (!doc) return null
  return {
    title: doc.title,
    author: Array.isArray(doc.author_name) ? doc.author_name[0] : null,
    published_year: doc.first_publish_year || null,
    page_count: doc.number_of_pages_median || null,
    // Subjects are messy and Library-of-Congress-y; take the first non-LCC one.
    genre: Array.isArray(doc.subject) ? doc.subject.find((s) => !s.startsWith('PR') && s.length < 40) : null,
    image_url: doc.cover_i ? COVER_URL(doc.cover_i, 'L') : null,
  }
}

export async function openLibraryLookup(title) {
  const t = (title || '').trim()
  if (!t) return null
  try {
    const params = new URLSearchParams({ title: t, limit: '1' })
    const res = await fetch(`${SEARCH_URL}?${params}`)
    if (!res.ok) return null
    const data = await res.json()
    return docToFacts(data?.docs?.[0])
  } catch {
    return null
  }
}

// Top-N candidate matches for the disambiguation picker. Same fact shape as
// openLibraryLookup. Empty array on miss. Searches q (not title:) so a typed
// "title author" still narrows.
export async function openLibrarySearch(title, n = 6) {
  const t = (title || '').trim()
  if (!t) return []
  try {
    const params = new URLSearchParams({ q: t, limit: String(n) })
    const res = await fetch(`${SEARCH_URL}?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    return (data?.docs || []).map(docToFacts).filter(Boolean)
  } catch {
    return []
  }
}
