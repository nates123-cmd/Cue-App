import { useEffect, useMemo, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { TypeIcon } from '../components/TypeIcon'
import {
  Card, Cover, Mono, RatingDots, SharedMark, StatusDot,
  btnGhost, btnTextChip, formatLengthShort, lengthBucket,
} from '../components/primitives'
import { SwipeRow } from '../components/SwipeRow'
import { TYPE_META, TYPE_ORDER } from '../lib/meta'
import { useEdition } from '../lib/EditionContext'

const LibraryRow = ({ item, onClick }) => {
  const ext = item.extension || {}
  const meta = []
  if (item.type === 'book') meta.push(ext.author, ext.published_year)
  if (item.type === 'tv') meta.push(ext.network_or_service, `${ext.seasons || 1}S`)
  if (item.type === 'movie') meta.push(ext.director, ext.release_year)
  if (item.type === 'article') meta.push(ext.source)
  if (item.type === 'video') meta.push(ext.channel)
  const lenShort = formatLengthShort(item)
  if (lenShort) meta.push(lenShort)
  return (
    <div onClick={onClick} style={{
      display: 'grid', gridTemplateColumns: '54px 1fr auto', gap: 14, alignItems: 'center',
      padding: '12px 0', borderBottom: '1px solid var(--hairline)', cursor: 'pointer',
    }}>
      <div style={{
        aspectRatio: '3 / 4', overflow: 'hidden', borderRadius: 2,
        border: '1px solid var(--hairline)', containerType: 'inline-size',
      }}>
        <Cover item={item} />
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
          <TypeIcon type={item.type} size={11} weight={1.4} />
          <Mono size={9} dim>{meta.filter(Boolean).join(' · ')}</Mono>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 17, lineHeight: 1.15, color: 'var(--text)',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>{item.title}</div>
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
      </div>
    </div>
  )
}

export const LibraryPage = ({ items, onOpenItem, density, onSetDensity, onDelete, onRequestFinish }) => {
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

  const recommenders = useMemo(() => {
    const s = new Set(items.map((i) => i.recommended_by))
    return ['all', ...Array.from(s)]
  }, [items])

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
    if (typeFilter !== 'all') r = r.filter((i) => i.type === typeFilter)
    if (statusFilter === 'open') r = r.filter((i) => i.status !== 'done')
    else if (statusFilter !== 'all') r = r.filter((i) => i.status === statusFilter)
    if (from !== 'all') r = r.filter((i) => i.recommended_by === from)
    if (together === 'with') r = r.filter((i) => (i.with || []).includes(partner))
    if (together === 'solo') r = r.filter((i) => !(i.with || []).includes(partner))
    if (genreFilter !== 'all') r = r.filter((i) => (i.extension || {}).genre === genreFilter)
    if (lengthFilter !== 'all') r = r.filter((i) => lengthBucket(i) === lengthFilter)
    if (sort === 'recent') r.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (sort === 'rating') r.sort((a, b) => (b.rating || 0) - (a.rating || 0))
    if (sort === 'alpha') r.sort((a, b) => a.title.localeCompare(b.title))
    return r
  }, [items, typeFilter, statusFilter, from, together, partner, genreFilter, lengthFilter, sort])

  const activeFilters = [
    statusFilter !== 'open' && { key: 'status', label: statusFilter, clear: () => setStatusFilter('open') },
    lengthFilter !== 'all' && { key: 'length', label: lengthFilter, clear: () => setLengthFilter('all') },
    from !== 'all' && { key: 'from', label: `from ${from}`, clear: () => setFrom('all') },
    together === 'with' && { key: 'with', label: `with ${partner}`, clear: () => setTogether('all') },
    together === 'solo' && { key: 'solo', label: 'solo', clear: () => setTogether('all') },
    genreFilter !== 'all' && { key: 'genre', label: genreFilter, clear: () => setGenreFilter('all') },
  ].filter(Boolean)

  const clearAll = () => {
    setStatusFilter('open'); setLengthFilter('all'); setFrom('all'); setTogether('all'); setGenreFilter('all')
  }

  return (
    <div>
      <Masthead
        kicker={`No. 002 · Library · ${items.length} items`}
        title="The Collection"
        right={
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              onClick={() => setTogether(together === 'with' ? 'all' : 'with')}
              title={together === 'with' ? `Showing items with ${partner}` : `Filter to items with ${partner}`}
              style={{
                appearance: 'none', cursor: 'pointer',
                width: 26, height: 26, padding: 0, borderRadius: '50%',
                background: together === 'with' ? 'var(--signal)' : 'transparent',
                color: together === 'with' ? 'var(--ink)' : 'var(--text-soft)',
                border: `1px solid ${together === 'with' ? 'var(--signal)' : 'var(--hairline-strong)'}`,
                fontFamily: 'var(--display)', fontStyle: 'italic',
                fontSize: 16, lineHeight: 1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>&amp;</button>
            <button onClick={() => onSetDensity(density === 'grid' ? 'list' : 'grid')} style={{
              ...btnGhost, padding: '4px 8px', fontSize: 9,
            }}>{density === 'grid' ? '☷ List' : '▦ Grid'}</button>
          </div>
        }
      />

      <div style={{ padding: '14px 20px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{
          display: 'flex', gap: 6, overflowX: 'auto',
          marginLeft: -2, marginRight: -2, padding: 2,
          scrollbarWidth: 'none',
        }}>
          <button onClick={() => setTypeFilter('all')} style={btnTextChip(typeFilter === 'all')}>All</button>
          {TYPE_ORDER.map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)} style={{
              ...btnTextChip(typeFilter === t),
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <TypeIcon type={t} size={11} weight={1.4} />
              {TYPE_META[t].plural}
            </button>
          ))}
        </div>

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
          <button onClick={() => setSort(sort === 'recent' ? 'rating' : sort === 'rating' ? 'alpha' : 'recent')}
            style={{ ...btnTextChip(true) }}>{sort}</button>
        </div>

        {filtersOpen && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: '12px 12px 14px',
            border: '1px solid var(--hairline)', borderRadius: 3,
            background: 'color-mix(in oklab, var(--paper) 60%, transparent)',
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
                <span style={{ fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 12, lineHeight: 0.7, transform: 'translateY(-1px)' }}>&amp;</span>
                {partner}
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
                <button onClick={clearAll} style={{ ...btnGhost, padding: '4px 9px', fontSize: 9 }}>Clear filters</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: '0 20px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Mono size={9} dim>{filtered.length} of {items.length} · showing</Mono>
        <Mono size={9} dim>{TYPE_META[typeFilter]?.plural || 'mixed'}</Mono>
      </div>

      {density === 'grid' ? (
        <div style={{
          padding: '8px 20px 120px',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 14px',
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
              <LibraryRow item={i} onClick={() => onOpenItem(i)} />
            </SwipeRow>
          ))}
        </div>
      )}
    </div>
  )
}

export { LibraryRow }
