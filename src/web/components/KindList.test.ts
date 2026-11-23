import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BlueprintsResponse, MyApprovals, WhoAmIResponse } from '../../shared/api.ts'
import type { Blueprint, Pin, StatusLevel } from '../../shared/model.ts'
import { keys } from '../api.ts'
import { headingLevels, KindList, moved } from './KindList.tsx'

const bp = (id: string, group: string): Blueprint => ({ id, title: id, group, fields: {}, relations: {}, origin: { kind: 'ui' }, updatedAt: '' })

/** The catalog rail over one group, with `hidden` hidden from the list. */
function render(all: Blueprint[], hidden: string[], levels: Record<string, StatusLevel>): string {
  const client = new QueryClient()
  client.setQueryData(keys.blueprints, { blueprints: all, layout: { hidden, closed: [] } } as unknown as BlueprintsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(KindList, { list: all, counts: {}, levels, current: undefined })))
}

describe('the catalog rail', () => {
  const all = [bp('service', 'Catalog'), bp('image', 'Catalog')]

  it('keeps a hidden failing item out of the group heading, but for a faint outline', () => {
    const html = render(all, ['image'], { service: 'green', image: 'red' })
    expect(html).not.toContain('lamp-signal-red')
    expect(html).toContain('border-dashed border-signal-red')
    expect(html).toContain('A hidden item is failing')
  })

  it('shows a listed failing item at full strength, with no faint lamp beside it', () => {
    const html = render(all, ['image'], { service: 'red', image: 'red' })
    expect(html).toContain('lamp-signal-red')
    expect(html).not.toContain('border-dashed')
  })
})

describe('the heading levels', () => {
  const levels: Record<string, StatusLevel> = { service: 'amber', image: 'red' }

  it('takes the heading lamp from what is listed and the faint one from what is hidden', () => {
    expect(headingLevels([all()[0]!], [all()[1]!], levels)).toEqual({ level: 'amber', tuckedLevel: 'red' })
  })

  it('counts every item once the hidden ones are shown', () => {
    expect(headingLevels(all(), [], levels)).toEqual({ level: 'red', tuckedLevel: 'green' })
  })

  function all() {
    return [bp('service', 'Catalog'), bp('image', 'Catalog')]
  }
})

describe('the approvals kind in the rail', () => {
  const list = [bp('approval', 'Inbox'), bp('service', 'Catalog')]
  /** The rail for a person the hub says `mine` of. */
  const rail = (mine: MyApprovals | null): string => {
    const client = new QueryClient()
    client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'approver@example.com', admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false, previews: [] } satisfies WhoAmIResponse)
    client.setQueryData([...keys.mine, 'approvals'], mine)
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(KindList, { list, counts: {}, levels: {}, current: undefined })))
  }
  /** The rail's row of a kind. */
  const row = (html: string, id: string): string => (html.match(/<a\b.*?<\/a>/g) ?? []).find((a) => a.includes(`>${id}<`)) ?? ''

  it('counts the records that wait for the reader, on that kind alone', () => {
    const html = rail({ blueprint: 'approval', waiting: 2 })
    expect(row(html, 'approval')).toContain('title="2 approvals wait for your decision"')
    expect(row(html, 'service')).not.toContain('waiting for your approval')
  })

  it('shows no count when none waits, or when the hub names no approvals kind', () => {
    expect(rail({ blueprint: 'approval', waiting: 0 })).not.toContain('waiting for your approval')
    expect(rail(null)).not.toContain('waiting for your approval')
  })
})

describe('a move in the rail', () => {
  const members = ['a', 'x', 'b', 'y', 'c']
  const shown = ['a', 'b', 'c']
  const tucked = ['x', 'y']

  it('steps a shown item over its shown neighbour, the hidden ones keeping their places', () => {
    expect(moved(members, shown, 'b', 1)).toEqual(['a', 'x', 'y', 'c', 'b'])
    expect(moved(members, shown, 'b', -1)).toEqual(['b', 'a', 'x', 'y', 'c'])
  })

  it('steps a hidden item over its hidden neighbour, the shown ones keeping their places', () => {
    expect(moved(members, tucked, 'y', -1)).toEqual(['a', 'y', 'x', 'b', 'c'])
    expect(moved(members, tucked, 'x', 1)).toEqual(['a', 'b', 'y', 'x', 'c'])
  })

  it('moves nothing past either end of its list', () => {
    expect(moved(members, tucked, 'x', -1)).toBeNull()
    expect(moved(members, tucked, 'y', 1)).toBeNull()
  })
})

describe('the kinds a person starred', () => {
  const list = [bp('service', 'Catalog'), bp('pipeline', 'Delivery'), bp('storage', 'Catalog')]
  /** The rail for a person who pinned `pins`, in that order. */
  const rail = (pins: Pin[]): string => {
    const client = new QueryClient()
    client.setQueryData(keys.blueprints, { blueprints: list, layout: { hidden: [], closed: [] } } as unknown as BlueprintsResponse)
    client.setQueryData(keys.pins, pins)
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(KindList, { list, counts: {}, levels: {}, current: undefined })))
  }
  /** Each kind's name, top to bottom. */
  const order = (html: string) => (html.match(/<a\b.*?<\/a>/g) ?? []).map((a) => /break-words[^>]*>([^<]+)</.exec(a)?.[1])

  it('come first, under Starred, in the order they were starred, and stay in their groups too', () => {
    const html = rail([{ kind: 'blueprint', id: 'storage' }, { kind: 'action', id: 'storage' }, { kind: 'blueprint', id: 'pipeline' }])
    expect(html.indexOf('Starred')).toBeGreaterThan(-1)
    expect(order(html)).toEqual(['storage', 'pipeline', 'service', 'storage', 'pipeline'])
    // Its one kind starred, the Delivery group still lists it where everyone finds it.
    expect(html).toContain('>Delivery<')
  })

  it('move a place earlier or later from their rows under Starred, and only there', () => {
    const html = rail([{ kind: 'blueprint', id: 'storage' }, { kind: 'blueprint', id: 'pipeline' }])
    expect(html.match(/aria-label="Move storage earlier"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Move pipeline later"/g)).toHaveLength(1)
    // The ends say they are off and stay in the tab order.
    expect(html).toMatch(/aria-disabled="true" aria-label="Move storage earlier"/)
    expect(html).toMatch(/aria-disabled="true" aria-label="Move pipeline later"/)
    expect(html).not.toMatch(/aria-disabled="true" aria-label="Move storage later"/)
  })

  it('have nothing to move while only one is starred', () => {
    expect(rail([{ kind: 'blueprint', id: 'storage' }])).not.toContain('Move storage')
  })

  it('leave the list as everyone shares it when none is starred', () => {
    const html = rail([{ kind: 'action', id: 'service' }])
    expect(html).not.toContain('Starred')
    expect(order(html)).toEqual(['service', 'storage', 'pipeline'])
  })
})
