// Primitives: covers, cards, pills, spine codes. All consume CSS vars
// (--ink/--paper/--paper-soft/--signal/--text/--muted/--hairline) set on the
// app root, so they restyle with the day/night and accent tweaks.

import { useState } from 'react'
import { TypeIcon } from './TypeIcon'
import { metaFor, TYPE_META } from '../lib/meta'

// ── format / bucket helpers ─────────────────────────────────
export function formatLength(item) {
  const e = item.extension || {}
  if (item.type === 'book' && e.page_count) return `${e.page_count} pp`
  if (item.type === 'movie' && e.runtime_min) return `${e.runtime_min} min`
  if (item.type === 'tv') {
    const parts = []
    if (e.seasons) parts.push(`${e.seasons}S`)
    if (e.episodes_total) parts.push(`${e.episodes_total} eps`)
    if (e.runtime_per_ep) parts.push(`~${e.runtime_per_ep}m`)
    return parts.join(' · ')
  }
  if (item.type === 'article') {
    const parts = []
    if (e.est_read_min) parts.push(`${e.est_read_min}m read`)
    if (e.word_count) parts.push(`${e.word_count.toLocaleString()} words`)
    return parts.join(' · ')
  }
  if (item.type === 'video' && e.duration_min) return `${e.duration_min} min`
  return ''
}

export function formatLengthShort(item) {
  const e = item.extension || {}
  if (item.type === 'book' && e.page_count) return `${e.page_count}p`
  if (item.type === 'movie' && e.runtime_min) return `${e.runtime_min}m`
  if (item.type === 'tv') {
    if (e.episodes_total) return `${e.episodes_total} eps`
    if (e.seasons) return `${e.seasons}S`
  }
  if (item.type === 'article' && e.est_read_min) return `${e.est_read_min}m`
  if (item.type === 'video' && e.duration_min) return `${e.duration_min}m`
  return ''
}

export function lengthBucket(item) {
  const e = item.extension || {}
  if (item.type === 'book' && e.page_count) {
    if (e.page_count < 300) return 'short'
    if (e.page_count > 500) return 'long'
    return 'medium'
  }
  if (item.type === 'movie' && e.runtime_min) {
    if (e.runtime_min < 100) return 'short'
    if (e.runtime_min > 140) return 'long'
    return 'medium'
  }
  if (item.type === 'tv' && e.episodes_total) {
    if (e.episodes_total <= 16) return 'short'
    if (e.episodes_total > 30) return 'long'
    return 'medium'
  }
  if (item.type === 'article' && e.est_read_min) {
    if (e.est_read_min < 10) return 'short'
    if (e.est_read_min > 25) return 'long'
    return 'medium'
  }
  if (item.type === 'video' && e.duration_min) {
    if (e.duration_min < 30) return 'short'
    if (e.duration_min > 60) return 'long'
    return 'medium'
  }
  return null
}

// ── atoms ────────────────────────────────────────────────────
export const Mono = ({ children, size = 10, dim = false, style = {} }) => (
  <span style={{
    fontFamily: 'var(--mono)', fontSize: size, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: dim ? 'var(--muted)' : 'inherit',
    ...style,
  }}>{children}</span>
)

export const Spine = ({ type, year, size = 10 }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
    <Mono size={size}>{metaFor(type).spine}</Mono>
    <span style={{ width: 1, height: size - 2, background: 'var(--hairline-strong)', alignSelf: 'center' }} />
    {year && <Mono size={size} dim>{year}</Mono>}
  </div>
)

export const RatingDots = ({ rating, size = 7 }) => (
  <div style={{ display: 'flex', gap: 4 }}>
    {[1, 2, 3].map((n) => (
      <span key={n} style={{
        width: size, height: size, borderRadius: '50%',
        background: rating && n <= rating ? 'var(--signal)' : 'var(--hairline-strong)',
      }} />
    ))}
  </div>
)

export const GenrePill = ({ genre }) => (
  <span style={{
    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em',
    textTransform: 'uppercase', color: 'var(--text-soft)',
    padding: '2px 7px', borderRadius: 2,
    border: '1px solid var(--hairline-strong)', whiteSpace: 'nowrap',
  }}>{genre}</span>
)

export const LengthPill = ({ item, onDark = false }) => {
  const s = formatLengthShort(item)
  if (!s) return null
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: onDark ? '#f0e9dd' : 'var(--text-soft)',
      padding: '2px 6px', borderRadius: 2,
      background: onDark ? 'rgba(0,0,0,0.45)' : 'transparent',
      border: onDark ? '1px solid rgba(255,255,255,0.25)' : '1px solid var(--hairline-strong)',
      backdropFilter: onDark ? 'blur(4px)' : undefined,
      whiteSpace: 'nowrap',
    }}>{s}</span>
  )
}

// ── covers ───────────────────────────────────────────────────
const TypeCover = ({ item }) => {
  const [bg, fg] = item.image_tone || ['#2a2820', '#8a8260']
  const t = metaFor(item.type)
  const ext = item.extension || {}
  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      background: bg, color: '#f0e9dd',
      padding: '14px 14px 12px', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.07,
        background: `radial-gradient(circle at 20% 20%, ${fg}, transparent 50%)`,
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative' }}>
        <Mono size={9} style={{ color: fg, opacity: 0.9 }}>{t.spine}</Mono>
        <Mono size={9} style={{ color: fg, opacity: 0.7 }}>{ext.published_year || ext.source || ''}</Mono>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', position: 'relative' }}>
        <div style={{
          fontFamily: 'var(--display)',
          fontSize: 'clamp(18px, 2.2cqi, 28px)',
          fontStyle: 'italic', lineHeight: 1.05, letterSpacing: '-0.01em', textWrap: 'balance',
        }}>{item.title}</div>
      </div>
      <div style={{ position: 'relative', borderTop: `1px solid ${fg}40`, paddingTop: 8 }}>
        <Mono size={9} style={{ color: fg, opacity: 0.85 }}>{ext.author || ext.source || ''}</Mono>
      </div>
    </div>
  )
}

const StripedCover = ({ item }) => {
  const [bg, fg] = item.image_tone || ['#1a1a1a', '#7a7a7a']
  const t = metaFor(item.type)
  const ext = item.extension || {}
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: bg, color: '#f0e9dd', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: `repeating-linear-gradient(90deg, transparent 0, transparent 14px, ${fg}1a 14px, ${fg}1a 15px)`,
      }} />
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 60%, transparent 30%, ${bg} 95%)`,
      }} />
      <div style={{ position: 'absolute', inset: 0, padding: '14px 14px 12px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Mono size={9} style={{ color: fg }}>{t.spine}</Mono>
          <Mono size={9} style={{ color: fg, opacity: 0.7 }}>
            {ext.release_year || (ext.network_or_service && ext.network_or_service.toUpperCase()) || ''}
          </Mono>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 4 }}>
          <div style={{
            fontFamily: 'var(--display)', fontStyle: 'italic',
            fontSize: 'clamp(20px, 2.6cqi, 32px)',
            lineHeight: 1.0, letterSpacing: '-0.01em', textWrap: 'balance',
          }}>{item.title}</div>
        </div>
      </div>
    </div>
  )
}

const VideoCover = ({ item }) => {
  const [bg, fg] = item.image_tone || ['#1f1a17', '#7a5a3a']
  const t = metaFor(item.type)
  const ext = item.extension || {}
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: bg, color: '#f0e9dd', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: `repeating-linear-gradient(0deg, transparent 0, transparent 12px, ${fg}1a 12px, ${fg}1a 13px)`,
      }} />
      <div style={{ position: 'absolute', inset: 0, padding: '14px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Mono size={9} style={{ color: fg }}>{t.spine}</Mono>
          <Mono size={9} style={{ color: fg, opacity: 0.7 }}>{ext.duration_min ? `${ext.duration_min} min` : ''}</Mono>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            border: `1.5px solid ${fg}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1l9 6-9 6V1z" fill={fg}/></svg>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{
            fontFamily: 'var(--display)', fontStyle: 'italic',
            fontSize: 'clamp(16px, 2.1cqi, 24px)',
            lineHeight: 1.05, letterSpacing: '-0.01em', textWrap: 'balance',
          }}>{item.title}</div>
          <Mono size={9} style={{ color: fg, opacity: 0.85 }}>{ext.channel || ''}</Mono>
        </div>
      </div>
    </div>
  )
}

// Real-image cover wrapper. Renders the source image (Open Library / TMDB /
// YouTube thumb / OG image) with object-cover fit. If the image fails to load
// or the parent type wants the designed look, falls back to the designed cover.
const ImageCover = ({ item, fallback }) => {
  const [errored, setErrored] = useState(false)
  if (errored) return fallback
  const isLandscape = item.cover_kind === 'thumb' || item.type === 'video'
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#000', overflow: 'hidden' }}>
      <img
        src={item.image_url}
        alt={item.title}
        onError={() => setErrored(true)}
        style={{
          width: '100%', height: '100%',
          objectFit: 'cover',
          objectPosition: isLandscape ? 'center' : 'center top',
          display: 'block',
        }}
      />
    </div>
  )
}

export const Cover = ({ item }) => {
  let designed
  if (item.cover_kind === 'thumb') designed = <VideoCover item={item} />
  else if (item.cover_kind === 'poster') designed = <StripedCover item={item} />
  else designed = <TypeCover item={item} />
  if (item.image_url) return <ImageCover item={item} fallback={designed} />
  return designed
}

// ── rotten tomatoes mini ─────────────────────────────────────
export const RottenScore = ({ critics, audience }) => {
  if (critics == null && audience == null) return null
  const Stat = ({ label, value }) => {
    if (value == null) return null
    const fresh = value >= 60
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <Mono size={9} dim>{label}</Mono>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span style={{
              fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: 22,
              lineHeight: 1, color: fresh ? 'var(--signal)' : 'var(--muted)', fontWeight: 400,
            }}>{value}</span>
            <Mono size={9} dim>%</Mono>
          </div>
        </div>
        <div style={{ position: 'relative', height: 2, background: 'var(--hairline)', borderRadius: 1 }}>
          <div style={{
            position: 'absolute', inset: '0 auto 0 0',
            width: `${value}%`, background: fresh ? 'var(--signal)' : 'var(--muted)',
            borderRadius: 1,
          }} />
        </div>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', gap: 18, padding: '12px 14px',
      border: '1px solid var(--hairline)', borderRadius: 3,
      background: 'color-mix(in oklab, var(--paper) 50%, transparent)',
    }}>
      <Stat label="Critics" value={critics} />
      <span style={{ width: 1, background: 'var(--hairline)' }} />
      <Stat label="Audience" value={audience} />
    </div>
  )
}

export const WatchOn = ({ services }) => {
  if (!services || !services.length) return null
  return (
    <div>
      <Mono size={9} dim style={{ display: 'block', marginBottom: 8 }}>Where to watch</Mono>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {services.map((s, i) => (
          <button key={s} style={{
            appearance: 'none', cursor: 'pointer',
            padding: '8px 12px', borderRadius: 2,
            background: i === 0 ? 'var(--paper-soft)' : 'transparent',
            color: 'var(--text)', border: '1px solid var(--hairline-strong)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
            textTransform: 'uppercase', fontWeight: 500,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: 'var(--signal)',
            }} />
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── status + shared marks + cards ────────────────────────────
export const StatusDot = ({ status }) => {
  const colors = { queued: 'var(--muted)', active: 'var(--signal)', done: 'var(--hairline-strong)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'var(--muted)',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: colors[status],
        boxShadow: status === 'active' ? '0 0 0 3px color-mix(in oklab, var(--signal) 25%, transparent)' : 'none',
      }} />
      {status}
    </span>
  )
}

export const SharedMark = ({ item, partner = 'Amanda', size = 9 }) => {
  if (!(item.with || []).includes(partner)) return null
  const sayUs = item.recommended_by === partner
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 4,
      color: 'var(--signal)',
      fontFamily: 'var(--mono)', fontSize: size, letterSpacing: '0.12em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      <span style={{
        fontFamily: 'var(--display)', fontStyle: 'italic',
        fontSize: size + 4, lineHeight: 0.7, transform: 'translateY(1px)',
      }}>&amp;</span>
      <span>{sayUs ? 'us' : partner}</span>
    </span>
  )
}

export const Card = ({ item, onClick }) => {
  const ext = item.extension || {}
  const isActive = item.status === 'active'
  return (
    <div onClick={onClick} style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        aspectRatio: '3 / 4', background: 'var(--paper)',
        border: '1px solid var(--hairline)', borderRadius: 4, overflow: 'hidden',
        position: 'relative',
        boxShadow: '0 1px 0 rgba(0,0,0,0.4), 0 12px 28px -16px rgba(0,0,0,0.6)',
        containerType: 'inline-size',
      }}>
        <Cover item={item} />
        {formatLengthShort(item) && (
          <div style={{ position: 'absolute', top: 8, left: 8 }}>
            <LengthPill item={item} onDark />
          </div>
        )}
        {(item.type === 'movie' || item.type === 'tv') && ext.rt_critics != null && (
          <div style={{
            position: 'absolute', bottom: 8, right: 8,
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 7px', borderRadius: 2,
            background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)',
            backdropFilter: 'blur(4px)', color: '#f0e9dd',
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.08em', fontWeight: 600,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: ext.rt_critics >= 60 ? 'var(--signal)' : 'rgba(240,232,216,0.5)',
            }} />
            {ext.rt_critics}
          </div>
        )}
        {isActive && (
          <div style={{
            position: 'absolute', top: 8, right: 8,
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 7px 3px 6px',
            background: 'var(--signal)', color: 'var(--ink)',
            borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 8.5,
            letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', background: 'var(--ink)',
              animation: 'pulse-now 1.6s ease-in-out infinite',
            }} />
            Now
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--text)', opacity: 0.85 }}>
            <TypeIcon type={item.type} size={13} weight={1.4} />
          </div>
          <Mono size={9} dim>{metaFor(item.type).spine}</Mono>
          <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
          <Mono size={9} dim>{item.recommended_by}</Mono>
          {(item.with || []).length > 0 && (
            <>
              <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
              <SharedMark item={item} />
            </>
          )}
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 18, lineHeight: 1.15,
          letterSpacing: '-0.005em', color: 'var(--text)', textWrap: 'balance',
        }}>{item.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
          <StatusDot status={item.status} />
          {item.rating && <RatingDots rating={item.rating} />}
          {ext.genre && (
            <Mono size={9} dim style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ext.genre}
            </Mono>
          )}
        </div>
      </div>
    </div>
  )
}

// Movies/articles/videos don't track incremental progress — "Bump" was a no-op
// for them. They get a Finish-only footer instead.
const hasIncrementalProgress = (type) => type === 'book' || type === 'tv'

const shortAgo = (iso) => {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return null
  const days = Math.floor(ms / 86400000)
  if (days >= 14) return `${Math.floor(days / 7)}w ago`
  if (days >= 1) return `${days}d ago`
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `${hours}h ago`
  return 'just now'
}

export const ProgressCard = ({ item, onBump, onFinish }) => {
  const ext = item.extension || {}
  const incremental = hasIncrementalProgress(item.type)
  let progress = { current: '', total: '', pct: 0, label: '' }
  if (item.type === 'book') {
    progress = {
      current: ext.current_page, total: ext.page_count,
      pct: ext.page_count ? (ext.current_page / ext.page_count) : 0,
      label: 'page',
    }
  } else if (item.type === 'tv') {
    const cur = ((ext.current_season || 1) - 1) * (ext.episodes_total / (ext.seasons || 1)) + (ext.current_episode || 0)
    progress = {
      current: `S${ext.current_season} · E${ext.current_episode}`,
      total: `of ${ext.seasons} season${ext.seasons > 1 ? 's' : ''}`,
      pct: ext.episodes_total ? cur / ext.episodes_total : 0,
      label: 'episode',
    }
  }
  const startedAgo = !incremental ? shortAgo(item.started_at) : null
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '92px 1fr', gap: 16,
      padding: '14px',
      background: 'var(--paper)', border: '1px solid var(--hairline)',
      borderRadius: 4,
      boxShadow: '0 1px 0 rgba(0,0,0,0.35), 0 16px 36px -20px rgba(0,0,0,0.65)',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 2, background: 'var(--signal)' }} />
      <div style={{
        aspectRatio: '3 / 4', borderRadius: 3, overflow: 'hidden',
        background: 'var(--ink)',
        boxShadow: '0 4px 14px -6px rgba(0,0,0,0.7)',
        containerType: 'inline-size',
      }}>
        <Cover item={item} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)' }}>
          <TypeIcon type={item.type} size={12} weight={1.4} />
          <Mono size={9} dim>{metaFor(item.type).spine}</Mono>
          <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
          <Mono size={9} dim>{item.recommended_by}</Mono>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 19, lineHeight: 1.15,
          letterSpacing: '-0.005em', color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{item.title}</div>
        <div style={{ marginTop: 'auto', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {incremental ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Mono size={10}>{progress.current}</Mono>
                <Mono size={9} dim>{progress.total}{item.type === 'book' && ` pages`}</Mono>
              </div>
              <div style={{ height: 2, background: 'var(--hairline)', position: 'relative', borderRadius: 1 }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${Math.min(100, progress.pct * 100)}%`,
                  background: 'var(--signal)', borderRadius: 1,
                }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button onClick={(e) => { e.stopPropagation(); onBump && onBump(item) }} style={btnGhost}>+ Bump</button>
                <button onClick={(e) => { e.stopPropagation(); onFinish && onFinish(item) }} style={btnPrimary}>Finish</button>
              </div>
            </>
          ) : (
            <>
              <Mono size={9} dim>{startedAgo ? `Started ${startedAgo}` : 'In progress'}</Mono>
              <button
                onClick={(e) => { e.stopPropagation(); onFinish && onFinish(item) }}
                style={{ ...btnPrimary, marginTop: 4, width: '100%' }}
              >Finish</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── button styles ────────────────────────────────────────────
export const btnPrimary = {
  appearance: 'none', border: 0, cursor: 'pointer',
  padding: '8px 14px', borderRadius: 3,
  background: 'var(--signal)', color: 'var(--ink)',
  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
  textTransform: 'uppercase', fontWeight: 600,
}

export const btnGhost = {
  appearance: 'none', cursor: 'pointer',
  padding: '8px 14px', borderRadius: 3,
  background: 'transparent', color: 'var(--text)',
  border: '1px solid var(--hairline-strong)',
  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
  textTransform: 'uppercase', fontWeight: 500,
}

export const btnTextChip = (active) => ({
  appearance: 'none', cursor: 'pointer',
  padding: '6px 10px', borderRadius: 2,
  background: active ? 'var(--text)' : 'transparent',
  color: active ? 'var(--ink)' : 'var(--text)',
  border: `1px solid ${active ? 'var(--text)' : 'var(--hairline-strong)'}`,
  fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.14em',
  textTransform: 'uppercase', fontWeight: 500, whiteSpace: 'nowrap',
})
