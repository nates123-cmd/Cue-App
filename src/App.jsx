import { useEffect, useMemo, useRef, useState } from 'react'
import { EditionContext } from './lib/EditionContext'
import { editionForHour, formatClock, PARTNER } from './lib/meta'
import { useItems } from './lib/items'
import { supabase } from './lib/supabase'
import { backfillMissingImages } from './lib/backfill'
import { BottomNav } from './components/Masthead'
import { ItemDetail } from './components/ItemDetail'
import { CaptureSheet } from './components/CaptureSheet'
import { FinishSheet } from './components/FinishSheet'
import { RecsPage } from './pages/Recs'
import { LibraryPage } from './pages/Library'
import { ActivePage } from './pages/Active'

export default function App() {
  const [page, setPage] = useState('library')
  const [openItem, setOpenItem] = useState(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [recsSeed, setRecsSeed] = useState(null) // { kind:'item', item } from "More like this"
  const [density, setDensity] = useState('grid')
  const [now, setNow] = useState(() => new Date())
  const [finishTarget, setFinishTarget] = useState(null) // item awaiting rating+notes
  const [backfillStatus, setBackfillStatus] = useState(null) // { index, total, title }

  const {
    items, loading, addItem, updateItem, deleteItem, finishItem, reload,
  } = useItems()

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // One-shot backfill of image_url for pre-source-provider rows. Runs once per
  // browser (localStorage flag). Skips Claude so manual edits are preserved.
  const backfillRanRef = useRef(false)
  useEffect(() => {
    if (backfillRanRef.current) return
    if (loading || items.length === 0) return
    backfillRanRef.current = true
    ;(async () => {
      const updated = await backfillMissingImages(items, {
        onProgress: (p) => setBackfillStatus(p),
      })
      setBackfillStatus(null)
      if (updated > 0) await reload()
    })()
  }, [loading, items, reload])

  const edition = editionForHour(now.getHours())
  const resolvedPaper = edition.isPaper

  const activeCount = items.filter((i) => i.status === 'active').length
  const recommenders = useMemo(
    () => Array.from(new Set(items.map((i) => i.recommended_by))),
    [items],
  )

  const groundCfg = resolvedPaper ? {
    '--ink': '#f3ece1',
    '--paper': '#fbf6ec',
    '--paper-soft': '#f6efe2',
    '--text': '#1c1611',
    '--text-soft': '#3d342a',
    '--muted': '#7a6f60',
    '--hairline': 'rgba(28,22,17,0.10)',
    '--hairline-strong': 'rgba(28,22,17,0.25)',
  } : {
    '--ink': '#15120f',
    '--paper': '#1c1916',
    '--paper-soft': '#23201c',
    '--text': '#f0e8d8',
    '--text-soft': '#cdc3b1',
    '--muted': '#8a8275',
    '--hairline': 'rgba(240,232,216,0.08)',
    '--hairline-strong': 'rgba(240,232,216,0.22)',
  }

  // ── mutations ─────────────────────────────────────────────
  // Used by both the Capture FAB sheet and the Recs "Queue" confirm. Stays on
  // the current page (the FAB sheet closes itself; Recs keeps its batch up).
  const onAdd = async (draft) => { await addItem(draft) }

  // Open the Recs tab pre-seeded with this item ("More like this").
  const onMoreLikeThis = (item) => {
    setOpenItem(null)
    setRecsSeed({ kind: 'item', item })
    setPage('recs')
  }

  const onBump = async (item) => {
    const ext = { ...(item.extension || {}) }
    if (item.type === 'book') {
      ext.current_page = Math.min(ext.page_count || 0, (ext.current_page || 0) + 25)
    }
    if (item.type === 'tv') {
      const epsPerSeason = Math.ceil((ext.episodes_total || 1) / (ext.seasons || 1))
      if ((ext.current_episode || 0) + 1 > epsPerSeason && (ext.current_season || 1) < (ext.seasons || 1)) {
        ext.current_season = (ext.current_season || 1) + 1
        ext.current_episode = 1
      } else {
        ext.current_episode = (ext.current_episode || 0) + 1
      }
    }
    await updateItem(item.id, { extension: ext })
  }

  const onRequestFinish = (item) => setFinishTarget(item)

  const onConfirmFinish = async ({ rating, note, share_to_ink }) => {
    if (!finishTarget) return
    const target = finishTarget
    await finishItem(target, { rating, note })
    if (openItem && openItem.id === target.id) {
      setOpenItem((prev) => prev ? { ...prev, status: 'done', rating, notes: note } : prev)
    }
    setFinishTarget(null)
    if (share_to_ink && note) {
      await shareReflectionToInk({ title: target.title, type: target.type, note })
    }
  }

  const onDelete = async (item) => deleteItem(item.id)

  const onChangeStatus = async (item, status) => {
    const patch = { status }
    if (status === 'active' && !item.started_at) patch.started_at = new Date().toISOString()
    if (status === 'done' && !item.finished_at) patch.finished_at = new Date().toISOString()
    await updateItem(item.id, patch)
    if (status === 'done') setOpenItem(null)
  }

  const onToggleWith = async (item) => {
    const cur = item.with || []
    const next = cur.includes(PARTNER) ? cur.filter((n) => n !== PARTNER) : [...cur, PARTNER]
    await updateItem(item.id, { with: next })
    setOpenItem((prev) => (prev && prev.id === item.id ? { ...prev, with: next } : prev))
  }

  // Generic patch from ItemDetail edits.
  const onPatchItem = async (item, patch) => {
    await updateItem(item.id, patch)
    setOpenItem((prev) => (prev && prev.id === item.id ? { ...prev, ...patch } : prev))
  }

  // Promote a read-only media_entries-derived item into a real library row.
  // We insert a matching recommendations row with status='done' so reload's
  // title-match merges the existing media rating/note onto it.
  const onPromoteToLibrary = async (item) => {
    await addItem({
      title: item.title,
      type: item.type,
      status: 'done',
      recommended_by: item.recommended_by || 'me',
      tags: item.tags || [],
      extension: item.extension || {},
    })
    await reload()
    setOpenItem(null)
  }

  // Cross-suite hook: write a reflection note into Ink's `entries` table.
  // Cue is media-only as of 2026-05-27, so primary_type is always 'media'.
  const shareReflectionToInk = async ({ title, note }) => {
    const raw_text = `${title} — ${note}`
    const { error } = await supabase.from('entries').insert({
      raw_text, primary_type: 'media', source_surface: 'cue_finish',
    })
    if (error) console.warn('entries insert failed', error)
  }

  const onFinishFromActive = async (item) => onRequestFinish(item)

  // Cross-system hook: queue a movie/TV item for download on the home *arr stack.
  // Writes a media_requests row; a poller on the Beelink picks it up (Radarr/Sonarr).
  // user_id is filled by the DB default (auth.uid()); RLS scopes it to this user.
  const pushToRadarr = async (item) => {
    const ext = item.extension || {}
    const tmdbId = ext.tmdb_id ? Number(ext.tmdb_id) : null
    const year = ext.release_year || ext.first_air_year || ext.published_year || null
    const { error } = await supabase.from('media_requests').insert({
      media_type: item.type === 'tv' ? 'tv' : 'movie',
      tmdb_id: Number.isFinite(tmdbId) ? tmdbId : null,
      title: item.title,
      year: year ? Number(year) : null,
    })
    if (error) throw error
  }

  const signOut = () => supabase.auth.signOut()

  return (
    <EditionContext.Provider value={{
      edition: edition.edition,
      label: edition.label,
      timeLabel: formatClock(now),
      isPaper: resolvedPaper,
      partner: PARTNER,
    }}>
      <div style={{
        ...groundCfg,
        '--signal': '#ec5a2a',
        '--display': '"Instrument Serif", Georgia, serif',
        '--body': '"Inter Tight", "Inter", system-ui, sans-serif',
        '--mono': '"JetBrains Mono", ui-monospace, monospace',
        minHeight: '100svh', position: 'relative',
        background: 'var(--ink)', color: 'var(--text)',
        fontFamily: 'var(--body)',
        transition: 'background 600ms ease, color 600ms ease',
      }}>
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1,
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0'/></filter><rect width='200' height='200' filter='url(%23n)' opacity='${resolvedPaper ? '0.18' : '0.30'}'/></svg>")`,
          mixBlendMode: resolvedPaper ? 'multiply' : 'overlay',
          opacity: 0.5,
          transition: 'opacity 600ms ease',
        }} />

        <div style={{ position: 'relative', zIndex: 2, paddingBottom: 120 }}>
          {page === 'recs' && (
            <RecsPage
              items={items}
              partner={PARTNER}
              seed={recsSeed}
              onClearSeed={() => setRecsSeed(null)}
              onAdd={onAdd}
              onOpenItem={setOpenItem}
            />
          )}
          {page === 'library' && (
            <LibraryPage
              items={items}
              onOpenItem={setOpenItem}
              density={density}
              onSetDensity={setDensity}
              onDelete={onDelete}
              onRequestFinish={onRequestFinish}
            />
          )}
          {page === 'active' && (
            <ActivePage
              items={items}
              onBump={onBump}
              onFinish={onFinishFromActive}
              onOpenItem={setOpenItem}
            />
          )}
        </div>

        {loading && items.length === 0 && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', pointerEvents: 'none',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}>
            loading library…
          </div>
        )}

        {backfillStatus && (
          <div style={{
            position: 'fixed', left: '50%', transform: 'translateX(-50%)',
            top: 'calc(12px + env(safe-area-inset-top, 0px))', zIndex: 40,
            padding: '6px 12px', borderRadius: 999,
            background: 'var(--paper)', border: '1px solid var(--hairline-strong)',
            color: 'var(--text-soft)', fontFamily: 'var(--mono)', fontSize: 9,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            boxShadow: '0 8px 20px -8px rgba(0,0,0,0.4)',
            maxWidth: 'calc(100vw - 32px)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            enriching {backfillStatus.index}/{backfillStatus.total} · {backfillStatus.title}
          </div>
        )}

        <BottomNav page={page} onChange={setPage} activeCount={activeCount} />

        {!captureOpen && !openItem && !finishTarget && (
          <button onClick={() => setCaptureOpen(true)} style={{
            position: 'fixed', bottom: 'calc(92px + env(safe-area-inset-bottom, 0px))', right: 16, zIndex: 35,
            appearance: 'none', cursor: 'pointer',
            padding: '11px 16px',
            background: 'var(--signal)', color: 'var(--ink)',
            border: 0, borderRadius: 999,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', fontWeight: 600,
            boxShadow: '0 12px 24px -8px rgba(0,0,0,0.5)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>+ Capture</button>
        )}

        {openItem && (
          <ItemDetail
            item={openItem}
            onClose={() => setOpenItem(null)}
            onChangeStatus={onChangeStatus}
            onToggleWith={onToggleWith}
            onPatch={onPatchItem}
            onRequestFinish={onRequestFinish}
            onPromoteToLibrary={onPromoteToLibrary}
            onDelete={onDelete}
            onPushToRadarr={pushToRadarr}
            onMoreLikeThis={onMoreLikeThis}
            partner={PARTNER}
            recommenders={recommenders}
          />
        )}

        <CaptureSheet
          open={captureOpen}
          onClose={() => setCaptureOpen(false)}
          onAdd={onAdd}
          recommenders={recommenders}
          partner={PARTNER}
        />

        <FinishSheet
          open={!!finishTarget}
          item={finishTarget}
          onClose={() => setFinishTarget(null)}
          onConfirm={onConfirmFinish}
        />

        <button onClick={signOut} title="Sign out" style={{
          position: 'fixed', top: 'calc(10px + env(safe-area-inset-top, 0px))', right: 10, zIndex: 30,
          appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
          color: 'var(--muted)', padding: 6, opacity: 0.6,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M5.5 12H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h2.5" />
            <path d="M9 4l3 3-3 3M5.5 7h6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </EditionContext.Provider>
  )
}
