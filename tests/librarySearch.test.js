import { describe, expect, it } from 'vitest'
import { searchText } from '../src/pages/Library.jsx'

describe('library search text', () => {
  it('covers title, creator, recommender and tags, lowercased', () => {
    const t = searchText({
      title: 'Past Lives', recommended_by: 'Amanda', tags: ['date night'],
      extension: { director: 'Celine Song' },
    })
    expect(t).toContain('past lives')
    expect(t).toContain('celine song')
    expect(t).toContain('amanda')
    expect(t).toContain('date night')
  })

  it('tolerates missing extension and tags', () => {
    expect(searchText({ title: 'Severance' })).toBe('severance')
  })
})
