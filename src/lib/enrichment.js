// Enrichment — the spine of Cue. Type-specific prompts → strict JSON →
// defensive parsing → fall back to a minimal manually-editable card on any
// failure. Never let a bad enrichment block a capture.

import { claudeComplete, extractJSON } from './claude'
import { jwLookup } from './justwatch'
import { openLibraryLookup, openLibrarySearch } from './sources/openlibrary'
import { googleBooksLookup, googleBooksSearch } from './sources/googlebooks'
import { openGraphLookup } from './sources/opengraph'
import { tmdbLookup, tmdbSearch } from './sources/tmdb'
import { youtubeLookup, youtubeSearch } from './sources/youtube'

const URL_RE = /^https?:\/\//i

const SYSTEM = `You enrich titles for a personal recommendation app called Cue.
You will be given a title and a type. Return JSON ONLY — no prose, no markdown
fences, no commentary. Make every field accurate when known, omit fields you
cannot confidently fill rather than guessing.`

const SHARED_RULES = `
- synopsis: 2-3 sentences, original wording (do NOT copy publisher blurb verbatim)
- image_tone: an array of two hex colors that evoke the item visually [bg_dark, accent]
- genre: a short single phrase
- links: an ordered array of { "label": "..." } targets to launch this item (web_url where stable, otherwise just label)`

const PROMPTS = {
  book: (title) => `Enrich this book: "${title}"

Return JSON with this exact shape:
{
  "title": "official title",
  "synopsis": "2-3 sentences",
  "extension": {
    "author": "...",
    "page_count": 0,
    "published_year": 0,
    "genre": "..."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "type",
  "links": [
    { "label": "Libby" },
    { "label": "Goodreads" },
    { "label": "Bookshop" }
  ]
}
${SHARED_RULES}`,

  tv: (title) => `Enrich this TV show: "${title}"

Return JSON with this exact shape:
{
  "title": "official title",
  "synopsis": "2-3 sentences",
  "extension": {
    "seasons": 0,
    "episodes_total": 0,
    "network_or_service": "...",
    "runtime_per_ep": 0,
    "genre": "...",
    "rt_critics": 0,
    "rt_audience": 0,
    "streaming_on": ["service", "service"]
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "poster",
  "links": [
    { "label": "JustWatch" },
    { "label": "Letterboxd" },
    { "label": "IMDb" }
  ]
}
${SHARED_RULES}`,

  movie: (title) => `Enrich this movie: "${title}"

Return JSON with this exact shape:
{
  "title": "official title",
  "synopsis": "2-3 sentences",
  "extension": {
    "runtime_min": 0,
    "release_year": 0,
    "director": "...",
    "genre": "...",
    "rt_critics": 0,
    "rt_audience": 0,
    "streaming_on": ["service", "service"]
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "poster",
  "links": [
    { "label": "JustWatch" },
    { "label": "Letterboxd" },
    { "label": "IMDb" }
  ]
}
${SHARED_RULES}`,

  article: (title) => `Enrich this article (title or URL): "${title}"

Return JSON with this exact shape:
{
  "title": "article headline",
  "synopsis": "2-3 sentences summarizing what it's about",
  "extension": {
    "source": "publication",
    "author": "byline",
    "est_read_min": 0,
    "word_count": 0,
    "genre": "..."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "type",
  "links": [
    { "label": "Read" }
  ]
}
${SHARED_RULES}`,

  video: (title) => `Enrich this YouTube video (title or URL): "${title}"

Return JSON with this exact shape:
{
  "title": "video title",
  "synopsis": "2-3 sentences",
  "extension": {
    "channel": "...",
    "duration_min": 0,
    "genre": "..."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "thumb",
  "links": [
    { "label": "YouTube" }
  ]
}
${SHARED_RULES}`,
}

// Minimal fallback — all fields manually editable.
function fallbackCard(title, type) {
  const tones = {
    book:    ['#2a2820', '#8a8260'],
    tv:      ['#0e2533', '#3a7da3'],
    movie:   ['#2a1a1f', '#a35a7a'],
    article: ['#23252a', '#7a7d85'],
    video:   ['#2a1f1a', '#a3633a'],
  }
  const links = {
    book:    [{ label: 'Libby' }, { label: 'Goodreads' }, { label: 'Bookshop' }],
    tv:      [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    movie:   [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    article: [{ label: 'Read' }],
    video:   [{ label: 'YouTube' }],
  }
  const coverKind = type === 'video' ? 'thumb'
    : (type === 'movie' || type === 'tv') ? 'poster'
    : 'type'
  return {
    title,
    type,
    synopsis: '',
    extension: {},
    image_tone: tones[type] || tones.book,
    cover_kind: coverKind,
    links: links[type] || [],
    _fallback: true,
  }
}

// Merge an Open Library result (book) over Claude's guesses. Real cover image
// is the big win; page count / first publish year are also more reliable here.
function mergeOpenLibrary(merged, ol) {
  if (!ol) return merged
  const ext = { ...merged.extension }
  if (ol.author) ext.author = ol.author
  if (ol.published_year) ext.published_year = ol.published_year
  if (ol.page_count) ext.page_count = ol.page_count
  if (ol.genre && !ext.genre) ext.genre = ol.genre
  return {
    ...merged,
    title: ol.title || merged.title,
    extension: ext,
    image_url: ol.image_url || merged.image_url || null,
    _olHit: !!ol.image_url,
  }
}

// Merge a Google Books result (book) over Claude's guesses. Primary book facts
// source: better covers, page counts, categories than Open Library. Applied
// AFTER Open Library so GB wins overlapping fields; OL stays as the backfill.
// Synopsis stays Claude's original wording (GB description is publisher blurb)
// unless Claude left it empty.
function mergeGoogleBooks(merged, gb) {
  if (!gb) return merged
  const ext = { ...merged.extension }
  if (gb.author) ext.author = gb.author
  if (gb.published_year) ext.published_year = gb.published_year
  if (gb.page_count) ext.page_count = gb.page_count
  if (gb.genre) ext.genre = gb.genre
  return {
    ...merged,
    title: gb.title || merged.title,
    synopsis: merged.synopsis || gb.synopsis || '',
    extension: ext,
    image_url: gb.image_url || merged.image_url || null,
    _gbHit: !!gb.image_url,
  }
}

// Merge OpenGraph article metadata over Claude's guesses. OG gives real source
// + author + image + title; we still let Claude write the synopsis (OG
// descriptions are often marketing copy or empty).
function mergeOpenGraph(merged, og) {
  if (!og) return merged
  const ext = { ...merged.extension }
  if (og.source) ext.source = og.source
  if (og.author) ext.author = og.author
  if (og.est_read_min) ext.est_read_min = og.est_read_min
  if (og.word_count) ext.word_count = og.word_count
  const links = og.web_url
    ? [{ label: 'Read', web_url: og.web_url }, ...(merged.links || []).filter((l) => l.label !== 'Read')]
    : merged.links
  return {
    ...merged,
    title: og.title || merged.title,
    synopsis: merged.synopsis || og.synopsis || '',
    extension: ext,
    image_url: og.image_url || merged.image_url || null,
    links,
    _ogHit: true,
  }
}

// Merge TMDB results over Claude's guesses for movie/tv. Real poster image is
// the big win; canonical title/year/overview are also high-quality.
function mergeTmdb(merged, tm, type) {
  if (!tm) return merged
  const ext = { ...merged.extension }
  if (tm.year) {
    if (type === 'movie') ext.release_year = tm.year
    if (type === 'tv') ext.first_air_year = tm.year
  }
  if (tm.tmdb_vote != null) ext.tmdb_vote = tm.tmdb_vote
  return {
    ...merged,
    title: tm.title || merged.title,
    synopsis: merged.synopsis || tm.synopsis || '',
    extension: ext,
    image_url: tm.image_url || merged.image_url || null,
    _tmdbHit: !!tm.image_url,
  }
}

// Merge YouTube results over Claude's guesses for videos. Real thumbnail,
// canonical title/channel, exact duration.
function mergeYoutube(merged, yt) {
  if (!yt) return merged
  const ext = { ...merged.extension }
  if (yt.channel) ext.channel = yt.channel
  if (yt.duration_min) ext.duration_min = yt.duration_min
  const links = yt.web_url
    ? [{ label: 'YouTube', web_url: yt.web_url }, ...(merged.links || []).filter((l) => l.label !== 'YouTube')]
    : merged.links
  return {
    ...merged,
    title: yt.title || merged.title,
    synopsis: merged.synopsis || yt.synopsis || '',
    extension: ext,
    image_url: yt.image_url || merged.image_url || null,
    links,
    _ytHit: true,
  }
}

// Merge JustWatch results over Claude's guesses for movie/tv. JW gives real
// streaming availability (US) + RT/IMDB scores + canonical title/year.
function mergeJustWatch(merged, jw, type) {
  if (!jw) return merged
  const ext = { ...merged.extension }
  if (jw.where_to_find?.length) {
    ext.streaming_on = jw.where_to_find.map((w) => w.label)
  }
  if (jw.scoring?.rt != null) ext.rt_critics = jw.scoring.rt
  if (jw.scoring?.imdb != null) ext.imdb = jw.scoring.imdb
  if (jw.year) {
    if (type === 'movie') ext.release_year = jw.year
    if (type === 'tv') ext.first_air_year = jw.year
  }
  const jwLinks = (jw.where_to_find || []).map((w) => ({ label: w.label, web_url: w.url }))
  // Keep generic discovery links (Letterboxd/IMDb) after the streaming links.
  const genericLinks = (merged.links || []).filter((l) =>
    !jwLinks.some((j) => j.label === l.label))
  return {
    ...merged,
    title: jw.title || merged.title,
    synopsis: merged.synopsis || jw.summary || '',
    extension: ext,
    links: jwLinks.length ? [...jwLinks, ...genericLinks] : merged.links,
    _jwHit: true,
  }
}

// Per-type external source lookups, all run in parallel with Claude. Each
// promise resolves to null on miss; none throw. Movie/tv fan out to both TMDB
// (poster + canonical) and JustWatch (streaming + scoring) at once.
async function gatherSources(type, input) {
  if (type === 'movie' || type === 'tv') {
    const [tmdb, jw] = await Promise.all([
      tmdbLookup(input, type).catch(() => null),
      jwLookup(input).catch(() => null),
    ])
    return { tmdb, jw }
  }
  if (type === 'book') {
    const [gb, ol] = await Promise.all([
      googleBooksLookup(input).catch(() => null),
      openLibraryLookup(input).catch(() => null),
    ])
    return { gb, ol }
  }
  if (type === 'article') return { og: await openGraphLookup(input).catch(() => null) }
  if (type === 'video') return { yt: await youtubeLookup(input).catch(() => null) }
  return {}
}

// Apply each successful source merge in priority order. TMDB before JustWatch
// so the poster + canonical title win; JustWatch layers streaming + scores on
// top without overwriting image_url.
function applySources(merged, srcs, type) {
  let out = merged
  // OL first, then GB — GB wins overlapping book fields, OL backfills gaps.
  if (srcs.ol) out = mergeOpenLibrary(out, srcs.ol)
  if (srcs.gb) out = mergeGoogleBooks(out, srcs.gb)
  if (srcs.og) out = mergeOpenGraph(out, srcs.og)
  if (srcs.tmdb) out = mergeTmdb(out, srcs.tmdb, type)
  if (srcs.jw) out = mergeJustWatch(out, srcs.jw, type)
  if (srcs.yt) out = mergeYoutube(out, srcs.yt)
  return out
}

// When the user picked a specific candidate from the disambiguation list,
// overlay that candidate's hard facts (cover/title/year/author…) on top of the
// merged card so the picked identity always wins — even if the re-query drifted.
// Reuses the per-source merge helpers; locked.raw matches each source's shape.
function applyLockedFacts(card, locked, type) {
  const r = locked?.raw
  if (!r) return card
  if (type === 'book') return mergeGoogleBooks(card, r)
  if (type === 'movie' || type === 'tv') return mergeTmdb(card, r, type)
  if (type === 'video') return mergeYoutube(card, r)
  return card
}

// `locked` (optional) is a candidate chosen from searchCandidates(); its
// disambiguating query drives Claude + the source re-lookup, and its facts are
// overlaid last so the exact picked item wins.
export async function enrich(title, type, locked = null) {
  const trimmed = (title || '').trim()
  if (!trimmed) return fallbackCard('', type)

  const promptFn = PROMPTS[type]
  if (!promptFn) return fallbackCard(trimmed, type)

  // A locked candidate carries a more specific query (e.g. "title author").
  const queryInput = (locked?.query || trimmed).trim()
  const finalize = (card, srcs) => {
    const out = applySources(card, srcs, type)
    return locked ? applyLockedFacts(out, locked, type) : out
  }

  // Kick off all type-specific external sources in parallel with Claude.
  const sourcesPromise = gatherSources(type, queryInput)

  try {
    const raw = await claudeComplete(promptFn(queryInput), {
      system: SYSTEM,
      max_tokens: 800,
    })
    const parsed = extractJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      const srcs = await sourcesPromise
      return finalize(fallbackCard(trimmed, type), srcs)
    }

    const baseFallback = fallbackCard(trimmed, type)
    const merged = {
      ...baseFallback,
      title: parsed.title || baseFallback.title,
      synopsis: parsed.synopsis || '',
      extension: { ...baseFallback.extension, ...(parsed.extension || {}) },
      image_tone: parsed.image_tone || baseFallback.image_tone,
      cover_kind: parsed.cover_kind || baseFallback.cover_kind,
      links: Array.isArray(parsed.links) && parsed.links.length ? parsed.links : baseFallback.links,
      _fallback: false,
    }
    const srcs = await sourcesPromise
    return finalize(merged, srcs)
  } catch {
    const srcs = await sourcesPromise
    return finalize(fallbackCard(trimmed, type), srcs)
  }
}

// Top candidate matches for the disambiguation picker. Returns a normalized,
// deduped list; the caller shows a picker only when it finds 2+ distinct
// entries. Books prefer Google Books, falling back to Open Library on a 429.
// Articles (URL-based) and any URL input are exact — no candidates.
export async function searchCandidates(type, query) {
  const q = (query || '').trim()
  if (!q || URL_RE.test(q)) return []

  let raws = []
  if (type === 'book') {
    const [gb, ol] = await Promise.all([
      googleBooksSearch(q).catch(() => []),
      openLibrarySearch(q).catch(() => []),
    ])
    raws = gb.length ? gb : ol
  } else if (type === 'movie' || type === 'tv') {
    raws = await tmdbSearch(q, type).catch(() => [])
  } else if (type === 'video') {
    raws = await youtubeSearch(q).catch(() => [])
  } else {
    return []
  }

  const seen = new Set()
  const out = []
  for (const r of raws) {
    const norm = normalizeCandidate(r, type)
    if (!norm) continue
    const key = `${norm.title.toLowerCase().trim()}|${(norm.subtitle || '').toLowerCase().trim()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...norm, key })
  }
  return out
}

function normalizeCandidate(r, type) {
  if (!r || !r.title) return null
  if (type === 'book') {
    return {
      type, title: r.title, subtitle: r.author || '', year: r.published_year || null,
      image_url: r.image_url || null,
      query: [r.title, r.author].filter(Boolean).join(' '),
      raw: r,
    }
  }
  if (type === 'movie' || type === 'tv') {
    return {
      type, title: r.title, subtitle: r.year ? String(r.year) : '', year: r.year || null,
      image_url: r.image_url || null,
      query: [r.title, r.year].filter(Boolean).join(' '),
      raw: r,
    }
  }
  if (type === 'video') {
    return {
      type, title: r.title, subtitle: r.channel || '', year: null,
      image_url: r.image_url || null,
      query: r.web_url || [r.title, r.channel].filter(Boolean).join(' '),
      raw: r,
    }
  }
  return null
}
