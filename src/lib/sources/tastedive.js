// TasteDive — similarity ("more like this") source for the types with no other
// clean recommendation DB: books, podcasts, music. Movies/TV use TMDB instead.
//
// API: https://tastedive.com/api/similar?q=<seed>&type=<type>&k=<key>&info=1&limit=N
// Returns { Similar: { Info: [...], Results: [{ Name, Type, ... }] } }.
//
// KEY: VITE_TASTEDIVE_KEY. TasteDive's free tier is rate-limited and the key
// terms are worth confirming first-hand before leaning on this in production
// (flagged as the keystone open-risk in the rec-engine spec). Without a key — or
// on ANY failure, including CORS — every call returns [] so the engine falls
// back to Claude-proposed candidates. Never throws.
//
// CORS caveat: the public API has historically been browser-callable, but this
// is not contractually guaranteed. If the browser blocks it, results degrade to
// [] (same as no key) and the Claude path covers it. Route through the
// `quick-service` proxy later if a server-side fetch becomes necessary.

const API_KEY = import.meta.env.VITE_TASTEDIVE_KEY || ''
const BASE = 'https://tastedive.com/api/similar'

// Cue type → TasteDive `type` param. TasteDive has no notion of articles/videos,
// so those return [] (handled by the engine's Claude fallback).
const TYPE_MAP = {
  book: 'book',
  podcast: 'podcast',
  music: 'music',
  movie: 'movie',
  tv: 'show',
}

function supports(type) {
  return Object.hasOwn(TYPE_MAP, type)
}

// One TasteDive result → a normalized candidate the engine understands. We only
// carry the title across; downstream enrichment (covers/facts) is the existing
// per-type pipeline's job. `source` marks provenance for the suggestion card.
function toCandidate(r, type) {
  const name = r?.Name || r?.name
  if (!name) return null
  return {
    title: String(name).trim(),
    type,
    source: 'tastedive',
    facts: {},
  }
}

// Similar items for a seed title. Returns [] on no key / unsupported type /
// any error. `n` caps the request size to keep within the free quota.
export async function tasteDiveSimilar(seedTitle, type, n = 12) {
  const q = (seedTitle || '').trim()
  if (!API_KEY || !q || !supports(type)) return []
  try {
    const params = new URLSearchParams({
      q: `${TYPE_MAP[type]}:${q}`,
      type: TYPE_MAP[type],
      k: API_KEY,
      info: '0',
      limit: String(n),
    })
    const res = await fetch(`${BASE}?${params}`)
    if (!res.ok) return []
    const data = await res.json()
    const results = data?.Similar?.Results || data?.similar?.results || []
    const seen = new Set([q.toLowerCase()])
    const out = []
    for (const r of results) {
      const cand = toCandidate(r, type)
      if (!cand) continue
      const key = cand.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(cand)
    }
    return out
  } catch {
    return []
  }
}

export function tasteDiveSupports(type) {
  return supports(type)
}
