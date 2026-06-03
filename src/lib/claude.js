// Client for the suite's shared Claude proxy edge function.
//
// Enrichment uses the JWT-gated `claude` function: every suite app authenticates
// (per-user OTP) so the Supabase session JWT authorizes the call — no client
// secret. The older `quick-service` proxy gates on a shared STOCK_PROXY_SECRET
// this build doesn't carry, so it returned 403 forbidden and nothing enriched
// (patch #eeb8b4cd).
//   POST { messages: [...], system?, model?, max_tokens? }  → { text, content }
//   model ∈ {'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'}; cap 4096.
//
// fetchUrlViaProxy still targets `quick-service` (the only function with a
// server-side URL-fetch branch); VITE_CLAUDE_PROXY_SECRET still gates it.

import { supabase } from './supabase'

const PROXY_SECRET = import.meta.env.VITE_CLAUDE_PROXY_SECRET
const DEFAULT_SYSTEM = 'You are a helpful assistant for a personal recommendation app. Return only the requested content — no preamble, no commentary.'

export async function claudeComplete(prompt, opts = {}) {
  const {
    system = DEFAULT_SYSTEM,
    max_tokens = 1024,
    model = 'claude-sonnet-4-6',
  } = opts

  const { data, error } = await supabase.functions.invoke('claude', {
    body: {
      system: system || DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      model,
      max_tokens,
    },
  })
  if (error) throw error
  if (typeof data === 'string') return data
  if (data?.text) return data.text
  if (Array.isArray(data?.content)) {
    return data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return JSON.stringify(data)
}

// Fetch a URL server-side via the same proxy. Returns { html, status } or null.
export async function fetchUrlViaProxy(url) {
  const { data, error } = await supabase.functions.invoke('quick-service', {
    body: { fetchUrl: url },
    headers: PROXY_SECRET ? { 'x-stock-proxy-secret': PROXY_SECRET } : undefined,
  })
  if (error || !data?.html) return null
  return data
}

// Strip ```json fences and return the first JSON value found. Returns null on
// failure — caller decides whether to fall back.
export function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  try { return JSON.parse(s) } catch {}
  const obj = s.match(/\{[\s\S]*\}/)
  const arr = s.match(/\[[\s\S]*\]/)
  const candidate = arr && obj
    ? (arr.index < obj.index ? arr[0] : obj[0])
    : (arr?.[0] || obj?.[0])
  if (!candidate) return null
  try { return JSON.parse(candidate) } catch { return null }
}
