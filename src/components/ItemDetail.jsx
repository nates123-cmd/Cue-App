// Detail sheet for any item. Override-always-wins: title, synopsis, notes,
// rating, recommended_by, tags, status are all editable here.

import { useEffect, useState } from 'react'
import {
  Cover, Mono, RatingDots, RottenScore, Spine, WatchOn,
  btnGhost, btnPrimary, btnTextChip,
} from './primitives'
import { RecommenderPicker } from './RecommenderPicker'
import { EditableField } from './EditableField'

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
  onPatch, onRequestFinish, onPromoteToLibrary, onDelete,
  partner = 'Amanda', recommenders = [],
}) => {
  if (!item) return null
  const [confirmDelete, setConfirmDelete] = useState(false)
  const readOnly = item._source !== 'rec' // media/visit-derived items are read-only
  const ext = item.extension || {}
  const meta = []
  if (item.type === 'book') meta.push(ext.author, ext.published_year, ext.page_count && `${ext.page_count} pp`)
  if (item.type === 'tv') meta.push(ext.network_or_service, ext.seasons && `${ext.seasons} season${(ext.seasons || 1) > 1 ? 's' : ''}`, ext.runtime_per_ep && `${ext.runtime_per_ep} min/ep`)
  if (item.type === 'movie') meta.push(ext.director, ext.release_year, ext.runtime_min && `${ext.runtime_min} min`)
  if (item.type === 'article') meta.push(ext.source, ext.author, ext.est_read_min && `${ext.est_read_min} min read`, ext.word_count && `${ext.word_count.toLocaleString()} words`)
  if (item.type === 'video') meta.push(ext.channel, ext.duration_min && `${ext.duration_min} min`)

  const setRating = (n) => {
    if (readOnly) return
    onPatch && onPatch(item, { rating: item.rating === n ? null : n })
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
              {[1, 2, 3].map((n) => (
                <button key={n}
                  onClick={() => setRating(n)}
                  disabled={readOnly}
                  style={{
                    appearance: 'none', cursor: readOnly ? 'default' : 'pointer',
                    background: 'transparent', border: 0, padding: 2,
                    opacity: readOnly ? 0.7 : 1,
                  }}>
                  <RatingDots rating={n <= (item.rating || 0) ? n : 0} size={10} />
                </button>
              ))}
              <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 14, color: 'var(--text-soft)' }}>
                {item.rating === 3 ? 'loved it' : item.rating === 2 ? 'good, glad I did' : item.rating === 1 ? 'meh' : ''}
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
