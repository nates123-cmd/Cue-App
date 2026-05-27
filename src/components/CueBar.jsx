import { useEffect, useState } from 'react'
import { Cover, Mono, SharedMark, btnGhost, btnPrimary } from './primitives'
import { TypeIcon } from './TypeIcon'
import { SwipeRow } from './SwipeRow'
import { metaFor, TYPE_META } from '../lib/meta'
import { claudeComplete, extractJSON } from '../lib/claude'

const QueueRow = ({ item, rank, onOpen }) => (
  <div onClick={() => onOpen(item)} style={{
    display: 'grid', gridTemplateColumns: '20px 60px 1fr', gap: 12, alignItems: 'stretch',
    padding: '12px 4px 12px 0', borderTop: '1px solid var(--hairline)', cursor: 'pointer',
  }}>
    <div style={{
      fontFamily: 'var(--display)', fontSize: 26, lineHeight: 1,
      color: 'var(--signal)', fontStyle: 'italic',
    }}>{rank}</div>
    <div style={{ aspectRatio: '3 / 4', borderRadius: 2, overflow: 'hidden', containerType: 'inline-size', border: '1px solid var(--hairline)' }}>
      <Cover item={item} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <TypeIcon type={item.type} size={11} weight={1.4} />
        <Mono size={9} dim>{metaFor(item.type).spine}</Mono>
        <span style={{ width: 1, height: 7, background: 'var(--hairline-strong)' }} />
        <Mono size={9} dim>{item.recommended_by}</Mono>
        {(item.with || []).length > 0 && (
          <>
            <span style={{ width: 1, height: 7, background: 'var(--hairline-strong)' }} />
            <SharedMark item={item} size={8.5} />
          </>
        )}
      </div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 17, lineHeight: 1.15, color: 'var(--text)' }}>{item.title}</div>
      <div style={{ fontFamily: 'var(--body)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-soft)', textWrap: 'pretty' }}>
        {item._why}
      </div>
    </div>
  </div>
)

const ExpandRow = ({ idea, onAdd }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '20px 1fr auto', gap: 12, alignItems: 'center',
    padding: '12px 4px', borderTop: '1px solid var(--hairline)',
  }}>
    <div style={{ color: 'var(--text-soft)' }}>
      <TypeIcon type={idea.type} size={14} weight={1.4} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{
        fontFamily: 'var(--display)', fontSize: 16, lineHeight: 1.15,
        color: 'var(--text)',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      }}>{idea.title}</div>
      <div style={{
        fontFamily: 'var(--body)', fontSize: 12, lineHeight: 1.35,
        color: 'var(--muted)', fontStyle: 'italic',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{idea.reason}</div>
    </div>
    <button onClick={(e) => { e.stopPropagation(); onAdd && onAdd(idea) }} style={{
      ...btnGhost, padding: '5px 9px', fontSize: 9,
    }}>+ Add</button>
  </div>
)

export const CueBar = ({
  open, onClose, items, partner, edition,
  onOpenItem, onAdd, onMarkSeen, onDelete,
}) => {
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState('idle')
  const [answer, setAnswer] = useState(null)
  const [expand, setExpand] = useState(null)
  const [dismissed, setDismissed] = useState(new Set())
  const [hiddenIdeas, setHiddenIdeas] = useState(new Set())

  useEffect(() => {
    if (!open) {
      setPhase('idle'); setAnswer(null); setExpand(null)
      setQuery(''); setDismissed(new Set()); setHiddenIdeas(new Set())
    }
  }, [open])

  // Pre-filter the queue against the query (client-side, keeps prompt small).
  function decide(q) {
    const ql = q.toLowerCase()
    let pool = items.filter((i) => i.status !== 'done')
    if (/short|under|quick|train/.test(ql)) pool = pool.filter((i) => {
      const e = i.extension || {}
      return (e.runtime_min && e.runtime_min < 120) || (e.runtime_per_ep && e.runtime_per_ep < 50)
        || (e.est_read_min && e.est_read_min < 20) || (e.duration_min && e.duration_min < 45)
    })
    if (/movie|film|watch.*tonight/.test(ql)) pool = pool.filter((i) => i.type === 'movie' || i.type === 'tv')
    if (/read|book|article/.test(ql)) pool = pool.filter((i) => i.type === 'book' || i.type === 'article')
    if (/together|amanda|us|date/.test(ql)) {
      const withPool = pool.filter((i) => (i.with || []).includes(partner || 'Amanda'))
      if (withPool.length >= 2) pool = withPool
    }
    if (pool.length < 3) pool = items.filter((i) => i.status !== 'done')
    return pool.slice(0, 3).map((i, n) => ({ ...i, _rank: n + 1, _why: '' }))
  }

  // Ask Claude for the rationale on the shortlist + ideas outside the library.
  async function expandTerritory(q, shortlist) {
    setExpand(null)
    try {
      const libraryTitles = items.map((i) => i.title).join(', ') || '(empty)'
      const shortlistJson = JSON.stringify(shortlist.map((i) => ({
        id: i.id, title: i.title, type: i.type,
      })))
      const prompt = `You are a taste-curator for a personal recommendation app called Cue.

User in the Cue Bar asked: "${q}"
Their library: ${libraryTitles}
Their partner (co-viewing): ${partner || 'Amanda'}
Current edition: ${edition || 'evening'}

Two parts:
PART A: For each item in their pre-filtered shortlist, write a one-line rationale
(under 60 chars, casual, lowercase, no period) explaining why it fits.
SHORTLIST: ${shortlistJson}

PART B: Suggest 3 SPECIFIC real titles NOT in their library that satisfy the
query. Mix types across [book, tv, movie, article, video].

Return ONLY JSON (no prose, no markdown):
{
  "rationales": [{ "id": "<id>", "why": "..." }, ...],
  "ideas": [{ "title": "...", "type": "book|tv|movie|article|video", "reason": "..." }, ...]
}`
      const raw = await claudeComplete(prompt, { max_tokens: 800 })
      const parsed = extractJSON(raw) || {}
      const ratMap = new Map((parsed.rationales || []).map((r) => [r.id, r.why]))
      setAnswer((cur) => (cur ? cur.map((i) => ({ ...i, _why: ratMap.get(i.id) || i._why })) : cur))
      const libTitles = new Set(items.map((i) => i.title.toLowerCase().trim()))
      const cleaned = Array.isArray(parsed.ideas) ? parsed.ideas.filter((s) =>
        s && typeof s.title === 'string' && s.title
        && ['book','tv','movie','article','video'].includes(s.type)
        && !libTitles.has(s.title.toLowerCase().trim())
      ).slice(0, 3) : []
      setExpand(cleaned)
    } catch {
      setExpand([])
    }
  }

  const submit = () => {
    if (!query.trim()) return
    setPhase('thinking')
    setExpand(null)
    const shortlist = decide(query)
    setAnswer(shortlist)
    setPhase('answer')
    expandTerritory(query, shortlist)
  }

  const presets = [
    'watch tonight, under 100 min',
    'a short essay to read on the train',
    'something to watch with ' + (partner || 'Amanda'),
  ]

  const captureIdea = (idea) => {
    if (!onAdd) return
    const tones = {
      book:    ['#2a2820', '#8a8260'],
      tv:      ['#0e2533', '#3a7da3'],
      movie:   ['#2a1a1f', '#a35a7a'],
      article: ['#23252a', '#7a7d85'],
      video:   ['#2a1f1a', '#a3633a'],
    }
    const draft = {
      title: idea.title, type: idea.type, status: 'queued',
      recommended_by: 'Cue Bar', tags: [], with: [],
      enrichment: { synopsis: idea.reason },
      extension: {}, links: [],
      image_tone: tones[idea.type] || tones.book,
      cover_kind: idea.type === 'video' ? 'thumb' : (idea.type === 'movie' || idea.type === 'tv') ? 'poster' : 'type',
    }
    onAdd(draft)
    setHiddenIdeas((prev) => new Set(prev).add(idea.title))
  }

  const visibleAnswer = answer ? answer.filter((i) => !dismissed.has(i.id)) : null
  const visibleExpand = expand ? expand.filter((i) => !hiddenIdeas.has(i.title)) : expand

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 80,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 240ms ease',
      }} />
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 90,
        background: 'var(--paper)',
        borderTop: '1px solid var(--hairline-strong)',
        borderTopLeftRadius: 16, borderTopRightRadius: 16,
        boxShadow: '0 -20px 60px rgba(0,0,0,0.55)',
        transform: open ? 'translateY(0)' : 'translateY(110%)',
        transition: 'transform 340ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        maxHeight: '88svh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <div style={{ width: 38, height: 3, borderRadius: 2, background: 'var(--hairline-strong)' }} />
        </div>
        <div style={{ padding: '14px 20px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 8px', borderRadius: 2,
            background: 'var(--signal)', color: 'var(--ink)',
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em',
            textTransform: 'uppercase', fontWeight: 600,
          }}>✦ Cue Bar</span>
          <Mono size={9} dim>reasons over your queue</Mono>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ ...btnGhost, padding: '4px 8px', fontSize: 9 }}>Close</button>
        </div>

        <div style={{ padding: '6px 20px 12px' }}>
          <div style={{
            border: '1px solid var(--hairline-strong)', borderRadius: 3,
            padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="what should we do tonight?"
              style={{
                appearance: 'none', border: 0, outline: 0, background: 'transparent',
                fontFamily: 'var(--display)', fontStyle: 'italic',
                fontSize: 19, color: 'var(--text)', padding: 0,
              }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {presets.map((p) => (
                <button key={p} onClick={() => setQuery(p)} style={{ ...btnGhost, padding: '4px 8px', fontSize: 9 }}>{p}</button>
              ))}
              <span style={{ flex: 1 }} />
              <button onClick={submit} style={{ ...btnPrimary, padding: '5px 10px', fontSize: 9 }}>Suggest ↵</button>
            </div>
          </div>
        </div>

        <div style={{ padding: '0 20px 32px', overflowY: 'auto', flex: 1 }}>
          {phase === 'idle' && (
            <div style={{
              padding: '14px 16px', border: '1px solid var(--hairline)', borderRadius: 3,
              color: 'var(--muted)',
            }}>
              <Mono size={9} dim>How this works</Mono>
              <p style={{ margin: '6px 0 0', fontFamily: 'var(--body)', fontSize: 13, lineHeight: 1.55, color: 'var(--text-soft)' }}>
                Ask a question. Cue starts with your queue, then expands into new territory.
                Swipe a row <span style={{ color: '#d4a23a', fontWeight: 600 }}>left for seen it</span>, <span style={{ color: '#c43a2a', fontWeight: 600 }}>right to delete</span>.
              </p>
            </div>
          )}

          {phase === 'thinking' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 4px' }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: 'var(--signal)',
                animation: 'pulse-now 1s ease-in-out infinite',
              }} />
              <Mono size={10}>reasoning over {items.filter((i) => i.status !== 'done').length} items in queue…</Mono>
            </div>
          )}

          {phase === 'answer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Mono size={9} dim>From your queue</Mono>
                  <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
                  <Mono size={9} dim>swipe</Mono>
                </div>
                {visibleAnswer && visibleAnswer.length > 0 ? (
                  visibleAnswer.map((i) => (
                    <SwipeRow
                      key={i.id}
                      onSwipeLeft={() => { onMarkSeen && onMarkSeen(i); setDismissed((prev) => new Set(prev).add(i.id)) }}
                      onSwipeRight={() => { onDelete && onDelete(i); setDismissed((prev) => new Set(prev).add(i.id)) }}>
                      <QueueRow item={i} rank={i._rank} onOpen={onOpenItem} />
                    </SwipeRow>
                  ))
                ) : (
                  <div style={{
                    padding: '14px 16px', border: '1px dashed var(--hairline-strong)', borderRadius: 3,
                    color: 'var(--muted)',
                  }}>
                    <Mono size={9} dim>Nothing in your queue matched.</Mono>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Mono size={9} dim>Expanding into new territory</Mono>
                  <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
                </div>
                {visibleExpand === null ? (
                  [0, 1, 2].map((n) => (
                    <div key={n} style={{
                      display: 'grid', gridTemplateColumns: '20px 1fr auto', gap: 12, alignItems: 'center',
                      padding: '12px 4px', borderTop: '1px solid var(--hairline)',
                    }}>
                      <div style={{ width: 14, height: 14, borderRadius: 2, background: 'var(--hairline-strong)', opacity: 0.5 }} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{
                          height: 11, width: `${60 + (n * 7) % 25}%`, borderRadius: 1,
                          background: 'linear-gradient(90deg, transparent, var(--hairline-strong), transparent)',
                          backgroundSize: '200% 100%',
                          animation: `shimmer 1.4s linear ${n * 0.12}s infinite`,
                        }} />
                        <div style={{
                          height: 8, width: `${45 + (n * 9) % 30}%`, borderRadius: 1,
                          background: 'linear-gradient(90deg, transparent, var(--hairline), transparent)',
                          backgroundSize: '200% 100%',
                          animation: `shimmer 1.4s linear ${n * 0.12 + 0.06}s infinite`,
                        }} />
                      </div>
                      <div style={{ width: 36, height: 18, borderRadius: 2, border: '1px dashed var(--hairline-strong)' }} />
                    </div>
                  ))
                ) : visibleExpand.length === 0 ? (
                  <div style={{
                    padding: '12px 16px', border: '1px dashed var(--hairline)', borderRadius: 3,
                    color: 'var(--muted)',
                  }}>
                    <Mono size={9} dim>No new ideas this round.</Mono>
                  </div>
                ) : (
                  visibleExpand.map((idea) => (
                    <SwipeRow
                      key={idea.title}
                      onSwipeLeft={() => setHiddenIdeas((prev) => new Set(prev).add(idea.title))}
                      onSwipeRight={() => setHiddenIdeas((prev) => new Set(prev).add(idea.title))}>
                      <ExpandRow idea={idea} onAdd={captureIdea} />
                    </SwipeRow>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
