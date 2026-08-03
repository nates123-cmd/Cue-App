import { useEffect, useMemo, useRef, useState } from 'react'

// Reorderable list, pointer-events only.
//
// HTML5 drag-and-drop does not fire on touch, and Cue is used on a phone, so
// this is built on pointer events + setPointerCapture instead. The gesture can
// only start on the grip: the rest of the row keeps its normal tap-to-open, and
// vertical page scrolling is never hijacked (touch-action: none is scoped to
// the grip alone).
//
// Row offsets are computed against the rects measured once at drag start. The
// live DOM is transform-shifted during the drag, so re-measuring mid-gesture
// would feed the moved positions back in and oscillate.

const Grip = (props) => (
  <div
    {...props}
    style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 3, width: 28, alignSelf: 'stretch',
      cursor: 'grab', touchAction: 'none', color: 'var(--muted)',
      // Without this an accidental drag selects the row text on desktop.
      userSelect: 'none', WebkitUserSelect: 'none',
    }}
  >
    {[0, 1, 2].map((i) => (
      <span key={i} style={{
        display: 'block', width: 11, height: 1,
        background: 'currentColor', opacity: 0.65,
      }} />
    ))}
  </div>
)

export const DragList = ({ items, onReorder, renderRow, onRemove, gap = 0 }) => {
  const idsKey = items.map((i) => i.id).join('|')
  const [order, setOrder] = useState(() => items.map((i) => i.id))
  const [drag, setDrag] = useState(null)
  const rowEls = useRef(new Map())

  // Re-sync when the caller's list actually changes. After a commit the parent
  // reorders optimistically to the same sequence, so idsKey is unchanged and
  // this doesn't fight the drag.
  useEffect(() => { setOrder(items.map((i) => i.id)) }, [idsKey])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const rows = order.map((id) => byId.get(id)).filter(Boolean)

  const startDrag = (e, idx) => {
    if (rows.length < 2) return
    const rects = order.map((id) => {
      const el = rowEls.current.get(id)
      if (!el) return { height: 0, center: 0 }
      const r = el.getBoundingClientRect()
      return { height: r.height, center: r.top + r.height / 2 }
    })
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    setDrag({ idx, overIdx: idx, startY: e.clientY, dy: 0, rects })
  }

  const moveDrag = (e) => {
    if (!drag) return
    const y = e.clientY
    let over = 0
    for (let i = 0; i < drag.rects.length; i++) if (y > drag.rects[i].center) over = i
    setDrag((d) => (d ? { ...d, dy: y - d.startY, overIdx: over } : d))
  }

  const endDrag = () => {
    if (!drag) return
    const { idx, overIdx } = drag
    setDrag(null)
    if (idx === overIdx) return
    const next = order.slice()
    const [moved] = next.splice(idx, 1)
    next.splice(overIdx, 0, moved)
    setOrder(next)
    onReorder && onReorder(next)
  }

  // How far a non-dragged row slides to open the gap the dragged row will land in.
  const shiftFor = (i) => {
    if (!drag || i === drag.idx) return 0
    const { idx: from, overIdx: to, rects } = drag
    const h = rects[from].height + gap
    if (from < to && i > from && i <= to) return -h
    if (from > to && i >= to && i < from) return h
    return 0
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {rows.map((item, i) => {
        const lifted = drag && drag.idx === i
        return (
          <div
            key={item.id}
            ref={(el) => { if (el) rowEls.current.set(item.id, el); else rowEls.current.delete(item.id) }}
            style={{
              position: 'relative',
              zIndex: lifted ? 5 : 1,
              transform: `translateY(${lifted ? drag.dy : shiftFor(i)}px)`,
              transition: lifted ? 'none' : 'transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1)',
              ...(lifted ? {
                background: 'var(--paper)',
                boxShadow: '0 18px 36px -18px rgba(0,0,0,0.75)',
                borderRadius: 3,
              } : {}),
            }}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: onRemove ? '28px 1fr 24px' : '28px 1fr',
              alignItems: 'center', gap: 4,
            }}>
              <Grip
                onPointerDown={(e) => startDrag(e, i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
              <div style={{ minWidth: 0 }}>{renderRow(item, i)}</div>
              {onRemove && (
                <button
                  onClick={() => onRemove(item)}
                  title="Remove from Up Next"
                  style={{
                    appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
                    padding: 4, color: 'var(--muted)', fontSize: 13, lineHeight: 1,
                  }}
                >×</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
