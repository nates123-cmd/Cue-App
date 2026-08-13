// Cue's data layer over Ink's existing tables.
//
// Cue's library = union of two sources:
//   1. `recommendations` — the queue + finished items Cue has added (writable)
//   2. `media_entries`   — Ink's consumption log, surfaced for titles NOT in
//                          recommendations (so already-consumed items show)
//
// Restaurants moved to Ink as of 2026-05-27 — Cue is media-only.
// All Cue mutations write to `recommendations`. On finish, Cue ALSO inserts a
// `media_entries` row so Ink's surfaces stay coherent.
//
// Status mapping: 'saved' (Ink's only value) reads as 'queued'. New Cue rows
// use 'queued'/'active'/'done'.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

// Normalize legacy values to Cue's media types. Unknown types collapse to
// 'article' (most generic — text-cover renderer, no type-specific extension).
// Legacy 'restaurant' rows also collapse to 'article' so they don't crash the
// renderer (they're still in the DB but no longer surfaced as their own type).
function normalizeType(t) {
  if (!t) return 'article'
  if (t === 'film') return 'movie'
  if (t === 'album') return 'music'
  if (['book', 'tv', 'movie', 'article', 'video', 'podcast', 'music'].includes(t)) return t
  return 'article'
}

// Cross-system download push: which home *arr app handles a given Cue type.
// movie→Radarr, tv→Sonarr, book→Prowler. Returns null for types with no
// download target. `media_type` is the value written to the `media_requests`
// row the Beelink poller reads to route the request.
// Normalize a season value to "a number, or null for the whole show".
//
// Worth a named helper rather than an inline check: Number(null) is 0 and
// Number('') is 0, so the obvious `Number.isFinite(Number(v))` test quietly
// turns "no season" into "season 0" — which Sonarr reads as Specials. Null,
// undefined and empty string all have to mean the whole show, since that is
// what every movie, every book, and every TV row written before the season
// picker existed carries.
export function toSeason(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Insights (the takeaways worth keeping from a finished item) live in Cue, in
// `recommendations.extension.insights`. They're authored as free text — one per
// line — so this is the single place that turns that text into the stored array.
// Blank lines and leading bullet characters are dropped so pasted notes land
// clean.
export function parseInsights(text) {
  if (Array.isArray(text)) return text.map((s) => String(s).trim()).filter(Boolean)
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-–—•*]\s*/, '').trim())
    .filter(Boolean)
}

// Read side of the same field. Legacy rows have no `insights` key at all, and
// nothing stops a hand-edited row from holding a string, so both collapse to [].
export function insightsOf(item) {
  const v = item?.extension?.insights
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim())
  return []
}

export function pushTarget(type) {
  if (type === 'movie') return { app: 'Radarr', media_type: 'movie' }
  if (type === 'tv') return { app: 'Sonarr', media_type: 'tv' }
  if (type === 'book') return { app: 'Prowler', media_type: 'book' }
  return null
}

function normalizeStatus(s, finishedAt) {
  if (finishedAt) return 'done'
  if (s === 'done' || s === 'finished') return 'done'
  if (s === 'active') return 'active'
  return 'queued' // 'saved' or null → queued
}

// recommendations row → Cue item shape
function recToItem(r) {
  const ext = { ...(r.extension || {}) }
  // Surface legacy creator/year into the extension under type-aware keys.
  if (r.creator) {
    if (r.media_type === 'book' || r.media_type === 'article') ext.author = ext.author || r.creator
    else if (r.media_type === 'movie' || r.media_type === 'film') ext.director = ext.director || r.creator
    else if (r.media_type === 'video') ext.channel = ext.channel || r.creator
    else if (r.media_type === 'tv') ext.network_or_service = ext.network_or_service || r.creator
  }
  if (r.year) {
    if (r.media_type === 'book' || r.media_type === 'article') ext.published_year = ext.published_year || r.year
    else if (r.media_type === 'movie' || r.media_type === 'film') ext.release_year = ext.release_year || r.year
  }
  const type = normalizeType(r.media_type)
  return {
    id: r.id,
    _source: 'rec',
    title: r.title,
    type,
    status: normalizeStatus(r.status, r.finished_at || r.consumed_at),
    // "Up Next" shortlist position. NULL = in the backlog, unranked. Priority
    // is deliberately NOT a status — you can be sure you'll read something and
    // still not have started it.
    queue_rank: r.queue_rank ?? null,
    recommended_by: r.recommended_by || 'me',
    tags: r.tags || [],
    with: r.with || [],
    rating: r.rating ?? null, // falls back to latest media_entry by title
    notes: r.notes ?? null,
    enrichment: { synopsis: r.summary || '' },
    links: Array.isArray(r.where_to_find) ? r.where_to_find : [],
    extension: ext,
    image_url: r.image_url || null,
    image_tone: r.image_tone,
    // Sticky pipeline status stamped by the Beelink daemons (media-bridge +
    // reading-sync). App-side writes are limited to the optimistic stamp on
    // push; everything after that is the box's to say.
    fulfillment: r.fulfillment && typeof r.fulfillment === 'object' ? r.fulfillment : {},
    cover_kind: r.cover_kind || defaultCoverKind(type),
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at || r.consumed_at,
  }
}

function defaultCoverKind(type) {
  if (type === 'video') return 'thumb'
  if (type === 'movie' || type === 'tv') return 'poster'
  return 'type'
}

// media_entries row (without matching rec) → read-only Cue item
function mediaToItem(m) {
  const type = normalizeType(m.format)
  return {
    id: `media:${m.id}`,
    _source: 'media',
    _media_id: m.id,
    title: m.title,
    type,
    status: 'done',
    queue_rank: null, // media_entries are already-consumed; never on the shortlist
    recommended_by: 'me',
    tags: [],
    with: [],
    rating: m.rating || null,
    notes: m.note || null,
    enrichment: { synopsis: '' },
    links: [],
    extension: {},
    image_url: null,
    image_tone: null,
    cover_kind: defaultCoverKind(type),
    created_at: m.created_at,
    started_at: null,
    finished_at: m.consumed_date ? `${m.consumed_date}T12:00:00Z` : m.created_at,
  }
}

export function useItems() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [recsRes, mediaRes] = await Promise.all([
        supabase.from('recommendations').select('*'),
        supabase.from('media_entries').select('*'),
      ])
      if (recsRes.error) throw recsRes.error
      if (mediaRes.error) throw mediaRes.error

      // Restaurants belong to Ink — hide any legacy restaurant rows from Cue's
      // surfaces. The data stays in Supabase; it's just not Cue's UI anymore.
      const recRows = (recsRes.data || []).filter((r) => r.media_type !== 'restaurant')
      const mediaRows = (mediaRes.data || []).filter((m) => m.format !== 'restaurant')

      const recs = recRows.map(recToItem)
      const recTitles = new Set(recs.map((r) => r.title.toLowerCase().trim()))

      // Attach latest media_entry rating/note to matching rec
      const mediaByTitle = new Map()
      for (const m of mediaRows) {
        const key = (m.title || '').toLowerCase().trim()
        const prev = mediaByTitle.get(key)
        if (!prev || (m.consumed_date || '') > (prev.consumed_date || '')) {
          mediaByTitle.set(key, m)
        }
      }
      for (const r of recs) {
        const m = mediaByTitle.get(r.title.toLowerCase().trim())
        if (m) {
          if (m.rating != null) r.rating = m.rating
          if (m.note) r.notes = m.note
          if (!r.finished_at && m.consumed_date) {
            r.finished_at = `${m.consumed_date}T12:00:00Z`
            r.status = 'done'
          }
        }
      }

      // media_entries without matching rec → read-only done items
      const orphanMedia = mediaRows
        .filter((m) => !recTitles.has((m.title || '').toLowerCase().trim()))
        .map(mediaToItem)

      const all = [...recs, ...orphanMedia]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      setItems(all)
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  // All adds go into recommendations.
  const addItem = useCallback(async (draft) => {
    const row = {
      title: draft.title,
      media_type: draft.type,
      status: draft.status === 'done' ? 'done' : 'queued',
      summary: draft.enrichment?.synopsis || null,
      where_to_find: draft.links || [],
      tags: draft.tags || [],
      recommended_by: draft.recommended_by || 'me',
      with: draft.with || [],
      extension: draft.extension || {},
      cover_kind: draft.cover_kind || defaultCoverKind(draft.type),
      image_url: draft.image_url || null,
      image_tone: draft.image_tone || null,
      // surface a couple of legacy columns Ink reads so its UI stays coherent
      creator: deriveCreator(draft),
      year: deriveYear(draft),
    }
    const { data, error } = await supabase
      .from('recommendations').insert(row).select('*').single()
    if (error) throw error
    const item = recToItem(data)
    setItems((prev) => [item, ...prev])
    return item
  }, [])

  // Cheap refresh of just the pipeline column. A push takes minutes (ebook) to
  // hours (audiobook swarm) to finish, and the daemons stamp progress as they
  // go — but the library itself only loads at boot, so without this the pills
  // would sit on whatever they said when the tab opened. Two columns instead of
  // a full reload, and it leaves every other field (including unsaved edits in
  // flight) untouched.
  const refreshFulfillment = useCallback(async () => {
    const { data, error } = await supabase
      .from('recommendations')
      .select('id,fulfillment')
      .not('fulfillment', 'eq', '{}')
    if (error || !data) return
    const byId = new Map(data.map((r) => [r.id, r.fulfillment || {}]))
    setItems((prev) => prev.map((i) => {
      if (i._source !== 'rec') return i
      const next = byId.get(i.id)
      if (!next) return i
      // Reference-compare via JSON so unchanged rows don't re-render the grid.
      if (JSON.stringify(next) === JSON.stringify(i.fulfillment || {})) return i
      return { ...i, fulfillment: next }
    }))
  }, [])

  const updateItem = useCallback(async (id, patch) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item || item._source !== 'rec') return // media/visit items are read-only here
    const dbPatch = patchToDb(patch)
    if (Object.keys(dbPatch).length === 0) return
    const { error } = await supabase
      .from('recommendations').update(dbPatch).eq('id', id)
    if (error) { await reload(); throw error }
  }, [reload])

  // Mark done = update recommendations (rating/notes/finished_at) + insert a
  // media_entries row so Ink's log stays coherent.
  const finishItem = useCallback(async (item, { rating = null, note = null, insights = null } = {}) => {
    const finished_at = new Date().toISOString()
    // Insights are merged into the existing extension rather than replacing it —
    // the extension also carries type-specific state (page counts, tmdb ids).
    const nextExt = insights
      ? { ...(item.extension || {}), insights }
      : (item.extension || {})
    setItems((prev) => prev.map((i) => i.id === item.id
      ? { ...i, status: 'done', finished_at, rating: rating ?? i.rating, notes: note ?? i.notes, extension: nextExt }
      : i))
    if (item._source === 'rec') {
      const upd = {
        status: 'done',
        finished_at,
        consumed_at: finished_at,
        rating: rating ?? item.rating ?? null,
        notes: note ?? item.notes ?? null,
        extension: nextExt,
      }
      const recRes = await supabase.from('recommendations').update(upd).eq('id', item.id)
      if (recRes.error) { await reload(); throw recRes.error }
    }
    const m = await supabase.from('media_entries').insert({
      title: item.title,
      format: item.type === 'movie' ? 'film' : item.type,
      consumed_date: finished_at.slice(0, 10),
      rating,
      note,
    })
    if (m.error) console.warn('media_entries insert failed', m.error)
  }, [reload])

  const deleteItem = useCallback(async (id) => {
    const item = itemsRef.current.find((i) => i.id === id)
    setItems((prev) => prev.filter((i) => i.id !== id))
    if (!item) return
    if (item._source === 'rec') {
      const { error } = await supabase.from('recommendations').delete().eq('id', id)
      if (error) { await reload(); throw error }
    } else if (item._source === 'media') {
      const { error } = await supabase.from('media_entries').delete().eq('id', item._media_id)
      if (error) { await reload(); throw error }
    }
  }, [reload])

  // Rewrite the whole shortlist to `orderedIds` (rank 1..n, ascending). Any row
  // that was ranked and isn't in the list drops back to the backlog (NULL).
  // Whole-list rewrite rather than gap integers: the shortlist is ~10 rows, and
  // the bookkeeping to avoid a handful of updates costs more than it saves.
  const setShortlist = useCallback(async (orderedIds) => {
    const rankById = new Map(orderedIds.map((id, i) => [id, i + 1]))
    // Read the previous ranking BEFORE the optimistic write so we know which
    // rows fell off the list.
    const dropped = itemsRef.current
      .filter((i) => i._source === 'rec' && i.queue_rank != null && !rankById.has(i.id))
      .map((i) => i.id)

    setItems((prev) => prev.map((i) => {
      if (i._source !== 'rec') return i
      const next = rankById.has(i.id) ? rankById.get(i.id) : null
      return i.queue_rank === next ? i : { ...i, queue_rank: next }
    }))

    const results = await Promise.all([
      ...orderedIds.map((id) => supabase
        .from('recommendations').update({ queue_rank: rankById.get(id) }).eq('id', id)),
      ...(dropped.length
        ? [supabase.from('recommendations').update({ queue_rank: null }).in('id', dropped)]
        : []),
    ])
    const bad = results.find((r) => r.error)
    if (bad) { await reload(); throw bad.error }
  }, [reload])

  // Library's "Up next" action: append to the end of the shortlist, or drop off
  // it if already on. Only `rec`-backed items can be ranked.
  const toggleShortlist = useCallback(async (item) => {
    if (!item || item._source !== 'rec') return
    const ranked = shortlistOf(itemsRef.current).map((i) => i.id)
    const next = ranked.includes(item.id)
      ? ranked.filter((id) => id !== item.id)
      : [...ranked, item.id]
    return setShortlist(next)
  }, [setShortlist])

  // Keep a ref to items so mutation handlers can resolve _source without re-deriving
  const itemsRef = useRef(items)
  itemsRef.current = items

  return {
    items, loading, error, addItem, updateItem, deleteItem, finishItem, reload,
    refreshFulfillment, setShortlist, toggleShortlist,
  }
}

// The "Up Next" shortlist, in rank order. Finished items fall off on their own
// (a done item is no longer up next) without needing the rank cleared.
export function shortlistOf(items) {
  return items
    .filter((i) => i._source === 'rec' && i.queue_rank != null && i.status !== 'done')
    .sort((a, b) => a.queue_rank - b.queue_rank)
}

function patchToDb(patch) {
  const map = {
    status: 'status',
    queue_rank: 'queue_rank',
    recommended_by: 'recommended_by',
    tags: 'tags',
    with: 'with',
    started_at: 'started_at',
    finished_at: 'finished_at',
    extension: 'extension',
    notes: 'notes',
    rating: 'rating',
    image_url: 'image_url',
    image_tone: 'image_tone',
    cover_kind: 'cover_kind',
    title: 'title',
    links: 'where_to_find',
    fulfillment: 'fulfillment',
  }
  // Map nested enrichment.synopsis → recommendations.summary, if present.
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enrichment' && v && typeof v === 'object' && 'synopsis' in v) {
      out.summary = v.synopsis || null
      continue
    }
    const col = map[k]
    if (col === undefined || col === null) continue
    out[col] = v
  }
  return out
}

function deriveCreator(draft) {
  const e = draft.extension || {}
  return e.author || e.director || e.channel || e.network_or_service || null
}

function deriveYear(draft) {
  const e = draft.extension || {}
  return e.published_year || e.release_year || null
}
