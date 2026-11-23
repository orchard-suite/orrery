import { describe, expect, it } from 'vitest'
import { DEFAULT_STANDARD, arrange, sizeByStandard, fromLegacy, hiddenByStandard, placeByHand, placeByStandard, showByHand, standardOrder, type ColumnFacts, type ColumnStandard } from './columns.ts'

const facts = (...ids: string[]): ColumnFacts[] => ids.map((id) => ({ id }))
const ids = (cols: { id: string }[]) => cols.map((c) => c.id)

const standard: ColumnStandard = {
  ranks: [
    { id: 'identity', columns: ['status', 'title'] },
    { id: 'ownership', columns: ['r:program', 'r:owner'] },
    { id: 'cost', columns: ['f:cost_month_to_date_cents', 'f:*_cents'] },
    { id: 'detail', columns: ['*'] },
    { id: 'raw', columns: ['@pivot', '@pivoted'] },
    { id: 'record', columns: ['key', 'state', 'owner', 'lastSeenAt', 'updatedAt'] },
  ],
  hidden: ['@pivot', 'f:tags_*', '!f:tags_environment', 'key'],
  widths: { 'f:sku': 60, 'f:*': 120 },
}

const columns: ColumnFacts[] = [
  { id: 'status' },
  { id: 'title' },
  { id: 'f:sku' },
  { id: 'f:tags', pivot: true },
  { id: 'f:tags_environment', pivoted: true },
  { id: 'f:tags_costcenter', pivoted: true },
  { id: 'f:cost_last_month_cents' },
  { id: 'f:cost_month_to_date_cents' },
  { id: 'r:owner' },
  { id: 'r:program' },
  { id: 'key' },
  { id: 'owner' },
]

describe('the column standard', () => {
  it('orders by rank, then pattern, then the blueprint', () => {
    expect(ids(standardOrder(standard, columns))).toEqual(['status', 'title', 'r:program', 'r:owner', 'f:cost_month_to_date_cents', 'f:cost_last_month_cents', 'f:sku', 'f:tags', 'f:tags_environment', 'f:tags_costcenter', 'key', 'owner'])
  })

  it('hides by pattern, and a later ! shows again', () => {
    expect(hiddenByStandard(standard, { id: 'f:tags', pivot: true })).toBe(true)
    expect(hiddenByStandard(standard, { id: 'f:tags_costcenter', pivoted: true })).toBe(true)
    expect(hiddenByStandard(standard, { id: 'f:tags_environment', pivoted: true })).toBe(false)
    expect(hiddenByStandard(standard, { id: 'f:sku' })).toBe(false)
  })

  it('puts what no rank names after every rank when there is no * rank', () => {
    const plain: ColumnStandard = { ranks: [{ id: 'a', columns: ['title'] }] }
    expect(ids(standardOrder(plain, facts('f:x', 'title', 'f:y')))).toEqual(['title', 'f:x', 'f:y'])
  })

  it('opens as the grid always has with the default standard', () => {
    const cols = facts('status', 'title', 'f:a', 'r:b', 'i:c.d', 's:e', 'u:e.f', 'a:g', 'key', 'state', 'owner', 'lastSeenAt', 'updatedAt')
    const out = arrange(DEFAULT_STANDARD, cols, [])
    expect(ids(out)).toEqual(ids(cols))
    expect(out.filter((c) => c.hidden).map((c) => c.id)).toEqual(['u:e.f', 'a:g'])
  })
})

describe('arranging a grid', () => {
  it('follows the standard where nobody changed anything', () => {
    const out = arrange(standard, columns, [])
    expect(ids(out)).toEqual(ids(standardOrder(standard, columns)))
    expect(out.filter((c) => c.hidden).map((c) => c.id)).toEqual(['f:tags', 'f:tags_costcenter', 'key'])
  })

  it('keeps a hand move when the standard changes', () => {
    const layout = [{ id: 'f:sku', after: 'title' }]
    expect(ids(arrange(standard, columns, layout)).slice(0, 4)).toEqual(['status', 'title', 'f:sku', 'r:program'])
    const reordered: ColumnStandard = { ...standard, ranks: [standard.ranks[0]!, standard.ranks[2]!, standard.ranks[1]!, ...standard.ranks.slice(3)] }
    expect(ids(arrange(reordered, columns, layout)).slice(0, 5)).toEqual(['status', 'title', 'f:sku', 'f:cost_month_to_date_cents', 'f:cost_last_month_cents'])
  })

  it('keeps a hand hide and a hand show over the standard', () => {
    const out = arrange(standard, columns, [{ id: 'f:sku', hidden: true }, { id: 'f:tags', hidden: false }])
    const hidden = new Map(out.map((c) => [c.id, c.hidden]))
    expect(hidden.get('f:sku')).toBe(true)
    expect(hidden.get('f:tags')).toBe(false)
  })

  it('places a column after a moved one', () => {
    const out = arrange(standard, columns, [
      { id: 'owner', after: 'title' },
      { id: 'key', after: 'owner' },
    ])
    expect(ids(out).slice(0, 4)).toEqual(['status', 'title', 'owner', 'key'])
  })

  it('keeps two columns placed after one in the order they were saved', () => {
    const out = arrange(standard, columns, [
      { id: 'owner', after: 'title' },
      { id: 'key', after: 'title' },
    ])
    expect(ids(out).slice(0, 4)).toEqual(['status', 'title', 'owner', 'key'])
  })

  it('falls back to the standard when the anchor is gone', () => {
    const out = arrange(standard, columns, [{ id: 'f:sku', after: 'f:deleted' }])
    expect(ids(out)).toEqual(ids(standardOrder(standard, columns)))
  })

  it('reads a layout saved before the standard as it was', () => {
    const saved = [{ id: 'title' }, { id: 'status' }, { id: 'f:sku' }, { id: 'owner', hidden: true }]
    const out = arrange(standard, columns, fromLegacy(saved))
    expect(ids(out).slice(0, 4)).toEqual(['title', 'status', 'f:sku', 'owner'])
    // What the old layout did not list takes the standard's order after it.
    expect(ids(out).slice(4)).toEqual(['r:program', 'r:owner', 'f:cost_month_to_date_cents', 'f:cost_last_month_cents', 'f:tags', 'f:tags_environment', 'f:tags_costcenter', 'key'])
    expect(out.find((c) => c.id === 'owner')!.hidden).toBe(true)
    // A column the old layout showed stays shown, even where the standard hides it.
    expect(arrange(standard, columns, fromLegacy([{ id: 'f:tags', pivot: true } as { id: string }])).find((c) => c.id === 'f:tags')!.hidden).toBe(false)
  })
})

describe('widths', () => {
  it('opens a column at the first width pattern that names it, and a hand width wins', () => {
    const out = arrange(standard, columns, [{ id: 'f:cost_month_to_date_cents', width: 90 }])
    const width = new Map(out.map((c) => [c.id, c.width]))
    expect(width.get('f:sku')).toBe(60)
    expect(width.get('f:tags')).toBe(120)
    expect(width.get('f:cost_month_to_date_cents')).toBe(90)
    expect(width.get('title')).toBeUndefined()
    expect(out.find((c) => c.id === 'f:cost_month_to_date_cents')!.sized).toBe(true)
  })

  it('gives a column back the standard width', () => {
    expect(sizeByStandard([{ id: 'f:sku', width: 90 }], 'f:sku')).toEqual([])
    expect(sizeByStandard([{ id: 'f:sku', width: 90, hidden: true }], 'f:sku')).toEqual([{ id: 'f:sku', hidden: true }])
  })
})

describe('changing a layout by hand', () => {
  it('records a move as the column now before it', () => {
    expect(placeByHand([], ['status', 'title', 'f:sku', 'r:program'], 'f:sku')).toEqual([{ id: 'f:sku', after: 'title' }])
    expect(placeByHand([{ id: 'f:sku', width: 90 }], ['f:sku', 'status'], 'f:sku')).toEqual([{ id: 'f:sku', width: 90, after: null }])
  })

  it('drops a column in front of one already placed by hand', () => {
    const drawn = ids(arrange(standard, columns, [{ id: 'owner', after: 'title' }]))
    expect(drawn.slice(0, 3)).toEqual(['status', 'title', 'owner'])
    // Drop key between title and owner.
    const rest = drawn.filter((id) => id !== 'key')
    rest.splice(rest.indexOf('owner'), 0, 'key')
    const layout = placeByHand([{ id: 'owner', after: 'title' }], rest, 'key')
    expect(ids(arrange(standard, columns, layout))).toEqual(rest)
  })

  it('leaves a column placed by hand where it was when the column before it moves away', () => {
    const layout = [{ id: 'owner', after: 'title' }, { id: 'key', after: 'owner' }]
    const drawn = ids(arrange(standard, columns, layout))
    const rest = drawn.filter((id) => id !== 'owner')
    rest.push('owner')
    expect(ids(arrange(standard, columns, placeByHand(layout, rest, 'owner')))).toEqual(rest)
  })

  it('gives a column back to the standard', () => {
    expect(placeByStandard([{ id: 'f:sku', after: 'title' }], 'f:sku')).toEqual([])
    expect(placeByStandard([{ id: 'f:sku', after: 'title', width: 90 }], 'f:sku')).toEqual([{ id: 'f:sku', width: 90 }])
  })

  it('stores a hide only where it differs from the standard', () => {
    expect(showByHand(standard, { id: 'f:sku' }, [], true)).toEqual([{ id: 'f:sku', hidden: true }])
    expect(showByHand(standard, { id: 'f:sku' }, [{ id: 'f:sku', hidden: true }], false)).toEqual([])
    expect(showByHand(standard, { id: 'f:tags', pivot: true }, [], true)).toEqual([])
  })
})
