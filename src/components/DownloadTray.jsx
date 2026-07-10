import { useState } from 'react'
import { useDownloads, statusView } from '../lib/downloads'

// Top-right download bubble + drop-down tray. Shows anything Cue has pushed to
// the home *arr stack, with live status/progress fed back by the media-bridge
// daemon onto the media_requests row. Poll-driven (10s) so it stays current
// without a persistent socket.

const TONE = {
  wait: 'var(--text-soft)',
  go: 'var(--signal)',
  done: '#4c9a6a',
  fail: '#c0503a',
}

function DownloadIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  )
}

function Row({ row }) {
  const v = statusView(row)
  const color = TONE[v.tone] || 'var(--text-soft)'
  return (
    <div style={{ padding: '10px 14px', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
        <span style={{
          fontFamily: 'var(--body)', fontSize: 13, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>{row.title}</span>
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
      {v.tone === 'fail' && v.msg && (
        <div style={{
          marginTop: 5, fontFamily: 'var(--mono)', fontSize: 9, lineHeight: 1.4,
          color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{v.msg}</div>
      )}
    </div>
  )
}

export function DownloadTray() {
  const [open, setOpen] = useState(false)
  const { rows, active } = useDownloads()

  // Bubble stays put even with nothing to show, per design — badge only when busy.
  const busy = active.length > 0
  const downloading = active.some((r) => r.status === 'downloading')

  return (
    <>
      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 44, background: 'transparent',
        }} />
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Downloads"
        style={{
          position: 'fixed', zIndex: 45,
          top: 'calc(12px + env(safe-area-inset-top, 0px))', right: 16,
          width: 42, height: 42, borderRadius: 999,
          appearance: 'none', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--paper)', color: 'var(--text)',
          border: '1px solid var(--hairline-strong)',
          boxShadow: downloading
            ? '0 0 0 3px color-mix(in srgb, var(--signal) 26%, transparent), 0 10px 22px -10px rgba(0,0,0,0.5)'
            : '0 10px 22px -10px rgba(0,0,0,0.5)',
          transition: 'box-shadow 500ms ease',
        }}
      >
        <DownloadIcon />
        {busy && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17,
            padding: '0 4px', borderRadius: 999,
            background: 'var(--signal)', color: 'var(--ink)',
            border: '2px solid var(--ink)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, lineHeight: 1,
          }}>{active.length}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'fixed', zIndex: 46,
          top: 'calc(60px + env(safe-area-inset-top, 0px))', right: 16,
          width: 300, maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'min(60vh, 440px)', overflowY: 'auto',
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
            rows.map((r) => <Row key={r.id} row={r} />)
          )}
        </div>
      )}
    </>
  )
}
