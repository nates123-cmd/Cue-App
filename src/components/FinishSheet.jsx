import { useEffect, useState } from 'react'
import { Mono, RatingPicker, btnGhost, btnPrimary } from './primitives'
import { ratingTone } from '../lib/meta'

// Small modal sheet to capture rating (1..5) + optional note before
// marking an item done. Restaurants get a slightly different framing.
export const FinishSheet = ({ open, item, onClose, onConfirm }) => {
  const [rating, setRating] = useState(null)
  const [note, setNote] = useState('')
  const [shareToInk, setShareToInk] = useState(true)

  useEffect(() => {
    if (open) {
      setRating(item?.rating ?? null)
      setNote(item?.notes ?? '')
      setShareToInk(true)
    }
  }, [open, item])

  if (!open || !item) return null

  const verb = 'Mark as done'
  const tone = (n) => ratingTone(n) || 'tap a dot'

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.55)',
      }} />
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
          <Mono size={9} dim>{verb}</Mono>
          <button onClick={onClose} style={{ ...btnGhost, padding: '3px 8px', fontSize: 9 }}>Cancel</button>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontStyle: 'italic',
          fontSize: 22, lineHeight: 1.1, color: 'var(--text)',
        }}>{item.title}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Mono size={9} dim>How was it?</Mono>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <RatingPicker value={rating} onChange={setRating} size={12} />
            <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 14, color: 'var(--text-soft)' }}>
              {tone(rating)}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>Notes (optional)</Mono>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="a sentence on what stayed with you"
            rows={3}
            style={{
              appearance: 'none', outline: 0, resize: 'vertical',
              padding: '10px 12px', borderRadius: 6,
              background: 'var(--paper-soft)',
              border: '1px solid var(--hairline-strong)',
              color: 'var(--text)',
              fontFamily: 'var(--body)', fontSize: 14, lineHeight: 1.5,
              minHeight: 64, maxHeight: 240,
            }}
          />
        </div>

        {note.trim() && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-soft)',
          }}>
            <input
              type="checkbox"
              checked={shareToInk}
              onChange={(e) => setShareToInk(e.target.checked)}
              style={{ accentColor: 'var(--signal)', cursor: 'pointer' }}
            />
            Also save this as a reflection in Ink
          </label>
        )}

        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button onClick={onClose} style={{ ...btnGhost, flex: 1 }}>Cancel</button>
          <button
            onClick={() => onConfirm({
              rating,
              note: note.trim() || null,
              share_to_ink: shareToInk && !!note.trim(),
            })}
            style={{ ...btnPrimary, flex: 1.4 }}
          >Confirm</button>
        </div>
      </div>
    </>
  )
}
