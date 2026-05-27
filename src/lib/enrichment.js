// Enrichment — the spine of Cue. Type-specific prompts → strict JSON →
// defensive parsing → fall back to a minimal manually-editable card on any
// failure. Never let a bad enrichment block a capture.

import { claudeComplete, extractJSON } from './claude'

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

  restaurant: (title) => `Enrich this restaurant: "${title}"

Return JSON with this exact shape:
{
  "title": "restaurant name",
  "synopsis": "2-3 sentences (vibe, what it's known for)",
  "extension": {
    "neighborhood": "...",
    "cuisine": "...",
    "price_level": 0,
    "address": "...",
    "genre": "..."
  },
  "image_tone": ["#hex", "#hex"],
  "cover_kind": "venue",
  "links": [
    { "label": "Google Maps" },
    { "label": "Resy" },
    { "label": "Website" }
  ]
}
${SHARED_RULES}
- price_level is 1-4 ($, $$, $$$, $$$$)`,
}

// Minimal fallback — all fields manually editable.
function fallbackCard(title, type) {
  const tones = {
    book:       ['#2a2820', '#8a8260'],
    tv:         ['#0e2533', '#3a7da3'],
    movie:      ['#2a1a1f', '#a35a7a'],
    article:    ['#23252a', '#7a7d85'],
    video:      ['#2a1f1a', '#a3633a'],
    restaurant: ['#1a2a2e', '#3a7a8a'],
  }
  const links = {
    book:       [{ label: 'Libby' }, { label: 'Goodreads' }, { label: 'Bookshop' }],
    tv:         [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    movie:      [{ label: 'JustWatch' }, { label: 'Letterboxd' }, { label: 'IMDb' }],
    article:    [{ label: 'Read' }],
    video:      [{ label: 'YouTube' }],
    restaurant: [{ label: 'Google Maps' }, { label: 'Resy' }, { label: 'Website' }],
  }
  const coverKind = type === 'restaurant' ? 'venue'
    : type === 'video' ? 'thumb'
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

export async function enrich(title, type) {
  const trimmed = (title || '').trim()
  if (!trimmed) return fallbackCard('', type)

  const promptFn = PROMPTS[type]
  if (!promptFn) return fallbackCard(trimmed, type)

  try {
    const raw = await claudeComplete(promptFn(trimmed), {
      system: SYSTEM,
      max_tokens: 800,
    })
    const parsed = extractJSON(raw)
    if (!parsed || typeof parsed !== 'object') return fallbackCard(trimmed, type)

    const merged = fallbackCard(trimmed, type)
    return {
      ...merged,
      title: parsed.title || merged.title,
      synopsis: parsed.synopsis || '',
      extension: { ...merged.extension, ...(parsed.extension || {}) },
      image_tone: parsed.image_tone || merged.image_tone,
      cover_kind: parsed.cover_kind || merged.cover_kind,
      links: Array.isArray(parsed.links) && parsed.links.length ? parsed.links : merged.links,
      _fallback: false,
    }
  } catch {
    return fallbackCard(trimmed, type)
  }
}
