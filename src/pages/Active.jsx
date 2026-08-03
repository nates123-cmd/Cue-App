import { Masthead } from '../components/Masthead'
import { Mono, ProgressCard } from '../components/primitives'
import { DragList } from '../components/DragList'
import { shortlistOf } from '../lib/items'
import { LibraryRow } from './Library'

export const ActivePage = ({ items, onBump, onFinish, onOpenItem, onReorderShortlist, onDropFromShortlist }) => {
  const active = items.filter((i) => i.status === 'active')
  // The shortlist, not a blind slice of the queue. The 100+ item backlog stays
  // in Library; this is the small ordered surface you actually look at.
  const upNext = shortlistOf(items)
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
            {upNext.length > 1 && <Mono size={8.5} dim>drag to reorder</Mono>}
            <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            {upNext.length > 0 && <Mono size={9} dim>{upNext.length}</Mono>}
          </div>
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
              items={upNext}
              onReorder={(ids) => onReorderShortlist && onReorderShortlist(ids)}
              onRemove={(i) => onDropFromShortlist && onDropFromShortlist(i)}
              renderRow={(i) => <LibraryRow item={i} onClick={() => onOpenItem && onOpenItem(i)} />}
            />
          )}
        </div>
      </div>
    </div>
  )
}
