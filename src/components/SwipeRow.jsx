import { useRef, useState } from 'react'

// Single-finger drag with snap. Commits when the drag passes ±90px.
export const SwipeRow = ({
  children, onSwipeLeft, onSwipeRight,
  leftLabel = 'Seen it', rightLabel = 'Delete',
  leftColor = '#d4a23a', rightColor = '#c43a2a',
}) => {
  const [dx, setDx] = useState(0)
  const [committing, setCommitting] = useState(false)
  const startX = useRef(0)
  const dragging = useRef(false)
  const moved = useRef(false)
  const THRESHOLD = 90

  const onDown = (e) => {
    if (committing) return
    dragging.current = true
    moved.current = false
    startX.current = e.clientX
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e) => {
    if (!dragging.current) return
    const d = e.clientX - startX.current
    if (Math.abs(d) > 3) moved.current = true
    setDx(d)
  }
  const onUp = () => {
    if (!dragging.current) return
    dragging.current = false
    if (dx < -THRESHOLD) {
      setCommitting(true); setDx(-600)
      setTimeout(() => onSwipeLeft && onSwipeLeft(), 240)
    } else if (dx > THRESHOLD) {
      setCommitting(true); setDx(600)
      setTimeout(() => onSwipeRight && onSwipeRight(), 240)
    } else {
      setDx(0)
    }
  }

  const onClickCapture = (e) => {
    if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false }
  }

  const dir = dx < 0 ? 'left' : dx > 0 ? 'right' : null
  const intent = Math.min(1, Math.abs(dx) / THRESHOLD)
  const past = Math.abs(dx) >= THRESHOLD

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 3 }}>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center',
        justifyContent: dir === 'left' ? 'flex-end' : 'flex-start',
        padding: '0 18px',
        background: dir === 'left'
          ? `color-mix(in oklab, ${leftColor} ${Math.round(intent * 80)}%, transparent)`
          : dir === 'right'
            ? `color-mix(in oklab, ${rightColor} ${Math.round(intent * 80)}%, transparent)`
            : 'transparent',
        opacity: dir ? 1 : 0,
        transition: dragging.current ? 'none' : 'background 200ms ease, opacity 200ms ease',
        pointerEvents: 'none',
      }}>
        {dir && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            color: past ? '#fff' : 'rgba(255,255,255,0.8)',
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
            textTransform: 'uppercase', fontWeight: 600,
            transform: `scale(${0.85 + intent * 0.2})`,
            transition: dragging.current ? 'none' : 'transform 200ms ease',
          }}>
            {dir === 'left' ? (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 7.5 5.5 10.5 11.5 4" />
                </svg>
                {leftLabel}
              </>
            ) : (
              <>
                {rightLabel}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l8 8M11 3l-8 8" />
                </svg>
              </>
            )}
          </div>
        )}
      </div>
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={onClickCapture}
        style={{
          transform: `translate3d(${dx}px, 0, 0)`,
          transition: dragging.current ? 'none' : 'transform 240ms cubic-bezier(0.2,0.7,0.2,1)',
          touchAction: 'pan-y',
          background: 'var(--paper)',
          cursor: 'grab',
        }}>
        {children}
      </div>
    </div>
  )
}
