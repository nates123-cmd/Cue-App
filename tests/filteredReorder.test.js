// Tests the REAL exported mergeFilteredOrder from src/pages/Active.jsx.
//
// This guards a data-loss bug, not a cosmetic one. With a type filter active,
// DragList only ever sees the visible rows. Handing its result straight to
// setShortlist would treat every hidden item as "no longer on the list" and
// null its queue_rank -- filtering to Movies, nudging one row, and silently
// losing every book and podcast off the shortlist.
//
// The contract: the returned order always contains exactly the same ids as the
// full order, hidden items never move, and visible items are redistributed
// through the slots they already occupied.
import { describe, it, expect } from 'vitest'
import { mergeFilteredOrder } from '../src/pages/Active.jsx'

describe('mergeFilteredOrder — reordering a filtered shortlist', () => {
  it('never loses an id', () => {
    const full = ['a', 'b', 'c', 'd', 'e']
    const out = mergeFilteredOrder(full, ['d', 'b'])
    expect(out.slice().sort()).toEqual(full.slice().sort())
    expect(out).toHaveLength(full.length)
  })

  it('leaves hidden items in their original positions', () => {
    // full:    a(0) b(1) c(2) d(3) e(4);  visible = b, d  -> slots 1 and 3
    // hidden a, c, e must stay at 0, 2, 4.
    const out = mergeFilteredOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])
    expect(out[0]).toBe('a')
    expect(out[2]).toBe('c')
    expect(out[4]).toBe('e')
  })

  it('applies the new visible order across the slots the visible items held', () => {
    const out = mergeFilteredOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])
    expect(out).toEqual(['a', 'd', 'c', 'b', 'e'])
  })

  it('is identity when the visible order is unchanged', () => {
    const full = ['a', 'b', 'c']
    expect(mergeFilteredOrder(full, ['a', 'c'])).toEqual(full)
  })

  it('behaves like a plain reorder when everything is visible', () => {
    expect(mergeFilteredOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('handles a single visible row without disturbing anything', () => {
    const full = ['a', 'b', 'c']
    expect(mergeFilteredOrder(full, ['b'])).toEqual(full)
  })

  it('handles an empty visible set', () => {
    const full = ['a', 'b']
    expect(mergeFilteredOrder(full, [])).toEqual(full)
  })

  it('does not mutate the array it is given', () => {
    const full = ['a', 'b', 'c']
    mergeFilteredOrder(full, ['c', 'a'])
    expect(full).toEqual(['a', 'b', 'c'])
  })
})
