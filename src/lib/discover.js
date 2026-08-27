// The Discover feed behind the Recs tab — an Overseerr-style browse surface
// over TMDB's /discover, filtered to the streaming services Nate actually pays
// for. Everything here is read-only TMDB; nothing is written until the user
// queues or downloads a title from the sheet.
//
// WHAT "NEW ON NETFLIX" MEANS HERE. TMDB exposes a title's *release* date and
// which providers currently carry it. It does NOT expose the date a title was
// added to a provider's catalogue. So a row is "released in the last
// NEW_WINDOW_DAYS and currently streaming on X", ranked by popularity — which
// is what a "new on Netflix" list mostly is. The gap: a back-catalogue title
// Netflix picked up last week (a 1999 film, say) will not appear, because its
// release date is old. Closing that needs a nightly snapshot of each provider's
// catalogue and a diff of successive snapshots.
//
// TV CAVEAT: `first_air_date` is the date the *series* premiered, so the new-TV
// rows surface new shows, not new seasons of existing ones. TMDB has no
// discover filter for "season aired recently".

const API_KEY = import.meta.env.VITE_TMDB_KEY || import.meta.env.VITE_TMDB_API_KEY || ''
const BASE = 'https://api.themoviedb.org/3'
const IMG = (path, size = 'w500') => `https://image.tmdb.org/t/p/${size}${path}`
const REGION = 'US'

export const hasTmdbKey = () => Boolean(API_KEY)

// How far back a title can have been released and still count as "new".
const NEW_WINDOW_DAYS = 120

// TMDB provider ids, verified against /watch/providers/{movie,tv}?watch_region=US.
// `id` is the watch-provider id; `label` is what the row header says. Add a row
// by adding an entry — the feed is built from this list.
// Paramount+ is deliberately absent: it does not come back in TMDB's US
// flatrate provider list under the id its docs suggest, so a row for it would
// silently render empty.
export const PROVIDERS = [
  { key: 'netflix', id: 8, label: 'Netflix' },
  { key: 'prime', id: 9, label: 'Prime Video' },
  { key: 'hbomax', id: 1899, label: 'HBO Max' },
  { key: 'hulu', id: 15, label: 'Hulu' },
  { key: 'disney', id: 337, label: 'Disney+' },
  { key: 'appletv', id: 350, label: 'Apple TV+' },
  { key: 'peacock', id: 386, label: 'Peacock' },
]

// ── cache ────────────────────────────────────────────────────
// The feed is the landing surface of the tab, so it gets hit on every visit.
// TMDB's discover results move on the order of days, not minutes — a 6h cache
// keeps the tab instant and stays well clear of the rate limit.
const TTL_MS = 6 * 60 * 60 * 1000
const CACHE_PREFIX = 'cue.discover.'

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const { at, data } = JSON.parse(raw)
    if (!at || Date.now() - at > TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }))
  } catch {
    // Quota or private mode — the feed just refetches next time.
  }
}

export function clearDiscoverCache() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k)
    }
  } catch {
    // Nothing to do — a failed clear only means the next fetch serves cache.
  }
}

// ── genres ───────────────────────────────────────────────────
// /discover returns `genre_ids`, not names. Resolve them once and hold the map
// for the session so every card can show a genre without an extra call.
let genreMapPromise = null

function loadGenreMap() {
  if (genreMapPromise) return genreMapPromise
  genreMapPromise = (async () => {
    const cached = readCache('genres')
    if (cached) return cached
    const get = async (kind) => {
      const res = await fetch(`${BASE}/genre/${kind}/list?api_key=${API_KEY}&language=en-US`).catch(() => null)
      if (!res || !res.ok) return []
      const data = await res.json().catch(() => null)
      return data?.genres || []
    }
    const [movie, tv] = await Promise.all([get('movie'), get('tv')])
    const map = {}
    for (const g of [...movie, ...tv]) if (g?.id != null) map[g.id] = g.name
    writeCache('genres', map)
    return map
  })()
  return genreMapPromise
}

// ── shaping ──────────────────────────────────────────────────
function ymd(d) {
  return d.toISOString().slice(0, 10)
}

function yearOf(date) {
  if (!date) return null
  return Number(String(date).slice(0, 4)) || null
}

// A raw TMDB discover/trending result → the shape the feed renders and the
// sheet hands to addItem / pushToRadarr. `facts` deliberately mirrors the keys
// Cue's `extension` column already uses (tmdb_id, image_url, release_year,
// first_air_year, genre…) so a queued title looks identical to an enriched one.
function toEntry(r, type, genreMap) {
  if (!r || r.id == null) return null
  const title = (type === 'movie' ? r.title : r.name) || null
  if (!title) return null
  const date = type === 'movie' ? r.release_date : r.first_air_date
  const genres = (r.genre_ids || []).map((id) => genreMap[id]).filter(Boolean)
  return {
    id: `tmdb:${type}:${r.id}`,
    title,
    type,
    date: date || null,
    popularity: typeof r.popularity === 'number' ? r.popularity : 0,
    facts: {
      tmdb_id: r.id,
      synopsis: r.overview || null,
      image_url: r.poster_path ? IMG(r.poster_path, 'w500') : null,
      backdrop_url: r.backdrop_path ? IMG(r.backdrop_path, 'w780') : null,
      tmdb_vote: typeof r.vote_average === 'number' ? r.vote_average : null,
      genres: genres.length ? genres : null,
      genre: genres.length ? genres[0] : null,
      ...(type === 'movie'
        ? { release_year: yearOf(date) }
        : { first_air_year: yearOf(date) }),
    },
  }
}

async function discoverPage(type, params) {
  const qs = new URLSearchParams({
    api_key: API_KEY,
    language: 'en-US',
    include_adult: 'false',
    watch_region: REGION,
    page: '1',
    ...params,
  })
  const res = await fetch(`${BASE}/discover/${type}?${qs}`).catch(() => null)
  if (!res || !res.ok) return []
  const data = await res.json().catch(() => null)
  return data?.results || []
}

// ── rows ─────────────────────────────────────────────────────

// "New on <provider>": released inside the recency window and currently on that
// service's subscription tier, ranked by popularity so the row leads with what
// people are actually watching rather than whatever happens to be newest.
// Movies and TV are fetched in parallel and interleaved by popularity.
export async function fetchProviderRow(provider) {
  if (!API_KEY) return []
  const cacheKey = `provider.${provider.key}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const genreMap = await loadGenreMap()
  const now = new Date()
  const from = new Date(now.getTime() - NEW_WINDOW_DAYS * 86400000)
  const shared = {
    with_watch_providers: String(provider.id),
    with_watch_monetization_types: 'flatrate',
    sort_by: 'popularity.desc',
  }

  const [movies, shows] = await Promise.all([
    discoverPage('movie', {
      ...shared,
      'primary_release_date.gte': ymd(from),
      'primary_release_date.lte': ymd(now),
    }),
    discoverPage('tv', {
      ...shared,
      'first_air_date.gte': ymd(from),
      'first_air_date.lte': ymd(now),
    }),
  ])

  const entries = [
    ...movies.map((r) => toEntry(r, 'movie', genreMap)),
    ...shows.map((r) => toEntry(r, 'tv', genreMap)),
  ]
    .filter(Boolean)
    .filter((e) => e.facts.image_url) // a posterless card is a dead tile
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20)

  writeCache(cacheKey, entries)
  return entries
}

// "Trending this week" — TMDB's cross-type trending, narrowed to movies and TV.
// Not provider-filtered: this is the "what is everyone talking about" row, and
// Cue can download anything regardless of where it streams.
export async function fetchTrendingRow() {
  if (!API_KEY) return []
  const cached = readCache('trending')
  if (cached) return cached

  const genreMap = await loadGenreMap()
  const res = await fetch(`${BASE}/trending/all/week?api_key=${API_KEY}&language=en-US`).catch(() => null)
  if (!res || !res.ok) return []
  const data = await res.json().catch(() => null)

  const entries = (data?.results || [])
    .filter((r) => r?.media_type === 'movie' || r?.media_type === 'tv')
    .map((r) => toEntry(r, r.media_type, genreMap))
    .filter(Boolean)
    .filter((e) => e.facts.image_url)
    .slice(0, 20)

  writeCache('trending', entries)
  return entries
}

// "Coming soon" — announced films not yet released. These have no provider yet
// and cannot be downloaded, so the sheet hides the download action for them.
export async function fetchUpcomingRow() {
  if (!API_KEY) return []
  const cached = readCache('upcoming')
  if (cached) return cached

  const genreMap = await loadGenreMap()
  const now = new Date()
  const to = new Date(now.getTime() + 90 * 86400000)
  const results = await discoverPage('movie', {
    'primary_release_date.gte': ymd(new Date(now.getTime() + 86400000)),
    'primary_release_date.lte': ymd(to),
    sort_by: 'popularity.desc',
  })

  const entries = results
    .map((r) => toEntry(r, 'movie', genreMap))
    .filter(Boolean)
    .filter((e) => e.facts.image_url)
    .slice(0, 20)

  writeCache('upcoming', entries)
  return entries
}

// Which subscription services carry a title right now. Used by the sheet to
// show "where to watch" — the same TMDB /watch/providers call the enrichment
// pipeline already leans on, so a title Cue can stream is obvious at a glance.
export async function fetchWatchProviders(tmdbId, type) {
  if (!API_KEY || tmdbId == null) return []
  const res = await fetch(`${BASE}/${type}/${tmdbId}/watch/providers?api_key=${API_KEY}`).catch(() => null)
  if (!res || !res.ok) return []
  const data = await res.json().catch(() => null)
  const r = data?.results?.[REGION]
  if (!r) return []
  const tier = r.flatrate || r.free || r.ads || []
  return tier.map((p) => p?.provider_name).filter(Boolean)
}

// ── trailers ─────────────────────────────────────────────────
// TMDB hands back every video it holds for a title — clips, featurettes,
// opening credits, award-show packages — in no useful order. One current film
// answered with 74 videos and not a single trailer in the first eight. So rank
// rather than taking results[0]: real Trailers before Teasers, official studio
// uploads before fan re-cuts, then the highest resolution. Anything that is not
// a trailer or a teaser is discarded, and only YouTube is kept (Vimeo entries
// carry a key that a youtube.com/watch URL cannot use).
const TRAILER_KIND = { Trailer: 0, Teaser: 1 }

// Sort key, lowest first. null = not a trailer at all.
function rankVideo(v) {
  if (!v || v.site !== 'YouTube' || !v.key) return null
  const kind = TRAILER_KIND[v.type]
  if (kind === undefined) return null
  return [kind, v.official ? 0 : 1, -(Number(v.size) || 0)]
}

function sortsBefore(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

// The YouTube key of the best trailer in a TMDB /videos payload, or null if it
// holds none. Pure and exported so the ranking is testable without the network.
export function pickTrailerKey(results) {
  let bestKey = null
  let bestRank = null
  for (const v of results || []) {
    const rank = rankVideo(v)
    if (!rank) continue
    if (!bestRank || sortsBefore(rank, bestRank)) {
      bestRank = rank
      bestKey = v.key
    }
  }
  return bestKey
}

// A YouTube search for the title. This is the fallback when TMDB holds no
// trailer, and the only option for a suggestion carrying no tmdb_id (TasteDive
// and Claude picks often don't). It always resolves to something watchable,
// which a dead or missing link would not.
export function youtubeSearchUrl(title, year) {
  const q = [title, year, 'trailer'].filter(Boolean).join(' ')
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
}

// The best YouTube trailer TMDB knows about, or null if it has none.
export async function fetchTrailerUrl(tmdbId, type) {
  if (!API_KEY || tmdbId == null) return null
  if (type !== 'movie' && type !== 'tv') return null

  const cacheKey = `trailer.${type}.${tmdbId}`
  // Cached as a { url } wrapper on purpose: a title with no trailer caches as
  // url:null, and a bare null would be indistinguishable from a cache miss.
  const cached = readCache(cacheKey)
  if (cached) return cached.url || null

  const res = await fetch(`${BASE}/${type}/${tmdbId}/videos?api_key=${API_KEY}&language=en-US`).catch(() => null)
  // Deliberately not cached: a network blip should retry next open, not stick
  // as "no trailer" for six hours.
  if (!res || !res.ok) return null
  const data = await res.json().catch(() => null)

  const bestKey = pickTrailerKey(data?.results)
  const url = bestKey ? `https://www.youtube.com/watch?v=${bestKey}` : null
  writeCache(cacheKey, { url })
  return url
}

// The full feed definition, in render order. Each row lazily fetches itself so
// the tab paints immediately and fills in as TMDB answers.
export function feedRows() {
  return [
    { key: 'trending', title: 'Trending this week', kicker: 'Everywhere', fetch: fetchTrendingRow },
    ...PROVIDERS.map((p) => ({
      key: `new.${p.key}`,
      title: `New on ${p.label}`,
      kicker: 'Last 4 months',
      fetch: () => fetchProviderRow(p),
    })),
    { key: 'upcoming', title: 'Coming soon', kicker: 'Not out yet', fetch: fetchUpcomingRow, unreleased: true },
  ]
}
