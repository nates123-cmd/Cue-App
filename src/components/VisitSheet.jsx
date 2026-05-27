import { useEffect, useState } from 'react'
import { Mono, btnGhost, btnPrimary } from './primitives'

const Chip = ({ children, active, onClick, dashed }) => (
  <button onClick={onClick} style={{
    appearance: 'none', cursor: 'pointer',
    fontFamily: 'var(--mono)', fontSize: 9, padding: '3px 8px',
    borderRadius: 2,
    background: active ? 'var(--text)' : 'transparent',
    color: active ? 'var(--ink)' : 'var(--text-soft)',
    border: `1px ${dashed ? 'dashed' : 'solid'} ${active ? 'var(--text)' : 'var(--hairline-strong)'}`,
  }}>{children}</button>
)

const ChipEditor = ({ values, onChange, placeholder = 'add' }) => {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft(''); setAdding(false)
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {values.map((v) => (
        <span key={v} onClick={() => onChange(values.filter((x) => x !== v))} style={{
          cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 9, padding: '3px 8px',
          borderRadius: 2, background: 'var(--paper)', color: 'var(--text-soft)',
          border: '1px solid var(--hairline)',
        }}>{v} <span style={{ opacity: 0.5, marginLeft: 2 }}>×</span></span>
      ))}
      {adding ? (
        <input
          autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setDraft(''); setAdding(false) }
          }}
          placeholder={placeholder}
          style={{
            appearance: 'none', outline: 0,
            width: 100, padding: '3px 8px', borderRadius: 2,
            background: 'var(--paper-soft)', color: 'var(--text)',
            border: '1px solid var(--signal)',
            fontFamily: 'var(--mono)', fontSize: 9,
          }}
        />
      ) : (
        <Chip dashed onClick={() => setAdding(true)}>+ {placeholder}</Chip>
      )}
    </div>
  )
}

// Modal sheet for logging a restaurant visit with full details:
// date, dishes, who you were with, would-return verdict, note.
// Confirms with onConfirm({ visit_date, dishes, with_people, would_return, note }).
export const VisitSheet = ({ open, item, onClose, onConfirm, partner = 'Amanda' }) => {
  const today = () => new Date().toISOString().slice(0, 10)
  const [visitDate, setVisitDate] = useState(today)
  const [dishes, setDishes] = useState([])
  const [withPeople, setWithPeople] = useState([])
  const [wouldReturn, setWouldReturn] = useState(null)
  const [note, setNote] = useState('')
  const [shareToInk, setShareToInk] = useState(true)

  useEffect(() => {
    if (open) {
      setVisitDate(today())
      setDishes([])
      setWithPeople((item?.with || []).filter(Boolean))
      setWouldReturn(null)
      setNote('')
      setShareToInk(true)
    }
  }, [open, item])

  if (!open || !item) return null

  const partnerOn = withPeople.includes(partner)
  const togglePartner = () => {
    setWithPeople(partnerOn
      ? withPeople.filter((p) => p !== partner)
      : [...withPeople, partner])
  }

  const submit = () => {
    const trimmedNote = note.trim() || null
    onConfirm({
      visit_date: visitDate,
      dishes,
      with_people: withPeople,
      would_return: wouldReturn,
      note: trimmedNote,
      share_to_ink: shareToInk && !!trimmedNote,
    })
  }

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
        maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Mono size={9} dim>Log visit</Mono>
          <button onClick={onClose} style={{ ...btnGhost, padding: '3px 8px', fontSize: 9 }}>Cancel</button>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontStyle: 'italic',
          fontSize: 22, lineHeight: 1.1, color: 'var(--text)',
        }}>{item.title}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>When</Mono>
          <input
            type="date"
            value={visitDate}
            max={today()}
            onChange={(e) => setVisitDate(e.target.value)}
            style={{
              appearance: 'none', outline: 0,
              padding: '8px 10px', borderRadius: 4,
              background: 'var(--paper-soft)',
              border: '1px solid var(--hairline-strong)',
              color: 'var(--text)',
              fontFamily: 'var(--mono)', fontSize: 12,
              colorScheme: 'dark',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>With</Mono>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip active={partnerOn} onClick={togglePartner}>{partner}</Chip>
            <ChipEditor
              values={withPeople.filter((p) => p !== partner)}
              onChange={(next) => setWithPeople(partnerOn ? [partner, ...next] : next)}
              placeholder="someone"
            />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>Dishes</Mono>
          <ChipEditor values={dishes} onChange={setDishes} placeholder="dish" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>Would return?</Mono>
          <div style={{ display: 'flex', gap: 6 }}>
            <Chip active={wouldReturn === true} onClick={() => setWouldReturn(wouldReturn === true ? null : true)}>yes</Chip>
            <Chip active={wouldReturn === false} onClick={() => setWouldReturn(wouldReturn === false ? null : false)}>no</Chip>
            <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 13, color: 'var(--text-soft)', alignSelf: 'center', marginLeft: 4 }}>
              {wouldReturn === true ? 'definitely' : wouldReturn === false ? 'pass' : 'leave blank if unsure'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Mono size={9} dim>Notes — what stood out</Mono>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="vibe, service, what you'd order again…"
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
            Also save this note as a reflection in Ink
          </label>
        )}

        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button onClick={onClose} style={{ ...btnGhost, flex: 1 }}>Cancel</button>
          <button onClick={submit} style={{ ...btnPrimary, flex: 1.4 }}>Log visit</button>
        </div>
      </div>
    </>
  )
}
