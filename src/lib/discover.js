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

import { tmdbResolveId } from './sources/tmdb'

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

// ── personal rows ────────────────────────────────────────────
// Everything above is the same feed for anyone. Below is the half that reads
// the library: what got rated highly, which genres keep recurring, and what is
// sitting in the queue that could actually be played tonight.
//
// The library is the only input — no model call on this path. A row that cannot
// be built (nothing rated yet, no tmdb_id, TMDB says nothing) returns [] and
// <DiscoverRow> collapses it silently, so a sparse library shows the generic
// feed rather than a wall of empty headers.

const keyOf = (type, title) => `${type}:${(title || '').toLowerCase().trim()}`

// Every subscription service in PROVIDERS, as the pipe-joined OR that TMDB's
// `with_watch_providers` expects. Used by the rows that mean "…and you can
// actually stream it right now".
const ALL_PROVIDER_IDS = PROVIDERS.map((p) => p.id).join('|')

// Genre name → id, the inverse of loadGenreMap(). Library items know genres by
// name (that is what enrichment stored); /discover wants ids.
async function genreIdFor(name) {
  const map = await loadGenreMap()
  const want = String(name || '').toLowerCase()
  for (const [id, label] of Object.entries(map)) {
    if (String(label).toLowerCase() === want) return Number(id)
  }
  return null
}

// Rotate the anchor/genre picked for a row once a day, so the feed is not
// permanently pinned to whatever was rated first. Deterministic within a day,
// which also means the 6h cache is not fighting a moving key.
const dayIndex = () => Math.floor(Date.now() / 86400000)

const isScreen = (i) => !!i && (i.type === 'movie' || i.type === 'tv')

// Loved library rows, most recently finished first. Ratings are 1..5 and 4+ is
// "loved" — the same threshold the recs engine's taste profile uses.
function lovedScreenItems(items) {
  return (items || [])
    .filter(isScreen)
    .filter((i) => (i.rating || 0) >= 4)
    .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))
}

// Which titles the "because you liked X" rows hang off. Falls back to recently
// finished titles when nothing is rated yet, so a fresh library still gets a
// personal row instead of none.
export function tasteAnchors(items, n = 2) {
  let pool = lovedScreenItems(items)
  if (!pool.length) {
    pool = (items || [])
      .filter(isScreen)
      .filter((i) => i.status === 'done')
      .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))
  }
  if (!pool.length) return []
  // A rotating window, so the rows change day to day while never showing the
  // same anchor twice in one feed.
  const out = []
  const seen = new Set()
  for (let k = 0; k < pool.length && out.length < n; k += 1) {
    const it = pool[(dayIndex() + k) % pool.length]
    if (!it || seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

// The genres that keep showing up in what was rated highly. Counted over loved
// items only — counting the whole library would surface whatever type gets
// captured most, not what actually landed.
export function tasteGenres(items, n = 2) {
  const count = {}
  for (const i of lovedScreenItems(items)) {
    const g = i.extension?.genres || (i.extension?.genre ? [i.extension.genre] : [])
    for (const name of g) if (name) count[name] = (count[name] || 0) + 1
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, n)
}

// Personal rows drop anything already in the library — unlike the generic rows,
// where a checkmarked title is useful context ("yes, you have that"). Here the
// whole promise of the row is "things you have not got yet".
function dropExcluded(entries, exclude) {
  if (!exclude || !exclude.size) return entries
  return entries.filter((e) => !exclude.has(keyOf(e.type, e.title)))
}

// "Because you liked <X>" — TMDB's own recommendations for the anchor title.
// The anchor's tmdb_id usually rides along on the item (enrichment stores it);
// when it does not, resolve it by title once and cache the resulting row.
export async function fetchBecauseRow(anchor, exclude) {
  if (!API_KEY || !anchor) return []
  const cacheKey = `because.${anchor.type}.${(anchor.title || '').toLowerCase().slice(0, 60)}`
  const cached = readCache(cacheKey)
  if (cached) return dropExcluded(cached, exclude)

  let id = anchor.extension?.tmdb_id ?? null
  if (id == null) id = await tmdbResolveId(anchor.title, anchor.type).catch(() => null)
  if (id == null) return []

  const genreMap = await loadGenreMap()
  const res = await fetch(
    `${BASE}/${anchor.type}/${id}/recommendations?api_key=${API_KEY}&language=en-US&page=1`,
  ).catch(() => null)
  if (!res || !res.ok) return []
  const data = await res.json().catch(() => null)

  const entries = (data?.results || [])
    .map((r) => toEntry(r, r.media_type === 'tv' ? 'tv' : r.media_type === 'movie' ? 'movie' : anchor.type, genreMap))
    .filter(Boolean)
    .filter((e) => e.facts.image_url)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20)

  writeCache(cacheKey, entries)
  return dropExcluded(entries, exclude)
}

// "More <genre>" — well-liked titles in a genre that keeps getting rated highly,
// held to a vote floor so the row is not filled with obscure entries that merely
// happen to be tagged right. Provider-filtered: the point of the row is
// something that can start tonight.
export async function fetchGenreRow(genreName, exclude) {
  if (!API_KEY || !genreName) return []
  const cacheKey = `genre.${String(genreName).toLowerCase()}`
  const cached = readCache(cacheKey)
  if (cached) return dropExcluded(cached, exclude)

  const id = await genreIdFor(genreName)
  if (id == null) return []
  const genreMap = await loadGenreMap()

  const shared = {
    with_genres: String(id),
    with_watch_providers: ALL_PROVIDER_IDS,
    with_watch_monetization_types: 'flatrate',
    sort_by: 'popularity.desc',
    'vote_average.gte': '6.5',
  }
  const [movies, shows] = await Promise.all([
    discoverPage('movie', { ...shared, 'vote_count.gte': '300' }),
    discoverPage('tv', { ...shared, 'vote_count.gte': '120' }),
  ])

  const entries = [
    ...movies.map((r) => toEntry(r, 'movie', genreMap)),
    ...shows.map((r) => toEntry(r, 'tv', genreMap)),
  ]
    .filter(Boolean)
    .filter((e) => e.facts.image_url)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20)

  writeCache(cacheKey, entries)
  return dropExcluded(entries, exclude)
}

// "Acclaimed and streaming" — the highly-rated back catalogue on services
// already paid for. The vote_count floors do the heavy lifting: without them
// vote_average.desc returns films with nine votes and a perfect score.
export async function fetchAcclaimedRow(exclude) {
  if (!API_KEY) return []
  const cached = readCache('acclaimed')
  if (cached) return dropExcluded(cached, exclude)

  const genreMap = await loadGenreMap()
  const shared = {
    with_watch_providers: ALL_PROVIDER_IDS,
    with_watch_monetization_types: 'flatrate',
    sort_by: 'vote_average.desc',
  }
  const [movies, shows] = await Promise.all([
    discoverPage('movie', { ...shared, 'vote_count.gte': '1500' }),
    discoverPage('tv', { ...shared, 'vote_count.gte': '400' }),
  ])

  const entries = [
    ...movies.map((r) => toEntry(r, 'movie', genreMap)),
    ...shows.map((r) => toEntry(r, 'tv', genreMap)),
  ]
    .filter(Boolean)
    .filter((e) => e.facts.image_url)
    .sort((a, b) => (b.facts.tmdb_vote || 0) - (a.facts.tmdb_vote || 0))
    .slice(0, 20)

  writeCache('acclaimed', entries)
  return dropExcluded(entries, exclude)
}

// "In your queue, streaming now" — the one row built entirely from Cue's own
// rows rather than TMDB's catalogue: everything queued that sits on a
// subscription already held, i.e. what can be watched without waiting on a
// download.
//
// Cost is one /watch/providers call per queued title, so the pool is capped.
// With the 6h cache that is a handful of calls twice a day, not per visit.
const QUEUE_PROBE_CAP = 18

export async function fetchQueueStreamingRow(items) {
  if (!API_KEY) return []
  const queued = (items || [])
    .filter(isScreen)
    .filter((i) => i.status === 'queued' || i.status === 'active')
    .filter((i) => i.extension?.tmdb_id != null)
    .slice(0, QUEUE_PROBE_CAP)
  if (!queued.length) return []

  const cacheKey = `queue.${queued.map((i) => i.extension.tmdb_id).join('.')}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const probed = await Promise.all(queued.map(async (i) => {
    const on = await fetchWatchProviders(i.extension.tmdb_id, i.type)
    if (!on.length) return null
    return {
      id: `cue:${i.id}`,
      title: i.title,
      type: i.type,
      date: null,
      popularity: 0,
      facts: {
        ...(i.extension || {}),
        image_url: i.extension?.image_url || i.image_url || null,
        availability: on,
      },
    }
  }))

  const entries = probed.filter(Boolean).filter((e) => e.facts.image_url)
  writeCache(cacheKey, entries)
  return entries
}

// ── the feed ─────────────────────────────────────────────────
// The full feed definition, in render order. Each row lazily fetches itself so
// the tab paints immediately and fills in as TMDB answers.
//
// The order is deliberate and Netflix-shaped: what everyone is watching, what
// could be played right now, the rows built from the library's own taste, then
// per-service new arrivals, then what is not out yet.
export function feedRows(items) {
  const library = items || []
  const exclude = new Set(library.map((i) => keyOf(i.type, i.title)))
  const anchors = tasteAnchors(library, 2)
  const genres = tasteGenres(library, 2)

  const hasQueue = library.some(
    (i) => isScreen(i) && (i.status === 'queued' || i.status === 'active') && i.extension?.tmdb_id != null,
  )

  return [
    { key: 'trending', title: 'Trending this week', kicker: 'Everywhere', fetch: fetchTrendingRow },
    ...(hasQueue ? [{
      key: 'queue.streaming',
      title: 'In your queue, streaming now',
      kicker: 'No download needed',
      fetch: () => fetchQueueStreamingRow(library),
    }] : []),
    ...anchors.map((a) => ({
      key: `because.${a.id}`,
      title: `Because you liked ${a.title}`,
      kicker: 'Your taste',
      fetch: () => fetchBecauseRow(a, exclude),
    })),
    ...genres.map((g) => ({
      key: `genre.${g}`,
      title: `More ${String(g).toLowerCase()}`,
      kicker: 'On your services',
      fetch: () => fetchGenreRow(g, exclude),
    })),
    { key: 'acclaimed', title: 'Acclaimed and streaming', kicker: 'On your services', fetch: () => fetchAcclaimedRow(exclude) },
    ...PROVIDERS.map((p) => ({
      key: `new.${p.key}`,
      title: `New on ${p.label}`,
      kicker: 'Last 4 months',
      fetch: () => fetchProviderRow(p),
    })),
    { key: 'upcoming', title: 'Coming soon', kicker: 'Not out yet', fetch: fetchUpcomingRow, unreleased: true },
  ]
}
