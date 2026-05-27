import { useEffect, useMemo, useState } from 'react'
import { EditionContext } from './lib/EditionContext'
import { editionForHour, formatClock, PARTNER } from './lib/meta'
import { useItems } from './lib/items'
import { supabase } from './lib/supabase'
import { BottomNav } from './components/Masthead'
import { ItemDetail } from './components/ItemDetail'
import { CueBar } from './components/CueBar'
import { FinishSheet } from './components/FinishSheet'
import { VisitSheet } from './components/VisitSheet'
import { CapturePage } from './pages/Capture'
import { LibraryPage } from './pages/Library'
import { ActivePage } from './pages/Active'

export default function App() {
  const [page, setPage] = useState('library')
  const [openItem, setOpenItem] = useState(null)
  const [cueBarOpen, setCueBarOpen] = useState(false)
  const [density, setDensity] = useState('grid')
  const [now, setNow] = useState(() => new Date())
  const [finishTarget, setFinishTarget] = useState(null) // item awaiting rating+notes
  const [visitTarget, setVisitTarget] = useState(null) // restaurant awaiting visit details

  const {
    items, loading, addItem, updateItem, deleteItem, finishItem, logVisit, reload,
  } = useItems()

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

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
  const onAdd = async (draft) => {
    await addItem(draft)
    setPage('library')
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

  // Restaurants get the richer VisitSheet (date/dishes/with/would-return);
  // everything else gets the rating+note FinishSheet.
  const onRequestFinish = (item) => {
    if (item.type === 'restaurant') setVisitTarget(item)
    else setFinishTarget(item)
  }

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

  const onMarkSeen = async (item) => {
    // Cue Bar swipe-left — no rating prompt, just log it.
    await finishItem(item, { rating: null, note: null })
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

  const onRequestLogVisit = (item) => setVisitTarget(item)

  const onConfirmLogVisit = async (fields) => {
    if (!visitTarget) return
    const target = visitTarget
    setVisitTarget(null)
    await logVisit(target, fields)
    // Logging a visit is the "I've been here" event — flip rec to done if not already.
    if (target._source === 'rec' && target.status !== 'done') {
      try { await updateItem(target.id, { status: 'done', finished_at: new Date().toISOString() }) }
      catch (e) { console.warn('mark restaurant done failed', e) }
    }
    if (fields.share_to_ink && fields.note) {
      await shareReflectionToInk({ title: target.title, type: 'restaurant', note: fields.note })
    }
    // The grouped visit_log lives on items.extension, which is rebuilt on reload.
    // Close the detail sheet so the new visit appears when reopened.
    setOpenItem(null)
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
  // primary_type follows Ink's conventions: 'restaurant' or 'media' (book/tv/movie/article/video).
  const shareReflectionToInk = async ({ title, type, note }) => {
    const primary_type = type === 'restaurant' ? 'restaurant' : 'media'
    const raw_text = `${title} — ${note}`
    const { error } = await supabase.from('entries').insert({
      raw_text, primary_type, source_surface: 'cue_finish',
    })
    if (error) console.warn('entries insert failed', error)
  }

  const onFinishFromActive = async (item) => onRequestFinish(item)

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
          {page === 'capture' && (
            <CapturePage
              onAdd={onAdd}
              onOpenCueBar={() => setCueBarOpen(true)}
              recommenders={recommenders}
              items={items}
            />
          )}
          {page === 'library' && (
            <LibraryPage
              items={items}
              onOpenItem={setOpenItem}
              density={density}
              onSetDensity={setDensity}
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

        <BottomNav page={page} onChange={setPage} activeCount={activeCount} />

        {!cueBarOpen && !openItem && !finishTarget && !visitTarget && (
          <button onClick={() => setCueBarOpen(true)} style={{
            position: 'fixed', bottom: 'calc(92px + env(safe-area-inset-bottom, 0px))', right: 16, zIndex: 35,
            appearance: 'none', cursor: 'pointer',
            padding: '11px 14px',
            background: 'var(--signal)', color: 'var(--ink)',
            border: 0, borderRadius: 999,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', fontWeight: 600,
            boxShadow: '0 12px 24px -8px rgba(0,0,0,0.5)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>✦ Cue Bar</button>
        )}

        {openItem && (
          <ItemDetail
            item={openItem}
            onClose={() => setOpenItem(null)}
            onChangeStatus={onChangeStatus}
            onToggleWith={onToggleWith}
            onPatch={onPatchItem}
            onLogVisit={onRequestLogVisit}
            onRequestFinish={onRequestFinish}
            onPromoteToLibrary={onPromoteToLibrary}
            partner={PARTNER}
            recommenders={recommenders}
          />
        )}

        <CueBar
          open={cueBarOpen}
          onClose={() => setCueBarOpen(false)}
          items={items}
          partner={PARTNER}
          edition={edition.label}
          onOpenItem={(i) => { setCueBarOpen(false); setOpenItem(i) }}
          onAdd={onAdd}
          onMarkSeen={onMarkSeen}
          onDelete={onDelete}
        />

        <FinishSheet
          open={!!finishTarget}
          item={finishTarget}
          onClose={() => setFinishTarget(null)}
          onConfirm={onConfirmFinish}
        />

        <VisitSheet
          open={!!visitTarget}
          item={visitTarget}
          onClose={() => setVisitTarget(null)}
          onConfirm={onConfirmLogVisit}
          partner={PARTNER}
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
