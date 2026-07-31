// Sticky fulfillment status — "where did this title actually end up?"
//
// The DownloadTray answers "what's happening right now" off `media_requests`,
// and it deliberately forgets: finished rows drop out after a day and a
// swipe-delete removes them. That's the wrong lifetime for the question Nate
// actually asks a card weeks later — is the ebook on my Kindle, did the
// audiobook land in Audiobookshelf, can Place sync my position on it?
//
// So the durable answer lives on the card: `recommendations.fulfillment`, a
// jsonb the Beelink daemons stamp as each leg completes. This module turns that
// blob into badges. Rendering never joins media_requests — the bridge writes
// live pct into the same blob, so one read covers in-flight and forever.
//
// Legs:
//   ebook     — grabbed (torrent or Libgen), imported to EBOOK_DIR, emailed to Kindle
//   audiobook — grabbed, hardlinked into AUDIOBOOK_DIR, auto-imported by ABS
//   place     — epub indexed by epubpos + published to `reading_books`, so the
//               Place PWA can push a reading position to the X4 / audiobook
//   download  — movie/tv equivalent (single leg, Radarr/Sonarr)

// Tone drives colour. 'go' is in-flight, 'done' landed, 'fail' needs Nate.
const TONES = { wait: 'wait', go: 'go', done: 'done', fail: 'fail' }

const LEG_ORDER = ['ebook', 'audiobook', 'place', 'download']

const LEG_LABEL = {
  ebook: 'Ebook',
  audiobook: 'Audiobook',
  place: 'Place',
  download: 'Download',
}

// Short form for the 2-up Library grid, where a card is ~160px wide.
const LEG_SHORT = {
  ebook: 'Ebook',
  audiobook: 'Audio',
  place: 'Place',
  download: 'DL',
}

function pctOf(leg) {
  const p = Number(leg?.pct)
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null
}

// One leg → { key, label, short, tone, title }. Returns null for a leg that was
// never attempted, so absence renders as nothing rather than "unknown".
export function legBadge(key, leg) {
  if (!leg || !leg.state) return null
  const name = LEG_LABEL[key] || key
  const short = LEG_SHORT[key] || name
  const pct = pctOf(leg)
  const at = leg.at || null
  const mk = (label, tone, title) => ({ key, label, short, tone, title: title || label, at, pct })

  switch (leg.state) {
    case 'searching':
      return mk(`${name} searching`, TONES.wait)
    case 'downloading':
      return mk(pct != null ? `${name} ${pct}%` : `${name} downloading`, TONES.go)
    case 'downloaded':
      // An ebook that's downloaded but not yet emailed is a real, distinct state:
      // it's on the shelf (so Place and the X4 can reach it) but not on the Kindle.
      return mk(`${name} downloaded`, TONES.done, leg.detail || `${name} downloaded`)
    case 'delivered':
      return mk(`${name} delivered`, TONES.done, leg.kindle || `${name} delivered`)
    case 'pending':
      return mk(`${name} syncing`, TONES.wait, leg.detail || `${name} sync pending`)
    case 'ready':
      return mk(`${name} synced`, TONES.done, leg.document_id ? `Place sync ready · ${leg.book_key || ''}`.trim() : 'Place sync ready')
    case 'failed':
      return mk(`${name} failed`, TONES.fail, leg.detail || leg.msg || `${name} failed`)
    default:
      return mk(`${name} ${leg.state}`, TONES.wait)
  }
}

// All badges for an item, in a stable order so they don't shuffle between polls.
export function fulfillmentBadges(item) {
  const f = item?.fulfillment
  if (!f || typeof f !== 'object') return []
  return LEG_ORDER.map((k) => legBadge(k, f[k])).filter(Boolean)
}

// True once every attempted leg has landed — used to decide whether the card
// shows a quiet "complete" treatment instead of individual pills.
export function isFullyFulfilled(item) {
  const badges = fulfillmentBadges(item)
  return badges.length > 0 && badges.every((b) => b.tone === TONES.done)
}

export function hasFulfillment(item) {
  return fulfillmentBadges(item).length > 0
}

// What the app optimistically stamps the moment Nate taps push, so the card
// shows something before the bridge's first 20s tick. The daemons overwrite
// each leg as it progresses; `place` only exists for books.
export function initialFulfillment(type) {
  const now = new Date().toISOString()
  if (type === 'book') {
    return {
      ebook: { state: 'searching', at: now },
      audiobook: { state: 'searching', at: now },
      place: { state: 'pending', at: now },
    }
  }
  return { download: { state: 'searching', at: now } }
}

export const FULFILLMENT_TONES = TONES
