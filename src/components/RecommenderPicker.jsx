import { useEffect, useMemo, useRef, useState } from 'react'
import { Mono, btnPrimary } from './primitives'

export const RecommenderPicker = ({ value, onChange, recommenders }) => {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false); setAdding(false); setDraft('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const ordered = useMemo(() => {
    const list = ['me', ...recommenders.filter((r) => r !== 'me')]
    return Array.from(new Set(list))
  }, [recommenders])

  const commitNew = () => {
    const v = draft.trim()
    if (!v) return
    onChange(v); setAdding(false); setDraft(''); setOpen(false)
  }

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
        padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em',
        color: 'var(--text)', borderBottom: '1px dashed var(--hairline-strong)',
        paddingBottom: 1,
      }}>
        <span>{value}</span>
        <span style={{
          fontSize: 8, opacity: 0.6,
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 160ms',
        }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: -8, zIndex: 50,
          minWidth: 180,
          background: 'var(--paper)',
          border: '1px solid var(--hairline-strong)', borderRadius: 3,
          padding: 8,
          boxShadow: '0 14px 32px -10px rgba(0,0,0,0.55)',
          animation: 'field-in 180ms cubic-bezier(0.2,0.7,0.2,1) backwards',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <Mono size={8.5} dim style={{ padding: '2px 4px' }}>From</Mono>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {ordered.map((r) => (
              <button key={r} onClick={() => { onChange(r); setOpen(false) }} style={{
                appearance: 'none', cursor: 'pointer',
                textAlign: 'left', padding: '6px 8px', borderRadius: 2,
                background: value === r ? 'var(--paper-soft)' : 'transparent',
                color: 'var(--text)', border: 0,
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: value === r ? 'var(--signal)' : 'transparent',
                  border: value === r ? 0 : '1px solid var(--hairline-strong)',
                }} />
                {r}
              </button>
            ))}
          </div>
          <span style={{ height: 1, background: 'var(--hairline)', margin: '4px 2px' }} />
          {!adding ? (
            <button onClick={() => setAdding(true)} style={{
              appearance: 'none', cursor: 'pointer',
              textAlign: 'left', padding: '6px 8px', borderRadius: 2,
              background: 'transparent', color: 'var(--text-soft)',
              border: 0,
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 12, lineHeight: 0.8 }}>+</span> Add new
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6, padding: 2 }}>
              <input
                autoFocus value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNew()
                  if (e.key === 'Escape') { setAdding(false); setDraft('') }
                }}
                placeholder="name"
                style={{
                  appearance: 'none', flex: 1, minWidth: 0, outline: 0,
                  padding: '6px 8px', borderRadius: 2,
                  background: 'var(--paper-soft)', color: 'var(--text)',
                  border: '1px solid var(--hairline-strong)',
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em',
                }}
              />
              <button onClick={commitNew} style={{
                ...btnPrimary, padding: '5px 9px', fontSize: 9,
                opacity: draft.trim() ? 1 : 0.3,
                pointerEvents: draft.trim() ? 'auto' : 'none',
              }}>Add</button>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
