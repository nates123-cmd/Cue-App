import { useEffect, useMemo, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { TypeIcon } from '../components/TypeIcon'
import {
  Card, Cover, FulfillmentPills, Mono, PosterStack, RatingDots, SectionHead, SharedMark, StatusDot,
  btnGhost, btnTextChip, formatLengthShort, lengthBucket, posterFrame,
} from '../components/primitives'
import { SwipeRow } from '../components/SwipeRow'
import { TYPE_META, TYPE_ORDER } from '../lib/meta'
import { useEdition } from '../lib/EditionContext'

const LibraryRow = ({ item, onClick, onToggleShortlist }) => {
  const ext = item.extension || {}
  const meta = []
  if (item.type === 'book') meta.push(ext.author, ext.published_year)
  if (item.type === 'tv') meta.push(ext.network_or_service, `${ext.seasons || 1}S`)
  if (item.type === 'movie') meta.push(ext.director, ext.release_year)
  if (item.type === 'article') meta.push(ext.source)
  if (item.type === 'video') meta.push(ext.channel)
  if (item.type === 'podcast') meta.push(ext.host, ext.publisher)
  const lenShort = formatLengthShort(item)
  if (lenShort) meta.push(lenShort)
  return (
    <div onClick={onClick} style={{
      display: 'grid', gridTemplateColumns: '48px 1fr auto', gap: 14, alignItems: 'center',
      padding: '11px 0', borderBottom: '1px solid var(--hairline)', cursor: 'pointer',
    }}>
      <div style={{ ...posterFrame, aspectRatio: '2 / 3' }}>
        <Cover item={item} />
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
          <TypeIcon type={item.type} size={11} weight={1.4} />
          <Mono size={9} dim>{meta.filter(Boolean).join(' · ')}</Mono>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontWeight: 700, fontSize: 17, lineHeight: 1.15, color: 'var(--text)',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>{item.title}</div>
        <FulfillmentPills item={item} compact />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <Mono size={9} dim>↗ {item.recommended_by}</Mono>
          {(item.with || []).length > 0 && (
            <>
              <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
              <SharedMark item={item} />
            </>
          )}
          {ext.genre && (
            <>
              <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
              <Mono size={9} dim>{ext.genre}</Mono>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <StatusDot status={item.status} />
        {item.rating && <RatingDots rating={item.rating} />}
        {/* Shortlist toggle. Both swipe directions are already spoken for
            (Watched / Delete), so this is an explicit tap target. */}
        {onToggleShortlist && item.status !== 'done' && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleShortlist(item) }}
            title={item.queue_rank != null ? 'Remove from Up Next' : 'Put up next'}
            style={{
              appearance: 'none', cursor: 'pointer', padding: '2px 7px', borderRadius: 999,
              background: item.queue_rank != null
                ? 'color-mix(in oklab, var(--signal) 16%, transparent)' : 'transparent',
              border: `1px solid ${item.queue_rank != null ? 'var(--signal)' : 'var(--hairline-strong)'}`,
              color: item.queue_rank != null ? 'var(--signal)' : 'var(--muted)',
              fontFamily: 'var(--ui)', fontSize: 8.5, letterSpacing: '0.1em',
              textTransform: 'uppercase', whiteSpace: 'nowrap',
            }}
          >{item.queue_rank != null ? `↑ ${item.queue_rank}` : '↑ Next'}</button>
        )}
      </div>
    </div>
  )
}

// Everything a search should hit: the title plus whoever made it and whoever
// recommended it.
export const searchText = (item) => {
  const e = item.extension || {}
  return [
    item.title, e.author, e.director, e.network_or_service, e.source, e.channel,
    e.host, e.artist, item.recommended_by, ...(item.tags || []),
  ].filter(Boolean).join(' ').toLowerCase()
}

export const LibraryPage = ({ items, onOpenItem, density, onSetDensity, onDelete, onRequestFinish, onToggleShortlist }) => {
  const ed = useEdition()
  const partner = ed.partner || 'Amanda'
  const [typeFilter, setTypeFilter] = useState('all')
  // Default to the working set — queued + active. 'done' stays selectable but
  // hidden by default so finishing an item drops it out of the list.
  const [statusFilter, setStatusFilter] = useState('open')
  const [from, setFrom] = useState('all')
  const [together, setTogether] = useState('all')
  const [genreFilter, setGenreFilter] = useState('all')
  const [lengthFilter, setLengthFilter] = useState('all')
  const [sort, setSort] = useState('recent')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const recommenders = useMemo(() => {
    const s = new Set(items.map((i) => i.recommended_by))
    return ['all', ...Array.from(s)]
  }, [items])

  // "From" collections: everything each person recommended, biggest first.
  // Shown as Letterboxd list stacks; tapping one is the From filter.
  const collections = useMemo(() => {
    const by = new Map()
    items.forEach((i) => {
      if (i.status === 'done' || !i.recommended_by) return
      if (!by.has(i.recommended_by)) by.set(i.recommended_by, [])
      by.get(i.recommended_by).push(i)
    })
    return Array.from(by, ([who, list]) => ({
      who,
      // Real art first so the fan reads as posters, not placeholder covers.
      list: list.slice().sort((a, b) => (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0)),
      together: list.filter((i) => (i.with || []).includes(partner)).length,
    })).sort((a, b) => b.list.length - a.list.length).slice(0, 4)
  }, [items, partner])

  const availableGenres = useMemo(() => {
    const s = new Set()
    items.forEach((i) => {
      const g = (i.extension || {}).genre
      if (!g) return
      if (typeFilter !== 'all' && i.type !== typeFilter) return
      s.add(g)
    })
    return Array.from(s).sort()
  }, [items, typeFilter])

  useEffect(() => {
    if (genreFilter !== 'all' && !availableGenres.includes(genreFilter)) setGenreFilter('all')
  }, [availableGenres, genreFilter])

  const filtered = useMemo(() => {
    let r = items.slice()
    if (q) r = r.filter((i) => searchText(i).includes(q))
    if (typeFilter !== 'all') r = r.filter((i) => i.type === typeFilter)
    // "Is this already in here?" -- a search reaches finished items too,
    // unless a status was picked on purpose.
    if (statusFilter === 'open') { if (!q) r = r.filter((i) => i.status !== 'done') }
    else if (statusFilter !== 'all') r = r.filter((i) => i.status === statusFilter)
    if (from !== 'all') r = r.filter((i) => i.recommended_by === from)
    if (together === 'with') r = r.filter((i) => (i.with || []).includes(partner))
    if (together === 'solo') r = r.filter((i) => !(i.with || []).includes(partner))
    if (genreFilter !== 'all') r = r.filter((i) => (i.extension || {}).genre === genreFilter)
    if (lengthFilter !== 'all') r = r.filter((i) => lengthBucket(i) === lengthFilter)
    if (sort === 'recent') r.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (sort === 'rating') r.sort((a, b) => (b.rating || 0) - (a.rating || 0))
    if (sort === 'alpha') r.sort((a, b) => a.title.localeCompare(b.title))
    // Shortlist first, in its own order; everything else keeps recency behind it.
    if (sort === 'up next') {
      r.sort((a, b) => {
        const ar = a.queue_rank ?? Infinity, br = b.queue_rank ?? Infinity
        if (ar !== br) return ar - br
        return (b.created_at || '').localeCompare(a.created_at || '')
      })
    }
    return r
  }, [items, q, typeFilter, statusFilter, from, together, partner, genreFilter, lengthFilter, sort])

  const activeFilters = [
    statusFilter !== 'open' && { key: 'status', label: statusFilter, clear: () => setStatusFilter('open') },
    lengthFilter !== 'all' && { key: 'length', label: lengthFilter, clear: () => setLengthFilter('all') },
    from !== 'all' && { key: 'from', label: `from ${from}`, clear: () => setFrom('all') },
    together === 'with' && { key: 'with', label: 'Nate and Amanda', clear: () => setTogether('all') },
    together === 'solo' && { key: 'solo', label: 'solo', clear: () => setTogether('all') },
    genreFilter !== 'all' && { key: 'genre', label: genreFilter, clear: () => setGenreFilter('all') },
  ].filter(Boolean)

  const clearAll = () => {
    setStatusFilter('open'); setLengthFilter('all'); setFrom('all'); setTogether('all'); setGenreFilter('all')
  }

  return (
    <div>
      <Masthead
        title="Library"
        stats={[
          { label: 'Saved', value: items.filter((i) => i.status !== 'done').length, onClick: () => setStatusFilter('open') },
          { label: 'Now', value: items.filter((i) => i.status === 'active').length, onClick: () => setStatusFilter('active') },
          { label: 'Finished', value: items.filter((i) => i.status === 'done').length, onClick: () => setStatusFilter('done') },
          { label: `With ${partner}`, value: items.filter((i) => (i.with || []).includes(partner)).length, onClick: () => setTogether('with') },
        ]}
        right={
          <button onClick={() => onSetDensity(density === 'grid' ? 'list' : 'grid')} style={{
            ...btnGhost, padding: '5px 9px', fontSize: 12,
          }}>{density === 'grid' ? 'List' : 'Grid'}</button>
        }
      />

      {/* Type tabs: Letterboxd's text tab strip, signal underline on the live one. */}
      <div style={{
        display: 'flex', gap: 18, overflowX: 'auto', scrollbarWidth: 'none',
        padding: '0 20px', borderBottom: '1px solid var(--hairline)',
      }}>
        {['all', ...TYPE_ORDER].map((t) => {
          const on = typeFilter === t
          return (
            <button key={t} onClick={() => setTypeFilter(t)} style={{
              appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
              padding: '10px 0 11px', flex: 'none',
              fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 500,
              color: on ? 'var(--text)' : 'var(--muted)',
              boxShadow: on ? 'inset 0 -2px var(--signal)' : 'none',
            }}>{t === 'all' ? 'All' : TYPE_META[t].plural}</button>
          )
        })}
      </div>

      <div style={{ padding: '14px 20px 0' }}>
          <div style={{ position: 'relative' }}>
            <input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your library"
              aria-label="Search your library"
              style={{
                appearance: 'none', width: '100%', boxSizing: 'border-box', outline: 0,
                padding: '10px 34px 10px 12px', borderRadius: 3, border: 0,
                background: 'var(--paper-soft)', color: 'var(--text)',
                fontFamily: 'var(--ui)', fontSize: 15,
              }}
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search" style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
                color: 'var(--muted)', fontSize: 18, lineHeight: 1, padding: '4px 6px',
              }}>×</button>
            )}
          </div>
      </div>

      {density === 'grid' && !q && from === 'all' && activeFilters.length === 0 && collections.length > 1 && (
        <section style={{ padding: '20px 20px 4px' }}>
          <SectionHead title="From" right={collections.length} />
          {collections.map((c) => (
            <button key={c.who} onClick={() => setFrom(c.who)} style={{
              appearance: 'none', background: 'transparent', border: 0, cursor: 'pointer',
              width: '100%', textAlign: 'left', color: 'inherit',
              display: 'grid', gridTemplateColumns: '150px 1fr', gap: 14, alignItems: 'center',
              padding: '11px 0', borderBottom: '1px solid var(--hairline)',
            }}>
              <PosterStack items={c.list} width={52} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 17, lineHeight: 1.15 }}>
                  {c.who === 'Me' ? 'Your own finds' : `From ${c.who}`}
                </div>
                <div style={{ marginTop: 4, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--muted)' }}>
                  {c.list.length} saved{c.together ? ` · ${c.together} with ${partner}` : ''}
                </div>
              </div>
            </button>
          ))}
        </section>
      )}

      <div style={{ padding: '16px 20px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setFiltersOpen((o) => !o)} style={{
            ...btnTextChip(filtersOpen || activeFilters.length > 0),
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <span>Filters</span>
            {activeFilters.length > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 14, height: 14, padding: '0 4px', borderRadius: 7,
                background: filtersOpen ? 'var(--ink)' : 'var(--signal)',
                color: filtersOpen ? 'var(--signal)' : 'var(--ink)',
                fontSize: 9, lineHeight: 1, fontWeight: 700,
              }}>{activeFilters.length}</span>
            )}
            <span style={{
              display: 'inline-block', fontSize: 9, marginLeft: 2,
              transform: filtersOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 180ms ease',
            }}>▾</span>
          </button>

          {!filtersOpen && activeFilters.map((f) => (
            <button key={f.key} onClick={f.clear} style={{
              ...btnTextChip(true),
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <span>{f.label}</span>
              <span style={{ opacity: 0.7, fontSize: 11, lineHeight: 0.6 }}>×</span>
            </button>
          ))}

          <span style={{ flex: 1 }} />
          <Mono size={9} dim>Sort</Mono>
          <button onClick={() => setSort(
            sort === 'recent' ? 'up next' : sort === 'up next' ? 'rating' : sort === 'rating' ? 'alpha' : 'recent',
          )} style={{ ...btnTextChip(true) }}>{sort}</button>
        </div>

        {filtersOpen && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: '12px 12px 14px',
            borderRadius: 3,
            background: 'var(--paper)',
            animation: 'field-in 240ms cubic-bezier(0.2, 0.7, 0.2, 1) backwards',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Mono size={9} dim style={{ minWidth: 48 }}>Status</Mono>
              {['open', 'queued', 'active', 'done', 'all'].map((s) => (
                <button key={s} onClick={() => setStatusFilter(s)} style={btnTextChip(statusFilter === s)}>
                  {s === 'open' ? 'in progress' : s === 'all' ? 'show done' : s}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Mono size={9} dim style={{ minWidth: 48 }}>Length</Mono>
              {['all', 'short', 'medium', 'long'].map((l) => (
                <button key={l} onClick={() => setLengthFilter(l)} style={btnTextChip(lengthFilter === l)}>
                  {l === 'all' ? 'any' : l}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Mono size={9} dim style={{ minWidth: 48 }}>From</Mono>
              {recommenders.slice(0, 6).map((r) => (
                <button key={r} onClick={() => setFrom(r)} style={btnTextChip(from === r)}>
                  {r === 'all' ? 'any' : r}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Mono size={9} dim style={{ minWidth: 48 }}>Watching</Mono>
              <button onClick={() => setTogether('all')} style={btnTextChip(together === 'all')}>any</button>
              <button onClick={() => setTogether('solo')} style={btnTextChip(together === 'solo')}>solo</button>
              <button onClick={() => setTogether('with')} style={{
                ...btnTextChip(together === 'with'),
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>
                <span style={{ fontFamily: 'var(--note)', fontStyle: 'italic', fontSize: 12, lineHeight: 0.7, transform: 'translateY(-1px)' }}>&amp;</span>
                Nate and Amanda
              </button>
            </div>

            {availableGenres.length > 0 && (
              <div style={{
                display: 'flex', gap: 6, overflowX: 'auto',
                padding: 2, scrollbarWidth: 'none', alignItems: 'center',
              }}>
                <Mono size={9} dim style={{ flexShrink: 0, minWidth: 48 }}>Genre</Mono>
                <button onClick={() => setGenreFilter('all')} style={btnTextChip(genreFilter === 'all')}>any</button>
                {availableGenres.map((g) => (
                  <button key={g} onClick={() => setGenreFilter(g)} style={btnTextChip(genreFilter === g)}>{g}</button>
                ))}
              </div>
            )}

            {activeFilters.length > 0 && (
              <div style={{
                display: 'flex', justifyContent: 'flex-end', paddingTop: 4,
                borderTop: '1px solid var(--hairline)',
              }}>
                <button onClick={clearAll} style={{ ...btnGhost, padding: '6px 10px', fontSize: 12 }}>Clear filters</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: '6px 20px 4px' }}>
        <SectionHead
          title={q ? `Matching “${query.trim()}”` : from !== 'all' ? `From ${from}` : sort === 'up next' ? 'Up next' : TYPE_META[typeFilter]?.plural || 'Everything'}
          right={`${filtered.length} of ${items.length}`}
        />
      </div>

      {density === 'grid' ? (
        <div style={{
          padding: '10px 20px 120px',
          display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px 9px',
        }}>
          {filtered.map((i) => <Card key={i.id} item={i} onClick={() => onOpenItem(i)} />)}
        </div>
      ) : (
        <div style={{ padding: '8px 20px 120px', display: 'flex', flexDirection: 'column' }}>
          {filtered.map((i) => (
            <SwipeRow
              key={i.id}
              leftLabel="Watched"
              rightLabel="Delete"
              onSwipeLeft={() => onRequestFinish && onRequestFinish(i)}
              onSwipeRight={() => onDelete && onDelete(i)}
            >
              <LibraryRow item={i} onClick={() => onOpenItem(i)} onToggleShortlist={onToggleShortlist} />
            </SwipeRow>
          ))}
        </div>
      )}
    </div>
  )
}

export { LibraryRow }
