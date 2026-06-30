// Capture, as a bottom sheet from the persistent FAB. Capture is the constant
// daily motion, so it's reachable from every tab — the old Capture tab is
// retired (Recs took its nav slot). This wraps the same flow the Capture page
// had: title/type/recommender + enrich → MatchPicker disambiguation → DraftCard
// inline edit → confirm. Bulk import lives behind a toggle so nothing is lost.

import { useEffect, useState } from 'react'
import { Mono, btnGhost, btnPrimary } from './primitives'
import { RecommenderPicker } from './RecommenderPicker'
import { BulkImport } from './BulkImport'
import { DraftCard, MatchPicker, Enriching, TypeChip } from '../pages/Capture'
import { TYPE_ORDER } from '../lib/meta'
import { useEdition } from '../lib/EditionContext'
import { enrich, searchCandidates, searchCandidatesAuto } from '../lib/enrichment'

export const CaptureSheet = ({ open, onClose, onAdd, recommenders = [], partner = 'Amanda' }) => {
  const ed = useEdition()
  const [mode, setMode] = useState('single')      // single | bulk
  const [title, setTitle] = useState('')
  const [type, setType] = useState('book')
  const [auto, setAuto] = useState(true)           // Auto = search across all media types, pick locks the type
  const [recommendedBy, setRecommendedBy] = useState('me')
  const [withPartner, setWithPartner] = useState(false)
  const [phase, setPhase] = useState('idle')       // idle | picking | enriching | draft
  const [draft, setDraft] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [pickedKey, setPickedKey] = useState(null)
  const [autoMiss, setAutoMiss] = useState(false)  // Auto search returned nothing → prompt to pick a type
  // iOS soft keyboard overlays fixed-bottom elements. Track visualViewport so
  // the sheet lifts above the keyboard and caps its height to the visible area,
  // keeping the type chips + Enrich button reachable (scroll handles the rest).
  const [vv, setVv] = useState({ inset: 0, height: 0 })

  useEffect(() => {
    const vp = typeof window !== 'undefined' && window.visualViewport
    if (!vp) return
    const onResize = () => {
      const inset = Math.max(0, window.innerHeight - vp.height - vp.offsetTop)
      setVv({ inset, height: vp.height })
    }
    onResize()
    vp.addEventListener('resize', onResize)
    vp.addEventListener('scroll', onResize)
    return () => { vp.removeEventListener('resize', onResize); vp.removeEventListener('scroll', onResize) }
  }, [])

  // Reset everything when the sheet closes.
  useEffect(() => {
    if (!open) {
      setMode('single'); setTitle(''); setType('book'); setAuto(true); setRecommendedBy('me')
      setWithPartner(false); setPhase('idle'); setDraft(null); setCandidates([]); setPickedKey(null); setAutoMiss(false)
    }
  }, [open])

  const decorate = (card) => {
    card.recommended_by = recommendedBy
    card.with = withPartner ? [partner] : []
    card.status = 'queued'
    return card
  }

  const submit = async () => {
    const q = title.trim()
    if (!q) return
    if (auto) return submitAuto(q)
    setPhase('enriching'); setDraft(null); setCandidates([]); setPickedKey(null); setAutoMiss(false)
    const [enriched, cands] = await Promise.all([
      enrich(q, type),
      searchCandidates(type, q).catch(() => []),
    ])
    setDraft(decorate(enriched))
    setPhase('draft')
    if (cands.length >= 2) { setCandidates(cands); setPickedKey(cands[0].key) }
  }

  // Auto: search across media types, show the cross-type picker, no draft yet —
  // the type is unknown until a candidate is picked. A miss prompts a type pick.
  const submitAuto = async (q) => {
    setPhase('picking'); setDraft(null); setCandidates([]); setPickedKey(null); setAutoMiss(false)
    const cands = await searchCandidatesAuto(q).catch(() => [])
    if (cands.length) { setCandidates(cands); setPhase('picking') }
    else { setPhase('idle'); setAutoMiss(true) }
  }

  const pickCandidate = async (cand) => {
    if (cand.key === pickedKey && phase === 'draft') return
    setPickedKey(cand.key); setType(cand.type); setPhase('enriching'); setDraft(null)
    const enriched = await enrich(cand.title, cand.type, cand)
    setDraft(decorate(enriched)); setPhase('draft')
  }

  const backToEdit = () => { setPhase('idle'); setDraft(null); setCandidates([]); setPickedKey(null); setAutoMiss(false) }
  const resetForAnother = () => { setTitle(''); setDraft(null); setPhase('idle'); setWithPartner(false); setCandidates([]); setPickedKey(null); setAutoMiss(false) }
  const chooseType = (t) => { setAuto(false); setType(t); setAutoMiss(false) }
  const confirm = () => { onAdd(draft); onClose() }

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition: 'opacity 240ms ease',
      }} />
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: vv.inset, zIndex: 90,
        background: 'var(--paper)', borderTop: '1px solid var(--hairline-strong)',
        borderTopLeftRadius: 16, borderTopRightRadius: 16, boxShadow: '0 -20px 60px rgba(0,0,0,0.55)',
        transform: open ? 'translateY(0)' : 'translateY(110%)',
        transition: 'transform 340ms cubic-bezier(0.2, 0.7, 0.2, 1), bottom 160ms ease',
        maxHeight: vv.inset > 0 && vv.height ? `${vv.height - 12}px` : '90svh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <div style={{ width: 38, height: 3, borderRadius: 2, background: 'var(--hairline-strong)' }} />
        </div>
        <div style={{ padding: '14px 20px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            padding: '3px 8px', borderRadius: 2, background: 'var(--signal)', color: 'var(--ink)',
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
          }}>Capture</span>
          <Mono size={9} dim>what did you just hear about?</Mono>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ ...btnGhost, padding: '4px 8px', fontSize: 9 }}>Close</button>
        </div>

        <div style={{ padding: '6px 20px 32px', overflowY: 'auto', WebkitOverflowScrolling: 'touch', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {[['single', 'One at a time'], ['bulk', 'Bulk import']].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} style={{
                appearance: 'none', cursor: 'pointer', flex: 1, padding: '8px 4px', borderRadius: 3,
                background: mode === m ? 'var(--paper-soft)' : 'transparent',
                border: `1px solid ${mode === m ? 'var(--signal)' : 'var(--hairline)'}`,
                color: mode === m ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
              }}>{label}</button>
            ))}
          </div>

          {mode === 'single' && (
            <>
              <div style={{
                border: '1px solid var(--hairline-strong)', background: 'var(--paper-soft)', borderRadius: 3,
                padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10,
                opacity: phase === 'enriching' ? 0.55 : 1, pointerEvents: phase === 'enriching' ? 'none' : 'auto',
                transition: 'opacity 200ms',
              }}>
                <Mono size={9} dim>Title or URL</Mono>
                <input
                  value={title}
                  onFocus={() => { if (phase === 'draft' || phase === 'picking') backToEdit() }}
                  onChange={(e) => { if (phase === 'draft' || phase === 'picking') backToEdit(); setTitle(e.target.value) }}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="Severance · Past Lives · The Overstory…"
                  style={{
                    appearance: 'none', border: 0, outline: 0, background: 'transparent',
                    fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 22, lineHeight: 1.2,
                    color: 'var(--text)', padding: 0, width: '100%',
                  }}
                />
                <button onClick={() => { setAuto(true); setAutoMiss(false) }} style={{
                  appearance: 'none', cursor: 'pointer', width: '100%', marginTop: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 4px',
                  background: auto ? 'color-mix(in oklab, var(--signal) 14%, var(--paper))' : 'transparent',
                  border: `1px solid ${auto ? 'var(--signal)' : 'var(--hairline)'}`, borderRadius: 3,
                  color: auto ? 'var(--text)' : 'var(--muted)', transition: 'all 160ms ease',
                }}>
                  <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 15, lineHeight: 0.8, color: auto ? 'var(--signal)' : 'var(--muted)' }}>✦</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Auto · best match</span>
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
                  <Mono size={8} dim>{auto ? 'or pick a type' : 'type'}</Mono>
                  <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, opacity: auto ? 0.5 : 1, transition: 'opacity 160ms' }}>
                  {TYPE_ORDER.map((t) => (
                    <TypeChip key={t} type={t} active={!auto && type === t} onClick={() => chooseType(t)} />
                  ))}
                </div>
                {autoMiss && (
                  <Mono size={9} style={{ color: 'var(--signal)' }}>No popular match — pick a type above, then Enrich.</Mono>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                  <Mono size={9} dim>From</Mono>
                  <RecommenderPicker value={recommendedBy} onChange={setRecommendedBy} recommenders={recommenders} />
                  <span style={{ width: 1, height: 10, background: 'var(--hairline-strong)' }} />
                  <button type="button" onClick={() => setWithPartner((v) => !v)} style={{
                    appearance: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '4px 9px 4px 7px', borderRadius: 999,
                    background: withPartner ? 'color-mix(in oklab, var(--signal) 16%, transparent)' : 'transparent',
                    border: `1px solid ${withPartner ? 'var(--signal)' : 'var(--hairline-strong)'}`,
                    color: withPartner ? 'var(--signal)' : 'var(--muted)',
                  }}>
                    <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 14, lineHeight: 0.7, transform: 'translateY(1px)' }}>&amp;</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{partner}</span>
                  </button>
                  <span style={{ flex: 1 }} />
                  <button onClick={submit} style={{ ...btnPrimary, opacity: title.trim() ? 1 : 0.3, pointerEvents: title.trim() ? 'auto' : 'none' }}>{phase === 'picking' ? 'Searching…' : auto ? 'Match ↵' : 'Enrich ↵'}</button>
                </div>
              </div>

              {candidates.length > 0 && (phase === 'picking' || phase === 'draft' || phase === 'enriching') && (
                <MatchPicker candidates={candidates} pickedKey={pickedKey} busy={phase === 'enriching'} showType={auto} onPick={pickCandidate} onDismiss={backToEdit} />
              )}
              {phase === 'enriching' && <Enriching title={title} />}
              {phase === 'draft' && draft && (
                <DraftCard draft={draft} onChange={setDraft} onConfirm={confirm} onAnother={resetForAnother} />
              )}
            </>
          )}

          {mode === 'bulk' && (
            <BulkImport onAdd={onAdd} defaultType={type} partner={partner} />
          )}
        </div>
      </div>
    </>
  )
}
