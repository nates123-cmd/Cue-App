import { useMemo, useRef, useState } from 'react'
import { Mono } from './primitives'
import { TypeIcon } from './TypeIcon'
import { btnGhost, btnPrimary } from './primitives'
import { TYPE_META, TYPE_ORDER } from '../lib/meta'
import { enrich } from '../lib/enrichment'

const KNOWN_TYPES = new Set(TYPE_ORDER)

// Parse pasted text into draft rows. One item per line. Blank lines and lines
// starting with `#` are skipped (comments / section headers). Fields are
// pipe- or tab-delimited:  title | type | recommended_by
//   - type: optional; if omitted or unrecognized, falls back to defaultType
//   - recommended_by: optional; defaults to 'me'
function parseLines(text, defaultType) {
  const out = []
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s*[|\t]\s*/)
    const title = (parts[0] || '').trim()
    if (!title) continue
    const typeRaw = (parts[1] || '').trim().toLowerCase()
    const type = KNOWN_TYPES.has(typeRaw) ? typeRaw : defaultType
    const recommended_by = (parts[2] || '').trim() || 'me'
    out.push({ raw: line, title, type, recommended_by, status: 'pending', error: null })
  }
  return out
}

// Run `worker` over items with a fixed concurrency cap. Resolves when all done.
async function runPool(items, concurrency, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

const STATUS_COLOR = {
  pending: 'var(--muted)',
  working: 'var(--signal)',
  done: 'var(--text-soft)',
  error: '#c4604f',
}

const RowLine = ({ row }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '16px 1fr auto', alignItems: 'center', gap: 10,
    padding: '7px 2px', borderBottom: '1px solid var(--hairline)',
  }}>
    <div style={{ color: STATUS_COLOR[row.status] }}>
      <TypeIcon type={row.type} size={13} weight={1.4} />
    </div>
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontFamily: 'var(--body)', fontSize: 13.5, lineHeight: 1.2, color: 'var(--text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{row.title}</div>
      {row.status === 'error' && row.error && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: STATUS_COLOR.error, marginTop: 2 }}>
          {row.error}
        </div>
      )}
    </div>
    <Mono size={8.5} style={{ color: STATUS_COLOR[row.status], letterSpacing: '0.12em' }}>
      {row.status === 'working' ? (
        <>
          <span style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
            background: 'var(--signal)', marginRight: 6, animation: 'pulse-now 1s ease-in-out infinite',
          }} />
          enriching
        </>
      ) : row.status === 'done' ? '✓ queued'
        : row.status === 'error' ? 'failed'
        : TYPE_META[row.type].label.toLowerCase()}
    </Mono>
  </div>
)

export const BulkImport = ({ onAdd, defaultType = 'book', partner = 'Amanda', onDone }) => {
  const [text, setText] = useState('')
  const [type, setType] = useState(defaultType)
  const [withPartner, setWithPartner] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | running | finished
  const [rows, setRows] = useState([])
  const cancelRef = useRef(false)

  const preview = useMemo(() => parseLines(text, type), [text, type])
  const counts = useMemo(() => {
    const done = rows.filter((r) => r.status === 'done').length
    const errored = rows.filter((r) => r.status === 'error').length
    return { done, errored, total: rows.length }
  }, [rows])

  const patchRow = (i, patch) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const start = async () => {
    const parsed = parseLines(text, type)
    if (parsed.length === 0) return
    cancelRef.current = false
    setRows(parsed)
    setPhase('running')

    await runPool(parsed, 3, async (row, i) => {
      if (cancelRef.current) return
      patchRow(i, { status: 'working' })
      try {
        const enriched = await enrich(row.title, row.type)
        enriched.recommended_by = row.recommended_by
        enriched.with = withPartner ? [partner] : []
        enriched.status = 'queued'
        await onAdd(enriched)
        if (!cancelRef.current) patchRow(i, { status: 'done' })
      } catch (e) {
        if (!cancelRef.current) patchRow(i, { status: 'error', error: (e?.message || 'error').slice(0, 80) })
      }
    })

    if (!cancelRef.current) setPhase('finished')
  }

  const reset = () => {
    cancelRef.current = true
    setText(''); setRows([]); setPhase('idle')
  }

  const running = phase === 'running'

  return (
    <div style={{
      border: '1px solid var(--hairline-strong)', background: 'var(--paper)',
      borderRadius: 3, padding: '14px 14px 12px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Mono size={9} dim>Bulk import</Mono>
        <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        {phase !== 'idle' && (
          <Mono size={9} dim>
            {counts.done}/{counts.total} queued{counts.errored ? ` · ${counts.errored} failed` : ''}
          </Mono>
        )}
      </div>

      {phase === 'idle' && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'One per line. Optional fields:  title | type | recommended by\n\nThe Overstory\nSeverance | tv | Amanda\nPast Lives | movie\n# lines starting with # are skipped'}
            rows={8}
            style={{
              appearance: 'none', outline: 0, resize: 'vertical',
              border: '1px solid var(--hairline)', borderRadius: 3,
              background: 'var(--bg)', color: 'var(--text)',
              fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.6,
              padding: '10px 12px', width: '100%',
            }}
          />
          <div>
            <Mono size={9} dim style={{ display: 'block', marginBottom: 6 }}>
              Default type (for lines with no type)
            </Mono>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
              {TYPE_ORDER.map((t) => (
                <button key={t} onClick={() => setType(t)} style={{
                  appearance: 'none', cursor: 'pointer',
                  padding: '8px 4px', borderRadius: 3,
                  background: type === t ? 'var(--bg)' : 'transparent',
                  border: `1px solid ${type === t ? 'var(--signal)' : 'var(--hairline)'}`,
                  color: type === t ? 'var(--text)' : 'var(--muted)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                  transition: 'all 160ms ease',
                }}>
                  <TypeIcon type={t} size={15} weight={1.4} />
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '0.12em', textTransform: 'uppercase',
                  }}>{TYPE_META[t].label}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setWithPartner((v) => !v)}
              title={`Add the whole batch to the shared list with ${partner}`}
              style={{
                appearance: 'none', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 9px 4px 7px', borderRadius: 999,
                background: withPartner ? 'color-mix(in oklab, var(--signal) 16%, transparent)' : 'transparent',
                border: `1px solid ${withPartner ? 'var(--signal)' : 'var(--hairline-strong)'}`,
                color: withPartner ? 'var(--signal)' : 'var(--muted)',
                transition: 'all 160ms ease',
              }}>
              <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 14, lineHeight: 0.7, transform: 'translateY(1px)' }}>&amp;</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'inherit' }}>{partner}</span>
            </button>
            <span style={{ flex: 1 }} />
            <Mono size={9} dim>{preview.length} item{preview.length === 1 ? '' : 's'}</Mono>
            <button onClick={start} style={{
              ...btnPrimary,
              opacity: preview.length ? 1 : 0.3,
              pointerEvents: preview.length ? 'auto' : 'none',
            }}>Enrich &amp; queue {preview.length || ''}</button>
          </div>
        </>
      )}

      {phase !== 'idle' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((r, i) => <RowLine key={`${r.title}-${i}`} row={r} />)}
          </div>
          <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
            {running ? (
              <button onClick={() => { cancelRef.current = true; setPhase('finished') }} style={{ ...btnGhost, flex: 1 }}>
                Stop
              </button>
            ) : (
              <>
                <button onClick={() => { onDone && onDone(); reset() }} style={{ ...btnGhost, flex: 1 }}>Done</button>
                <button onClick={reset} style={{ ...btnPrimary, flex: 1 }}>Import more</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
