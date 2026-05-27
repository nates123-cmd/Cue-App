// One-shot image_url backfill for existing library rows. Runs once per browser
// (localStorage flag) the first time the user lands after the source providers
// were added. Skips Claude entirely — we only ADD provider-sourced metadata
// (image_url + a couple of facts) so manual edits to synopsis / image_tone /
// links / etc. are preserved.

import { supabase } from './supabase'
import { tmdbLookup } from './sources/tmdb'
import { openLibraryLookup } from './sources/openlibrary'
import { openGraphLookup } from './sources/opengraph'
import { youtubeLookup } from './sources/youtube'

// Bump the version suffix to force backfill to retry on next load — useful
// when the previous pass ran without API keys forwarded to the build.
const FLAG = 'cue:backfill:image_url:v2'

async function lookupFor(type, input) {
  if (type === 'movie' || type === 'tv') return tmdbLookup(input, type).catch(() => null)
  if (type === 'book') return openLibraryLookup(input).catch(() => null)
  if (type === 'article') return openGraphLookup(input).catch(() => null)
  if (type === 'video') return youtubeLookup(input).catch(() => null)
  return null
}

// Build a small patch from a source result. Only fill empty fields — never
// clobber values the user (or earlier enrichment) already wrote.
function patchFromSource(item, src, type) {
  if (!src) return null
  const ext = { ...(item.extension || {}) }
  let changedExt = false
  const fill = (key, val) => {
    if (val == null) return
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
  if (changedExt) patch.extension = ext
  return Object.keys(patch).length ? patch : null
}

export async function backfillMissingImages(items, opts = {}) {
  const { force = false, onProgress } = opts
  if (!force && typeof localStorage !== 'undefined' && localStorage.getItem(FLAG)) return 0

  const candidates = items.filter((i) =>
    i._source === 'rec'
    && !i.image_url
    && ['book', 'tv', 'movie', 'article', 'video'].includes(i.type)
  )
  if (candidates.length === 0) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG, String(Date.now()))
    return 0
  }

  let updated = 0
  for (let n = 0; n < candidates.length; n++) {
    const item = candidates[n]
    onProgress && onProgress({ index: n + 1, total: candidates.length, title: item.title })
    const src = await lookupFor(item.type, item.title)
    const patch = patchFromSource(item, src, item.type)
    if (!patch) continue
    const { error } = await supabase
      .from('recommendations')
      .update(patch)
      .eq('id', item.id)
    if (!error) updated++
  }

  if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG, String(Date.now()))
  return updated
}
