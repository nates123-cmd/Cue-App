// Type glyphs — minimal, single-stroke, distinct silhouettes.
export function TypeIcon({ type, size = 18, weight = 1.5 }) {
  const s = { width: size, height: size, stroke: 'currentColor', strokeWidth: weight, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }
  switch (type) {
    case 'book':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <path d="M3 5.5C5.5 4.5 9 4.5 12 6c3-1.5 6.5-1.5 9-0.5v13c-2.5-1-6-1-9 0.5-3-1.5-6.5-1.5-9-0.5v-13z" />
          <path d="M12 6v13.5" />
        </svg>
      )
    case 'tv':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect x="2.5" y="4.5" width="19" height="13" rx="1.5" />
          <path d="M8 20.5h8M12 17.5v3" />
        </svg>
      )
    case 'movie':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
          <path d="M3.5 8h17M3.5 16h17M8 3.5v17M16 3.5v17" />
        </svg>
      )
    case 'article':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <path d="M5 3.5h10l4 4v13a0.5 0.5 0 01-0.5 0.5h-13a0.5 0.5 0 01-0.5-0.5v-16a0.5 0.5 0 01.5-0.5z" />
          <path d="M14.5 3.5v4h4M8 12h8M8 15.5h8M8 8.5h3" />
        </svg>
      )
    case 'video':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
          <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'podcast':
      return (
        <svg viewBox="0 0 24 24" style={s}>
          <rect x="8.5" y="3" width="7" height="11" rx="3.5" />
          <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" />
        </svg>
      )
    default:
      return null
  }
}
