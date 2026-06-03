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

// Normalize legacy values to Cue's five types. Unknown types collapse to
// 'article' (most generic — text-cover renderer, no type-specific extension).
// Legacy 'restaurant' rows also collapse to 'article' so they don't crash the
// renderer (they're still in the DB but no longer surfaced as their own type).
function normalizeType(t) {
  if (!t) return 'article'
  if (t === 'film') return 'movie'
  if (['book', 'tv', 'movie', 'article', 'video'].includes(t)) return t
  return 'article'
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
  const finishItem = useCallback(async (item, { rating = null, note = null } = {}) => {
    const finished_at = new Date().toISOString()
    setItems((prev) => prev.map((i) => i.id === item.id
      ? { ...i, status: 'done', finished_at, rating: rating ?? i.rating, notes: note ?? i.notes }
      : i))
    if (item._source === 'rec') {
      const upd = {
        status: 'done',
        finished_at,
        consumed_at: finished_at,
        rating: rating ?? item.rating ?? null,
        notes: note ?? item.notes ?? null,
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

  // Keep a ref to items so mutation handlers can resolve _source without re-deriving
  const itemsRef = useRef(items)
  itemsRef.current = items

  return { items, loading, error, addItem, updateItem, deleteItem, finishItem, reload }
}

function patchToDb(patch) {
  const map = {
    status: 'status',
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
