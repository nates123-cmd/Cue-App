import { useEffect, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { TypeIcon } from '../components/TypeIcon'
import {
  Cover, Mono, RottenScore, SharedMark, Spine, WatchOn,
  btnGhost, btnPrimary,
} from '../components/primitives'
import { SwipeRow } from '../components/SwipeRow'
import { RecommenderPicker } from '../components/RecommenderPicker'
import { EditableField } from '../components/EditableField'
import { TYPE_META, TYPE_ORDER } from '../lib/meta'
import { useEdition } from '../lib/EditionContext'
import { enrich } from '../lib/enrichment'
import { claudeComplete, extractJSON } from '../lib/claude'

const TypeChip = ({ type, active, onClick }) => (
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

const Enriching = ({ title }) => (
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

const DraftCard = ({ draft, onChange, onConfirm, onAnother }) => {
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
  if (ext.genre) meta.push(ext.genre)
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

const SmartSuggestions = ({ suggestions, edition, onPick, onRefresh, onDismiss }) => {
  const loading = suggestions === null
  const empty = !loading && suggestions.length === 0
  const placeholders = [0, 1, 2, 3]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Mono size={9} dim>Suggested for {edition}</Mono>
        <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        <Mono size={9} dim>swipe</Mono>
        <button onClick={onRefresh} disabled={loading} title="Refresh suggestions" style={{
          appearance: 'none', cursor: loading ? 'wait' : 'pointer',
          background: 'transparent', border: 0, padding: '2px 4px',
          color: 'var(--muted)', opacity: loading ? 0.4 : 1,
        }}>
          <span style={{
            display: 'inline-block', transition: 'transform 320ms ease',
            transform: loading ? 'rotate(180deg)' : 'rotate(0deg)', fontSize: 11,
          }}>↻</span>
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {empty && (
          <div style={{
            padding: '14px 16px', border: '1px dashed var(--hairline-strong)', borderRadius: 3,
            color: 'var(--muted)',
          }}>
            <Mono size={9} dim>All cleared.</Mono>
            <div style={{
              fontFamily: 'var(--body)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-soft)',
              marginTop: 4,
            }}>You&rsquo;ve dismissed every pick this round. Tap ↻ for a fresh set.</div>
          </div>
        )}
        {(loading ? placeholders : suggestions).map((s, i) => {
          const inner = (
            <button
              key={loading ? i : `${s.title}-${i}`}
              disabled={loading}
              onClick={loading ? undefined : () => onPick(s)}
              style={{
                appearance: 'none', cursor: loading ? 'default' : 'pointer',
                textAlign: 'left', width: '100%',
                display: 'grid', gridTemplateColumns: '20px 1fr auto', alignItems: 'center', gap: 12,
                padding: '10px 12px',
                background: 'var(--paper)',
                border: '1px solid var(--hairline)',
                borderRadius: 3, color: 'var(--text)',
                transition: 'all 160ms ease',
              }}>
              {loading ? (
                <span style={{
                  width: 14, height: 14, borderRadius: 2,
                  background: 'linear-gradient(90deg, transparent 0%, var(--hairline-strong) 50%, transparent 100%)',
                  backgroundSize: '200% 100%',
                  animation: `shimmer 1.4s linear ${i * 0.12}s infinite`,
                }} />
              ) : (
                <div style={{ color: 'var(--text-soft)' }}>
                  <TypeIcon type={s.type} size={14} weight={1.4} />
                </div>
              )}
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {loading ? (
                  <>
                    <div style={{
                      height: 11, width: `${55 + (i * 7) % 30}%`, borderRadius: 1,
                      background: 'linear-gradient(90deg, transparent 0%, var(--hairline-strong) 50%, transparent 100%)',
                      backgroundSize: '200% 100%',
                      animation: `shimmer 1.4s linear ${i * 0.12}s infinite`,
                    }} />
                    <div style={{
                      height: 8, width: `${40 + (i * 11) % 35}%`, borderRadius: 1,
                      background: 'linear-gradient(90deg, transparent 0%, var(--hairline) 50%, transparent 100%)',
                      backgroundSize: '200% 100%',
                      animation: `shimmer 1.4s linear ${i * 0.12 + 0.05}s infinite`,
                    }} />
                  </>
                ) : (
                  <>
                    <div style={{
                      fontFamily: 'var(--display)', fontSize: 15, lineHeight: 1.15,
                      color: 'var(--text)',
                      display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>{s.title}</div>
                    <div style={{
                      fontFamily: 'var(--body)', fontSize: 11, lineHeight: 1.3,
                      color: 'var(--muted)', fontStyle: 'italic',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>{s.reason}</div>
                  </>
                )}
              </div>
              <span style={{
                opacity: loading ? 0 : 0.4, fontSize: 16, lineHeight: 1, color: 'var(--text)',
                transition: 'opacity 160ms', fontWeight: 300,
              }}>+</span>
            </button>
          )
          if (loading) return inner
          return (
            <SwipeRow key={`${s.title}-${i}`}
              onSwipeLeft={() => onDismiss && onDismiss(s)}
              onSwipeRight={() => onDismiss && onDismiss(s)}>
              {inner}
            </SwipeRow>
          )
        })}
      </div>
    </div>
  )
}

const FALLBACK_SUGGESTIONS = [
  { title: 'Severance',  type: 'tv',      reason: 'season two, Apple’s slow-burn return' },
  { title: 'Past Lives', type: 'movie',   reason: 'tender, 105 min, made for a quiet night' },
  { title: 'Piranesi',   type: 'book',    reason: 'short, strange, a comfort read' },
  { title: 'Rick Rubin on noticing', type: 'video', reason: 'an hour-long conversation worth the run' },
]

export const CapturePage = ({ onAdd, onOpenCueBar, recommenders = [], items = [] }) => {
  const ed = useEdition()
  const partner = ed.partner || 'Amanda'
  const [title, setTitle] = useState('')
  const [type, setType] = useState('book')
  const [recommendedBy, setRecommendedBy] = useState('me')
  const [withPartner, setWithPartner] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [draft, setDraft] = useState(null)

  const [suggestions, setSuggestions] = useState(null)
  const [suggestNonce, setSuggestNonce] = useState(0)
  const [dismissed, setDismissed] = useState(() => new Set())

  useEffect(() => {
    let cancelled = false
    const fetchSuggestions = async () => {
      setSuggestions(null)
      try {
        const byType = {}
        items.forEach((i) => {
          byType[i.type] = byType[i.type] || []
          byType[i.type].push(i.title)
        })
        const libraryDump = Object.entries(byType).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')
        const recs = Array.from(new Set(items.map((i) => i.recommended_by).filter((r) => r && r !== 'me'))).join(', ') || 'none yet'

        const prompt = `You are a taste-curator for Cue, a personal recommendation app.
User is on the Capture screen looking for ideas of what to add.

Context:
- Current edition: ${ed.label} (${ed.timeLabel})
- Their partner (co-viewing): ${partner}
- Their library so far:
${libraryDump || '(empty)'}
- Their recurring recommenders: ${recs}
${dismissed.size ? `- They have already dismissed: ${[...dismissed].join(', ')}` : ''}

Return 4 specific real titles they might want to capture next, mixed across
[book, tv, movie, article, video]. Avoid duplicates of their library and dismissed.
Lean into the time of day: ${ed.label === 'morning' ? 'reading, contemplative' : ed.label === 'afternoon' ? 'mixed, productive' : ed.label === 'evening' ? 'date-night cinema, prestige tv' : 'shorter, quieter'}.

Return ONLY a JSON array (no prose, no markdown), exactly 4 objects:
[{"title":"...","type":"book|tv|movie|article|video","reason":"under 60 chars, lowercase, no period"}]`

        const raw = await claudeComplete(prompt, { max_tokens: 600 })
        if (cancelled) return
        const parsed = extractJSON(raw)
        const libTitlesL = new Set(items.map((i) => i.title.toLowerCase().trim()))
        const cleaned = Array.isArray(parsed) ? parsed.filter((s) =>
          s && typeof s.title === 'string' && s.title.length > 0
          && ['book','tv','movie','article','video'].includes(s.type)
          && !libTitlesL.has(s.title.toLowerCase().trim())
          && !dismissed.has(s.title)
        ).slice(0, 4) : null
        setSuggestions(cleaned && cleaned.length ? cleaned : FALLBACK_SUGGESTIONS)
      } catch {
        if (!cancelled) setSuggestions(FALLBACK_SUGGESTIONS)
      }
    }
    fetchSuggestions()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.label, partner, suggestNonce])

  const submit = async () => {
    if (!title.trim()) return
    setPhase('enriching')
    setDraft(null)
    const enriched = await enrich(title.trim(), type)
    enriched.recommended_by = recommendedBy
    enriched.with = withPartner ? [partner] : []
    enriched.status = 'queued'
    setDraft(enriched)
    setPhase('draft')
  }

  const reset = () => {
    setTitle(''); setDraft(null); setPhase('idle'); setWithPartner(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Masthead
        kicker="No. 001 · Capture"
        title="What did you just hear about?"
        right={
          <button onClick={onOpenCueBar} style={{ ...btnGhost, padding: '4px 9px', fontSize: 9 }}>Cue Bar ✦</button>
        }
      />
      <div style={{ padding: '18px 20px 110px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{
          border: '1px solid var(--hairline-strong)',
          background: 'var(--paper)',
          borderRadius: 3, padding: '14px 14px 12px',
          display: 'flex', flexDirection: 'column', gap: 10,
          opacity: phase !== 'idle' ? 0.55 : 1,
          pointerEvents: phase !== 'idle' ? 'none' : 'auto',
          transition: 'opacity 200ms',
        }}>
          <Mono size={9} dim>Title or URL</Mono>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Severance · Past Lives · The Overstory…"
            style={{
              appearance: 'none', border: 0, outline: 0, background: 'transparent',
              fontFamily: 'var(--display)', fontStyle: 'italic',
              fontSize: 22, lineHeight: 1.2, color: 'var(--text)',
              padding: 0, width: '100%',
            }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginTop: 6 }}>
            {TYPE_ORDER.map((t) => (
              <TypeChip key={t} type={t} active={type === t} onClick={() => setType(t)} />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
            <Mono size={9} dim>Recommended by</Mono>
            <RecommenderPicker value={recommendedBy} onChange={setRecommendedBy} recommenders={recommenders} />
            <span style={{ width: 1, height: 10, background: 'var(--hairline-strong)' }} />
            <button
              type="button"
              onClick={() => setWithPartner((v) => !v)}
              title={withPartner ? `Added to shared list with ${partner}` : `Add to shared list with ${partner}`}
              style={{
                appearance: 'none', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 9px 4px 7px', borderRadius: 999,
                background: withPartner ? 'color-mix(in oklab, var(--signal) 16%, transparent)' : 'transparent',
                border: `1px solid ${withPartner ? 'var(--signal)' : 'var(--hairline-strong)'}`,
                color: withPartner ? 'var(--signal)' : 'var(--muted)',
                transition: 'all 160ms ease',
              }}>
              <span style={{
                fontFamily: 'var(--display)', fontStyle: 'italic',
                fontSize: 14, lineHeight: 0.7, transform: 'translateY(1px)',
              }}>&amp;</span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'inherit',
              }}>{partner}</span>
            </button>
            <span style={{ flex: 1 }} />
            <button onClick={submit} style={{
              ...btnPrimary,
              opacity: title.trim() ? 1 : 0.3,
              pointerEvents: title.trim() ? 'auto' : 'none',
            }}>Enrich ↵</button>
          </div>
        </div>

        {phase === 'enriching' && <Enriching title={title} />}
        {phase === 'draft' && draft && (
          <DraftCard
            draft={draft}
            onChange={setDraft}
            onConfirm={() => { onAdd(draft); reset() }}
            onAnother={reset}
          />
        )}

        {phase === 'idle' && (
          <SmartSuggestions
            suggestions={suggestions ? suggestions.filter((s) => !dismissed.has(s.title)) : suggestions}
            edition={ed.label}
            onPick={(s) => { setTitle(s.title); setType(s.type) }}
            onRefresh={() => setSuggestNonce((n) => n + 1)}
            onDismiss={(s) => setDismissed((prev) => new Set(prev).add(s.title))}
          />
        )}
      </div>
    </div>
  )
}
