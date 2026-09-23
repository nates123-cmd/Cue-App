import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDownloads, statusView, optionsOf } from '../lib/downloads'
import { OptionList } from './PushModeSheet'

// Download bubble + tray, docked in the Masthead's top-right cluster (it used to
// float over the page). Shows anything Cue pushed to the home *arr stack, with
// live status/progress the media-bridge daemon writes back onto the
// media_requests row. Poll-driven (10s). Swipe a row left to delete it.

const TONE = {
  wait: 'var(--text-soft)',
  ask: 'var(--signal)',
  go: 'var(--signal)',
  done: '#4c9a6a',
  fail: '#c0503a',
}

const DELETE_AT = -70   // px of leftward drag that commits the delete
const MAX_DRAG = -110

function DownloadIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  )
}

function Row({ row, onDelete, onPicked }) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startX = useRef(null)

  const onTouchStart = (e) => {
    startX.current = e.touches[0].clientX
    setDragging(true)
  }
  const onTouchMove = (e) => {
    if (startX.current == null) return
    const d = e.touches[0].clientX - startX.current
    setDx(Math.max(MAX_DRAG, Math.min(0, d)))
  }
  const onTouchEnd = () => {
    startX.current = null
    setDragging(false)
    if (dx <= DELETE_AT) {
      setDx(-360)                       // slide it out, then drop the row
      setTimeout(() => onDelete(row), 160)
    } else {
      setDx(0)
    }
  }

  const v = statusView(row)
  const color = TONE[v.tone] || 'var(--text-soft)'
  const armed = dx <= DELETE_AT

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderTop: '1px solid var(--hairline)' }}>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        paddingRight: 16, background: TONE.fail,
        color: '#fff', fontFamily: 'var(--mono)', fontSize: 9,
        letterSpacing: '0.14em', textTransform: 'uppercase',
        opacity: dx < -6 ? 1 : 0, transition: 'opacity 120ms ease',
      }}>{armed ? 'Release' : 'Delete'}</div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: 'relative', padding: '10px 14px', background: 'var(--paper)',
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 180ms ease',
          touchAction: 'pan-y',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
          <span style={{
            fontFamily: 'var(--body)', fontSize: 13, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {row.title}
            {/* Two rows for one show are two seasons, not a bug — say which. */}
            {row.season != null && (
              <span style={{
                marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9,
                letterSpacing: '0.1em', color: 'var(--muted)',
              }}>S{row.season}</span>
            )}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.12em',
            textTransform: 'uppercase', color, whiteSpace: 'nowrap', flexShrink: 0,
          }}>{v.label}</span>
        </div>
        {v.pct != null && (
          <div style={{
            marginTop: 7, height: 3, borderRadius: 999, overflow: 'hidden',
            background: 'var(--hairline-strong)',
          }}>
            <div style={{
              height: '100%', width: `${v.pct}%`, background: color,
              borderRadius: 999, transition: 'width 500ms ease',
            }} />
          </div>
        )}
        {/* "Show me options": the bridge parked this on a choice. List the
            candidates right here so a pick made after the popup closed still
            lands on the same row (and the same Telegram buttons). */}
        {row.status === 'choosing' && !row.choice && optionsOf(row).length > 0 && (
          <div style={{ marginTop: 8 }}>
            <OptionList row={row} options={optionsOf(row)} compact onPicked={() => onPicked?.(row)} />
          </div>
        )}
        {(v.tone === 'fail' || v.tone === 'ask' || row.status === 'watching') && v.msg && (
          <div style={{
            marginTop: 5, fontFamily: 'var(--mono)', fontSize: 9, lineHeight: 1.4,
            color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{v.msg}</div>
        )}
      </div>
    </div>
  )
}

export function DownloadTray() {
  const [open, setOpen] = useState(false)
  const { rows, active, remove, reload } = useDownloads()
  const btnRef = useRef(null)

  // The tray renders inside the Masthead, which sits inside App's z-index 2
  // page wrapper — a stacking context. A fixed backdrop rendered from here is
  // capped at layer 2 and loses to BottomNav (z 40) and the Capture FAB (z 35),
  // so a tap on either went to them instead of dismissing the tray. Portal both
  // the backdrop and the panel out to #cue-overlay-root (see App.jsx), which is
  // unpositioned and therefore lands them in the root stacking context.
  const [host, setHost] = useState(null)
  // Portalling costs the panel its `position: absolute` anchor, so the button's
  // viewport rect has to be measured — and re-measured, because the Masthead is
  // a static header that scrolls away under the panel.
  const [anchor, setAnchor] = useState(null)

  useEffect(() => {
    setHost(document.getElementById('cue-overlay-root') || null)
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const top = r.bottom + 10
      setAnchor({
        top,
        right: Math.max(8, window.innerWidth - r.right),
        // Keep the panel inside the viewport however far down the button sits.
        maxHeight: Math.max(120, Math.min(440, window.innerHeight * 0.6, window.innerHeight - top - 16)),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const busy = active.length > 0
  const downloading = active.some((r) => r.status === 'downloading')

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Downloads"
        style={{
          position: 'relative', zIndex: 45,
          width: 26, height: 26, borderRadius: '50%', padding: 0,
          appearance: 'none', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: downloading ? 'var(--signal)' : 'transparent',
          color: downloading ? 'var(--ink)' : 'var(--text-soft)',
          border: `1px solid ${downloading ? 'var(--signal)' : 'var(--hairline-strong)'}`,
          transition: 'background 400ms ease, color 400ms ease, border-color 400ms ease',
        }}
      >
        <DownloadIcon />
        {busy && !downloading && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 14, height: 14,
            padding: '0 3px', borderRadius: 999,
            background: 'var(--signal)', color: 'var(--ink)',
            border: '1.5px solid var(--ink)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700, lineHeight: 1,
          }}>{active.length}</span>
        )}
      </button>

      {open && host && anchor && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{
            position: 'fixed', inset: 0, zIndex: 44, background: 'transparent',
          }} />
          <div style={{
            position: 'fixed', zIndex: 46,
            top: anchor.top, right: anchor.right,
            width: 300, maxWidth: 'calc(100vw - 32px)',
            maxHeight: anchor.maxHeight, overflowY: 'auto',
            background: 'var(--paper)', color: 'var(--text)',
            border: '1px solid var(--hairline-strong)', borderRadius: 14,
            boxShadow: '0 20px 44px -16px rgba(0,0,0,0.6)',
            WebkitOverflowScrolling: 'touch',
          }}>
          <div style={{
            padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 8,
            justifyContent: 'space-between',
          }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em',
              textTransform: 'uppercase', color: 'var(--text-soft)',
            }}>Downloads</span>
            {busy && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'var(--signal)',
              }}>{active.length} active</span>
            )}
          </div>
          {rows.length === 0 ? (
            <div style={{
              padding: '18px 14px 22px', borderTop: '1px solid var(--hairline)',
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--muted)', textAlign: 'center',
            }}>Nothing downloading</div>
          ) : (
            rows.map((r) => <Row key={r.id} row={r} onDelete={remove} onPicked={reload} />)
          )}
          </div>
        </>,
        host,
      )}
    </div>
  )
}
