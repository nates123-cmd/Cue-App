import { useEffect, useRef, useState } from 'react'

// Click-to-edit text — display mode shows the value, click swaps to input.
// Saves on blur or Enter (Enter on single-line, Cmd/Ctrl+Enter on multiline);
// Escape cancels.
export const EditableField = ({
  value, onSave, placeholder,
  multiline = false,
  displayStyle = {}, editStyle = {},
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const ref = useRef(null)

  useEffect(() => { if (!editing) setDraft(value || '') }, [value, editing])
  useEffect(() => { if (editing && ref.current) ref.current.focus() }, [editing])

  const commit = () => {
    const v = draft.trim()
    if (v !== (value || '').trim()) onSave(v)
    setEditing(false)
  }
  const cancel = () => { setDraft(value || ''); setEditing(false) }

  if (editing) {
    const Tag = multiline ? 'textarea' : 'input'
    return (
      <Tag
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel()
          if (e.key === 'Enter' && !multiline) { e.preventDefault(); commit() }
          if (e.key === 'Enter' && multiline && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
        }}
        placeholder={placeholder}
        rows={multiline ? 3 : undefined}
        style={{
          width: '100%', appearance: 'none', outline: 0,
          resize: multiline ? 'vertical' : 'none',
          padding: '4px 6px', borderRadius: 3,
          background: 'var(--paper-soft)',
          border: '1px solid var(--signal)',
          color: 'var(--text)',
          ...editStyle,
        }}
      />
    )
  }
  return (
    <div
      onClick={() => setEditing(true)}
      style={{
        cursor: 'text',
        padding: '4px 6px', margin: '-4px -6px',
        borderRadius: 3,
        borderBottom: '1px dashed transparent',
        transition: 'border-color 180ms ease, background 180ms ease',
        whiteSpace: multiline ? 'pre-wrap' : undefined,
        ...displayStyle,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderBottomColor = 'var(--hairline-strong)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent' }}
    >
      {value || <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{placeholder}</span>}
    </div>
  )
}
