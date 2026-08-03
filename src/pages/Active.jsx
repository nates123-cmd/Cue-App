import { useMemo, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { Mono, ProgressCard } from '../components/primitives'
import { TypeIcon } from '../components/TypeIcon'
import { DragList } from '../components/DragList'
import { shortlistOf } from '../lib/items'
import { TYPE_META, TYPE_ORDER } from '../lib/meta'
import { LibraryRow } from './Library'

// Reorder a filtered view without disturbing the rows the filter is hiding.
//
// DragList only ever sees the visible rows, so handing its result straight to
// setShortlist would drop every hidden item off the list (rank -> NULL). Instead
// the visible items are written back into the slots they already occupied in the
// full order, leaving hidden items exactly where they were.
export function mergeFilteredOrder(fullIds, visibleIds) {
  const visible = new Set(visibleIds)
  const slots = []
  fullIds.forEach((id, idx) => { if (visible.has(id)) slots.push(idx) })
  const next = fullIds.slice()
  slots.forEach((slot, k) => { next[slot] = visibleIds[k] })
  return next
}

export const ActivePage = ({ items, onBump, onFinish, onOpenItem, onReorderShortlist, onDropFromShortlist }) => {
  const [typeFilter, setTypeFilter] = useState('all')
  const active = items.filter((i) => i.status === 'active')
  // The shortlist, not a blind slice of the queue. The 100+ item backlog stays
  // in Library; this is the small ordered surface you actually look at.
  const upNext = useMemo(() => shortlistOf(items), [items])

  // Only offer a chip for a type that is actually on the shortlist — a row of
  // dead filters on a six-item list is noise.
  const presentTypes = useMemo(() => {
    const s = new Set(upNext.map((i) => i.type))
    return TYPE_ORDER.filter((t) => s.has(t))
  }, [upNext])

  const shown = typeFilter === 'all' ? upNext : upNext.filter((i) => i.type === typeFilter)
  const filtering = typeFilter !== 'all'

  const reorder = (visibleIds) => {
    if (!onReorderShortlist) return
    const fullIds = upNext.map((i) => i.id)
    onReorderShortlist(filtering ? mergeFilteredOrder(fullIds, visibleIds) : visibleIds)
  }

  const chip = (key, label, icon) => (
    <button key={key} onClick={() => setTypeFilter(key)} style={{
      appearance: 'none', cursor: 'pointer', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', borderRadius: 999,
      background: typeFilter === key ? 'color-mix(in oklab, var(--signal) 15%, transparent)' : 'transparent',
      border: `1px solid ${typeFilter === key ? 'var(--signal)' : 'var(--hairline-strong)'}`,
      color: typeFilter === key ? 'var(--signal)' : 'var(--muted)',
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
      transition: 'all 140ms ease',
    }}>
      {icon}
      {label}
    </button>
  )

  return (
    <div>
      <Masthead
        kicker={`No. 003 · In progress · ${active.length}`}
        title="What we're in the middle of"
      />
      <div style={{ padding: '16px 20px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {active.length === 0 ? (
          <div style={{
            padding: '40px 24px', textAlign: 'center', border: '1px dashed var(--hairline-strong)',
            borderRadius: 4, color: 'var(--muted)',
          }}>
            <Mono size={10} dim>Nothing currently</Mono>
            <div style={{
              fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 22,
              marginTop: 10, color: 'var(--text-soft)',
            }}>Start something from the queue?</div>
          </div>
        ) : (
          active.map((i) => (
            <ProgressCard key={i.id} item={i} onBump={onBump} onFinish={onFinish} />
          ))
        )}

        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Mono size={9.5} dim>Up next</Mono>
            {shown.length > 1 && <Mono size={8.5} dim>drag to reorder</Mono>}
            <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            {upNext.length > 0 && (
              <Mono size={9} dim>{filtering ? `${shown.length} of ${upNext.length}` : upNext.length}</Mono>
            )}
          </div>

          {presentTypes.length > 1 && (
            <div style={{
              display: 'flex', gap: 6, overflowX: 'auto',
              marginLeft: -2, marginRight: -2, padding: 2, scrollbarWidth: 'none',
            }}>
              {chip('all', 'All', null)}
              {presentTypes.map((t) => chip(t, TYPE_META[t].plural, <TypeIcon type={t} size={11} weight={1.4} />))}
            </div>
          )}

          {upNext.length === 0 ? (
            <div style={{
              padding: '22px 18px', border: '1px dashed var(--hairline-strong)',
              borderRadius: 4, color: 'var(--muted)',
            }}>
              <Mono size={9.5} dim>Nothing shortlisted</Mono>
              <div style={{
                fontFamily: 'var(--body)', fontStyle: 'italic', fontSize: 14,
                marginTop: 8, color: 'var(--text-soft)', lineHeight: 1.5,
              }}>
                Open anything in the Library and tap <em>Up next</em>. The rest of
                the queue keeps waiting where it is.
              </div>
            </div>
          ) : (
            <DragList
              items={shown}
              onReorder={reorder}
              onRemove={(i) => onDropFromShortlist && onDropFromShortlist(i)}
              renderRow={(i) => <LibraryRow item={i} onClick={() => onOpenItem && onOpenItem(i)} />}
            />
          )}
        </div>
      </div>
    </div>
  )
}
