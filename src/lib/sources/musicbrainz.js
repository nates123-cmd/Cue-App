// MusicBrainz lookup for music (albums / release-groups). Free, no key required,
// CORS-enabled (no proxy) — same shape as the Google Books source. Cover art
// comes from the Cover Art Archive (CAA), keyed by the release-group MBID.
//
// We use the REST API directly rather than the `musicbrainz-api` npm package:
// that package depends on `tough-cookie` and other Node-only modules, so it does
// not bundle cleanly for the browser/Vite. The REST endpoints are keyless,
// CORS-friendly, and give us everything we need.
//
// Rate limits: MusicBrainz asks for max 1 req/sec and a descriptive User-Agent.
// We serialize all requests through a single-flight 1.1s queue and send the
// required UA header. Returns a partial enrichment: title, artist, year, label,
// track count, primary type (Album/EP/Single…), cover image URL.

const MB_BASE = 'https://musicbrainz.org/ws/2'
const CAA_BASE = 'https://coverartarchive.org'
const UA = 'Cue/1.0 ( nates123@gmail.com )'

// Serialize requests so we never exceed MusicBrainz's ~1 req/sec ceiling. Each
// call waits until at least MIN_GAP ms after the previous one started.
const MIN_GAP = 1100
let lastStart = 0
let chain = Promise.resolve()
function throttle() {
  chain = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP - (Date.now() - lastStart))
    if (wait) await new Promise((r) => setTimeout(r, wait))
    lastStart = Date.now()
  })
  return chain
}

async function mbFetch(path) {
  await throttle()
  // Browsers reject a custom User-Agent header on fetch, but MusicBrainz also
  // accepts it as a query param. Send both so it works server-side too.
  const sep = path.includes('?') ? '&' : '?'
  const url = `${MB_BASE}${path}${sep}fmt=json`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  })
  if (!res.ok) return null
  return res.json()
}

// "2013-05-17" / "2013-05" / "2013" → 2013.
function yearOf(date) {
  if (!date) return null
  return parseInt(String(date).slice(0, 4), 10) || null
}

// Cover Art Archive front image for a release-group MBID. The endpoint 307s to
// the actual hosted image; we hand back the stable CAA URL and let the browser
// follow the redirect (CAA sets CORS + caches well).
function caaCover(rgid) {
  return rgid ? `${CAA_BASE}/release-group/${rgid}/front-500` : null
}

// A MusicBrainz release-group → the partial-enrichment shape the merge layer
// expects. label + track_count need a follow-up release fetch (see lookup).
function rgToFacts(rg) {
  if (!rg) return null
  const artist = Array.isArray(rg['artist-credit']) && rg['artist-credit'].length
    ? rg['artist-credit'].map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim()
    : null
  return {
    mbid: rg.id || null,
    title: rg.title || null,
    artist: artist || null,
    published_year: yearOf(rg['first-release-date']),
    album_type: rg['primary-type'] || null,
    label: null,
    track_count: null,
    image_url: caaCover(rg.id),
  }
}

// Pull label + total track count from the release-group's first release. Best
// effort — never throws, just leaves the fields null on any miss.
async function enrichFromRelease(facts) {
  if (!facts?.mbid) return facts
  try {
    const rg = await mbFetch(`/release-group/${facts.mbid}?inc=releases`)
    const relId = rg?.releases?.[0]?.id
    if (!relId) return facts
    const rel = await mbFetch(`/release/${relId}?inc=labels+recordings`)
    if (!rel) return facts
    const trackCount = Array.isArray(rel.media)
      ? rel.media.reduce((a, m) => a + (m['track-count'] || 0), 0) || null
      : null
    const label = Array.isArray(rel['label-info']) && rel['label-info'].length
      ? rel['label-info'].map((l) => l.label?.name).filter(Boolean)[0] || null
      : null
    return { ...facts, track_count: trackCount, label }
  } catch {
    return facts
  }
}

// Search release-groups, returning the top match enriched with label + track
// count. Empty input or any failure → null.
export async function musicBrainzLookup(query) {
  const q = (query || '').trim()
  if (!q) return null
  try {
    const data = await mbFetch(`/release-group/?query=${encodeURIComponent(q)}&limit=1`)
    const rg = data?.['release-groups']?.[0]
    const facts = rgToFacts(rg)
    if (!facts) return null
    return enrichFromRelease(facts)
  } catch {
    return null
  }
}

// Top-N candidate matches for the disambiguation picker. Same fact shape as
// musicBrainzLookup, one per release-group. We do NOT fan out to per-release
// label/track lookups here (would be N extra rate-limited calls); those fill in
// when the user picks one and the full enrich() runs. Empty array on miss.
export async function musicBrainzSearch(query, n = 6) {
  const q = (query || '').trim()
  if (!q) return []
  try {
    const data = await mbFetch(`/release-group/?query=${encodeURIComponent(q)}&limit=${n}`)
    return (data?.['release-groups'] || []).map(rgToFacts).filter(Boolean)
  } catch {
    return []
  }
}
