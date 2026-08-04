// Enrichment — the spine of Cue. Type-specific prompts → strict JSON →
// defensive parsing → fall back to a minimal manually-editable card on any
// failure. Never let a bad enrichment block a capture.

import { claudeComplete, extractJSON } from './claude'
import { toSeason } from './items'
import { jwLookup } from './justwatch'
import { openLibraryLookup, openLibrarySearch } from './sources/openlibrary'
import { googleBooksLookup, googleBooksSearch } from './sources/googlebooks'
import { openGraphLookup } from './sources/opengraph'
import { tmdbLookup, tmdbSearch, tmdbSeason, tmdbSeasonList } from './sources/tmdb'
import { youtubeLookup, youtubeSearch } from './sources/youtube'
import { musicBrainzLookup, musicBrainzSearch } from './sources/musicbrainz'

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

  tv: (title, season = null) => `Enrich this TV show: "${title}"${season != null ? `

The user is interested in SEASON ${season} specifically. Write the synopsis about
that season's story, not the series as a whole. Every other field still describes
the whole series.` : ''}

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

  podcast: (title) => `Enrich this podcast (show name): "${title}"

Return JSON with this exact shape:
{
  "title": "official show name",
  "synopsis": "2-3 sentences on what the show is about",
  "extension": {
    "host": "...",
    "publisher": "network or studio",
    "genre": "...",
    "cadence": "weekly | daily | seasonal | etc."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "type",
  "links": [
    { "label": "Apple Podcasts" },
    { "label": "Spotify" },
    { "label": "Overcast" }
  ]
}
${SHARED_RULES}`,

  music: (title) => `Enrich this music album or release: "${title}"

Return JSON with this exact shape:
{
  "title": "official album title",
  "synopsis": "2-3 sentences on the album / its significance",
  "extension": {
    "artist": "...",
    "published_year": 0,
    "label": "record label",
    "track_count": 0,
    "album_type": "Album | EP | Single | Compilation",
    "genre": "..."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "art",
  "links": [
    { "label": "Spotify" },
    { "label": "Apple Music" },
    { "label": "Bandcamp" }
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
    podcast: ['#1f1a2a', '#7a5aa3'],
    music:   ['#1a2420', '#5aa37a'],
  }
  const links = {
    book:    [{ label: 'Libby' }, { label: 'Goodreads' }, { label: 'Bookshop' }],
    tv:      [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    movie:   [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    article: [{ label: 'Read' }],
    video:   [{ label: 'YouTube' }],
    podcast: [{ label: 'Apple Podcasts' }, { label: 'Spotify' }, { label: 'Overcast' }],
    music:   [{ label: 'Spotify' }, { label: 'Apple Music' }, { label: 'Bandcamp' }],
  }
  const coverKind = type === 'video' ? 'thumb'
    : (type === 'movie' || type === 'tv') ? 'poster'
    : type === 'music' ? 'art'
    : 'type'
  return {
    title,
    type,
    // Every consumer of an enriched card (DraftCard's editor, items.addItem →
    // recommendations.summary) reads `enrichment.synopsis`, so the two are kept
    // in lockstep. Writing only the flat `synopsis` silently drops it on save.
    synopsis: '',
    enrichment: { synopsis: '' },
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
// the big win; canonical title/year/overview/runtime/genres/director are also
// high-quality hard facts. Defensive: every field guarded so a sparse result
// (e.g. a search-only candidate with no detail call yet) never overwrites a
// good Claude value with null. Synopsis prefers TMDB's overview, else Claude.
function mergeTmdb(merged, tm, type) {
  if (!tm) return merged
  const ext = { ...merged.extension }
  if (tm.year) {
    if (type === 'movie') ext.release_year = tm.year
    if (type === 'tv') ext.first_air_year = tm.year
  }
  // Runtime maps to the per-type Claude field name.
  if (tm.runtime) {
    if (type === 'movie') ext.runtime_min = tm.runtime
    if (type === 'tv') ext.runtime_per_ep = tm.runtime
  }
  // Genres: keep the full list AND a single-phrase genre for the card.
  if (Array.isArray(tm.genres) && tm.genres.length) ext.genres = tm.genres
  if (tm.genre) ext.genre = tm.genre
  // Director (movie) / creator (tv) — only overwrite when TMDB has a value.
  if (type === 'movie' && tm.director) ext.director = tm.director
  if (type === 'tv' && tm.creator) ext.creator = tm.creator
  if (tm.tmdb_vote != null) ext.tmdb_vote = tm.tmdb_vote
  // tmdb_id is what the season picker and the *arr push both key on, so it has
  // to survive onto the saved item, not just live in the merge.
  if (tm.tmdb_id != null) ext.tmdb_id = tm.tmdb_id
  // TV season inventory — TMDB counts beat Claude's, and seasons_list is what
  // the picker renders. Only present on a detail lookup, so guarded.
  if (type === 'tv') {
    if (Array.isArray(tm.seasons_list) && tm.seasons_list.length) ext.seasons_list = tm.seasons_list
    if (tm.seasons) ext.seasons = tm.seasons
    if (tm.episodes_total) ext.episodes_total = tm.episodes_total
  }
  return {
    ...merged,
    title: tm.title || merged.title,
    // Synopsis: prefer TMDB overview when present, else keep Claude's.
    synopsis: tm.synopsis || merged.synopsis || '',
    extension: ext,
    image_url: tm.image_url || merged.image_url || null,
    _tmdbHit: !!tm.image_url,
  }
}

// The merge helpers all write the flat `synopsis`; the UI and the save path both
// read `enrichment.synopsis`. Reconcile once, at the end of every enrich.
function syncSynopsis(card) {
  const synopsis = card.synopsis || card.enrichment?.synopsis || ''
  return { ...card, synopsis, enrichment: { ...(card.enrichment || {}), synopsis } }
}

// Stash the show-level synopsis/poster before a season narrows the card, so the
// season picker can offer "whole show" without paying for another enrich.
// `_show` is a leading-underscore scratch field — items.addItem ignores it, so
// it never reaches the database.
function withShowSnapshot(card) {
  if (card._show) return card
  return {
    ...card,
    _show: { synopsis: card.synopsis || '', image_url: card.image_url || null },
  }
}

// Point a TV card at one season. Show-level facts (network, creator, total
// seasons, seasons_list) all stay — the season layers its own number, episode
// count, air year and, when TMDB has them, its own poster and overview on top.
// `ext.season` is the field App.pushToRadarr sends to Sonarr, so it is stamped
// even when the TMDB season fetch missed (no key / offline): the number the user
// picked is still the number the download manager should search for.
function mergeSeason(merged, s) {
  if (!s || s.season_number == null) return merged
  const ext = { ...merged.extension, season: s.season_number }
  if (s.name) ext.season_name = s.name
  if (s.episode_count) ext.season_episodes = s.episode_count
  if (s.year) ext.season_year = s.year
  const synopsis = s.overview || merged.synopsis || ''
  return {
    ...merged,
    extension: ext,
    // A season poster is more specific than the show poster when TMDB has one.
    image_url: s.image_url || merged.image_url || null,
    synopsis,
    enrichment: { ...(merged.enrichment || {}), synopsis },
  }
}

// Drop back to the whole show: strip every season-scoped field and restore the
// show-level synopsis/poster captured at enrich time (see `_show`).
function clearSeason(card) {
  const ext = { ...(card.extension || {}) }
  delete ext.season
  delete ext.season_name
  delete ext.season_episodes
  delete ext.season_year
  const show = card._show || {}
  const synopsis = show.synopsis ?? card.synopsis ?? ''
  return {
    ...card,
    extension: ext,
    image_url: show.image_url ?? card.image_url ?? null,
    synopsis,
    enrichment: { ...(card.enrichment || {}), synopsis },
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

// Merge a MusicBrainz result (music) over Claude's guesses. Real cover art (via
// the Cover Art Archive) is the big win; artist / year / label / track count /
// album type are also more reliable from the database than Claude. Synopsis
// stays Claude's wording (MusicBrainz has none). Defensive: every field guarded
// so a sparse release-group never overwrites a good Claude value with null.
function mergeMusicBrainz(merged, mb) {
  if (!mb) return merged
  const ext = { ...merged.extension }
  if (mb.artist) ext.artist = mb.artist
  if (mb.published_year) ext.published_year = mb.published_year
  if (mb.label) ext.label = mb.label
  if (mb.track_count) ext.track_count = mb.track_count
  if (mb.album_type) ext.album_type = mb.album_type
  return {
    ...merged,
    title: mb.title || merged.title,
    extension: ext,
    image_url: mb.image_url || merged.image_url || null,
    _mbHit: !!mb.image_url,
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
// `season` (tv only) triggers a second, dependent TMDB call — the season detail
// needs the show's tmdb_id, which only exists once the lookup resolves.
async function gatherSources(type, input, season = null) {
  if (type === 'movie' || type === 'tv') {
    const [tmdb, jw] = await Promise.all([
      tmdbLookup(input, type).catch(() => null),
      jwLookup(input).catch(() => null),
    ])
    let seasonFacts = null
    if (type === 'tv' && season != null && tmdb?.tmdb_id != null) {
      seasonFacts = await tmdbSeason(tmdb.tmdb_id, season).catch(() => null)
    }
    return { tmdb, jw, season: seasonFacts }
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
  if (type === 'music') return { mb: await musicBrainzLookup(input).catch(() => null) }
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
  if (srcs.mb) out = mergeMusicBrainz(out, srcs.mb)
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
  if (type === 'music') return mergeMusicBrainz(card, r)
  return card
}

// `locked` (optional) is a candidate chosen from searchCandidates(); its
// disambiguating query drives Claude + the source re-lookup, and its facts are
// overlaid last so the exact picked item wins.
//
// `opts.season` (tv only) narrows the card to one season: the synopsis becomes
// that season's, the poster becomes its poster where TMDB has one, and
// `extension.season` carries the number through to the Sonarr push. Everything
// else still describes the whole series.
export async function enrich(title, type, locked = null, opts = {}) {
  const trimmed = (title || '').trim()
  if (!trimmed) return fallbackCard('', type)

  const promptFn = PROMPTS[type]
  if (!promptFn) return fallbackCard(trimmed, type)

  const season = type === 'tv' ? toSeason(opts.season) : null

  // A locked candidate carries a more specific query (e.g. "title author").
  const queryInput = (locked?.query || trimmed).trim()
  const finalize = (card, srcs) => {
    let out = applySources(card, srcs, type)
    if (locked) out = applyLockedFacts(out, locked, type)
    // Snapshot the show-level card BEFORE the season narrows it, so the picker
    // can switch back to "whole show" without re-enriching.
    if (type === 'tv') out = withShowSnapshot(out)
    // Season last: it has to beat both the locked candidate's show poster and
    // TMDB's show overview. Falls back to the bare number when the season fetch
    // missed, so the push is still season-specific.
    if (season != null) out = mergeSeason(out, srcs.season || { season_number: season })
    return syncSynopsis(out)
  }

  // Kick off all type-specific external sources in parallel with Claude.
  const sourcesPromise = gatherSources(type, queryInput, season)

  try {
    const raw = await claudeComplete(promptFn(queryInput, season), {
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

// ── seasons ──────────────────────────────────────────────────────────────────

// Every season of a TV card, for the picker. Uses the list TMDB already put on
// the card during enrichment; falls back to a lookup for older saved items (and
// for anything captured before seasons existed). Empty array when TMDB can't
// resolve the show — the picker then simply doesn't render.
export async function seasonsFor(item) {
  if (!item || item.type !== 'tv') return []
  const ext = item.extension || {}
  if (Array.isArray(ext.seasons_list) && ext.seasons_list.length) return ext.seasons_list
  const id = ext.tmdb_id ?? (await tmdbLookup(item.title, 'tv').catch(() => null))?.tmdb_id
  if (id == null) return []
  return tmdbSeasonList(id).catch(() => [])
}

// Re-point an already-enriched TV card at `season` (or back to the whole show
// with null). TMDB-only — no Claude round-trip — so tapping through seasons is
// one fast request instead of a full re-enrich. Returns the card unchanged for
// non-TV.
export async function pickSeason(card, season) {
  if (!card || card.type !== 'tv') return card
  // Snapshot first (a card loaded from the DB has no `_show`), then strip any
  // season already on it so switching S2 → S3 doesn't stack S2's poster.
  const base = clearSeason(withShowSnapshot(card))
  const n = toSeason(season)
  if (n == null) return syncSynopsis(base)
  const ext = base.extension || {}
  const id = ext.tmdb_id ?? (await tmdbLookup(base.title, 'tv').catch(() => null))?.tmdb_id
  const facts = id == null ? null : await tmdbSeason(id, n).catch(() => null)
  return syncSynopsis(mergeSeason(base, facts || { season_number: n }))
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
  } else if (type === 'music') {
    raws = await musicBrainzSearch(q).catch(() => [])
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

// Auto/type-agnostic candidate search. The user hasn't told us what kind of
// thing this is, so we search the popular media types in parallel and let them
// pick. Each source returns its hits already ordered by popularity/relevance;
// we interleave across types (round-robin by rank) so the picker shows a spread
// — most-popular movie, top show, top book… — instead of all movies first.
// URLs are exact (an article/video link), so auto returns [].
export async function searchCandidatesAuto(query) {
  const q = (query || '').trim()
  if (!q || URL_RE.test(q)) return []

  const [movie, tv, book, music] = await Promise.all([
    tmdbSearch(q, 'movie').catch(() => []),
    tmdbSearch(q, 'tv').catch(() => []),
    googleBooksSearch(q).catch(() => []).then((gb) => gb.length ? gb : openLibrarySearch(q).catch(() => [])),
    musicBrainzSearch(q).catch(() => []),
  ])

  // Normalize each source's hits, tagged with their type.
  const lanes = [
    movie.map((r) => normalizeCandidate(r, 'movie')),
    tv.map((r) => normalizeCandidate(r, 'tv')),
    book.map((r) => normalizeCandidate(r, 'book')),
    music.map((r) => normalizeCandidate(r, 'music')),
  ].map((lane) => lane.filter(Boolean))

  // Round-robin interleave across lanes for a cross-type spread.
  const seen = new Set()
  const out = []
  const maxLen = Math.max(0, ...lanes.map((l) => l.length))
  for (let i = 0; i < maxLen && out.length < 8; i++) {
    for (const lane of lanes) {
      if (out.length >= 8) break
      const norm = lane[i]
      if (!norm) continue
      const key = `${norm.type}|${norm.title.toLowerCase().trim()}|${(norm.subtitle || '').toLowerCase().trim()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...norm, key })
    }
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
  if (type === 'music') {
    return {
      type, title: r.title, subtitle: r.artist || '', year: r.published_year || null,
      image_url: r.image_url || null,
      query: [r.title, r.artist].filter(Boolean).join(' '),
      raw: r,
    }
  }
  return null
}
