// One-shot backfill for existing library rows. Runs once per browser
// (localStorage flag) after a key/source provider gets added.
//
// Two passes per row:
//   1. Source provider (TMDB / Open Library / OpenGraph / YouTube) →
//      fills image_url + provider-native extension fields.
//   2. Claude — small focused call that ONLY fills empty synopsis / genre.
//      Won't overwrite any field the user (or earlier enrichment) already set.

import { supabase } from './supabase'
import { tmdbLookup } from './sources/tmdb'
import { openLibraryLookup } from './sources/openlibrary'
import { openGraphLookup } from './sources/opengraph'
import { youtubeLookup } from './sources/youtube'
import { claudeComplete, extractJSON } from './claude'

// Bump the version suffix to force backfill to retry on next load.
const FLAG = 'cue:backfill:image_url:v3'

async function lookupFor(type, input) {
  if (type === 'movie' || type === 'tv') return tmdbLookup(input, type).catch(() => null)
  if (type === 'book') return openLibraryLookup(input).catch(() => null)
  if (type === 'article') return openGraphLookup(input).catch(() => null)
  if (type === 'video') return youtubeLookup(input).catch(() => null)
  return null
}

// Build a patch from a source result. Only fill empty fields.
function patchFromSource(item, src, type) {
  if (!src) return { patch: {}, mergedExt: { ...(item.extension || {}) }, mergedSynopsis: item.enrichment?.synopsis || '' }
  const ext = { ...(item.extension || {}) }
  let changedExt = false
  const fill = (key, val) => {
    if (val == null || val === '') return
    if (ext[key] == null || ext[key] === '') { ext[key] = val; changedExt = true }
  }
  if (type === 'movie' && src.year) fill('release_year', src.year)
  if (type === 'tv' && src.year) fill('first_air_year', src.year)
  if (type === 'book') {
    fill('author', src.author)
    fill('published_year', src.published_year)
    fill('page_count', src.page_count)
    fill('genre', src.genre)
  }
  if (type === 'article') {
    fill('source', src.source)
    fill('author', src.author)
    fill('est_read_min', src.est_read_min)
    fill('word_count', src.word_count)
  }
  if (type === 'video') {
    fill('channel', src.channel)
    fill('duration_min', src.duration_min)
  }
  const patch = {}
  if (src.image_url && !item.image_url) patch.image_url = src.image_url

  // Sources may also carry a synopsis (TMDB.overview, OG.description, YT.description).
  // Use it ONLY when the local synopsis is empty.
  const haveSynopsis = !!(item.enrichment?.synopsis && item.enrichment.synopsis.trim())
  let mergedSynopsis = item.enrichment?.synopsis || ''
  if (!haveSynopsis && src.synopsis) {
    patch.summary = src.synopsis
    mergedSynopsis = src.synopsis
  }

  if (changedExt) patch.extension = ext
  return { patch, mergedExt: ext, mergedSynopsis }
}

// Small focused Claude call. Asks ONLY for synopsis + genre and returns JSON.
async function claudeSynopsisAndGenre(type, title) {
  try {
    const raw = await claudeComplete(
      `Provide a 2-3 sentence synopsis and a short single-phrase genre for this ${type}: "${title}". Return JSON ONLY (no prose, no markdown), exactly this shape:\n{"synopsis":"...","genre":"..."}`,
      {
        system: 'You enrich titles for a personal recommendation app. Be accurate; if you do not know, return empty strings rather than guessing. Return JSON only.',
        max_tokens: 250,
      }
    )
    const parsed = extractJSON(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      synopsis: typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : '',
      genre: typeof parsed.genre === 'string' ? parsed.genre.trim() : '',
    }
  } catch {
    return null
  }
}

export async function backfillMissingImages(items, opts = {}) {
  const { force = false, onProgress } = opts
  if (!force && typeof localStorage !== 'undefined' && localStorage.getItem(FLAG)) return 0

  // Candidates: rec rows missing an image_url, OR missing synopsis, OR missing
  // genre. We only act on items where at least one of those gaps exists.
  const candidates = items.filter((i) => {
    if (i._source !== 'rec') return false
    if (!['book', 'tv', 'movie', 'article', 'video'].includes(i.type)) return false
    const noImage = !i.image_url
    const noSynopsis = !i.enrichment?.synopsis || !i.enrichment.synopsis.trim()
    const noGenre = !i.extension?.genre
    return noImage || noSynopsis || noGenre
  })
  if (candidates.length === 0) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG, String(Date.now()))
    return 0
  }

  let updated = 0
  for (let n = 0; n < candidates.length; n++) {
    const item = candidates[n]
    onProgress && onProgress({ index: n + 1, total: candidates.length, title: item.title })

    // Pass 1: source provider.
    const src = await lookupFor(item.type, item.title)
    const { patch, mergedExt, mergedSynopsis } = patchFromSource(item, src, item.type)

    // Pass 2: Claude fills only what's STILL missing after the source pass.
    const stillNoSynopsis = !mergedSynopsis || !mergedSynopsis.trim()
    const stillNoGenre = !mergedExt.genre
    if (stillNoSynopsis || stillNoGenre) {
      const c = await claudeSynopsisAndGenre(item.type, item.title)
      if (c) {
        if (stillNoSynopsis && c.synopsis) patch.summary = c.synopsis
        if (stillNoGenre && c.genre) {
          const ext = patch.extension || { ...mergedExt }
          ext.genre = c.genre
          patch.extension = ext
        }
      }
    }

    if (Object.keys(patch).length === 0) continue
    const { error } = await supabase
      .from('recommendations')
      .update(patch)
      .eq('id', item.id)
    if (!error) updated++
  }

  if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG, String(Date.now()))
  return updated
}
