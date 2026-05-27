import { createContext, useContext } from 'react'

export const EditionContext = createContext({
  edition: 'day', label: 'day', timeLabel: '',
  isPaper: true, partner: 'Amanda',
})

export const useEdition = () => useContext(EditionContext)
