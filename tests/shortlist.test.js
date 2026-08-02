// Tests the REAL exported shortlistOf from src/lib/items.js.
//
// The "Up Next" shortlist is a rank ordering laid over a ~108-row queue, kept
// deliberately separate from status: an item can be shortlisted and still not
// started. The contract this guards:
//   - order is by queue_rank ascending, NOT insertion or creation order
//   - queue_rank == null means "in the backlog", never on the list
//   - a finished item falls off on its own, without the rank being cleared
//   - media_entries-backed rows are read-only and can never be ranked
import { describe, it, expect } from 'vitest'
import { shortlistOf } from '../src/lib/items.js'

const rec = (id, over = {}) => ({
  id, _source: 'rec', status: 'queued', queue_rank: null, title: id, ...over,
})

describe('shortlistOf — the Up Next list', () => {
  it('orders by queue_rank ascending, not array order', () => {
    const items = [
      rec('c', { queue_rank: 3 }),
      rec('a', { queue_rank: 1 }),
      rec('b', { queue_rank: 2 }),
    ]
    expect(shortlistOf(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('excludes unranked backlog rows', () => {
    const items = [rec('ranked', { queue_rank: 1 }), rec('backlog')]
    expect(shortlistOf(items).map((i) => i.id)).toEqual(['ranked'])
  })

  it('drops a finished item even while it still carries a rank', () => {
    const items = [
      rec('done', { queue_rank: 1, status: 'done' }),
      rec('open', { queue_rank: 2 }),
    ]
    expect(shortlistOf(items).map((i) => i.id)).toEqual(['open'])
  })

  it('keeps active items — in progress is still up next', () => {
    const items = [rec('watching', { queue_rank: 1, status: 'active' })]
    expect(shortlistOf(items).map((i) => i.id)).toEqual(['watching'])
  })

  it('ignores media_entries rows, which are read-only and unrankable', () => {
    const items = [{ id: 'media:1', _source: 'media', status: 'done', queue_rank: 1 }]
    expect(shortlistOf(items)).toEqual([])
  })

  it('returns an empty list rather than throwing when nothing is ranked', () => {
    expect(shortlistOf([rec('a'), rec('b')])).toEqual([])
  })

  it('does not mutate the array it is given', () => {
    const items = [rec('c', { queue_rank: 2 }), rec('a', { queue_rank: 1 })]
    shortlistOf(items)
    expect(items.map((i) => i.id)).toEqual(['c', 'a'])
  })
})
