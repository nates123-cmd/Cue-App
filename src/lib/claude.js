// Client for the suite's shared `claude` Supabase edge function. JWT-gated, so
// the user must be signed in. Returns the raw model string (caller does parsing).
//
// The edge function takes { prompt, system?, max_tokens?, model?, tools? } and
// proxies to the Anthropic API with the secret key held server-side.

import { supabase } from './supabase'

export async function claudeComplete(prompt, opts = {}) {
  const {
    system,
    max_tokens = 1024,
    model = 'claude-sonnet-4-6',
    tools,
  } = opts

  const { data, error } = await supabase.functions.invoke('claude', {
    body: { prompt, system, max_tokens, model, tools },
  })
  if (error) throw error
  // Edge fn shape: { text: string } | { content: [{ type:'text', text }] }
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

// Strip ```json fences and return the first JSON value found. Returns null on
// failure — caller decides whether to fall back.
export function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  // Try direct parse
  try { return JSON.parse(s) } catch {}
  // Find first {...} or [...] block
  const obj = s.match(/\{[\s\S]*\}/)
  const arr = s.match(/\[[\s\S]*\]/)
  const candidate = arr && obj
    ? (arr.index < obj.index ? arr[0] : obj[0])
    : (arr?.[0] || obj?.[0])
  if (!candidate) return null
  try { return JSON.parse(candidate) } catch { return null }
}
