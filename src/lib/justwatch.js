// JustWatch lookup via the shared edge function (deployed for the Break app).
// Returns { title, year, type, summary, jwUrl, where_to_find, scoring } for the
// best matching result, or null if nothing found / network failure.
//
// The function gates on the project's anon-key JWT shape; we send the key both
// as `apikey` and as `Authorization: Bearer …` so either path works.

const SB_URL = import.meta.env.VITE_SUPABASE_URL
const SB_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export async function jwLookup(title, year) {
  if (!SB_URL || !SB_ANON_KEY || !title) return null
  const params = new URLSearchParams({ title })
  if (year) params.set('year', String(year))
  try {
    const res = await fetch(`${SB_URL}/functions/v1/justwatch?${params}`, {
      headers: {
        apikey: SB_ANON_KEY,
        Authorization: `Bearer ${SB_ANON_KEY}`,
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.results?.[0] || null
  } catch {
    return null
  }
}
