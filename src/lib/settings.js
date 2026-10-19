// Per-user Cue preferences, read from the suite's `user_settings` table
// (PK (user_id, key), RLS auth.uid() = user_id, so the anon client only ever
// sees the signed-in person's rows).
//
// Two keys so far, both optional:
//
//   cue_types    which media types this login sees. JSON array or a comma
//                list, e.g. `["book"]` or `book,article`. Unknown names are
//                dropped; absent / empty / nothing-valid means every type.
//                Set to `["book"]` for a reader who only wants the Kindle
//                side of Cue (Gabe, 2026-10-19) -- the type chips, capture
//                picker, auto-search lanes, the Recs feed and the Claude
//                proposal prompt all narrow to it. Rows of other types stay
//                in the DB untouched; they are just not shown.
//
//   cue_partner  the co-viewing partner name. Absent means the historical
//                default (Amanda). Empty string / "none" / "off" switches the
//                "with <partner>" UI off entirely for that login.
//
// Everything downstream of the UI (media_requests, the bridge, Kindle routing)
// was already per-user; this is only the chrome.
import { supabase } from './supabase'
import { PARTNER, TYPE_ORDER } from './meta'

const PARTNER_OFF = new Set(['', 'none', 'off', 'null', 'false'])

export const DEFAULT_PREFS = Object.freeze({ types: TYPE_ORDER, partner: PARTNER })

// Pure: `cue_types` raw value -> ordered list of known types. Order follows
// TYPE_ORDER, not the setting, so the chips never reshuffle between logins.
export function parseTypes(raw) {
  if (raw == null) return TYPE_ORDER
  let list = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return TYPE_ORDER
    try {
      list = JSON.parse(s)
    } catch {
      list = s.split(',')
    }
  }
  if (!Array.isArray(list)) return TYPE_ORDER
  const wanted = new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))
  const kept = TYPE_ORDER.filter((t) => wanted.has(t))
  return kept.length ? kept : TYPE_ORDER
}

// Pure: `cue_partner` raw value -> name, or null for "no partner UI".
export function parsePartner(raw) {
  if (raw == null) return PARTNER
  const s = String(raw).trim()
  if (PARTNER_OFF.has(s.toLowerCase())) return null
  return s
}

export function prefsFromRows(rows) {
  const map = {}
  for (const r of rows || []) if (r && r.key) map[r.key] = r.value
  return {
    types: parseTypes(map.cue_types),
    partner: parsePartner(map.cue_partner),
  }
}

// One round trip at app start. A failed read falls back to the defaults
// rather than blocking the app: worst case a books-only reader briefly sees
// every type, never the other way round for anyone else.
export async function loadPrefs() {
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('key,value')
      .in('key', ['cue_types', 'cue_partner'])
    if (error) throw error
    return prefsFromRows(data)
  } catch (e) {
    console.warn('cue prefs load failed, using defaults', e)
    return { ...DEFAULT_PREFS }
  }
}

// True when this login is narrowed to a subset of the registry.
export function typesRestricted(types) {
  return Array.isArray(types) && types.length < TYPE_ORDER.length
}
