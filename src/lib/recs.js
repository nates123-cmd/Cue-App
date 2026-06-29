// Cue recommendations engine — one pipeline, three seeds, tiered sources.
//
// Seeds:   nl (free-text ask) · surprise (whole-library taste) · item (anchor).
// Sources: DB-first — TMDB for movie/tv, TasteDive for book/podcast/music,
//          the user's own backlog for resurfacing; Claude only where no DB fits.
// Claude is the TASTE layer (propose for nl/surprise, re-rank for item), never
// the candidate generator on the DB paths. web_search is never used (the proxy
// has no such branch) — availability comes from TMDB watch-providers, not search.
//
// Persistence is localStorage (truly ephemeral, zero schema change). The
// optional server-sync path is supabase/migrations/20260628000001_rec_suggestions
// .sql; this module's load/save abstraction is the seam to switch to it.

import { claudeComplete, extractJSON } from './claude'
import { tmdbRecommendations, tmdbResolveId, tmdbWatchProviders } from './sources/tmdb'
import { tasteDiveSimilar, tasteDiveSupports } from './sources/tastedive'

const TYPES = ['book', 'tv', 'movie', 'article', 'video', 'podcast', 'music']
const NET_NEW_TARGET = 8         // how many net-new cards a batch renders
const BACKLOG_TARGET = 12        // how many backlog rows a batch surfaces
const BATCH_KEY = 'cue_recs_batch_v1'
const DISMISS_KEY = 'cue_recs_dismissed_v1'

// ── keys / exclusion ──────────────────────────────────────────────────────────
const norm = (s) => (s || '').toLowerCase().trim()
export function titleKey(title, type) { return `${norm(title)}|${type}` }
const today = () => new Date().toISOString().slice(0, 10)
// Stable-ish id without Math.random (varies by title+type+index).
const candId = (c, i) => `${titleKey(c.title, c.type)}#${i}`

// ── soft dismissals (persisted) ───────────────────────────────────────────────
export function loadDismissals() {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch { return new Set() }
}
export function addDismissal(title, type) {
  const set = loadDismissals()
  set.add(titleKey(title, type))
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set])) } catch {}
  return set
}

// ── batch persistence (last batch survives so the tab isn't empty on open) ─────
export function loadBatch() {
  try { return JSON.parse(localStorage.getItem(BATCH_KEY) || 'null') } catch { return null }
}
export function saveBatch(batch) {
  try { localStorage.setItem(BATCH_KEY, JSON.stringify(batch)) } catch {}
}
export function clearBatch() {
  try { localStorage.removeItem(BATCH_KEY) } catch {}
}

// ── taste profile (read in-prompt; no retraining) ─────────────────────────────
// Compact view of what Nate likes — ratings + tags — for Claude's taste layer.
function tasteProfile(items) {
  const rated = items.filter((i) => i.rating)
  const loved = rated.filter((i) => i.rating >= 3).map((i) => i.title)
  const liked = rated.filter((i) => i.rating === 2).map((i) => i.title)
  const meh = rated.filter((i) => i.rating === 1).map((i) => i.title)
  const tagCount = {}
  items.forEach((i) => (i.tags || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1 }))
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t)
  const byType = {}
  items.forEach((i) => { byType[i.type] = (byType[i.type] || 0) + 1 })
  return {
    loved, liked, meh, topTags,
    text: [
      loved.length ? `Loved: ${loved.slice(0, 20).join(', ')}` : '',
      liked.length ? `Liked: ${liked.slice(0, 20).join(', ')}` : '',
      meh.length ? `Lukewarm on: ${meh.slice(0, 12).join(', ')}` : '',
      topTags.length ? `Recurring tags: ${topTags.join(', ')}` : '',
      Object.keys(byType).length ? `Collection mix: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}` : '',
    ].filter(Boolean).join('\n') || '(library is sparse — lean on the query/seed)',
  }
}

// ── exclusion: drop captured + soft-dismissed ─────────────────────────────────
function buildExcluder(items, dismissed) {
  const captured = new Set(items.map((i) => norm(i.title)))
  return (cand) => !captured.has(norm(cand.title)) && !dismissed.has(titleKey(cand.title, cand.type))
}

// ── Claude: propose (nl / surprise) ───────────────────────────────────────────
async function claudePropose({ seed, items, partner, edition }, n) {
  const taste = tasteProfile(items)
  const dismissed = [...loadDismissals()].map((k) => k.split('|')[0]).slice(0, 30)
  const ask = seed.kind === 'nl'
    ? `They asked, in their own words: "${seed.query}"`
    : `No query — this is a one-tap "Surprise me". Seed on the whole-library taste profile below and the time of day. Spread across several media types; favor a couple of bolder, less-obvious picks.`
  const prompt = `You are the taste curator for Cue, a personal recommendation library.
${ask}

Their taste:
${taste.text}

Co-viewing partner: ${partner || 'Amanda'}. Current edition: ${edition || 'evening'}.
${dismissed.length ? `Already dismissed (do NOT repeat): ${dismissed.join(', ')}` : ''}

Propose ${n} SPECIFIC, real, findable titles they do NOT already own, mixed across
[${TYPES.join(', ')}]. Match their taste; for "${edition}" lean ${edition === 'morning' ? 'contemplative / reading' : edition === 'afternoon' ? 'mixed / productive' : edition === 'evening' ? 'cinema, prestige tv' : 'shorter, quieter'}.

Return ONLY a JSON array (no prose, no markdown), exactly ${n} objects:
[{"title":"...","type":"book|tv|movie|article|video|podcast|music","reason":"why it fits them, under 70 chars, lowercase, no period"}]`
  try {
    const raw = await claudeComplete(prompt, { max_tokens: 900 })
    const parsed = extractJSON(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s) => s && typeof s.title === 'string' && s.title && TYPES.includes(s.type))
      .slice(0, n)
      .map((s) => ({ title: s.title.trim(), type: s.type, source: 'claude', facts: {}, why: s.reason || null }))
  } catch { return [] }
}

// ── Claude: taste re-rank (item seed, DB candidates) ──────────────────────────
// DB candidates are taste-blind (metadata / co-engagement). This is the
// load-bearing step that re-orders them by what Nate actually likes. Returns the
// candidate objects reordered + trimmed; falls back to DB order on any failure.
async function claudeRerank(candidates, { seed, items }, n) {
  if (candidates.length <= n) return candidates.slice(0, n)
  const taste = tasteProfile(items)
  const list = candidates.map((c, i) => `${i}. ${c.title} (${c.type})`).join('\n')
  const anchor = seed.item ? `${seed.item.title} (${seed.item.type})` : '(unknown)'
  const refine = seed.query ? `\nExtra refinement from the user: "${seed.query}" — weight this heavily.` : ''
  const prompt = `Cue is re-ranking "more like this" candidates for one anchor title by the user's taste.

Anchor (what they liked): ${anchor}${refine}
Their taste:
${taste.text}

Candidates (metadata-similar to the anchor, but taste-blind):
${list}

Pick the ${n} BEST for this user, ordered best-first. Favor ones that fit both the
anchor AND their broader taste; drop weak/off ones.
Return ONLY a JSON array of the chosen indices, e.g. [3,0,7,...]. No prose.`
  try {
    const raw = await claudeComplete(prompt, { max_tokens: 200 })
    const idx = extractJSON(raw)
    if (!Array.isArray(idx)) return candidates.slice(0, n)
    const picked = idx.map((i) => candidates[i]).filter(Boolean)
    return (picked.length ? picked : candidates).slice(0, n)
  } catch { return candidates.slice(0, n) }
}

// ── DB candidates for an item seed ────────────────────────────────────────────
async function dbCandidatesForItem(item) {
  const type = item.type
  const ext = item.extension || {}
  if (type === 'movie' || type === 'tv') {
    const id = ext.tmdb_id ?? await tmdbResolveId(item.title, type)
    if (id != null) {
      const recs = await tmdbRecommendations(id, type)
      if (recs.length) return recs
    }
    return []
  }
  if (tasteDiveSupports(type)) {
    return await tasteDiveSimilar(item.title, type)
  }
  // video / article: no clean similarity DB → caller falls back to Claude.
  return []
}

// ── availability stamp (TMDB watch-providers; movie/tv only) ───────────────────
// Surfaces "where to watch" without a search call. Does NOT filter — a great
// pick you can't stream yet still queues.
async function stampAvailability(sug) {
  if (sug.type !== 'movie' && sug.type !== 'tv') return sug
  try {
    const id = sug.facts?.tmdb_id ?? await tmdbResolveId(sug.title, sug.type)
    if (id == null) return sug
    const providers = await tmdbWatchProviders(id, sug.type)
    return { ...sug, facts: { ...sug.facts, tmdb_id: id }, availability: providers, checked_on: today() }
  } catch { return sug }
}

// ── backlog ranking (own table; zero API cost) ────────────────────────────────
function rankBacklog(items, seed, n) {
  let pool = items.filter((i) => i.status === 'queued' || i.status === 'active')
  const score = (i) => {
    let s = 0
    if (i.status === 'active') s += 2
    if (seed.kind === 'item' && seed.item) {
      if (i.type === seed.item.type) s += 3
      const seedTags = new Set(seed.item.tags || [])
      s += (i.tags || []).filter((t) => seedTags.has(t)).length * 2
    }
    if (seed.kind === 'nl' && seed.query) {
      const q = norm(seed.query)
      const hay = `${norm(i.title)} ${(i.tags || []).join(' ')} ${norm(i.enrichment?.synopsis)}`
      if (/short|under|quick|train/.test(q)) {
        const e = i.extension || {}
        if ((e.runtime_min && e.runtime_min < 120) || (e.est_read_min && e.est_read_min < 20)
          || (e.duration_min && e.duration_min < 45)) s += 3
      }
      if (/movie|film|watch/.test(q) && (i.type === 'movie' || i.type === 'tv')) s += 3
      if (/read|book|article/.test(q) && (i.type === 'book' || i.type === 'article')) s += 3
      q.split(/\s+/).filter((w) => w.length > 3).forEach((w) => { if (hay.includes(w)) s += 1 })
    }
    // recency tiebreak
    s += Math.max(0, 1 - (Date.now() - new Date(i.created_at || 0).getTime()) / (1000 * 60 * 60 * 24 * 365))
    return s
  }
  return pool
    .map((i) => ({ i, s: score(i) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ i }) => i)
}

// ── the pipeline ──────────────────────────────────────────────────────────────
// seed = { kind: 'nl'|'surprise'|'item', query?, item? }
// Returns a batch: { id, seed, createdAt, netNew: [suggestion], backlog: [item] }.
export async function generateRecs({ seed, items, partner, edition }) {
  const dismissed = loadDismissals()
  const keep = buildExcluder(items, dismissed)

  // 1–4: net-new candidates → exclude → taste layer.
  let netNew = []
  if (seed.kind === 'item' && seed.item) {
    const cands = (await dbCandidatesForItem(seed.item)).filter(keep)
    if (cands.length) {
      netNew = await claudeRerank(cands, { seed, items }, NET_NEW_TARGET)
    } else {
      // No DB similarity for this type (video/article) or DB came up empty —
      // fall back to a Claude proposal seeded on the anchor.
      const nlSeed = { kind: 'nl', query: `more like "${seed.item.title}" (${seed.item.type})` }
      netNew = (await claudePropose({ seed: nlSeed, items, partner, edition }, NET_NEW_TARGET)).filter(keep)
    }
  } else {
    netNew = (await claudePropose({ seed, items, partner, edition }, NET_NEW_TARGET + 4)).filter(keep)
    netNew = netNew.slice(0, NET_NEW_TARGET)
  }

  // 5: availability stamp (parallel, movie/tv only).
  netNew = await Promise.all(netNew.map(stampAvailability))

  // Finalize suggestion shape.
  const seedRef = seed.kind === 'item' ? (seed.item?.id || seed.item?.title) : (seed.query || '')
  const suggestions = netNew.map((c, i) => ({
    id: candId(c, i),
    title: c.title,
    type: c.type,
    source: c.source || 'claude',
    facts: c.facts || {},
    availability: c.availability || [],
    checked_on: c.checked_on || null,
    why: c.why ?? null,            // null on DB paths → lazy; reason inline on Claude paths
    seedKind: seed.kind,
    seedRef,
  }))

  // 2 (parallel): backlog resurfacing from the own table.
  const backlog = rankBacklog(items, seed, BACKLOG_TARGET)

  return {
    id: `${seed.kind}:${seedRef}:${today()}`,
    seed: { kind: seed.kind, query: seed.query || null, itemTitle: seed.item?.title || null },
    createdAt: new Date().toISOString(),
    netNew: suggestions,
    backlog: backlog.map((i) => i.id),   // store ids; the tab resolves against live items
  }
}

// ── lazy "why this" (only on the card the user actually taps) ──────────────────
export async function whyThis(sug, { seed, items }) {
  const taste = tasteProfile(items)
  const anchor = seed?.kind === 'item' ? (seed.itemTitle || seed.item?.title) : null
  const ctx = anchor
    ? `They liked "${anchor}" and asked for more like it.`
    : seed?.query ? `They asked: "${seed.query}".` : `This is a surprise pick from their taste.`
  const prompt = `One sentence, lowercase, no period, under 90 chars: why would this user like "${sug.title}" (${sug.type})?
${ctx}
Their taste: ${taste.text}
Just the sentence.`
  try {
    const raw = await claudeComplete(prompt, { max_tokens: 80 })
    return (raw || '').trim().replace(/^["']|["']$/g, '') || null
  } catch { return null }
}
