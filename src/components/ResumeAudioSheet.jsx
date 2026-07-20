import { useEffect, useState } from 'react'
import { Mono, btnGhost, btnPrimary } from './primitives'
import { bookKeyFor, loadTranscript, searchTranscript, requestSeek, fmtClock } from '../lib/audioSeek'

// "Resume in audio" — you read the ebook on a Kindle; paste the last line you read
// and this seeks the audiobook (in Audiobookshelf) to that spot. Needs the book to
// have been aligned by Storyteller first (a `book_transcripts` row exists).
//
// phase: loading | none | ready | sending | sent | error
export const ResumeAudioSheet = ({ open, item, onClose }) => {
  const [phase, setPhase] = useState('loading')
  const [transcript, setTranscript] = useState(null)
  const [phrase, setPhrase] = useState('')
  const [matches, setMatches] = useState([])
  const [picked, setPicked] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open || !item) return
    setPhase('loading'); setPhrase(''); setMatches([]); setPicked(null); setErr('')
    let live = true
    loadTranscript(bookKeyFor(item.title))
      .then((t) => { if (!live) return; setTranscript(t); setPhase(t ? 'ready' : 'none') })
      .catch((e) => { if (!live) return; setErr(String(e?.message || e)); setPhase('error') })
    return () => { live = false }
  }, [open, item])

  if (!open || !item) return null

  const runSearch = (text) => {
    setPhrase(text); setPicked(null)
    setMatches(transcript ? searchTranscript(transcript.segments, text) : [])
  }

  const send = async () => {
    if (!picked) return
    setPhase('sending'); setErr('')
    try {
      await requestSeek({
        absItemId: transcript.abs_item_id,
        bookTitle: transcript.book_title || item.title,
        seconds: picked.startSec,
        phrase,
      })
      setPhase('sent')
    } catch (e) {
      setErr(String(e?.message || e)); setPhase('error')
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.55)' }} />
      <div style={{
        position: 'fixed', left: '50%', bottom: 'calc(40px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)', zIndex: 110,
        width: 'min(440px, calc(100vw - 32px))',
        background: 'var(--paper)',
        border: '1px solid var(--hairline-strong)', borderRadius: 12,
        padding: '18px 18px 16px',
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)',
        animation: 'sheet-in 280ms cubic-bezier(0.2,0.7,0.2,1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Mono size={9} dim>Resume in audio</Mono>
          <button onClick={onClose} style={{ ...btnGhost, padding: '3px 8px', fontSize: 9 }}>Close</button>
        </div>
        <div style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 22, lineHeight: 1.1, color: 'var(--text)' }}>
          {item.title}
        </div>

        {phase === 'loading' && <Mono size={11} dim>Checking for a synced transcript…</Mono>}

        {phase === 'none' && (
          <Mono size={11} dim style={{ lineHeight: 1.6 }}>
            No synced transcript yet. Align this book in Storyteller (ebook + audiobook), then it'll show up here.
          </Mono>
        )}

        {(phase === 'ready' || phase === 'sending') && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Mono size={9} dim>Paste the last line you read on your Kindle</Mono>
              <textarea
                value={phrase}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="a distinctive phrase (a few words)"
                rows={2}
                style={{
                  appearance: 'none', outline: 0, resize: 'vertical',
                  padding: '10px 12px', borderRadius: 6,
                  background: 'var(--paper-soft)', border: '1px solid var(--hairline-strong)',
                  color: 'var(--text)', fontFamily: 'var(--body)', fontSize: 14, lineHeight: 1.5,
                  minHeight: 52, maxHeight: 200,
                }}
              />
            </div>

            {phrase.trim().length > 0 && matches.length === 0 && (
              <Mono size={10} dim>No match — try a longer or more distinctive line (3+ words).</Mono>
            )}

            {matches.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Mono size={9} dim>{matches.length === 1 ? 'Found it' : 'Best matches'}</Mono>
                {matches.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => setPicked(m)}
                    style={{
                      appearance: 'none', cursor: 'pointer', textAlign: 'left',
                      padding: '9px 11px', borderRadius: 6,
                      background: picked === m ? 'var(--signal-wash, var(--paper-soft))' : 'var(--paper-soft)',
                      border: `1px solid ${picked === m ? 'var(--signal)' : 'var(--hairline)'}`,
                      color: 'var(--text)', display: 'flex', justifyContent: 'space-between', gap: 10,
                    }}
                  >
                    <span style={{ fontFamily: 'var(--body)', fontSize: 13, lineHeight: 1.4, opacity: 0.85 }}>
                      …{m.snippet}…
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--signal)', whiteSpace: 'nowrap' }}>
                      {fmtClock(m.startSec)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={send}
              disabled={!picked || phase === 'sending'}
              style={{ ...btnPrimary, opacity: !picked || phase === 'sending' ? 0.5 : 1 }}
            >
              {phase === 'sending' ? 'Sending…' : picked ? `Send to Audiobookshelf · ${fmtClock(picked.startSec)}` : 'Pick a match'}
            </button>
          </>
        )}

        {phase === 'sent' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 18, color: 'var(--text)' }}>
              Set to {fmtClock(picked?.startSec || 0)} ✓
            </div>
            <Mono size={11} dim style={{ lineHeight: 1.6 }}>
              Open Audiobookshelf and press play — it's parked at the spot. (Takes a few seconds to sync.)
            </Mono>
            <button onClick={onClose} style={btnPrimary}>Done</button>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Mono size={11} style={{ color: 'var(--signal)' }}>{err || 'Something went wrong.'}</Mono>
            <button onClick={onClose} style={btnGhost}>Close</button>
          </div>
        )}
      </div>
    </>
  )
}
