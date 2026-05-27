// YouTube Data API v3 lookup for videos. Requires VITE_YT_API_KEY (Google
// Cloud Console → enable YouTube Data API v3 → create API key; restrict it by
// HTTP referrer to your Pages + localhost). Returns null if the key is missing
// or nothing matches.
//
// Accepts either a YouTube URL (preferred — direct video-id lookup is more
// accurate) or a plain title (falls back to /search → /videos for duration).

const API_KEY = import.meta.env.VITE_YT_API_KEY
const BASE = 'https://www.googleapis.com/youtube/v3'

const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/

function extractVideoId(input) {
  const m = (input || '').match(VIDEO_ID_RE)
  return m ? m[1] : null
}

// ISO 8601 duration (PT1H23M45S) → integer minutes (rounded up if any seconds).
function isoDurationToMinutes(iso) {
  if (!iso) return null
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!m) return null
  const h = Number(m[1] || 0)
  const min = Number(m[2] || 0)
  const s = Number(m[3] || 0)
  const total = h * 60 + min + (s > 0 ? 1 : 0)
  return total || null
}

function bestThumb(snippet) {
  const t = snippet?.thumbnails || {}
  // Prefer maxres → high → medium → default.
  return t.maxres?.url || t.high?.url || t.medium?.url || t.default?.url || null
}

async function fetchById(videoId) {
  const params = new URLSearchParams({
    id: videoId,
    part: 'snippet,contentDetails',
    key: API_KEY,
  })
  const res = await fetch(`${BASE}/videos?${params}`)
  if (!res.ok) return null
  const data = await res.json()
  const item = data?.items?.[0]
  if (!item) return null
  return {
    title: item.snippet?.title || null,
    channel: item.snippet?.channelTitle || null,
    synopsis: item.snippet?.description?.split('\n').slice(0, 4).join(' ').slice(0, 400) || null,
    image_url: bestThumb(item.snippet),
    duration_min: isoDurationToMinutes(item.contentDetails?.duration),
    youtube_id: videoId,
    web_url: `https://www.youtube.com/watch?v=${videoId}`,
  }
}

async function fetchByQuery(query) {
  const params = new URLSearchParams({
    q: query,
    part: 'snippet',
    type: 'video',
    maxResults: '1',
    key: API_KEY,
  })
  const res = await fetch(`${BASE}/search?${params}`)
  if (!res.ok) return null
  const data = await res.json()
  const item = data?.items?.[0]
  const id = item?.id?.videoId
  if (!id) return null
  // Fetch full details so we get duration too.
  return await fetchById(id)
}

export async function youtubeLookup(input) {
  if (!API_KEY) return null
  const i = (input || '').trim()
  if (!i) return null
  const id = extractVideoId(i)
  if (id) return await fetchById(id)
  return await fetchByQuery(i)
}
