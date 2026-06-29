import { useEdition } from '../lib/EditionContext'
import { Mono } from './primitives'

const EditionGlyph = ({ edition, size = 11 }) => {
  const stroke = 'currentColor'
  if (edition === 'morning') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.1" strokeLinecap="round">
        <path d="M2 11h10" />
        <path d="M3.5 8.5a3.5 3.5 0 0 1 7 0" />
        <path d="M7 3.5v1.2M3 4.6l.8.8M11 4.6l-.8.8" />
      </svg>
    )
  }
  if (edition === 'afternoon') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.1" strokeLinecap="round">
        <circle cx="7" cy="7" r="2.6" />
        <path d="M7 1.5v1.6M7 10.9v1.6M1.5 7h1.6M10.9 7h1.6M3.1 3.1l1.1 1.1M9.8 9.8l1.1 1.1M3.1 10.9l1.1-1.1M9.8 4.2l1.1-1.1" />
      </svg>
    )
  }
  if (edition === 'evening') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.1" strokeLinecap="round">
        <path d="M2 9h10" />
        <path d="M3.5 6.5a3.5 3.5 0 0 1 7 0" />
        <path d="M0.5 11.5h13" strokeDasharray="1.5 1.4" opacity="0.5" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 8.6A4.6 4.6 0 1 1 5.4 3 3.6 3.6 0 0 0 11 8.6Z" />
    </svg>
  )
}

export const Masthead = ({ kicker, title, right }) => {
  const ed = useEdition()
  return (
    <header style={{
      padding: 'calc(8px + env(safe-area-inset-top, 0px)) 20px 16px',
      borderBottom: '1px solid var(--hairline)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <Mono size={9.5} dim style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{kicker}</Mono>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span title={`Cue · ${ed.label} edition · ${ed.timeLabel}`} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: 'var(--text-soft)',
            padding: '3px 6px',
            border: '1px solid var(--hairline)', borderRadius: 999,
          }}>
            <EditionGlyph edition={ed.edition} size={11} />
          </span>
          {right}
        </div>
      </div>
      <h1 style={{
        margin: 0, fontFamily: 'var(--display)',
        fontSize: 38, lineHeight: 1, letterSpacing: '-0.025em',
        color: 'var(--text)', fontStyle: 'italic', fontWeight: 400,
      }}>{title}</h1>
    </header>
  )
}

export const BottomNav = ({ page, onChange, activeCount }) => {
  const items = [
    { id: 'recs', label: 'Recs', glyph: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.1 5.5L20 10l-5.9 1.5L12 17l-2.1-5.5L4 10l5.9-1.5z" /><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></svg> },
    { id: 'library', label: 'Library', glyph: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 5h6v14H4zM10 5h4v14h-4zM14 5l5 1.5-3 13.5-5-1.5" /></svg> },
    { id: 'active', label: 'Active', glyph: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8" /></svg> },
  ]
  return (
    <nav style={{
      position: 'fixed', left: 0, right: 0, bottom: 0,
      height: 'calc(78px + env(safe-area-inset-bottom, 0px))', zIndex: 40,
      background: 'color-mix(in oklab, var(--ink) 84%, transparent)',
      backdropFilter: 'blur(20px) saturate(140%)',
      WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      borderTop: '1px solid var(--hairline)',
      paddingBottom: 'calc(22px + env(safe-area-inset-bottom, 0px))',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-around', paddingTop: 10,
    }}>
      {items.map((it) => {
        const active = page === it.id
        return (
          <button key={it.id} onClick={() => onChange(it.id)} style={{
            appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            color: active ? 'var(--text)' : 'var(--muted)',
            padding: '4px 12px', position: 'relative',
          }}>
            <span style={{ position: 'relative' }}>
              {it.glyph}
              {it.id === 'active' && activeCount > 0 && (
                <span style={{
                  position: 'absolute', top: -3, right: -8,
                  fontFamily: 'var(--mono)', fontSize: 8.5,
                  background: 'var(--signal)', color: 'var(--ink)',
                  padding: '1px 4px 0', borderRadius: 6, fontWeight: 600,
                  minWidth: 12, textAlign: 'center',
                }}>{activeCount}</span>
              )}
            </span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: active ? 'var(--text)' : 'var(--muted)',
            }}>{it.label}</span>
            {active && (
              <span style={{
                position: 'absolute', bottom: -6, width: 18, height: 1.5,
                background: 'var(--signal)', borderRadius: 1,
              }} />
            )}
          </button>
        )
      })}
    </nav>
  )
}
