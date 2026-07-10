// Download tray data layer.
//
// Cue pushes movie/tv titles to the home *arr stack by inserting a
// `media_requests` row (see App.pushToRadarr). The Beelink media-bridge daemon
// picks them up, adds them to Radarr/Sonarr, and — as of the status-feed work —
// writes live progress back onto the SAME row: `status` walks
// pending → added(=searching) → downloading → downloaded (or failed), and
// `detail` carries a JSON blob { msg, app, arr_id, pct, eta }.
//
// This hook surfaces those rows for the top-right DownloadTray bubble. RLS scopes
// the select to the signed-in user (media_requests.user_id = auth.uid()).

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

const ACTIVE = new Set(['pending', 'added', 'downloading'])
const POLL_MS = 10000
const RECENT_DONE_MS = 24 * 60 * 60 * 1000 // keep finished/failed visible for a day

// detail is JSON on new rows, a plain human string on legacy rows, or null.
export function parseDetail(detail) {
  if (!detail) return {}
  if (typeof detail === 'object') return detail
  try {
    const o = JSON.parse(detail)
    return o && typeof o === 'object' ? o : { msg: String(detail) }
  } catch {
    return { msg: String(detail) }
  }
}

export function isActive(status) {
  return ACTIVE.has(status)
}

// Map a row to a display state for the tray.
export function statusView(row) {
  const d = parseDetail(row.detail)
  const pct = Number.isFinite(d.pct) ? Math.max(0, Math.min(100, Math.round(d.pct))) : null
  switch (row.status) {
    case 'pending':
      return { label: 'Queued', tone: 'wait', pct: null }
    case 'added':
      return { label: 'Searching', tone: 'wait', pct: null }
    case 'downloading':
      return { label: pct != null ? `Downloading ${pct}%` : 'Downloading', tone: 'go', pct, eta: d.eta }
    case 'downloaded':
      return { label: 'Done', tone: 'done', pct: 100 }
    case 'failed':
      return { label: 'Failed', tone: 'fail', pct: null, msg: d.msg }
    default:
      return { label: row.status || 'Unknown', tone: 'wait', pct: null }
  }
}

export function useDownloads() {
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const timer = useRef(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('media_requests')
      .select('id,title,media_type,status,detail,requested_at,processed_at')
      .order('requested_at', { ascending: false })
      .limit(40)
    if (!error && data) {
      const now = Date.now()
      const visible = data.filter((r) => {
        if (ACTIVE.has(r.status)) return true
        const ts = r.processed_at || r.requested_at
        return ts && now - new Date(ts).getTime() < RECENT_DONE_MS
      })
      setRows(visible)
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, POLL_MS)
    // Best-effort realtime: nudge a refetch on any change. Poll is the safety net
    // if realtime isn't enabled on the table, so a silent no-op here is fine.
    let ch = null
    try {
      ch = supabase
        .channel('media_requests_tray')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'media_requests' }, () => load())
        .subscribe()
    } catch {
      ch = null
    }
    return () => {
      clearInterval(timer.current)
      if (ch) supabase.removeChannel(ch)
    }
  }, [load])

  const active = rows.filter((r) => ACTIVE.has(r.status))
  return { rows, active, loaded, reload: load }
}
