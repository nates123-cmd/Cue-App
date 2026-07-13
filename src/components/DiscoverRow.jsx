import { useEffect, useRef, useState } from 'react'
import { Cover, Mono } from './primitives'
import { TypeIcon } from './TypeIcon'

// One horizontally-scrolling row of the Discover feed ("New on Netflix", …).
//
// Rows fetch themselves the first time they scroll into view rather than all at
// once on mount: the feed is ~9 rows and each provider row costs two TMDB calls,
// so eager loading would fire ~17 requests to paint a screen that shows two.
const TILE_W = 108

// A feed entry → the shape <Cover> renders. Discover entries always carry a
// TMDB poster (posterless ones are filtered out upstream), so this is the
// poster path in practice; the designed cover stays as the fallback.
function asCoverItem(entry) {
  return {
    title: entry.title,
    type: entry.type,
    image_url: entry.facts?.image_url || null,
    image_tone: null,
    cover_kind: 'poster',
    extension: entry.facts || {},
  }
}

const Tile = ({ entry, inLibrary, onOpen }) => {
  const f = entry.facts || {}
  const year = f.release_year || f.first_air_year || null
  return (
    <button
      onClick={() => onOpen(entry)}
      style={{
        appearance: 'none', background: 'transparent', border: 0, padding: 0,
        cursor: 'pointer', textAlign: 'left',
        width: TILE_W, flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 7,
        scrollSnapAlign: 'start',
      }}
    >
      <div style={{
        aspectRatio: '3 / 4', width: '100%', position: 'relative',
        borderRadius: 4, overflow: 'hidden',
        border: '1px solid var(--hairline)', background: 'var(--paper)',
        containerType: 'inline-size',
        boxShadow: '0 1px 0 rgba(0,0,0,0.4), 0 10px 22px -14px rgba(0,0,0,0.6)',
      }}>
        <Cover item={asCoverItem(entry)} />
        {inLibrary && (
          <div
            title="Already in your library"
            style={{
              position: 'absolute', top: 6, right: 6,
              width: 18, height: 18, borderRadius: '50%',
              background: 'var(--signal)', color: 'var(--ink)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px -2px rgba(0,0,0,0.6)',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.2l2.3 2.3 4.7-5" />
            </svg>
          </div>
        )}
        <div style={{
          position: 'absolute', bottom: 6, left: 6,
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 5px', borderRadius: 2,
          background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)',
          backdropFilter: 'blur(4px)', color: '#f0e9dd',
        }}>
          <TypeIcon type={entry.type} size={9} weight={1.5} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 13.5, lineHeight: 1.2,
          color: 'var(--text)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>{entry.title}</div>
        {year && <Mono size={8.5} dim>{year}</Mono>}
      </div>
    </button>
  )
}

const TileSkeleton = ({ i }) => (
  <div style={{ width: TILE_W, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
    <div style={{
      aspectRatio: '3 / 4', borderRadius: 4,
      background: 'linear-gradient(90deg, transparent, var(--hairline-strong), transparent)',
      backgroundSize: '200% 100%', animation: `shimmer 1.4s linear ${i * 0.08}s infinite`,
      border: '1px solid var(--hairline)',
    }} />
    <div style={{ height: 9, width: '80%', borderRadius: 1, background: 'var(--hairline)' }} />
  </div>
)

export const DiscoverRow = ({ row, libraryKeys, onOpen }) => {
  const [entries, setEntries] = useState(null) // null = not fetched yet
  const [failed, setFailed] = useState(false)
  const ref = useRef(null)
  const firedRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || firedRef.current) return

    const load = () => {
      if (firedRef.current) return
      firedRef.current = true
      row.fetch()
        .then((e) => setEntries(e))
        .catch(() => { setFailed(true); setEntries([]) })
    }

    // rootMargin starts the fetch a screen early, so a row is usually populated
    // by the time it is actually scrolled to.
    const io = new IntersectionObserver(
      (obs) => { if (obs.some((o) => o.isIntersecting)) { load(); io.disconnect() } },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [row])

  // A row that came back empty is not an error worth showing — a provider
  // simply may have nothing new in the window. Collapse it silently.
  if (entries && entries.length === 0 && !failed) return null

  return (
    <section ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, paddingRight: 4 }}>
        <h2 style={{
          margin: 0, fontFamily: 'var(--display)', fontStyle: 'italic',
          fontSize: 20, lineHeight: 1, fontWeight: 400, color: 'var(--text)',
        }}>{row.title}</h2>
        <Mono size={8.5} dim style={{ flexShrink: 0 }}>{row.kicker}</Mono>
      </div>

      {failed ? (
        <Mono size={9} dim>Could not load this row.</Mono>
      ) : (
        <div
          style={{
            display: 'flex', gap: 12, overflowX: 'auto', overflowY: 'hidden',
            scrollSnapType: 'x proximity',
            // Bleed the row to the screen edges so posters run off-screen the way
            // they do in Overseerr, while the page keeps its 20px gutter.
            margin: '0 -20px', padding: '2px 20px 4px',
            // Without this the snapport starts at the scrollport edge, so the
            // first tile snaps flush to the screen edge and eats the 20px
            // padding — the row would sit a gutter left of its own header.
            scrollPaddingLeft: 20,
            scrollbarWidth: 'none',
          }}
        >
          {entries === null
            ? [0, 1, 2, 3, 4].map((i) => <TileSkeleton key={i} i={i} />)
            : entries.map((e) => (
              <Tile
                key={e.id}
                entry={e}
                inLibrary={libraryKeys.has(`${e.type}:${e.title.toLowerCase().trim()}`)}
                onOpen={onOpen}
              />
            ))}
        </div>
      )}
    </section>
  )
}
