import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BlueprintsResponse } from '../../shared/api.ts'
import type { Blueprint } from '../../shared/model.ts'
import { keys } from '../api.ts'
import { BlueprintIndex } from './BlueprintIndex.tsx'

const bp = (id: string, title: string, group: string): Blueprint => ({ id, title, group, fields: {}, relations: {}, origin: { kind: 'ui' }, updatedAt: '' })

/** The list of blueprints as a phone shows it, over the blueprints the hub sent. */
function render(all: Blueprint[], layout: { closed?: string[]; hidden?: string[] } = {}): string {
  const client = new QueryClient()
  const hidden = layout.hidden ?? []
  client.setQueryData(keys.blueprints, { blueprints: all, layout: { order: [], blueprints: {}, closed: layout.closed ?? [], hidden } } satisfies Partial<BlueprintsResponse>)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(BlueprintIndex, { title: 'Catalog', intro: '', all, counts: {}, hidden: new Set(hidden), to: (id) => ({ page: 'inventory', blueprint: id }) })))
}

describe('the blueprint list', () => {
  it('names two blueprints titled alike by their sections, and a unique one by its title alone', () => {
    const html = render([bp('program_portfolio', 'Portfolio', 'Programs'), bp('finops_portfolio', 'Portfolio', 'Finance'), bp('team', 'Team', 'People')])
    expect(html).toContain('>Portfolio · Programs<')
    expect(html).toContain('>Portfolio · Finance<')
    expect(html).toContain('>Team<')
    expect(html).not.toContain('Team · ')
  })

  it('starts a group closed when everyone shares it closed, as the rail on a desk does', () => {
    const html = render([bp('team', 'Team', 'People'), bp('host', 'Host', 'Compute')], { closed: ['People'] })
    expect(html).not.toContain('>Team<')
    expect(html).toContain('>Host<')
    expect(html).toContain('aria-expanded="false"')
  })

  it('keeps a hidden blueprint inside its group until asked for, and counts it', () => {
    const html = render([bp('team', 'Team', 'People'), bp('person', 'Person', 'People')], { hidden: ['person'] })
    expect(html).toContain('>Team<')
    expect(html).not.toContain('>Person<')
    expect(html).toContain('1 of 2')
    expect(html).toContain('Show hidden items')
  })
})
