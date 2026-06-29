// TMDB v3 lookup for movies + TV. Returns null if the key is missing or
// nothing matches.
//
// KEY: TMDB needs the v3 "API Key" (the `api_key` query param) from
// https://www.themoviedb.org/settings/api — explicitly safe for client-side use
// per TMDB's docs (mirrors how Google Books reads VITE_GOOGLE_BOOKS_KEY
// client-side). We read VITE_TMDB_KEY first (the suite-standard name), falling
// back to the older VITE_TMDB_API_KEY so existing builds keep working.
// TODO: set VITE_TMDB_KEY in the deploy env (and .env for local dev). Without it
// every lookup returns null and movie/tv enrichment degrades gracefully to
// Claude-only.

const API_KEY = import.meta.env.VITE_TMDB_KEY || import.meta.env.VITE_TMDB_API_KEY || ''
const BASE = 'https://api.themoviedb.org/3'
const IMG = (path, size = 'w500') => `https://image.tmdb.org/t/p/${size}${path}`

function isType(type) {
  return type === 'movie' || type === 'tv'
}

// "2013-05-17" / "2013" → 2013.
function yearOf(date) {
  if (!date) return null
  return Number(String(date).slice(0, 4)) || null
}

// A TMDB search/detail object → the partial-enrichment shape the merge layer
// expects. Every field is null when absent so a sparse result never clobbers a
// good Claude value. `genres`/`runtime`/`director`/`creator` only appear on the
// detail payload (search results omit them) — they stay null from search.
function resultToFacts(r, type) {
  if (!r) return null
  const dateField = type === 'movie' ? r.release_date : r.first_air_date
  // Detail-only fields, defensively read.
  const genres = Array.isArray(r.genres)
    ? r.genres.map((g) => g?.name).filter(Boolean)
    : null
  const runtime = type === 'movie'
    ? (typeof r.runtime === 'number' ? r.runtime : null)
    : (Array.isArray(r.episode_run_time) && r.episode_run_time.length
        ? r.episode_run_time[0]
        : null)
  // Director (movie, from /credits append) / creator (tv, created_by).
  let director = null
  if (type === 'movie' && Array.isArray(r.credits?.crew)) {
    director = r.credits.crew.find((c) => c?.job === 'Director')?.name || null
  }
  let creator = null
  if (type === 'tv' && Array.isArray(r.created_by) && r.created_by.length) {
    creator = r.created_by.map((c) => c?.name).filter(Boolean)[0] || null
  }
  return {
    title: (type === 'movie' ? r.title : r.name) || null,
    year: yearOf(dateField),
    synopsis: r.overview || null,
    image_url: r.poster_path ? IMG(r.poster_path, 'w500') : null,
    backdrop_url: r.backdrop_path ? IMG(r.backdrop_path, 'w780') : null,
    tmdb_vote: typeof r.vote_average === 'number' ? r.vote_average : null,
    tmdb_id: r.id ?? null,
    runtime,
    genres: genres && genres.length ? genres : null,
    genre: genres && genres.length ? genres[0] : null,
    director,
    creator,
  }
}

async function tmdbSearchResults(title, type, n) {
  const t = (title || '').trim()
  if (!API_KEY || !t || !isType(type)) return []
  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv'
  const params = new URLSearchParams({
    api_key: API_KEY,
    query: t,
    include_adult: 'false',
    language: 'en-US',
    page: '1',
  })
  const res = await fetch(`${BASE}/${endpoint}?${params}`)
  if (!res.ok) return []
  const data = await res.json()
  return (data?.results || []).slice(0, n).map((r) => resultToFacts(r, type)).filter(Boolean)
}

// Fetch the full detail record (runtime, genres, director/creator) for one id.
// `append_to_response=credits` gets the director in the same round-trip (cheap).
async function tmdbDetail(id, type) {
  if (!API_KEY || id == null || !isType(type)) return null
  const params = new URLSearchParams({
    api_key: API_KEY,
    language: 'en-US',
    append_to_response: type === 'movie' ? 'credits' : '',
  })
  const res = await fetch(`${BASE}/${type}/${id}?${params}`)
  if (!res.ok) return null
  return res.json()
}

// Top match, enriched with the detail call so runtime / genres / director land
// on the card. Falls back to the search-only facts if the detail fetch misses.
export async function tmdbLookup(title, type) {
  try {
    const top = (await tmdbSearchResults(title, type, 1))[0]
    if (!top) return null
    if (top.tmdb_id == null) return top
    const detail = await tmdbDetail(top.tmdb_id, type).catch(() => null)
    if (!detail) return top
    const full = resultToFacts(detail, type)
    if (!full) return top
    // Detail wins where present; search facts backfill any null.
    return {
      ...top,
      ...Object.fromEntries(Object.entries(full).filter(([, v]) => v != null)),
    }
  } catch {
    return null
  }
}

// Top-N candidate matches for the disambiguation picker. Search-only (no
// per-id detail call — saves N requests); runtime / genres / director fill in
// when the user picks one and the locked re-enrich runs tmdbLookup. Empty array
// on miss / no key.
export async function tmdbSearch(title, type, n = 6) {
  try {
    return await tmdbSearchResults(title, type, n)
  } catch {
    return []
  }
}

// ── recommendations engine helpers ───────────────────────────────────────────

// Resolve a title to its TMDB id (search-only, cheap). Used when a candidate
// arrived without an id (e.g. a Claude-proposed net-new title) and we need one
// for /recommendations or /watch/providers. Returns null on miss / no key.
export async function tmdbResolveId(title, type) {
  const top = (await tmdbSearchResults(title, type, 1).catch(() => []))[0]
  return top?.tmdb_id ?? null
}

// "More like this" candidates for a movie/tv id: TMDB's own /recommendations
// (co-engagement based) plus /similar (metadata based), deduped. Each becomes a
// normalized engine candidate carrying the hard facts TMDB already knows, so the
// card renders rich without a follow-up detail call. Empty array on miss/no key.
export async function tmdbRecommendations(id, type, n = 16) {
  if (!API_KEY || id == null || !isType(type)) return []
  const fetchList = async (kind) => {
    const params = new URLSearchParams({ api_key: API_KEY, language: 'en-US', page: '1' })
    const res = await fetch(`${BASE}/${type}/${id}/${kind}?${params}`).catch(() => null)
    if (!res || !res.ok) return []
    const data = await res.json().catch(() => null)
    return data?.results || []
  }
  const [recs, similar] = await Promise.all([
    fetchList('recommendations'),
    fetchList('similar'),
  ])
  const seen = new Set()
  const out = []
  for (const r of [...recs, ...similar]) {
    if (r?.id == null || seen.has(r.id)) continue
    seen.add(r.id)
    const f = resultToFacts(r, type)
    if (!f?.title) continue
    out.push({
      title: f.title,
      type,
      source: 'tmdb',
      facts: {
        tmdb_id: f.tmdb_id,
        synopsis: f.synopsis,
        image_url: f.image_url,
        genre: f.genre,
        genres: f.genres,
        tmdb_vote: f.tmdb_vote,
        ...(type === 'movie' ? { release_year: f.year } : { first_air_year: f.year }),
      },
    })
    if (out.length >= n) break
  }
  return out
}

// US streaming availability for a movie/tv id, sourced from TMDB's
// /watch/providers (JustWatch data, no gated JustWatch API needed). Returns the
// flatrate (subscription) provider names — "where can I watch" without a search
// call. Empty array on miss / no key / nothing streaming.
export async function tmdbWatchProviders(id, type, region = 'US') {
  if (!API_KEY || id == null || !isType(type)) return []
  const params = new URLSearchParams({ api_key: API_KEY })
  const res = await fetch(`${BASE}/${type}/${id}/watch/providers?${params}`).catch(() => null)
  if (!res || !res.ok) return []
  const data = await res.json().catch(() => null)
  const r = data?.results?.[region]
  if (!r) return []
  // flatrate = subscription streaming; fall back to free/ads, then rent/buy.
  const tier = r.flatrate || r.free || r.ads || r.rent || r.buy || []
  return tier.map((p) => p?.provider_name).filter(Boolean)
}
