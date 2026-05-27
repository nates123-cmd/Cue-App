import { Masthead } from '../components/Masthead'
import { Mono, ProgressCard } from '../components/primitives'
import { LibraryRow } from './Library'

export const ActivePage = ({ items, onBump, onFinish, onOpenItem }) => {
  const active = items.filter((i) => i.status === 'active')
  const upNext = items.filter((i) => i.status === 'queued').slice(0, 3)
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
            <Mono size={9.5} dim>Up next from the queue</Mono>
            <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {upNext.map((i) => <LibraryRow key={i.id} item={i} onClick={() => onOpenItem && onOpenItem(i)} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
