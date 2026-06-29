// Shared capture sub-components (used by CaptureSheet). The Capture *tab* was
// retired when Recs took its nav slot; these building blocks live on.
import { TypeIcon } from '../components/TypeIcon'
import {
  Cover, Mono, RottenScore, SharedMark, Spine, WatchOn,
  btnGhost, btnPrimary,
} from '../components/primitives'
import { EditableField } from '../components/EditableField'
import { TYPE_META } from '../lib/meta'

export const TypeChip = ({ type, active, onClick }) => (
  <button onClick={onClick} style={{
    appearance: 'none', cursor: 'pointer',
    flex: 1, minWidth: 0,
    padding: '12px 4px 10px',
    background: active ? 'var(--paper)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--signal)' : 'var(--hairline)'}`,
    borderRadius: 3,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    transition: 'all 160ms ease',
  }}>
    <TypeIcon type={type} size={18} weight={1.4} />
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: active ? 'var(--text)' : 'var(--muted)',
    }}>{TYPE_META[type].label}</span>
  </button>
)

const FieldReveal = ({ delay = 0, children, style = {} }) => (
  <div style={{
    opacity: 0, transform: 'translateY(8px)',
    animation: `field-in 480ms cubic-bezier(0.2, 0.7, 0.2, 1) ${delay}ms forwards`,
    ...style,
  }}>{children}</div>
)

export const Enriching = ({ title }) => (
  <div style={{
    background: 'var(--paper)', border: '1px solid var(--hairline)',
    borderRadius: 4, padding: '28px 20px',
    display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start',
  }}>
    <Mono size={9.5} style={{ color: 'var(--signal)' }}>
      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--signal)', marginRight: 8, animation: 'pulse-now 1s ease-in-out infinite' }} />
      Enriching
    </Mono>
    <div style={{
      fontFamily: 'var(--display)', fontSize: 24, lineHeight: 1.15,
      letterSpacing: '-0.01em', color: 'var(--text)', fontStyle: 'italic',
    }}>{title}</div>
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
      {[60, 90, 75, 40].map((w, i) => (
        <div key={i} style={{
          height: 8, width: `${w}%`, borderRadius: 1,
          background: 'linear-gradient(90deg, transparent 0%, var(--hairline-strong) 50%, transparent 100%)',
          backgroundSize: '200% 100%',
          animation: `shimmer 1.4s linear ${i * 0.12}s infinite`,
        }} />
      ))}
    </div>
  </div>
)

export const DraftCard = ({ draft, onChange, onConfirm, onAnother }) => {
  const ext = draft.extension || {}
  const patch = (k, v) => onChange && onChange({ ...draft, [k]: v })
  const patchEnrichment = (v) => onChange && onChange({
    ...draft, enrichment: { ...(draft.enrichment || {}), synopsis: v },
  })
  const meta = []
  if (draft.type === 'book') meta.push(ext.author, ext.published_year, ext.page_count && `${ext.page_count} pp`)
  if (draft.type === 'tv') meta.push(ext.network_or_service, ext.seasons && `${ext.seasons} season${ext.seasons > 1 ? 's' : ''}`, ext.runtime_per_ep && `~${ext.runtime_per_ep} min`)
  if (draft.type === 'movie') meta.push(ext.director, ext.release_year, ext.runtime_min && `${ext.runtime_min} min`)
  if (draft.type === 'article') meta.push(ext.source, ext.author, ext.est_read_min && `${ext.est_read_min} min read`, ext.word_count && `${ext.word_count.toLocaleString()} words`)
  if (draft.type === 'video') meta.push(ext.channel, ext.duration_min && `${ext.duration_min} min`)
  if (draft.type === 'podcast') meta.push(ext.host, ext.publisher, ext.cadence)
  if (draft.type === 'music') meta.push(ext.artist, ext.published_year, ext.label, ext.track_count && `${ext.track_count} tracks`)
  const metaLine = meta.filter(Boolean).join(' · ')

  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--hairline)',
      borderRadius: 4, overflow: 'hidden',
      boxShadow: '0 1px 0 rgba(0,0,0,0.4), 0 24px 50px -24px rgba(0,0,0,0.7)',
    }}>
      <div style={{ aspectRatio: '5 / 3', containerType: 'inline-size', position: 'relative' }}>
        <FieldReveal delay={0} style={{ position: 'absolute', inset: 0 }}>
          <Cover item={draft} />
        </FieldReveal>
      </div>
      <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FieldReveal delay={120}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Spine type={draft.type} year={ext.release_year || ext.published_year} />
            {(draft.with || []).length > 0 && (
              <>
                <span style={{ width: 1, height: 9, background: 'var(--hairline-strong)' }} />
                <SharedMark item={draft} />
              </>
            )}
            <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            <Mono size={9} dim>{draft._fallback ? 'Manual draft' : 'Enriched · just now'}</Mono>
          </div>
        </FieldReveal>
        <FieldReveal delay={240}>
          <EditableField
            value={draft.title}
            onSave={(v) => patch('title', v)}
            placeholder="title"
            displayStyle={{
              fontFamily: 'var(--display)', fontSize: 28, lineHeight: 1.1, letterSpacing: '-0.015em',
              color: 'var(--text)', textWrap: 'balance', fontWeight: 400,
            }}
          />
        </FieldReveal>
        {metaLine && (
          <FieldReveal delay={360}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: '0.02em' }}>
              {metaLine}
            </div>
          </FieldReveal>
        )}
        <FieldReveal delay={500}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ext.genre && (
              <span style={{
                alignSelf: 'flex-start',
                padding: '2px 8px', borderRadius: 2,
                background: 'color-mix(in oklab, var(--signal) 14%, transparent)',
                color: 'var(--signal)',
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.18em',
                textTransform: 'uppercase',
                border: '1px solid color-mix(in oklab, var(--signal) 30%, transparent)',
              }}>{ext.genre}</span>
            )}
            <EditableField
              value={draft.enrichment?.synopsis || ''}
              onSave={patchEnrichment}
              placeholder="add a synopsis…"
              multiline
              displayStyle={{
                fontFamily: 'var(--body)', fontSize: 14.5, lineHeight: 1.55,
                color: 'var(--text-soft)', textWrap: 'pretty',
              }}
            />
          </div>
        </FieldReveal>
        {(draft.type === 'movie' || draft.type === 'tv') && ext.rt_critics != null && (
          <FieldReveal delay={580}>
            <RottenScore critics={ext.rt_critics} audience={ext.rt_audience} />
          </FieldReveal>
        )}
        {(draft.type === 'movie' || draft.type === 'tv') && ext.streaming_on && (
          <FieldReveal delay={620}>
            <WatchOn services={ext.streaming_on} />
          </FieldReveal>
        )}
        {draft.links?.length > 0 && (
          <FieldReveal delay={640}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {draft.links.map((l, i) => (
                <span key={i} style={{
                  padding: '5px 9px',
                  border: '1px solid var(--hairline-strong)',
                  borderRadius: 2,
                  fontFamily: 'var(--mono)', fontSize: 9.5,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-soft)',
                }}>↗ {l.label}</span>
              ))}
            </div>
          </FieldReveal>
        )}
        <FieldReveal delay={780}>
          <div style={{ display: 'flex', gap: 8, paddingTop: 4, borderTop: '1px solid var(--hairline)', marginTop: 4 }}>
            <button onClick={onAnother} style={{ ...btnGhost, flex: 1, marginTop: 12 }}>Capture another</button>
            <button onClick={onConfirm} style={{ ...btnPrimary, flex: 1.4, marginTop: 12 }}>Confirm · Queue</button>
          </div>
        </FieldReveal>
      </div>
    </div>
  )
}

// Shown above the draft when a title has 2+ distinct matches. Tap a row to
// re-enrich locked to that exact item — fixes "searched Playground, got the
// wrong one."
export const MatchPicker = ({ candidates, pickedKey, busy, onPick, onDismiss }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Mono size={9} style={{ color: 'var(--signal)' }}>More than one match</Mono>
      <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
      <button onClick={onDismiss} disabled={busy} title="Back to search" style={{
        appearance: 'none', cursor: busy ? 'wait' : 'pointer', background: 'transparent',
        border: 0, padding: '2px 4px', color: 'var(--muted)',
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>← edit search</button>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {candidates.map((c) => {
        const active = c.key === pickedKey
        const yr = c.year && !String(c.subtitle).includes(String(c.year)) ? c.year : null
        const meta = [c.subtitle, yr].filter(Boolean).join(' · ')
        return (
          <button key={c.key} disabled={busy} onClick={() => onPick(c)} style={{
            appearance: 'none', cursor: busy ? 'wait' : 'pointer', textAlign: 'left', width: '100%',
            display: 'grid', gridTemplateColumns: '34px 1fr auto', alignItems: 'center', gap: 12,
            padding: '8px 10px',
            background: active ? 'color-mix(in oklab, var(--signal) 12%, var(--paper))' : 'var(--paper)',
            border: `1px solid ${active ? 'var(--signal)' : 'var(--hairline)'}`,
            borderRadius: 3, color: 'var(--text)', transition: 'all 160ms ease',
            opacity: busy && !active ? 0.5 : 1,
          }}>
            <div style={{
              width: 34, height: 48, borderRadius: 2, overflow: 'hidden', background: 'var(--hairline)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)',
            }}>
              {c.image_url
                ? <img src={c.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <TypeIcon type={c.type} size={14} weight={1.4} />}
            </div>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 15, lineHeight: 1.15, color: 'var(--text)',
                display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{c.title}</div>
              {meta && (
                <div style={{
                  fontFamily: 'var(--body)', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic',
                  display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>{meta}</div>
              )}
            </div>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: active ? 'var(--signal)' : 'var(--muted)',
            }}>{active ? 'shown' : 'use'}</span>
          </button>
        )
      })}
    </div>
  </div>
)

