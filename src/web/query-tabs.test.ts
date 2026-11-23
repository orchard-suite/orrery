import { describe, expect, it } from 'vitest'
import { closeQuery, closeTab, newTab, openQuery, tabsNow, updateTab } from './query-tabs.ts'

const front = () => tabsNow().tabs.find((t) => t.key === tabsNow().active)

describe('the open queries', () => {
  it('opens a saved query in the tab in front while it holds nothing, then beside it, and brings an open one forward', () => {
    openQuery(null)
    expect(tabsNow().tabs).toHaveLength(1)
    openQuery('a')
    expect(tabsNow().tabs.map((t) => t.id)).toEqual(['a'])
    openQuery('b')
    expect(tabsNow().tabs.map((t) => t.id)).toEqual(['a', 'b'])
    openQuery('a')
    expect(front()?.id).toBe('a')
  })

  it('keeps a changed tab when another opens, and brings the one beside it forward when one closes', () => {
    const fresh = newTab()
    updateTab(fresh.key, { draft: { ...fresh.draft, title: 'Mine' } })
    openQuery('c')
    expect(tabsNow().tabs.some((t) => t.key === fresh.key)).toBe(true)
    const next = closeTab(tabsNow().active!)
    expect(next?.key).toBe(tabsNow().active)
    expect(tabsNow().tabs.some((t) => t.id === 'c')).toBe(false)
  })

  it('closes the tabs of a removed query, and only those', () => {
    openQuery('gone')
    openQuery('kept')
    closeQuery('gone')
    expect(tabsNow().tabs.some((t) => t.id === 'gone')).toBe(false)
    expect(tabsNow().tabs.some((t) => t.id === 'kept')).toBe(true)
  })
})
