// Primitives: covers, cards, pills, labels. All consume CSS vars
// (--ink/--paper/--paper-soft/--signal/--text/--muted/--hairline, and the
// --display/--read/--ui/--note faces) set on the app root. See DESIGN.md:
// the poster is the object, chrome recedes (Letterboxd), and who-recommended-it
// gets a Strand staff-pick card.

import { useState } from 'react'
import { TypeIcon } from './TypeIcon'
import { fulfillmentBadges } from '../lib/fulfillment'
import { metaFor, RATING_MAX, TYPE_META } from '../lib/meta'

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
// Small spaced caps in the UI grotesk -- Letterboxd's section-label voice.
// (Was a monospace; the name stayed so ~100 call sites did not churn.) Grotesk
// caps read smaller than mono at the same size, hence the +1.
export const Mono = ({ children, size = 10, dim = false, style = {} }) => (
  <span style={{
    fontFamily: 'var(--ui)', fontSize: size + 1, letterSpacing: '0.08em',
    fontWeight: 500,
    textTransform: 'uppercase', color: dim ? 'var(--muted)' : 'inherit',
    ...style,
  }}>{children}</span>
)

// Section heading: spaced caps, a hairline under it, an optional count or
// action flush right. The one way Cue divides a screen.
export const SectionHead = ({ title, right, onRight, style = {} }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10,
    paddingBottom: 7, borderBottom: '1px solid var(--hairline-strong)', ...style,
  }}>
    <Mono size={10.5} style={{ color: 'var(--text-soft)' }}>{title}</Mono>
    {right != null && (onRight ? (
      <button onClick={onRight} style={{
        appearance: 'none', background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
        color: 'var(--muted)',
      }}><Mono size={9.5}>{right}</Mono></button>
    ) : <Mono size={9.5} dim>{right}</Mono>)}
  </div>
)

// The poster frame: 3px corners, a faint light keyline inside, no drop shadow.
export const posterFrame = {
  borderRadius: 3, overflow: 'hidden', position: 'relative',
  background: 'var(--paper)', containerType: 'inline-size',
}
const PosterKeyline = () => (
  <span aria-hidden style={{
    position: 'absolute', inset: 0, borderRadius: 3, pointerEvents: 'none',
    boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--text) 16%, transparent)',
  }} />
)

// Overlapping fan of covers -- the Letterboxd list preview. A collection
// (everything one person recommended) shown as the objects in it.
export const PosterStack = ({ items, width = 58, overlap = 0.55, max = 5 }) => {
  const shown = items.slice(0, max)
  return (
    <div style={{ display: 'flex', flex: 'none', width: width + (shown.length - 1) * width * (1 - overlap) }}>
      {shown.map((it, i) => (
        <div key={it.id} style={{
          ...posterFrame, width, flex: 'none', aspectRatio: '2 / 3',
          marginLeft: i === 0 ? 0 : -width * overlap, zIndex: max - i,
          boxShadow: i === shown.length - 1 ? 'none' : '5px 0 8px -4px rgba(0,0,0,0.55)',
        }}>
          <Cover item={it} />
          <PosterKeyline />
        </div>
      ))}
    </div>
  )
}

// Strand staff-pick card: a signal band naming whose pick it is, then the
// card body. Only the band uses the --note italic.
export const PickCard = ({ who, when, children }) => (
  <div style={{ background: 'var(--paper)', borderRadius: 3, overflow: 'hidden' }}>
    <div style={{
      background: 'var(--signal)', color: 'var(--ink)',
      padding: '7px 12px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10,
    }}>
      <span style={{ fontFamily: 'var(--note)', fontStyle: 'italic', fontSize: 20, lineHeight: 1 }}>{who}</span>
      {when && <Mono size={9} style={{ fontWeight: 600 }}>{when}</Mono>}
    </div>
    <div style={{ padding: '12px 12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {children}
    </div>
  </div>
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
    {Array.from({ length: RATING_MAX }, (_, i) => i + 1).map((n) => (
      <span key={n} style={{
        width: size, height: size, borderRadius: '50%',
        background: rating && n <= rating ? 'var(--signal)' : 'var(--hairline-strong)',
      }} />
    ))}
  </div>
)

// Tappable rating. One button per dot, filled up to the current value; tapping
// the current value clears it.
//
// The old 3-point version rendered a whole RatingDots row *inside* each of its
// three buttons (three progressively-filled triplets). That does not scale --
// at five it would be twenty-five dots -- so the picker is now one dot per
// button, which is also what a rating control is normally expected to be.
export const RatingPicker = ({ value, onChange, size = 12, disabled = false, gap = 8 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap }}>
    {Array.from({ length: RATING_MAX }, (_, i) => i + 1).map((n) => (
      <button
        key={n}
        onClick={() => !disabled && onChange(value === n ? null : n)}
        disabled={disabled}
        aria-label={`${n} of ${RATING_MAX}`}
        style={{
          appearance: 'none', background: 'transparent', border: 0,
          padding: 3, lineHeight: 0,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <span style={{
          display: 'block', width: size, height: size, borderRadius: '50%',
          background: value && n <= value ? 'var(--signal)' : 'var(--hairline-strong)',
          transition: 'background 140ms ease',
        }} />
      </button>
    ))}
  </div>
)

export const GenrePill = ({ genre }) => (
  <span style={{
    fontFamily: 'var(--ui)', fontSize: 9, letterSpacing: '0.1em',
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
      fontFamily: 'var(--ui)', fontSize: 9, letterSpacing: '0.1em',
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
          fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em', textWrap: 'balance',
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
            fontFamily: 'var(--display)', fontWeight: 700,
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
            fontFamily: 'var(--display)', fontWeight: 700,
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
          maxWidth: '100%', minWidth: 0,
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
              fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22,
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
            fontFamily: 'var(--ui)', fontSize: 10, letterSpacing: '0.12em',
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
      fontFamily: 'var(--ui)', fontSize: 9, letterSpacing: '0.12em',
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

// Sticky pipeline status: "ebook delivered", "audiobook downloaded",
// "place synced". Reads `recommendations.fulfillment`, which the Beelink
// daemons stamp — unlike the DownloadTray these never expire, because the
// question ("is this on my Kindle?") outlives the download by months.
const FULFILLMENT_TONE_STYLE = {
  wait: { dot: 'var(--muted)', text: 'var(--muted)', ring: 'none' },
  go: {
    dot: 'var(--signal)',
    text: 'var(--text)',
    ring: '0 0 0 3px color-mix(in oklab, var(--signal) 22%, transparent)',
  },
  done: { dot: 'color-mix(in oklab, var(--text) 60%, transparent)', text: 'var(--muted)', ring: 'none' },
  fail: { dot: 'transparent', text: 'var(--signal)', ring: 'inset 0 0 0 1.5px var(--signal)' },
}

export const FulfillmentPills = ({ item, compact = false, max = null }) => {
  const badges = fulfillmentBadges(item)
  if (badges.length === 0) return null
  const shown = max ? badges.slice(0, max) : badges
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 7 : 10,
      flexWrap: 'wrap', minWidth: 0,
    }}>
      {shown.map((b) => {
        const tone = FULFILLMENT_TONE_STYLE[b.tone] || FULFILLMENT_TONE_STYLE.wait
        return (
          <span key={b.key} title={b.title} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
            fontFamily: 'var(--ui)', fontSize: compact ? 8.5 : 9,
            letterSpacing: '0.11em', textTransform: 'uppercase',
            color: tone.text, whiteSpace: 'nowrap',
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flex: 'none',
              background: tone.dot, boxShadow: tone.ring,
            }} />
            {compact ? b.short : b.label}
            {compact && b.pct != null && b.tone === 'go' ? ` ${b.pct}%` : ''}
          </span>
        )
      })}
    </div>
  )
}

export const SharedMark = ({ item, partner = 'Amanda', size = 9 }) => {
  if (!(item.with || []).includes(partner)) return null
  const sayUs = item.recommended_by === partner
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 4,
      color: 'var(--signal)',
      fontFamily: 'var(--ui)', fontSize: size, letterSpacing: '0.12em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      <span style={{
        fontFamily: 'var(--note)', fontStyle: 'italic',
        fontSize: size + 7, lineHeight: 0.7, transform: 'translateY(2px)',
      }}>&amp;</span>
      <span>{sayUs ? 'us' : partner}</span>
    </span>
  )
}

// Grid cell: the poster is the object. One quiet row under it -- the rating,
// the shared "&", a Now mark -- and pipeline pills only when they exist.
// The title lives on the cover (real art, or the designed cover prints it);
// it is also the accessible name.
export const Card = ({ item, onClick }) => {
  const isActive = item.status === 'active'
  const shared = (item.with || []).length > 0
  return (
    <div onClick={onClick} role="button" aria-label={item.title} style={{
      cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
    }}>
      {/* minWidth:0 above and below: a grid item defaults to min-width:auto, so a
          large intrinsic cover image can force its 1fr track wider than the cell. */}
      <div style={{ ...posterFrame, aspectRatio: '2 / 3', width: '100%', minWidth: 0 }}>
        <Cover item={item} />
        <PosterKeyline />
        {isActive && (
          <span aria-hidden style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'var(--signal)',
          }} />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 10, minWidth: 0 }}>
        {item.rating ? <RatingDots rating={item.rating} size={5} /> : isActive ? (
          <Mono size={8.5} style={{ color: 'var(--signal)', fontWeight: 600 }}>Now</Mono>
        ) : null}
        <span style={{ flex: 1 }} />
        {shared && <SharedMark item={item} size={8.5} />}
      </div>
      <FulfillmentPills item={item} compact max={2} />
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
      background: 'var(--paper)',
      borderRadius: 3,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 2, background: 'var(--signal)' }} />
      <div style={{
        ...posterFrame, aspectRatio: '2 / 3', alignSelf: 'start',
      }}>
        <Cover item={item} />
        <PosterKeyline />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)' }}>
          <TypeIcon type={item.type} size={12} weight={1.4} />
          <Mono size={9} dim>{metaFor(item.type).spine}</Mono>
          <span style={{ width: 1, height: 8, background: 'var(--hairline-strong)' }} />
          <Mono size={9} dim>{item.recommended_by}</Mono>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontWeight: 700, fontSize: 19, lineHeight: 1.15,
          letterSpacing: '-0.01em', color: 'var(--text)',
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
// Letterboxd buttons: filled blocks, small radius, sentence case in the UI
// grotesk. No outline-as-button; the signal fill is reserved for the one
// primary action on a surface.
export const btnPrimary = {
  appearance: 'none', border: 0, cursor: 'pointer',
  padding: '9px 14px', borderRadius: 3,
  background: 'var(--signal)', color: 'var(--ink)',
  fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600,
}

export const btnGhost = {
  appearance: 'none', cursor: 'pointer',
  padding: '9px 14px', borderRadius: 3,
  background: 'var(--paper-soft)', color: 'var(--text)',
  border: 0,
  fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 500,
}

export const btnTextChip = (active) => ({
  appearance: 'none', cursor: 'pointer',
  padding: '6px 10px', borderRadius: 3,
  background: active ? 'var(--text)' : 'var(--paper-soft)',
  color: active ? 'var(--ink)' : 'var(--text-soft)',
  border: 0,
  fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap',
})
