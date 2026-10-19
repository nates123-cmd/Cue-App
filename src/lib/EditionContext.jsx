import { createContext, useContext } from 'react'
import { PARTNER, TYPE_ORDER } from './meta'

// Edition (time-of-day theme) plus the per-login preferences from
// lib/settings.js: `types` is the ordered list of media types this person
// sees, `partner` the co-viewing partner or null when that UI is switched off.
export const EditionContext = createContext({
  edition: 'day', label: 'day', timeLabel: '',
  isPaper: true, partner: PARTNER, types: TYPE_ORDER,
})

export const useEdition = () => useContext(EditionContext)
