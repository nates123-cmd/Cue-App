import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mono, btnGhost } from './primitives'
import { chooseOption, fetchRequest, optionsOf } from '../lib/downloads'

// The follow-up after "Push to Radarr" on a movie: how should the file be
// picked? Three answers, and the third keeps this sheet open while the bridge
// searches so the candidates can be picked right here.
//
//   auto     - the bridge's default. Fastest copy inside the rules; if a much
//              faster copy breaks a rule it asks on Telegram, and takes the safe
//              one after 20 minutes of silence.
//   fastest  - most seeders per GB, soft rules (size floor/ceiling, quality
//              tier) waived. No questions asked.
//   options  - the bridge writes the best few releases onto the request row and
//              parks it on status 'choosing'. They show up here, in the tray,
//              and as Telegram buttons. Nothing downloads until one is tapped.
//
// TV and books never see this sheet: a season is many files, and the bridge's
// season-pack logic owns that choice.

export const PUSH_MODES = [
  {
    key: 'auto',
    title: 'Auto',
    blurb: 'Fastest copy inside your rules. Asks on Telegram only if a faster one breaks a rule.',
  },
  {
    key: 'fastest',
    title: 'Fastest',
    blurb: 'Most seeders per GB, rules waived. No questions.',
  },
  {
    key: 'options',
    title: 'Show me options',
    blurb: 'The best few copies, listed here and on Telegram. Nothing downloads until you pick.',
  },
]

const OPTIONS_POLL_MS = 5000
const OPTIONS_WAIT_MS = 4 * 60 * 1000   // a Radarr interactive search is normally < 1 min

// One tappable release row. Shared with the DownloadTray, which shows the same
// list under a 'choosing' request so a pick made later lands on the same row.
export function OptionList({ row, options, onPicked, compact = false }) {
  const [picking, setPicking] = useState(null)   // tok being written
  const [err, setErr] = useState(null)
  const picked = row?.choice || null

  const pick = async (tok) => {
    if (picking || picked) return
    setPicking(tok)
    setErr(null)
    try {
      await chooseOption(row.id, tok)
      onPicked?.(tok)
    } catch (e) {
      setErr(e?.message || 'Could not send that pick.')
      setPicking(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 6 }}>
      {options.map((o, i) => {
        const chosen = picked === o.tok
        const busy = picking === o.tok
        const dim = (picked && !chosen) || (picking && !busy)
        return (
          <button
            key={o.tok}
            onClick={() => pick(o.tok)}
            disabled={!!picked || !!picking}
            style={{
              appearance: 'none', textAlign: 'left', cursor: picked || picking ? 'default' : 'pointer',
              width: '100%', padding: compact ? '7px 9px' : '9px 11px', borderRadius: 4,
              background: chosen ? 'var(--signal)' : 'transparent',
              color: chosen ? 'var(--ink)' : 'var(--text)',
              border: `1px solid ${chosen ? 'var(--signal)' : o.ok ? 'var(--hairline-strong)' : 'var(--hairline)'}`,
              opacity: dim ? 0.45 : 1,
              display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
            }}
          >
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', flexShrink: 0,
                color: chosen ? 'var(--ink)' : 'var(--muted)',
              }}>{i + 1}</span>
              <span style={{
                fontFamily: 'var(--body)', fontSize: compact ? 11.5 : 12.5, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
              }}>{o.title}</span>
            </span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: chosen ? 'var(--ink)' : o.ok ? 'var(--text-soft)' : 'var(--signal)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {busy ? 'Sending…' : chosen ? 'Grabbing' : (
                `${o.gb != null ? `${Number(o.gb).toFixed(1)} GB` : '? GB'} · ${o.seeders ?? 0} seeders` +
                `${o.quality ? ` · ${o.quality}` : ''}` +
                `${o.ok ? '' : ` · ${o.why || 'outside your rules'}`}`
              )}
            </span>
          </button>
        )
      })}
      {err && <Mono size={9} style={{ color: 'var(--signal)' }}>{err}</Mono>}
    </div>
  )
}

// `pending` is { item, resolve } set by App.pushToRadarr; `onSubmit(mode)`
// performs the real insert and returns { duplicate, id } from it.
export const PushModeSheet = ({ pending, onSubmit, onClose }) => {
  const [host, setHost] = useState(null)
  const [phase, setPhase] = useState('pick')      // pick | sending | waiting | options | done | error
  const [row, setRow] = useState(null)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const started = useRef(0)

  useEffect(() => {
    setHost(document.getElementById('cue-overlay-root') || document.body)
  }, [])

  useEffect(() => {
    setPhase('pick'); setRow(null); setError(null)
    return () => clearInterval(timer.current)
  }, [pending])

  if (!pending || !host) return null
  const { item } = pending

  const choose = async (mode) => {
    if (phase !== 'pick') return
    setPhase('sending')
    setError(null)
    let res
    try {
      res = await onSubmit(mode)
    } catch (e) {
      setError(e?.message || 'Push failed — try again.')
      setPhase('error')
      return
    }
    if (mode !== 'options' || res?.duplicate || !res?.id) {
      setPhase('done')
      setTimeout(onClose, 700)
      return
    }
    // Watch the row until the bridge writes the candidates (or gives up and
    // falls back to auto, which shows as status 'added').
    setPhase('waiting')
    started.current = Date.now()
    const poll = async () => {
      try {
        const r = await fetchRequest(res.id)
        if (!r) return
        setRow(r)
        if (r.status === 'choosing' && optionsOf(r).length) {
          setPhase('options')
          clearInterval(timer.current)
        } else if (r.status !== 'pending' && r.status !== 'choosing') {
          setPhase('done')          // fell back to auto, failed, or already grabbed
          clearInterval(timer.current)
        } else if (Date.now() - started.current > OPTIONS_WAIT_MS) {
          clearInterval(timer.current)
          setPhase('done')
        }
      } catch { /* keep polling */ }
    }
    clearInterval(timer.current)
    timer.current = setInterval(poll, OPTIONS_POLL_MS)
    poll()
  }

  const heading = {
    pick: 'How should it pick the file?',
    sending: 'Sending…',
    waiting: 'Searching the indexers…',
    options: 'Pick a copy',
    done: 'Queued in Radarr',
    error: 'Push failed',
  }[phase]

  const fellBack = phase === 'done' && row && row.status !== 'choosing' && row.detail
  const doneMsg = row?.choice
    ? 'Grabbing that one.'
    : fellBack
      ? 'Radarr found nothing worth choosing between, so it went ahead on its own.'
      : phase === 'done' && row ? 'No answer yet. Pick later from the tray, or on Telegram.' : null

  return createPortal(
    <>
      <div onClick={phase === 'sending' ? undefined : onClose} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,0.55)',
      }} />
      <div style={{
        position: 'fixed', left: '50%', bottom: 'calc(28px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)', zIndex: 130,
        width: 'min(440px, calc(100vw - 28px))',
        maxHeight: 'min(72svh, 600px)', overflowY: 'auto',
        background: 'var(--paper)', color: 'var(--text)',
        border: '1px solid var(--hairline-strong)', borderRadius: 12,
        padding: '16px 16px 14px',
        display: 'flex', flexDirection: 'column', gap: 12,
        boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)',
        animation: 'sheet-in 280ms cubic-bezier(0.2,0.7,0.2,1)',
        WebkitOverflowScrolling: 'touch',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <Mono size={9} dim>Push to Radarr</Mono>
          <button onClick={onClose} disabled={phase === 'sending'} style={{ ...btnGhost, padding: '3px 8px', fontSize: 9 }}>
            {phase === 'options' || phase === 'waiting' ? 'Pick later' : 'Close'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{
            fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 22, lineHeight: 1.1,
            color: 'var(--text)',
          }}>{heading}</div>
          <div style={{
            fontFamily: 'var(--body)', fontSize: 12.5, color: 'var(--text-soft)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{item.title}{item.extension?.release_year ? ` · ${item.extension.release_year}` : ''}</div>
        </div>

        {phase === 'pick' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PUSH_MODES.map((m) => (
              <button key={m.key} onClick={() => choose(m.key)} style={{
                appearance: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '11px 13px', borderRadius: 6,
                background: 'transparent', color: 'var(--text)',
                border: '1px solid var(--hairline-strong)',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.14em',
                  textTransform: 'uppercase', fontWeight: 600,
                }}>{m.title}</span>
                <span style={{ fontFamily: 'var(--body)', fontSize: 12, lineHeight: 1.4, color: 'var(--text-soft)' }}>
                  {m.blurb}
                </span>
              </button>
            ))}
          </div>
        )}

        {(phase === 'sending' || phase === 'waiting') && (
          <div style={{ padding: '6px 0 2px' }}>
            <Mono size={9} dim>
              {phase === 'sending'
                ? 'Writing the request…'
                : 'Usually under a minute. Close this and the list waits in the tray and on Telegram.'}
            </Mono>
          </div>
        )}

        {phase === 'options' && row && (
          <>
            <OptionList row={row} options={optionsOf(row)} onPicked={(tok) => {
              setRow((r) => ({ ...r, choice: tok }))
              setPhase('done')
              setTimeout(onClose, 900)
            }} />
            <Mono size={8.5} dim>
              Also sent to Telegram. Nothing downloads until you pick; after a day it takes the fastest in-rules copy.
            </Mono>
          </>
        )}

        {phase === 'done' && doneMsg && <Mono size={9} dim>{doneMsg}</Mono>}
        {phase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Mono size={9} style={{ color: 'var(--signal)' }}>{error}</Mono>
            <button onClick={() => setPhase('pick')} style={{ ...btnGhost, alignSelf: 'flex-start' }}>Try again</button>
          </div>
        )}
      </div>
    </>,
    host,
  )
}
