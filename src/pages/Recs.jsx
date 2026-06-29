import { useEffect, useMemo, useRef, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { TypeIcon } from '../components/TypeIcon'
import {
  Cover, Mono, Spine, WatchOn, btnGhost, btnPrimary,
} from '../components/primitives'
import { metaFor } from '../lib/meta'
import { useEdition } from '../lib/EditionContext'
import {
  generateRecs, whyThis, loadBatch, saveBatch, addDismissal,
} from '../lib/recs'

const SOURCE_LABEL = { tmdb: 'TMDB', tastedive: 'TasteDive', backlog: 'Backlog', claude: 'Cue' }

// A suggestion → the shape <Cover> renders. Real poster (TMDB) wins; otherwise
// the designed type cover, tinted by any tone the facts carry.
function asCoverItem(sug) {
  const f = sug.facts || {}
  return {
    title: sug.title,
    type: sug.type,
    image_url: f.image_url || null,
    image_tone: f.image_tone || null,
    cover_kind: f.image_url ? ((sug.type === 'movie' || sug.type === 'tv') ? 'poster' : 'type') : undefined,
    extension: f,
  }
}

const SourceTag = ({ source }) => (
  <span style={{
    fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 2, padding: '1px 5px',
  }}>{SOURCE_LABEL[source] || source}</span>
)

// One net-new suggestion. Why-line is lazy: tapping "why this" fetches it.
const SuggestionCard = ({ sug, why, whyBusy, onWhy, onConfirm, onDismiss, confirmed }) => {
  const ext = sug.facts || {}
  const meta = []
  if (sug.type === 'movie') meta.push(ext.director, ext.release_year, ext.runtime_min && `${ext.runtime_min} min`)
  else if (sug.type === 'tv') meta.push(ext.first_air_year, ext.genre)
  else if (sug.type === 'book') meta.push(ext.author, ext.published_year)
  else meta.push(ext.genre)
  const metaLine = meta.filter(Boolean).join(' · ')

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '74px 1fr', gap: 14, alignItems: 'stretch',
      padding: 12, background: 'var(--paper)', border: '1px solid var(--hairline)', borderRadius: 4,
      opacity: confirmed ? 0.5 : 1, transition: 'opacity 220ms ease',
    }}>
      <div style={{
        aspectRatio: '3 / 4', borderRadius: 3, overflow: 'hidden',
        border: '1px solid var(--hairline)', containerType: 'inline-size', alignSelf: 'start',
      }}>
        <Cover item={asCoverItem(sug)} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <TypeIcon type={sug.type} size={12} weight={1.4} />
          <Mono size={9} dim>{metaFor(sug.type).spine}</Mono>
          <SourceTag source={sug.source} />
        </div>
        <div style={{ fontFamily: 'var(--display)', fontSize: 19, lineHeight: 1.12, color: 'var(--text)', textWrap: 'balance' }}>
          {sug.title}
        </div>
        {metaLine && <Mono size={9} dim style={{ letterSpacing: '0.04em' }}>{metaLine}</Mono>}

        {/* Why — inline when the source gave one (Claude paths), lazy otherwise. */}
        {sug.why || why ? (
          <div style={{ fontFamily: 'var(--body)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-soft)', fontStyle: 'italic' }}>
            {sug.why || why}
          </div>
        ) : (
          <button onClick={onWhy} disabled={whyBusy} style={{
            ...btnGhost, alignSelf: 'flex-start', padding: '3px 8px', fontSize: 8.5,
            opacity: whyBusy ? 0.5 : 0.8, cursor: whyBusy ? 'wait' : 'pointer',
          }}>{whyBusy ? 'thinking…' : '✦ why this'}</button>
        )}

        {sug.availability?.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Mono size={8} dim>on</Mono>
            {sug.availability.slice(0, 4).map((s) => (
              <span key={s} style={{
                fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.08em',
                color: 'var(--text-soft)', border: '1px solid var(--hairline-strong)', borderRadius: 2, padding: '1px 5px',
              }}>{s}</span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 6 }}>
          <button onClick={onConfirm} disabled={confirmed} style={{ ...btnPrimary, padding: '6px 12px', fontSize: 9 }}>
            {confirmed ? 'Queued ✓' : '+ Queue'}
          </button>
          {!confirmed && (
            <button onClick={onDismiss} style={{ ...btnGhost, padding: '6px 10px', fontSize: 9 }}>Not for me</button>
          )}
        </div>
      </div>
    </div>
  )
}

const BacklogRow = ({ item, onOpen }) => (
  <div onClick={() => onOpen(item)} style={{
    display: 'grid', gridTemplateColumns: '48px 1fr auto', gap: 12, alignItems: 'center',
    padding: '10px 4px', borderTop: '1px solid var(--hairline)', cursor: 'pointer',
  }}>
    <div style={{ aspectRatio: '3 / 4', borderRadius: 2, overflow: 'hidden', containerType: 'inline-size', border: '1px solid var(--hairline)' }}>
      <Cover item={item} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
        <TypeIcon type={item.type} size={10} weight={1.4} />
        <Mono size={9} dim>{metaFor(item.type).spine}</Mono>
        <span style={{ width: 1, height: 7, background: 'var(--hairline-strong)' }} />
        <Mono size={9} dim>{item.status}</Mono>
      </div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 16, lineHeight: 1.15, color: 'var(--text)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
        {item.title}
      </div>
    </div>
    <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--muted)' }}>open</span>
  </div>
)

const CardSkeleton = ({ i }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '74px 1fr', gap: 14, padding: 12, background: 'var(--paper)', border: '1px solid var(--hairline)', borderRadius: 4 }}>
    <div style={{ aspectRatio: '3 / 4', borderRadius: 3, background: 'var(--hairline)', opacity: 0.5 }} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      {[70, 90, 50].map((w, n) => (
        <div key={n} style={{
          height: n === 1 ? 16 : 9, width: `${w}%`, borderRadius: 1,
          background: 'linear-gradient(90deg, transparent, var(--hairline-strong), transparent)',
          backgroundSize: '200% 100%', animation: `shimmer 1.4s linear ${(i + n) * 0.1}s infinite`,
        }} />
      ))}
    </div>
  </div>
)

export const RecsPage = ({ items, partner, seed, onClearSeed, onAdd, onOpenItem }) => {
  const ed = useEdition()
  const [batch, setBatch] = useState(() => loadBatch())
  const [generating, setGenerating] = useState(false)
  const [view, setView] = useState('net')      // net | backlog
  const [query, setQuery] = useState('')
  const [whyMap, setWhyMap] = useState({})      // id → why
  const [whyBusy, setWhyBusy] = useState(new Set())
  const [confirmed, setConfirmed] = useState(new Set())
  // The live seed object (carries the actual anchor item for refresh/refine).
  const [activeSeed, setActiveSeed] = useState(null)
  const seedFiredRef = useRef(null)

  const run = async (s) => {
    setGenerating(true)
    setActiveSeed(s)
    try {
      const b = await generateRecs({ seed: s, items, partner, edition: ed.label })
      setBatch(b)
      saveBatch(b)
      setView('net')
      setConfirmed(new Set())
      setWhyMap({})
    } finally {
      setGenerating(false)
    }
  }

  // Arriving from "More like this" pre-seeds a generation once per anchor.
  useEffect(() => {
    if (seed?.kind === 'item' && seed.item && seedFiredRef.current !== seed.item.id) {
      seedFiredRef.current = seed.item.id
      run({ kind: 'item', item: seed.item })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const onSurprise = () => run({ kind: 'surprise' })
  const onAsk = () => {
    const q = query.trim()
    if (!q) return
    // With a seed chip up, an NL ask refines the anchor; otherwise it's a fresh NL seed.
    if (activeSeed?.kind === 'item' && activeSeed.item) run({ kind: 'item', item: activeSeed.item, query: q })
    else run({ kind: 'nl', query: q })
  }
  const onRefresh = () => { if (activeSeed) run(activeSeed) }
  const clearSeed = () => { setActiveSeed(null); seedFiredRef.current = null; onClearSeed && onClearSeed() }

  const fetchWhy = async (sug) => {
    if (whyMap[sug.id] || whyBusy.has(sug.id)) return
    setWhyBusy((p) => new Set(p).add(sug.id))
    const w = await whyThis(sug, { seed: batch?.seed || {}, items })
    setWhyMap((p) => ({ ...p, [sug.id]: w || 'a strong fit for your taste' }))
    setWhyBusy((p) => { const n = new Set(p); n.delete(sug.id); return n })
  }

  const confirm = (sug) => {
    const f = sug.facts || {}
    const provenance = batch?.seed?.itemTitle ? `Cue · like ${batch.seed.itemTitle}` : 'Cue'
    onAdd({
      title: sug.title,
      type: sug.type,
      status: 'queued',
      recommended_by: provenance,
      tags: [],
      with: [],
      enrichment: { synopsis: f.synopsis || (sug.why || whyMap[sug.id] || '') },
      extension: { ...f },
      image_url: f.image_url || null,
      image_tone: f.image_tone || null,
      cover_kind: f.image_url ? ((sug.type === 'movie' || sug.type === 'tv') ? 'poster' : 'type') : undefined,
      links: [],
    })
    setConfirmed((p) => new Set(p).add(sug.id))
  }

  const dismiss = (sug) => {
    addDismissal(sug.title, sug.type)
    setBatch((b) => {
      if (!b) return b
      const next = { ...b, netNew: b.netNew.filter((s) => s.id !== sug.id) }
      saveBatch(next)
      return next
    })
  }

  // Resolve persisted backlog ids against live items (status may have changed).
  const backlogItems = useMemo(() => {
    if (!batch?.backlog) return []
    const byId = new Map(items.map((i) => [i.id, i]))
    return batch.backlog.map((id) => byId.get(id)).filter(Boolean).filter((i) => i.status !== 'done')
  }, [batch, items])

  const visibleNet = batch?.netNew || []
  const seedChip = activeSeed?.kind === 'item' ? (activeSeed.item?.title) : (batch?.seed?.itemTitle)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Masthead kicker="No. 002 · Recommendations" title="What's next?" />
      <div style={{ padding: '16px 20px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* The ask */}
        <div style={{ border: '1px solid var(--hairline-strong)', background: 'var(--paper)', borderRadius: 3, padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {seedChip && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 999,
                background: 'color-mix(in oklab, var(--signal) 14%, transparent)', color: 'var(--signal)',
                border: '1px solid color-mix(in oklab, var(--signal) 30%, transparent)',
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em',
              }}>
                Like: {seedChip}
                <button onClick={clearSeed} title="Clear seed" style={{ appearance: 'none', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 11 }}>✕</button>
              </span>
            </div>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAsk()}
            placeholder={seedChip ? '…but shorter, funnier, etc.' : 'something short and funny tonight…'}
            style={{
              appearance: 'none', border: 0, outline: 0, background: 'transparent',
              fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 19, color: 'var(--text)', padding: 0,
            }}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={onSurprise} disabled={generating} style={{ ...btnGhost, padding: '6px 11px', fontSize: 9 }}>✦ Surprise me</button>
            <span style={{ flex: 1 }} />
            <button onClick={onAsk} disabled={generating || !query.trim()} style={{ ...btnPrimary, padding: '6px 12px', fontSize: 9, opacity: query.trim() ? 1 : 0.4 }}>Ask ↵</button>
          </div>
        </div>

        {/* net-new ⇄ backlog toggle + refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {[['net', 'New to you'], ['backlog', `From your queue${backlogItems.length ? ` · ${backlogItems.length}` : ''}`]].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{
              appearance: 'none', cursor: 'pointer', padding: '6px 11px', borderRadius: 999,
              background: view === v ? 'var(--text)' : 'transparent', color: view === v ? 'var(--ink)' : 'var(--muted)',
              border: `1px solid ${view === v ? 'var(--text)' : 'var(--hairline-strong)'}`,
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
            }}>{label}</button>
          ))}
          <span style={{ flex: 1 }} />
          {batch && (
            <button onClick={onRefresh} disabled={generating || !activeSeed} title="Regenerate" style={{
              appearance: 'none', cursor: generating ? 'wait' : 'pointer', background: 'transparent', border: 0,
              color: 'var(--muted)', padding: '2px 6px', opacity: activeSeed ? 1 : 0.4,
            }}>
              <span style={{ display: 'inline-block', fontSize: 13, transition: 'transform 320ms', transform: generating ? 'rotate(180deg)' : 'none' }}>↻</span>
            </button>
          )}
        </div>

        {/* Body */}
        {generating ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3].map((i) => <CardSkeleton key={i} i={i} />)}
          </div>
        ) : !batch ? (
          <div style={{ padding: '22px 18px', border: '1px dashed var(--hairline-strong)', borderRadius: 3, color: 'var(--muted)' }}>
            <Mono size={9} dim>Nothing generated yet</Mono>
            <p style={{ margin: '8px 0 0', fontFamily: 'var(--body)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)' }}>
              Tap <strong>Surprise me</strong>, ask for something specific, or open any item and hit <em>More like this</em>.
              Cue draws candidates from TMDB / TasteDive / your own backlog, then ranks them to your taste.
            </p>
          </div>
        ) : view === 'net' ? (
          visibleNet.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visibleNet.map((sug) => (
                <SuggestionCard
                  key={sug.id}
                  sug={sug}
                  why={whyMap[sug.id]}
                  whyBusy={whyBusy.has(sug.id)}
                  confirmed={confirmed.has(sug.id)}
                  onWhy={() => fetchWhy(sug)}
                  onConfirm={() => confirm(sug)}
                  onDismiss={() => dismiss(sug)}
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: '18px', border: '1px dashed var(--hairline-strong)', borderRadius: 3, color: 'var(--muted)' }}>
              <Mono size={9} dim>No new picks left this round.</Mono>
              <div style={{ fontFamily: 'var(--body)', fontSize: 12.5, marginTop: 4, color: 'var(--text-soft)' }}>Tap ↻ to regenerate, or check your queue.</div>
            </div>
          )
        ) : (
          backlogItems.length ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {backlogItems.map((i) => <BacklogRow key={i.id} item={i} onOpen={onOpenItem} />)}
            </div>
          ) : (
            <div style={{ padding: '18px', border: '1px dashed var(--hairline-strong)', borderRadius: 3, color: 'var(--muted)' }}>
              <Mono size={9} dim>Your queue is empty.</Mono>
            </div>
          )
        )}
      </div>
    </div>
  )
}
