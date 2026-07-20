// "Resume in audio" — the Kindle-compatible half of the Storyteller sync.
//
// You read the ebook on a Kindle (which has no position API, so it can't tell us
// where you stopped). To jump the audiobook to that spot, you hand us an anchor
// phrase (the last line you read). We search the book's forced-alignment transcript
// (produced by Storyteller on the Beelink), resolve a timestamp, and drop a row in
// `audio_seek_requests`. The media-bridge polls it and writes the position into
// Audiobookshelf via /api/me/progress — so you just open ABS and press play.
//
// Transcript shape (one `book_transcripts` row per aligned book):
//   { book_key, abs_item_id, book_title, segments: [{ t: <startSec>, s: <text> }, ...] }
//
// NB: supabase is imported lazily inside the data functions so the pure text-search
// surface (searchTranscript/normalize/fmtClock) stays importable in tests without
// VITE_SUPABASE_* env (supabase.js throws at import time when env is missing).

// --- text search -----------------------------------------------------------

export function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'") // smart quotes -> plain
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ') // drop punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Flatten segments into a word stream, each word carrying its segment start time.
// Segment-level timestamps are all we get from alignment, so every word in a
// segment inherits that segment's start — accurate to a sentence, which is plenty
// for "resume playback here".
function toWords(segments) {
  const words = []
  for (const seg of segments || []) {
    const t = seg.t ?? seg.start ?? seg.start_sec
    for (const w of normalize(seg.s ?? seg.text).split(' ')) {
      if (w) words.push({ w, t })
    }
  }
  return words
}

// Find where `phrase` best matches the transcript. Returns the top candidates
// ranked by how many of the phrase's words match contiguously, each with the
// timestamp of the match's first word and a readable snippet.
export function searchTranscript(segments, phrase, { limit = 3 } = {}) {
  const words = toWords(segments)
  const q = normalize(phrase).split(' ').filter(Boolean)
  if (!q.length || !words.length) return []

  // An anchor must be distinctive: require several matched words so a lone common
  // word ("the", "work") can't seek you to a random spot.
  const MIN_MATCH = 3
  const candidates = []
  for (let i = 0; i + q.length <= words.length; i++) {
    let hits = 0
    for (let j = 0; j < q.length; j++) if (words[i + j].w === q[j]) hits++
    // strong contiguous match AND enough absolute signal
    if (hits < MIN_MATCH || hits / q.length < 0.6) continue
    candidates.push({
      score: hits / q.length,
      startSec: words[i].t,
      index: i,
      snippet: words.slice(i, i + q.length).map((x) => x.w).join(' '),
    })
  }

  // best score first; on ties, earliest position. de-dupe near-identical windows.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  const out = []
  for (const c of candidates) {
    if (out.some((o) => Math.abs(o.index - c.index) < q.length)) continue
    out.push(c)
    if (out.length >= limit) break
  }
  return out.map(({ score, startSec, snippet }) => ({ score, startSec, snippet }))
}

// Stable per-book key shared by Cue (lookup) and the Beelink extractor (write).
// Title-derived slug; keep both sides using THIS function so they agree.
export const bookKeyFor = (title) => normalize(title).replace(/ /g, '-')

// --- data ------------------------------------------------------------------

// Load the aligned transcript for a book. `bookKey` is the stable key we store on
// the transcript row (title-derived); returns null when the book hasn't been
// aligned yet (no read-along available).
export async function loadTranscript(bookKey) {
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .from('book_transcripts')
    .select('book_key, abs_item_id, book_title, segments')
    .eq('book_key', bookKey)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// Insert a seek request. The bridge resolves the ABS item by id when we have one,
// else by title, then PATCHes the listen position. user_id is stamped by the DB
// default (auth.uid()); never set it here.
export async function requestSeek({ absItemId, bookTitle, seconds, phrase }) {
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .from('audio_seek_requests')
    .insert({
      abs_item_id: absItemId || null,
      book_title: bookTitle || null,
      current_time_sec: Math.max(0, Math.round(seconds)),
      anchor_phrase: phrase || null,
    })
    .select('id')
    .single()
  if (error) throw error
  return data
}

// mm:ss / h:mm:ss for display
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
