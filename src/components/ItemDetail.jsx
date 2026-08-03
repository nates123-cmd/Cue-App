// Detail sheet for any item. Override-always-wins: title, synopsis, notes,
// rating, recommended_by, tags, status are all editable here.

import { useEffect, useState } from 'react'
import {
  Cover, Mono, RatingPicker, RottenScore, Spine, WatchOn,
  btnGhost, btnPrimary, btnTextChip,
} from './primitives'
import { ratingTone } from '../lib/meta'
import { RecommenderPicker } from './RecommenderPicker'
import { EditableField } from './EditableField'
import { enrich } from '../lib/enrichment'
import { fulfillmentBadges } from '../lib/fulfillment'
import { pushTarget } from '../lib/items'

// Small uppercased mono chip rendered just above the synopsis. Picks up the
// suite signal color so it reads like a press-tag editorial label.
const GenreChip = ({ genre }) => (
  <span style={{
    alignSelf: 'flex-start',
    padding: '2px 8px', borderRadius: 2,
    background: 'color-mix(in oklab, var(--signal) 14%, transparent)',
    color: 'var(--signal)',
    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.18em',
    textTransform: 'uppercase',
    border: '1px solid color-mix(in oklab, var(--signal) 30%, transparent)',
  }}>{genre}</span>
)

// The full pipeline read-out for one title: a row per leg with whatever the
// Beelink daemons last said about it. A book push fans out to three legs
// (ebook -> Kindle, audiobook -> Audiobookshelf, epub -> Place/X4 sync), and
// they finish at wildly different times — the audiobook can be hours behind the
// ebook — so each reports for itself rather than collapsing to one status.
const PANEL_TONE = {
  wait: 'var(--muted)',
  go: 'var(--signal)',
  done: 'color-mix(in oklab, var(--text) 60%, transparent)',
  fail: 'var(--signal)',
}

const FulfillmentPanel = ({ item }) => {
  const badges = fulfillmentBadges(item)
  if (badges.length === 0) return null
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      padding: '11px 12px', borderRadius: 3,
      border: '1px solid var(--hairline)',
      background: 'color-mix(in oklab, var(--paper) 50%, transparent)',
    }}>
      <Mono size={9} dim>pipeline</Mono>
      {badges.map((b) => (
        <div key={b.key} style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', flex: 'none',
            transform: 'translateY(-2px)',
            background: b.tone === 'fail' ? 'transparent' : PANEL_TONE[b.tone],
            boxShadow: b.tone === 'fail' ? 'inset 0 0 0 1.5px var(--signal)'
              : b.tone === 'go' ? '0 0 0 3px color-mix(in oklab, var(--signal) 22%, transparent)'
                : 'none',
          }} />
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.11em',
              textTransform: 'uppercase',
              color: b.tone === 'fail' ? 'var(--signal)' : 'var(--text)',
            }}>{b.label}</span>
            {b.title && b.title !== b.label && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
                overflowWrap: 'anywhere',
              }}>{b.title}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

const TogetherRow = ({ item, partner, onToggle }) => {
  const isShared = (item.with || []).includes(partner)
  const recIsPartner = item.recommended_by === partner
  const summary = isShared
    ? (recIsPartner ? 'for us' : `with ${partner}`)
    : 'solo'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      border: '1px solid var(--hairline)', borderRadius: 3,
      background: isShared
        ? 'color-mix(in oklab, var(--signal) 8%, transparent)'
        : 'color-mix(in oklab, var(--paper) 50%, transparent)',
      transition: 'background 240ms ease',
    }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%',
        border: `1px solid ${isShared ? 'var(--signal)' : 'var(--hairline-strong)'}`,
        background: isShared ? 'color-mix(in oklab, var(--signal) 16%, transparent)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--display)', fontStyle: 'italic',
          fontSize: 18, lineHeight: 1,
          color: isShared ? 'var(--signal)' : 'var(--muted)',
        }}>&amp;</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Mono size={9} dim>Together</Mono>
        <div style={{
          fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 15,
          color: isShared ? 'var(--text)' : 'var(--muted)',
        }}>{summary}</div>
      </div>
      <button onClick={() => onToggle && onToggle(item)} style={{
        ...btnGhost, padding: '6px 10px', fontSize: 9,
        background: isShared ? 'var(--text)' : 'transparent',
        color: isShared ? 'var(--ink)' : 'var(--text)',
        borderColor: isShared ? 'var(--text)' : 'var(--hairline-strong)',
      }}>{isShared ? 'On shared list' : `Add for ${partner}`}</button>
    </div>
  )
}

const TagEditor = ({ tags = [], onChange }) => {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = () => {
    const v = draft.trim().replace(/^#/, '')
    if (v && !tags.includes(v)) onChange([...tags, v])
    setDraft(''); setAdding(false)
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {tags.map((t) => (
        <span key={t} onClick={() => onChange(tags.filter((x) => x !== t))} style={{
          cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px',
          borderRadius: 2, background: 'var(--paper)', color: 'var(--text-soft)',
          border: '1px solid var(--hairline)',
        }}>#{t} <span style={{ opacity: 0.5, marginLeft: 2 }}>×</span></span>
      ))}
      {adding ? (
        <input
          autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setDraft(''); setAdding(false) }
          }}
          placeholder="tag"
          style={{
            appearance: 'none', outline: 0,
            width: 80, padding: '2px 6px', borderRadius: 2,
            background: 'var(--paper-soft)', color: 'var(--text)',
            border: '1px solid var(--signal)',
            fontFamily: 'var(--mono)', fontSize: 9,
          }}
        />
      ) : (
        <button onClick={() => setAdding(true)} style={{
          appearance: 'none', cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px',
          borderRadius: 2, background: 'transparent', color: 'var(--muted)',
          border: '1px dashed var(--hairline-strong)',
        }}>+ tag</button>
      )}
    </div>
  )
}

export const ItemDetail = ({
  item, onClose, onChangeStatus, onToggleWith,
  onPatch, onRequestFinish, onPromoteToLibrary, onDelete, onPushToRadarr, onMoreLikeThis, onToggleShortlist,
  partner = 'Amanda', recommenders = [],
}) => {
  if (!item) return null
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [pushState, setPushState] = useState(null) // null | 'pushing' | 'sent' | 'error'
  const readOnly = item._source !== 'rec' // media/visit-derived items are read-only

  // Fetch cover art + where-to-watch (and other type facts) for this item on
  // demand, then patch them in. Reuses the same enrichment pipeline as capture.
  const runEnrich = async () => {
    if (readOnly || enriching) return
    setEnriching(true)
    try {
      const card = await enrich(item.title, item.type)
      const patch = {}
      if (card.image_url) patch.image_url = card.image_url
      if (card.image_tone) patch.image_tone = card.image_tone
      if (card.cover_kind) patch.cover_kind = card.cover_kind
      if (card.extension && Object.keys(card.extension).length) {
        patch.extension = { ...(item.extension || {}), ...card.extension }
      }
      if (card.synopsis && !item.enrichment?.synopsis) {
        patch.enrichment = { ...(item.enrichment || {}), synopsis: card.synopsis }
      }
      if (Array.isArray(card.links) && card.links.length) patch.links = card.links
      if (Object.keys(patch).length && onPatch) onPatch(item, patch)
    } catch (e) {
      console.warn('enrich failed', e)
    } finally {
      setEnriching(false)
    }
  }
  // Queue this movie/TV item for download on the home *arr stack (Radarr/Sonarr)
  // via the media_requests outbox. A poller on the server picks it up.
  const runPush = async () => {
    if (pushState === 'pushing' || pushState === 'sent' || !onPushToRadarr) return
    setPushState('pushing')
    try {
      await onPushToRadarr(item)
      setPushState('sent')
    } catch (e) {
      console.warn('push to radarr failed', e)
      setPushState('error')
      setTimeout(() => setPushState(null), 2600)
    }
  }
  const ext = item.extension || {}
  const meta = []
  if (item.type === 'book') meta.push(ext.author, ext.published_year, ext.page_count && `${ext.page_count} pp`)
  if (item.type === 'tv') meta.push(ext.network_or_service, ext.seasons && `${ext.seasons} season${(ext.seasons || 1) > 1 ? 's' : ''}`, ext.runtime_per_ep && `${ext.runtime_per_ep} min/ep`)
  if (item.type === 'movie') meta.push(ext.director, ext.release_year, ext.runtime_min && `${ext.runtime_min} min`)
  if (item.type === 'article') meta.push(ext.source, ext.author, ext.est_read_min && `${ext.est_read_min} min read`, ext.word_count && `${ext.word_count.toLocaleString()} words`)
  if (item.type === 'video') meta.push(ext.channel, ext.duration_min && `${ext.duration_min} min`)
  if (item.type === 'podcast') meta.push(ext.host, ext.publisher, ext.cadence)
  if (item.type === 'music') meta.push(ext.artist, ext.published_year, ext.label, ext.track_count && `${ext.track_count} tracks`)

  // RatingPicker already sends null when you tap the current value, so this
  // just writes what it is given.
  const setRating = (n) => {
    if (readOnly) return
    onPatch && onPatch(item, { rating: n })
  }

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)',
      }} />
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, top: 70, zIndex: 90,
        background: 'var(--ink)',
        borderTop: '1px solid var(--hairline-strong)',
        borderTopLeftRadius: 16, borderTopRightRadius: 16,
        boxShadow: '0 -20px 60px rgba(0,0,0,0.5)',
        overflowY: 'auto', animation: 'sheet-in 320ms cubic-bezier(0.2,0.7,0.2,1)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <div style={{ width: 38, height: 3, borderRadius: 2, background: 'var(--hairline-strong)' }} />
        </div>
        <div style={{ padding: '14px 20px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Spine type={item.type} year={ext.published_year || ext.release_year} />
          <button onClick={onClose} style={{ ...btnGhost, padding: '4px 9px', fontSize: 9 }}>Close</button>
        </div>
        <div style={{ padding: '0 20px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{
            aspectRatio: '5 / 3', borderRadius: 4, overflow: 'hidden',
            border: '1px solid var(--hairline)', containerType: 'inline-size',
            boxShadow: '0 24px 50px -24px rgba(0,0,0,0.7)',
          }}>
            <Cover item={item} />
          </div>
          <div>
            {readOnly ? (
              <div style={{
                fontFamily: 'var(--display)', fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.018em',
                color: 'var(--text)', textWrap: 'balance', fontWeight: 400,
              }}>{item.title}</div>
            ) : (
              <EditableField
                value={item.title}
                onSave={(v) => onPatch && onPatch(item, { title: v })}
                placeholder="title"
                displayStyle={{
                  fontFamily: 'var(--display)', fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.018em',
                  color: 'var(--text)', textWrap: 'balance', fontWeight: 400,
                }}
                editStyle={{
                  fontFamily: 'var(--display)', fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.018em',
                  color: 'var(--text)', fontWeight: 400,
                }}
              />
            )}
            <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
              {meta.filter(Boolean).join(' · ')}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {!readOnly && (
              <button onClick={runEnrich} disabled={enriching} style={{
                ...btnGhost,
                opacity: enriching ? 0.6 : 1,
                cursor: enriching ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 7,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', background: 'var(--signal)',
                  animation: enriching ? 'pulse-now 1s ease-in-out infinite' : 'none',
                }} />
                {enriching ? 'Enriching…' : '✦ Enrich — cover + where to watch'}
              </button>
            )}
            {onMoreLikeThis && (
              <button onClick={() => onMoreLikeThis(item)} style={{
                ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 7,
              }}>
                <span style={{ fontSize: 11 }}>✦</span> More like this
              </button>
            )}
          </div>

          {/* Where this title actually ended up. Sticky — the DownloadTray
              forgets a finished push after a day, this doesn't. */}
          <FulfillmentPanel item={item} />

          {pushTarget(item.type) && onPushToRadarr && (
            <button onClick={runPush} disabled={pushState === 'pushing' || pushState === 'sent'} style={{
              ...btnGhost, alignSelf: 'flex-start',
              opacity: pushState === 'pushing' ? 0.6 : 1,
              cursor: pushState === 'pushing' ? 'wait' : pushState === 'sent' ? 'default' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 7,
              ...(pushState === 'sent' ? { borderColor: 'var(--signal)', color: 'var(--signal)' } : {}),
            }}>
              <span style={{ fontSize: 11 }}>➤</span>
              {pushState === 'pushing' ? 'Sending…'
                : pushState === 'sent' ? `Queued in ${pushTarget(item.type).app} ✓`
                : pushState === 'error' ? 'Failed — tap to retry'
                : `Push to ${pushTarget(item.type).app}`}
            </button>
          )}

          {/* Synopsis — editable. Genre chip leads as a small tag. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ext.genre && <GenreChip genre={ext.genre} />}
            {readOnly ? (
              item.enrichment?.synopsis && (
                <p style={{ margin: 0, fontFamily: 'var(--body)', fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-soft)', textWrap: 'pretty' }}>
                  {item.enrichment.synopsis}
                </p>
              )
            ) : (
              <EditableField
                value={item.enrichment?.synopsis || ''}
                onSave={(v) => onPatch && onPatch(item, { enrichment: { ...(item.enrichment || {}), synopsis: v } })}
                placeholder="add a synopsis…"
                multiline
                displayStyle={{
                  fontFamily: 'var(--body)', fontSize: 14.5, lineHeight: 1.6,
                  color: 'var(--text-soft)', textWrap: 'pretty',
                }}
                editStyle={{
                  fontFamily: 'var(--body)', fontSize: 14.5, lineHeight: 1.6, color: 'var(--text)',
                }}
              />
            )}
          </div>

          {(item.type === 'movie' || item.type === 'tv') && (ext.rt_critics != null || ext.rt_audience != null) && (
            <RottenScore critics={ext.rt_critics} audience={ext.rt_audience} />
          )}
          {(item.type === 'movie' || item.type === 'tv') && ext.streaming_on && (
            <WatchOn services={ext.streaming_on} />
          )}

          {/* Status */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Mono size={9} dim>Status</Mono>
            {['queued', 'active', 'done'].map((s) => (
              <button key={s}
                onClick={() => {
                  if (s === 'done' && item.status !== 'done' && onRequestFinish) {
                    onRequestFinish(item)
                  } else {
                    onChangeStatus(item, s)
                  }
                }}
                disabled={readOnly && s !== item.status}
                style={{
                  ...btnTextChip(item.status === s),
                  opacity: readOnly && s !== item.status ? 0.4 : 1,
                  cursor: readOnly && s !== item.status ? 'not-allowed' : 'pointer',
                }}>{s}</button>
            ))}
            {/* Priority is orthogonal to status — an item can be shortlisted and
                still not started. This is the grid-density path onto the list;
                the Library list rows carry the same toggle. */}
            {!readOnly && item.status !== 'done' && onToggleShortlist && (
              <>
                <span style={{ width: 1, height: 12, background: 'var(--hairline-strong)' }} />
                <button
                  onClick={() => onToggleShortlist(item)}
                  style={btnTextChip(item.queue_rank != null)}
                >{item.queue_rank != null ? `↑ up next · ${item.queue_rank}` : '↑ up next'}</button>
              </>
            )}
          </div>

          {/* From + tags */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Mono size={9} dim>From</Mono>
              {readOnly ? (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em',
                  color: 'var(--text)', borderBottom: '1px dashed var(--hairline-strong)', paddingBottom: 1,
                }}>{item.recommended_by}</span>
              ) : (
                <RecommenderPicker
                  value={item.recommended_by}
                  onChange={(v) => onPatch && onPatch(item, { recommended_by: v })}
                  recommenders={recommenders}
                />
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Mono size={9} dim>Tags</Mono>
              {readOnly ? (
                item.tags?.length ? item.tags.map((t) => (
                  <span key={t} style={{
                    fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px',
                    borderRadius: 2, background: 'var(--paper)', color: 'var(--text-soft)',
                    border: '1px solid var(--hairline)',
                  }}>#{t}</span>
                )) : <Mono size={9} dim>(none)</Mono>
              ) : (
                <TagEditor tags={item.tags || []} onChange={(tags) => onPatch && onPatch(item, { tags })} />
              )}
            </div>
          </div>

          <TogetherRow item={item} partner={partner} onToggle={readOnly ? undefined : onToggleWith} />

          {/* Rating + notes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Mono size={9} dim>Rating</Mono>
              <RatingPicker
                value={item.rating}
                onChange={setRating}
                size={10}
                disabled={readOnly}
              />
              <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 14, color: 'var(--text-soft)' }}>
                {ratingTone(item.rating)}
              </span>
            </div>
            <div>
              <Mono size={9} dim style={{ display: 'block', marginBottom: 6 }}>Notes</Mono>
              {readOnly ? (
                item.notes ? (
                  <div style={{
                    borderLeft: '2px solid var(--signal)', paddingLeft: 12,
                    fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 16, lineHeight: 1.4,
                    color: 'var(--text)',
                  }}>&ldquo;{item.notes}&rdquo;</div>
                ) : <Mono size={9} dim>(none)</Mono>
              ) : (
                <EditableField
                  value={item.notes || ''}
                  onSave={(v) => onPatch && onPatch(item, { notes: v || null })}
                  placeholder="your take, after"
                  multiline
                  displayStyle={{
                    fontFamily: item.notes ? 'var(--display)' : 'var(--body)',
                    fontStyle: item.notes ? 'italic' : 'normal',
                    fontSize: item.notes ? 16 : 14, lineHeight: 1.4,
                    color: item.notes ? 'var(--text)' : 'var(--muted)',
                    borderLeft: item.notes ? '2px solid var(--signal)' : '2px solid transparent',
                    paddingLeft: 12,
                  }}
                  editStyle={{
                    fontFamily: 'var(--body)', fontSize: 14, lineHeight: 1.5, color: 'var(--text)',
                  }}
                />
              )}
            </div>
          </div>


          {item.links?.length > 0 && (
            <div>
              <Mono size={9} dim style={{ display: 'block', marginBottom: 8 }}>Launch</Mono>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {item.links.map((l, i) => (
                  <a key={i} href={l.url || '#'} target="_blank" rel="noopener noreferrer" style={{
                    appearance: 'none', cursor: 'pointer', textDecoration: 'none',
                    padding: '8px 12px', borderRadius: 2,
                    background: i === 0 ? 'var(--text)' : 'transparent',
                    color: i === 0 ? 'var(--ink)' : 'var(--text)',
                    border: `1px solid ${i === 0 ? 'var(--text)' : 'var(--hairline-strong)'}`,
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
                    textTransform: 'uppercase', fontWeight: 500,
                  }}>↗ {l.label}</a>
                ))}
              </div>
            </div>
          )}

          {readOnly && (
            <div style={{
              padding: '10px 12px',
              border: '1px dashed var(--hairline-strong)', borderRadius: 3,
              color: 'var(--muted)', fontFamily: 'var(--body)', fontSize: 12,
              lineHeight: 1.4,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div>
                {item._source === 'media'
                  ? 'This came from Ink\'s consumption log. Promote it to the library to edit details.'
                  : 'This entry was derived from your visit history. Edits to the visit log work directly.'}
              </div>
              {item._source === 'media' && onPromoteToLibrary && (
                <button
                  onClick={() => onPromoteToLibrary(item)}
                  style={{ ...btnPrimary, alignSelf: 'flex-start' }}
                >Promote to library</button>
              )}
            </div>
          )}

          {onDelete && (
            <DeleteRow
              item={item}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDelete={onDelete}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </>
  )
}

// Two-step delete row at the bottom of ItemDetail. First tap arms it; second
// tap (or the explicit Yes button) deletes and closes the sheet. Auto-disarms
// after ~4 seconds so it doesn't sit primed forever.
const DeleteRow = ({ item, confirmDelete, setConfirmDelete, onDelete, onClose }) => {
  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 4000)
    return () => clearTimeout(t)
  }, [confirmDelete, setConfirmDelete])

  return (
    <div style={{
      marginTop: 4, paddingTop: 16,
      borderTop: '1px solid var(--hairline)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <Mono size={9} dim>Danger</Mono>
      {confirmDelete ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            flex: 1, fontFamily: 'var(--body)', fontSize: 13, color: 'var(--text-soft)',
          }}>Delete <em style={{ color: 'var(--text)' }}>{item.title}</em>?</span>
          <button onClick={() => setConfirmDelete(false)} style={{ ...btnGhost, padding: '5px 10px', fontSize: 10 }}>
            Cancel
          </button>
          <button
            onClick={async () => {
              try { await onDelete(item) } finally { onClose && onClose() }
            }}
            style={{
              ...btnPrimary, padding: '5px 12px', fontSize: 10,
              background: '#c43a2a', color: '#fff', borderColor: '#c43a2a',
            }}
          >Yes, delete</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmDelete(true)}
          style={{
            ...btnGhost, alignSelf: 'flex-start', padding: '5px 10px', fontSize: 10,
            color: '#c43a2a', borderColor: 'color-mix(in oklab, #c43a2a 40%, transparent)',
          }}
        >Delete this item</button>
      )}
    </div>
  )
}
