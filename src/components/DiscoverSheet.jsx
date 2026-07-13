import { useEffect, useState } from 'react'
import { Cover, Mono, btnGhost, btnPrimary } from './primitives'
import { TypeIcon } from './TypeIcon'
import { metaFor } from '../lib/meta'
import { fetchWatchProviders } from '../lib/discover'

// The sheet behind a tapped Discover tile: what it is, where it streams, and
// the two things Cue can do with it — put it in the queue, or send it to the
// home *arr stack to download.
//
// A discover entry is not a library row: it has no id and nothing has been
// written. Both actions are the first write.

function asCoverItem(entry) {
  return {
    title: entry.title,
    type: entry.type,
    image_url: entry.facts?.image_url || null,
    image_tone: null,
    cover_kind: 'poster',
    extension: entry.facts || {},
  }
}

export const DiscoverSheet = ({ entry, unreleased, inLibrary, onClose, onQueue, onDownload }) => {
  const [providers, setProviders] = useState(null) // null = still looking
  const [queueState, setQueueState] = useState('idle') // idle | busy | done
  const [dlState, setDlState] = useState('idle')       // idle | busy | done | duplicate | error
  const [error, setError] = useState(null)

  useEffect(() => {
    setProviders(null)
    setQueueState('idle')
    setDlState('idle')
    setError(null)
    if (!entry) return
    let live = true
    fetchWatchProviders(entry.facts?.tmdb_id, entry.type)
      .then((p) => { if (live) setProviders(p) })
      .catch(() => { if (live) setProviders([]) })
    return () => { live = false }
  }, [entry])

  if (!entry) return null

  const f = entry.facts || {}
  const year = f.release_year || f.first_air_year || null
  const meta = [metaFor(entry.type).spine, year, f.genre].filter(Boolean).join(' · ')
  // TMDB's 0–10 average, shown as a 0–100 the way the rest of Cue shows scores.
  const score = typeof f.tmdb_vote === 'number' && f.tmdb_vote > 0
    ? Math.round(f.tmdb_vote * 10)
    : null

  const queue = async () => {
    setQueueState('busy')
    try {
      await onQueue(entry)
      setQueueState('done')
    } catch (e) {
      setQueueState('idle')
      setError(e?.message || 'Could not queue this.')
    }
  }

  const download = async () => {
    setDlState('busy')
    setError(null)
    try {
      const res = await onDownload(entry)
      setDlState(res?.duplicate ? 'duplicate' : 'done')
    } catch (e) {
      setDlState('error')
      setError(e?.message || 'Could not send this to the download stack.')
    }
  }

  const dlLabel = {
    idle: '↓ Download',
    busy: 'Sending…',
    done: 'Downloading ✓',
    duplicate: 'Already queued',
    error: 'Retry download',
  }[dlState]

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.55)' }} />
      <div style={{
        position: 'fixed', left: '50%', bottom: 'calc(28px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)', zIndex: 110,
        width: 'min(460px, calc(100vw - 28px))',
        maxHeight: 'min(76svh, 640px)', overflowY: 'auto',
        background: 'var(--paper)',
        border: '1px solid var(--hairline-strong)', borderRadius: 12,
        padding: '16px 16px 14px',
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)',
        animation: 'sheet-in 280ms cubic-bezier(0.2,0.7,0.2,1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <Mono size={9} dim>{unreleased ? 'Not out yet' : 'From the feed'}</Mono>
          <button onClick={onClose} style={{ ...btnGhost, padding: '3px 8px', fontSize: 9 }}>Close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 14, alignItems: 'start' }}>
          <div style={{
            aspectRatio: '3 / 4', borderRadius: 3, overflow: 'hidden',
            border: '1px solid var(--hairline)', containerType: 'inline-size',
          }}>
            <Cover item={asCoverItem(entry)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
              <TypeIcon type={entry.type} size={12} weight={1.4} />
              <Mono size={9} dim>{meta}</Mono>
            </div>
            <div style={{
              fontFamily: 'var(--display)', fontStyle: 'italic',
              fontSize: 22, lineHeight: 1.1, color: 'var(--text)', textWrap: 'balance',
            }}>{entry.title}</div>
            {score != null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: score >= 60 ? 'var(--signal)' : 'var(--muted)',
                }} />
                <Mono size={9} dim>{score}% on TMDB</Mono>
              </div>
            )}
            {inLibrary && (
              <Mono size={9} style={{ color: 'var(--signal)' }}>Already in your library</Mono>
            )}
          </div>
        </div>

        {f.synopsis && (
          <p style={{
            margin: 0, fontFamily: 'var(--body)', fontSize: 13.5, lineHeight: 1.55,
            color: 'var(--text-soft)',
          }}>{f.synopsis}</p>
        )}

        {/* Where to watch. Absent for unreleased titles by definition. */}
        {!unreleased && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Mono size={9} dim>Streaming on</Mono>
            {providers === null ? (
              <Mono size={9} dim style={{ opacity: 0.6 }}>checking…</Mono>
            ) : providers.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {providers.map((p) => (
                  <span key={p} style={{
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.08em',
                    color: 'var(--text-soft)', padding: '3px 7px', borderRadius: 2,
                    border: '1px solid var(--hairline-strong)',
                  }}>{p}</span>
                ))}
              </div>
            ) : (
              <Mono size={9} dim style={{ opacity: 0.7 }}>Not on a subscription service you get.</Mono>
            )}
          </div>
        )}

        {error && (
          <div style={{
            fontFamily: 'var(--body)', fontSize: 12.5, lineHeight: 1.45,
            color: 'var(--signal)',
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, paddingTop: 2 }}>
          <button
            onClick={queue}
            disabled={queueState !== 'idle'}
            style={{
              ...btnGhost, flex: 1,
              opacity: queueState === 'idle' ? 1 : 0.55,
              cursor: queueState === 'busy' ? 'wait' : 'pointer',
            }}
          >
            {queueState === 'done' ? 'Queued ✓' : queueState === 'busy' ? 'Adding…' : '+ Queue'}
          </button>
          {/* Nothing to download before a film is released, and Cue only has a
              download target for movies and TV. */}
          {!unreleased && (entry.type === 'movie' || entry.type === 'tv') && (
            <button
              onClick={download}
              disabled={dlState === 'busy' || dlState === 'done' || dlState === 'duplicate'}
              style={{
                ...btnPrimary, flex: 1.2,
                opacity: dlState === 'busy' ? 0.6 : 1,
                cursor: dlState === 'busy' ? 'wait' : 'pointer',
              }}
            >{dlLabel}</button>
          )}
        </div>
      </div>
    </>
  )
}
