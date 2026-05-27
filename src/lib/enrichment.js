// Enrichment — the spine of Cue. Type-specific prompts → strict JSON →
// defensive parsing → fall back to a minimal manually-editable card on any
// failure. Never let a bad enrichment block a capture.

import { claudeComplete, extractJSON } from './claude'
import { jwLookup } from './justwatch'
import { openLibraryLookup } from './sources/openlibrary'
import { openGraphLookup } from './sources/opengraph'
import { tmdbLookup } from './sources/tmdb'
import { youtubeLookup } from './sources/youtube'

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
  if (type === 'book') return { ol: await openLibraryLookup(input).catch(() => null) }
  if (type === 'article') return { og: await openGraphLookup(input).catch(() => null) }
  if (type === 'video') return { yt: await youtubeLookup(input).catch(() => null) }
  return {}
}

// Apply each successful source merge in priority order. TMDB before JustWatch
// so the poster + canonical title win; JustWatch layers streaming + scores on
// top without overwriting image_url.
function applySources(merged, srcs, type) {
  let out = merged
  if (srcs.ol) out = mergeOpenLibrary(out, srcs.ol)
  if (srcs.og) out = mergeOpenGraph(out, srcs.og)
  if (srcs.tmdb) out = mergeTmdb(out, srcs.tmdb, type)
  if (srcs.jw) out = mergeJustWatch(out, srcs.jw, type)
  if (srcs.yt) out = mergeYoutube(out, srcs.yt)
  return out
}

export async function enrich(title, type) {
  const trimmed = (title || '').trim()
  if (!trimmed) return fallbackCard('', type)

  const promptFn = PROMPTS[type]
  if (!promptFn) return fallbackCard(trimmed, type)

  // Kick off all type-specific external sources in parallel with Claude.
  const sourcesPromise = gatherSources(type, trimmed)

  try {
    const raw = await claudeComplete(promptFn(trimmed), {
      system: SYSTEM,
      max_tokens: 800,
    })
    const parsed = extractJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      const srcs = await sourcesPromise
      return applySources(fallbackCard(trimmed, type), srcs, type)
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
    return applySources(merged, srcs, type)
  } catch {
    const srcs = await sourcesPromise
    return applySources(fallbackCard(trimmed, type), srcs, type)
  }
}
