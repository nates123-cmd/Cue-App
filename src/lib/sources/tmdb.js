// TMDB v3 lookup for movies + TV. Requires VITE_TMDB_API_KEY (the v3 "API Key"
// field at https://www.themoviedb.org/settings/api — explicitly safe for
// client-side use per TMDB's docs). Returns null if the key is missing or
// nothing matches.

const API_KEY = import.meta.env.VITE_TMDB_API_KEY
const BASE = 'https://api.themoviedb.org/3'
const IMG = (path, size = 'w500') => `https://image.tmdb.org/t/p/${size}${path}`

export async function tmdbLookup(title, type) {
  const t = (title || '').trim()
  if (!API_KEY || !t || (type !== 'movie' && type !== 'tv')) return null
  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv'
  try {
    const params = new URLSearchParams({
      api_key: API_KEY,
      query: t,
      include_adult: 'false',
      language: 'en-US',
      page: '1',
    })
    const res = await fetch(`${BASE}/${endpoint}?${params}`)
    if (!res.ok) return null
    const data = await res.json()
    const r = data?.results?.[0]
    if (!r) return null
    const dateField = type === 'movie' ? r.release_date : r.first_air_date
    const year = dateField ? Number(dateField.slice(0, 4)) : null
    return {
      title: type === 'movie' ? r.title : r.name,
      year,
      synopsis: r.overview || null,
      image_url: r.poster_path ? IMG(r.poster_path, 'w500') : null,
      backdrop_url: r.backdrop_path ? IMG(r.backdrop_path, 'w780') : null,
      tmdb_vote: typeof r.vote_average === 'number' ? r.vote_average : null,
      tmdb_id: r.id,
    }
  } catch {
    return null
  }
}
