import { describe, expect, it } from 'vitest'
import { href, parseRoute, startFromSearch } from './router.ts'

const at = (url: string) => parseRoute(new URL(url, 'http://hub'))

describe('the model route', () => {
  it('carries the blueprint to open on the graph', () => {
    expect(at('/model?focus=k8s_pod')).toEqual({ page: 'model', id: null, focus: 'k8s_pod' })
    expect(href({ page: 'model', id: null, focus: 'k8s_pod' })).toBe('/model?focus=k8s_pod')
  })

  it('browses a catalog when the path names one, whatever the query says', () => {
    expect(at('/model/service?focus=team')).toEqual({ page: 'model', id: 'service' })
    expect(href({ page: 'model', id: 'service', focus: 'team' })).toBe('/model/service')
  })

  it('is the whole model with neither', () => {
    expect(at('/model')).toEqual({ page: 'model', id: null })
    expect(href({ page: 'model', id: null })).toBe('/model')
  })
})

describe('the ground route', () => {
  it('lists the grounds, opens one blueprint\'s, and opens one entity on it', () => {
    expect(at('/ground')).toEqual({ page: 'ground', blueprint: null })
    expect(at('/ground/repository')).toEqual({ page: 'ground', blueprint: 'repository' })
    expect(at('/ground/repository/billing')).toEqual({ page: 'ground', blueprint: 'repository', key: 'billing' })
  })

  it('round-trips a key that holds a slash', () => {
    const route = { page: 'ground' as const, blueprint: 'repository', key: 'acme/billing api' }
    expect(href(route)).toBe('/ground/repository/acme/billing%20api')
    expect(at(href(route))).toEqual(route)
    expect(href({ page: 'ground', blueprint: null })).toBe('/ground')
  })
})

describe('the map route', () => {
  it('lists the maps, and opens a holder\'s planet', () => {
    expect(at('/map')).toEqual({ page: 'map', blueprint: null })
    expect(at('/map/program/803')).toEqual({ page: 'map', blueprint: 'program', key: '803' })
  })

  it('round-trips a place, a plot on it, and a kind of open ground on it', () => {
    for (const route of [
      { page: 'map' as const, blueprint: 'program', key: 'acme/one', at: 'Prod' },
      { page: 'map' as const, blueprint: 'program', key: '803', at: 'Pre prod', plot: 'web/api' },
      { page: 'map' as const, blueprint: 'program', key: '803', at: 'Prod', kind: 'database' },
    ])
      expect(at(href(route))).toEqual(route)
    expect(href({ page: 'map', blueprint: 'program', key: '803', at: 'Prod', plot: 'api' })).toBe('/map/program/803?at=Prod&plot=api')
  })

  it('says what is placed nowhere apart from any place', () => {
    const route = { page: 'map' as const, blueprint: 'program', key: '803', at: null, plot: 'library' }
    expect(href(route)).toBe('/map/program/803?nowhere&plot=library')
    expect(at(href(route))).toEqual(route)
    expect(at('/map/program/803?nowhere')).toEqual({ page: 'map', blueprint: 'program', key: '803', at: null })
  })

  it('reads an empty place as the planet', () => {
    expect(at('/map/program/803?at=')).toEqual({ page: 'map', blueprint: 'program', key: '803' })
  })
})

describe('the scorecards route', () => {
  it('opens a scorecard on one rule of one kind, and round-trips it', () => {
    expect(at('/scorecards/secure?kind=azure_app_service&rule=https_only')).toEqual({ page: 'scorecards', id: 'secure', fix: { kind: 'azure_app_service', rule: 'https_only' } })
    expect(href({ page: 'scorecards', id: 'secure', fix: { kind: 'azure_app_service', rule: 'https_only' } })).toBe('/scorecards/secure?kind=azure_app_service&rule=https_only')
  })

  it('ignores a half-given fix and a fix with no scorecard', () => {
    expect(at('/scorecards/secure?rule=https_only')).toEqual({ page: 'scorecards', id: 'secure' })
    expect(at('/scorecards?kind=a&rule=b')).toEqual({ page: 'scorecards', id: null })
  })

  it('carries the lens asked for beside a fix, and drops one it does not know', () => {
    expect(at('/scorecards?lens=wide')).toEqual({ page: 'scorecards', id: null, lens: 'wide' })
    expect(href({ page: 'scorecards', id: null, lens: 'wide' })).toBe('/scorecards?lens=wide')
    const fixed = { page: 'scorecards' as const, id: 'secure', fix: { kind: 'svc', rule: 'ci' }, lens: 'yours' as const }
    expect(at(href(fixed))).toEqual(fixed)
    expect(at('/scorecards/secure?lens=everything')).toEqual({ page: 'scorecards', id: 'secure' })
  })
})

describe('the search route', () => {
  it('round-trips', () => {
    expect(at('/search')).toEqual({ page: 'search' })
    expect(href({ page: 'search' })).toBe('/search')
  })
})

describe('the front page', () => {
  it('is Now, at the root and at any path the app does not know', () => {
    expect(at('/')).toEqual({ page: 'now' })
    expect(at('/nowhere')).toEqual({ page: 'now' })
    expect(href({ page: 'now' })).toBe('/')
  })
})

describe('a prefilled action link', () => {
  const inputs = { reason: { type: 'string' }, days: { type: 'number' }, urgent: { type: 'boolean' }, people: { type: 'entity', many: true } }

  it('starts the form on the entity and inputs it names, typed by each input', () => {
    expect(startFromSearch('?entity=entra_app:t%2Fapp-1&input.reason=new%20starter&input.days=30&input.urgent=true&input.people=entra_user:a&input.people=entra_user:b', inputs)).toEqual({
      entity: 'entra_app:t/app-1',
      inputs: { reason: 'new starter', days: 30, urgent: true, people: ['entra_user:a', 'entra_user:b'] },
    })
  })

  it('takes an entity by its bare key, the action\'s and an input\'s', () => {
    const typed = { app: { type: 'entity', blueprint: 'entra_app' }, user: { type: 'entity', blueprint: 'entra_user' } }
    expect(startFromSearch('?entity=t%2Freq-1&input.app=t%2Fvisio&input.user=entra_user:t%2Fu1', typed, 'it_approval')).toEqual({
      entity: 'it_approval:t/req-1',
      inputs: { app: 'entra_app:t/visio', user: 'entra_user:t/u1' },
    })
  })

  it('takes a person by a bare key once the estate says who a person is, and the new kinds as typed', () => {
    const typed = { lead: { type: 'person' }, due: { type: 'date' }, crew: { type: 'person', many: true } }
    expect(startFromSearch('?input.lead=u1&input.due=2026-03-10&input.crew=u2&input.crew=human:u3', typed, undefined, 'human')).toEqual({ inputs: { lead: 'human:u1', due: '2026-03-10', crew: ['human:u2', 'human:u3'] } })
    expect(startFromSearch('?input.lead=u1', typed)).toEqual({ inputs: { lead: 'u1' } })
  })

  it('leaves out what the action has no input for, and a number that is not one', () => {
    expect(startFromSearch('?input.role=Admin&input.days=lots&input.reason=', inputs)).toEqual({ inputs: {} })
  })
})

describe('the sources route', () => {
  it('opens a shelf of keys or secrets when no source is named', () => {
    expect(at('/sources?shelf=access')).toEqual({ page: 'sources', id: null, shelf: 'access' })
    expect(href({ page: 'sources', id: null, shelf: 'secrets' })).toBe('/sources?shelf=secrets')
  })

  it('opens the source when one is named, and drops a shelf it does not know', () => {
    expect(at('/sources/k8s?shelf=access')).toEqual({ page: 'sources', id: 'k8s' })
    expect(at('/sources?shelf=other')).toEqual({ page: 'sources', id: null })
    expect(href({ page: 'sources', id: 'k8s', shelf: 'access' })).toBe('/sources/k8s')
  })
})
