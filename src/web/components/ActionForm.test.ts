import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActionsResponse, BlueprintsResponse, EntitiesResponse, WhoAmIResponse } from '../../shared/api.ts'
import { ACTION_INPUT_TYPES, type ActionStats, type ActionView, type Blueprint, type Entity } from '../../shared/model.ts'
import { CallError, keys } from '../api.ts'
import { ActionForm, refusedInput, Review } from './ActionForm.tsx'
import { listChange } from '../../shared/list-change.ts'

const action: Omit<ActionView, 'iconShown' | 'stats'> = { id: 'deploy', title: 'Deploy', inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.com/run' }, origin: { kind: 'ui' }, updatedAt: '2026-01-05T15:00:00Z', canRun: true, lastRun: null }

/** The form of an action whose runs say `stats` of it, or of one from a hub that says nothing. */
function form(stats?: ActionStats): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'user@example.com', admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActionForm, { action: stats ? { ...action, stats } : action })))
}

describe("what an action's form says of its runs", () => {
  it('says how long it usually takes', () => {
    expect(form({ usualSeconds: 20, meanSeconds: null, failedInARow: 0 })).toContain('Usually takes 20s')
  })

  it('says it is failing, as a warning in words', () => {
    const html = form({ usualSeconds: null, meanSeconds: null, failedInARow: 3 })
    expect(html).toContain('Failed the last 3 runs')
    expect(html).toContain('<span class="sr-only">Warning: </span>')
    expect(html).not.toContain('Usually takes')
  })

  it('says neither for an action with too few runs, or from a hub that sends no stats', () => {
    for (const html of [form({ usualSeconds: null, meanSeconds: null, failedInARow: 2 }), form()]) {
      expect(html).not.toContain('Usually takes')
      expect(html).not.toContain('Failed the last')
    }
  })
})

/** The form of an action that takes `inputs`, started from `given`, on a hub that says a person is a `human`. */
function asking(inputs: ActionView['inputs'], given?: Record<string, unknown>, more: Partial<ActionView> = {}, seed: (client: QueryClient) => void = () => {}): string {
  const client = new QueryClient()
  seed(client)
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'user@example.com', admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
  client.setQueryData(keys.actions, { actions: [], person: 'human' } satisfies ActionsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActionForm, { action: { ...action, inputs, ...more }, start: given ? { inputs: given } : undefined })))
}

/** The markup of one question: from its label or legend to the next question. */
function question(html: string, label: string): string {
  const at = html.indexOf(`>${label}</span>`)
  expect(at, label).toBeGreaterThan(-1)
  const next = html.indexOf('<span class="text-sm font-medium text-ink-100">', at)
  return html.slice(at, next === -1 ? undefined : next)
}

describe('the control each kind of input is asked with', () => {
  const html = asking({
    name: { type: 'string', title: 'Name', required: true },
    notes: { type: 'text', title: 'Notes' },
    plan: { type: 'markdown', title: 'Plan' },
    whole: { type: 'attachment', title: 'Whole plan' },
    stated: { type: 'change', title: 'The change' },
    count: { type: 'number', title: 'Count', min: 1, max: 5 },
    notify: { type: 'boolean', title: 'Notify' },
    due: { type: 'date', title: 'Due', min: '2026-01-01', max: '2026-12-31' },
    at: { type: 'datetime', title: 'At' },
    mail: { type: 'email', title: 'Mail' },
    link: { type: 'url', title: 'Link' },
    size: { type: 'enum', title: 'Size', values: ['small', 'large'] },
    lead: { type: 'person', title: 'Lead' },
    hosts: { type: 'string', title: 'Hosts', many: true },
  })

  it('draws every kind the registry names', () => {
    for (const type of ACTION_INPUT_TYPES) expect(Object.values({ name: 'string', notes: 'text', plan: 'markdown', whole: 'attachment', stated: 'change', count: 'number', notify: 'boolean', due: 'date', at: 'datetime', mail: 'email', link: 'url', size: 'enum', lead: 'person', target: 'entity' }), type).toContain(type)
    expect(question(html, 'Name')).toContain('type="text"')
    expect(question(html, 'Notes')).toMatch(/<textarea[^>]*class="[^"]*min-h-28/)
    expect(question(html, 'Notes')).not.toContain('font-mono')
    expect(question(html, 'Plan')).toMatch(/<textarea[^>]*font-mono/)
    expect(question(html, 'Whole plan')).toMatch(/<textarea[^>]*font-mono/)
    expect(question(html, 'The change')).toMatch(/<textarea[^>]*font-mono/)
    expect(question(html, 'Count')).toMatch(/type="number"[^>]*min="1"[^>]*max="5"/)
    expect(question(html, 'Notify')).toContain('type="checkbox"')
    expect(question(html, 'Due')).toMatch(/type="date"[^>]*min="2026-01-01"[^>]*max="2026-12-31"/)
    expect(question(html, 'At')).toContain('type="datetime-local"')
    expect(question(html, 'Mail')).toContain('type="email"')
    expect(question(html, 'Link')).toContain('type="url"')
    expect(question(html, 'Size')).toContain('<select')
    expect(question(html, 'Lead')).toContain('role="combobox"')
    expect(question(html, 'Hosts')).toContain('aria-label="Hosts, 1 of 1"')
  })

  it('says which questions must be answered, in words', () => {
    expect(question(html, 'Name')).toMatch(/<span aria-hidden="true"[^>]*>\*<\/span>/)
    expect(question(html, 'Name')).toContain('aria-required="true"')
    expect(question(html, 'Notes')).toContain('(optional)')
    expect(question(html, 'Notes')).not.toContain('aria-required')
    // A set of checkboxes has nowhere to say it is required but its name.
    const set = asking({ sizes: { type: 'enum', title: 'Sizes', many: true, values: ['s', 'm'], required: true } })
    expect(set).toContain('<span class="sr-only"> (required)</span>')
  })

  it('draws a choice as buttons where the input asks: one of them, or any of them', () => {
    const buttons = asking({ size: { type: 'enum', title: 'Size', values: ['small', 'large'], display: 'buttons', required: true }, extras: { type: 'enum', title: 'Extras', values: ['a', 'b'], many: true, display: 'buttons' } }, { size: 'large' })
    expect(buttons).toMatch(/<fieldset[^>]*role="radiogroup"[^>]*aria-required="true"/)
    expect(buttons).toContain('<legend')
    expect(buttons.match(/type="radio"/g)).toHaveLength(2)
    expect(buttons).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*value="large"|<input[^>]*value="large"[^>]*checked=""/)
    expect(question(buttons, 'Extras').match(/type="checkbox"/g)).toHaveLength(2)
    expect(question(buttons, 'Extras')).not.toContain('radiogroup')
  })
})

describe('what an input says of a value it does not take', () => {
  it('says it at the input, in words and with a mark that is not colour', () => {
    const html = question(asking({ mail: { type: 'email', title: 'Mail' }, next: { type: 'string', title: 'Next' } }, { mail: 'nobody' }), 'Mail')
    expect(html).toContain('Expected an email address')
    expect(html).toContain('<span class="sr-only">Error: </span>')
    expect(html).toMatch(/<p id="([^"]+)-error"[^>]*><svg[^>]*aria-hidden="true"/)
    expect(html).toContain('aria-invalid="true"')
    const error = /<p id="([^"]+-error)"/.exec(html)![1]!
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="[^"]*${error}`))
  })

  it('says the hint where a rule has one, and nothing of a value that keeps its rules', () => {
    const inputs: ActionView['inputs'] = { ticket: { type: 'string', title: 'Ticket', description: 'The ticket it is for', pattern: '[A-Z]+-\\d+', hint: 'Give the ticket, such as OPS-12' } }
    const bad = asking(inputs, { ticket: 'ops 12' })
    expect(bad).toContain('Give the ticket, such as OPS-12')
    expect(bad).toContain('The ticket it is for')
    expect(bad).toContain('aria-invalid="true"')
    const good = asking(inputs, { ticket: 'OPS-12' })
    expect(good).not.toContain('Give the ticket')
    expect(good).not.toContain('aria-invalid')
  })

  it('holds a number, a day, and a count of picks to their rules', () => {
    expect(asking({ count: { type: 'number', title: 'Count', max: 5 } }, { count: 9 })).toContain('Expected 5 or less')
    expect(asking({ due: { type: 'date', title: 'Due', min: '2026-06-01' } }, { due: '2026-01-01' })).toContain('Expected 2026-06-01 or later')
    expect(asking({ sizes: { type: 'enum', title: 'Sizes', many: true, values: ['s', 'm', 'l'], maxLength: 2 } }, { sizes: ['s', 'm', 'l'] })).toContain('Expected at most 2 picked')
  })

  it('says nothing of a question nobody answered until the form is sent', () => {
    const html = asking({ name: { type: 'string', title: 'Name', required: true } })
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('Error: ')
  })
})

describe('what the hub refuses about one input', () => {
  it('is said at that input, without the hub naming it twice', () => {
    expect(refusedInput(new CallError('Input "lead": crew:x does not exist, or is not one the action offers here', 400, 'lead'), ['lead'])).toEqual({ input: 'lead', message: 'crew:x does not exist, or is not one the action offers here' })
    expect(refusedInput(new CallError('Input "mail": expected an email address', 400, 'mail'), ['mail'])).toEqual({ input: 'mail', message: 'Expected an email address' })
    expect(refusedInput(new CallError('Input "lead" is required', 400, 'lead'), ['lead'])).toEqual({ input: 'lead', message: 'This must be filled in' })
  })

  it('stays a note for the whole form when it names no input the form asks', () => {
    expect(refusedInput(new CallError('This action is not open to you', 403), ['lead'])).toBeNull()
    expect(refusedInput(new CallError('Input "zone": expected text', 400, 'zone'), ['lead'])).toBeNull()
    expect(refusedInput(new Error('offline'), ['lead'])).toBeNull()
  })
})

describe('an input asked only when the answers above it say so', () => {
  const inputs: ActionView['inputs'] = {
    env: { type: 'enum', title: 'Environment', values: ['dev', 'prod'], required: true },
    reason: { type: 'string', title: 'Reason', required: true, when: { field: 'env', op: 'eq', value: 'prod' } },
    ticket: { type: 'string', title: 'Ticket', when: { field: 'reason', op: 'exists' } },
  }

  it('is not drawn until its when matches, and is drawn as soon as it does', () => {
    const hidden = asking(inputs, { env: 'dev' })
    expect(hidden).toContain('>Environment</span>')
    expect(hidden).not.toContain('>Reason</span>')
    const shown = asking(inputs, { env: 'prod' })
    expect(question(shown, 'Reason')).toContain('aria-required="true"')
    // Nothing is given for the reason yet, so what reads it is not asked either.
    expect(shown).not.toContain('>Ticket</span>')
    expect(asking(inputs, { env: 'prod', reason: 'down' })).toContain('>Ticket</span>')
  })

  it('reads nothing from an input that is not asked, whatever the form holds for it', () => {
    // The reason was typed while it was asked; it is not asked now, so the ticket is not either.
    expect(asking(inputs, { env: 'dev', reason: 'left over' })).not.toContain('>Ticket</span>')
  })
})

describe('an input the form works out', () => {
  const inputs: ActionView['inputs'] = {
    name: { type: 'string', title: 'Name' },
    slug: { type: 'string', title: 'Slug', description: 'What it is called in the cluster', value: "lower(name) + '-svc'", pattern: '[a-z-]+', hint: 'Use letters only' },
  }

  it('is shown as it is worked out, read aloud when it moves, and never asked', () => {
    const html = question(asking(inputs, { name: 'API' }), 'Slug')
    expect(html).toMatch(/<output[^>]*aria-live="polite"[^>]*>api-svc<\/output>/)
    expect(html).toContain('(worked out)')
    expect(html).toContain('What it is called in the cluster')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('(optional)')
    // Focus can be sent to it, for what the hub refuses of it, but Tab never stops there.
    expect(html).toMatch(/<output[^>]*tabindex="-1"/)
  })

  it('says so when there is nothing to work it out from yet', () => {
    const html = question(asking(inputs), 'Slug')
    expect(html).toMatch(/<output[^>]*>Nothing yet<\/output>/)
    expect(html).not.toContain('Error: ')
  })

  it('says what is wrong with what it works out, without waiting to be left', () => {
    const html = question(asking(inputs, { name: 'API 2' }), 'Slug')
    expect(html).toContain('api 2-svc')
    expect(html).toContain('<span class="sr-only">Error: </span>')
    expect(html).toContain('Use letters only')
  })

  it('never reads what the form was started with for it', () => {
    expect(question(asking(inputs, { name: 'API', slug: 'mine' }), 'Slug')).toContain('>api-svc</output>')
  })
})

describe("a form's sections", () => {
  const inputs: ActionView['inputs'] = {
    name: { type: 'string', title: 'Name' },
    env: { type: 'enum', title: 'Environment', values: ['dev', 'prod'] },
    reason: { type: 'string', title: 'Reason', when: { field: 'env', op: 'eq', value: 'prod' } },
    note: { type: 'string', title: 'Note' },
  }
  const sections = [{ title: 'Basics', description: 'Start here', inputs: ['name', 'env'] }, { title: 'Why', inputs: ['reason'] }]

  it('draws each as a named group under its heading, and what no section names last, under none', () => {
    const html = asking(inputs, { env: 'prod' }, { sections })
    const [, id] = /<div role="group" aria-labelledby="([^"]+)"[^>]*><div><h3 id="([^"]+)"[^>]*>Basics<\/h3>/.exec(html) ?? []
    expect(id).toBeTruthy()
    expect(html).toContain('Start here')
    expect(html).toMatch(/<h3[^>]*>Why<\/h3>/)
    expect(html.indexOf('>Basics</h3>')).toBeLessThan(html.indexOf('>Name</span>'))
    expect(html.indexOf('>Environment</span>')).toBeLessThan(html.indexOf('>Why</h3>'))
    expect(html.indexOf('>Why</h3>')).toBeLessThan(html.indexOf('>Reason</span>'))
    expect(html.indexOf('>Reason</span>')).toBeLessThan(html.indexOf('>Note</span>'))
    expect(html.match(/role="group"/g)).toHaveLength(2)
  })

  it('draws no section whose inputs are all not asked', () => {
    const html = asking(inputs, { env: 'dev' }, { sections })
    expect(html).toContain('>Basics</h3>')
    expect(html).not.toContain('>Why</h3>')
  })
})

describe('a form walked a section at a time', () => {
  const inputs: ActionView['inputs'] = {
    name: { type: 'string', title: 'Name', required: true },
    env: { type: 'enum', title: 'Environment', values: ['dev', 'prod'] },
    reason: { type: 'string', title: 'Reason', when: { field: 'env', op: 'eq', value: 'prod' } },
    note: { type: 'string', title: 'Note' },
  }
  const sections = [{ title: 'Basics', description: 'Start here', inputs: ['name', 'env'] }, { title: 'Why', inputs: ['reason'] }, { title: 'Anything else', inputs: ['note'] }]

  it('starts on its first step, says which of how many in words, and goes on with Next', () => {
    const html = asking(inputs, { env: 'prod' }, { sections, walk: true })
    expect(html).toMatch(/<h3[^>]*tabindex="-1"[^>]*><span[^>]*>Step 1 of 3<\/span>Basics<\/h3>/)
    expect(html).toContain('Start here')
    expect(html).toContain('>Name</span>')
    expect(html).not.toContain('>Reason</span>')
    expect(html).not.toContain('>Note</span>')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Next/)
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*>.*Run/)
    // The first step has nowhere to go back to.
    expect(html).not.toContain('Back')
  })

  it('counts only the steps that ask something', () => {
    expect(asking(inputs, { env: 'dev' }, { sections, walk: true })).toContain('Step 1 of 2')
  })

  it('is a plain form when there is one step to take', () => {
    const html = asking({ name: inputs.name! }, undefined, { sections: [{ title: 'Basics', inputs: ['name'] }], walk: true })
    expect(html).not.toContain('Step 1')
    expect(html).toContain('>Basics</h3>')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Run/)
  })
})

describe('the fields an option shows', () => {
  const locker: Blueprint = { id: 'locker', title: 'Locker', fields: { floor: { type: 'string', title: 'Floor' }, seats: { type: 'number' } }, relations: {}, origin: { kind: 'ui' }, updatedAt: '' }
  const entity = (key: string, title: string, fields: Record<string, unknown>) => ({ id: `locker:${key}`, blueprint: 'locker', key, title, fields, relations: {} }) as unknown as Entity
  const seed = (client: QueryClient) => {
    client.setQueryData(keys.blueprints, { blueprints: [locker], counts: {}, held: {}, layout: { order: [], closed: [], blueprints: {}, hidden: [] }, adminOnly: [] } satisfies BlueprintsResponse)
    // The second locker's floor is not the reader's to read, so the hub sent none.
    client.setQueryData(keys.entities('locker', 'options:title:null'), { entities: [entity('a1', 'Locker A1', { floor: 'Second', seats: 4 }), entity('b2', 'Locker B2', { seats: 2 })] } as unknown as EntitiesResponse)
  }
  const inputs: ActionView['inputs'] = { where: { type: 'entity', title: 'Where', blueprint: 'locker', show: ['floor', 'seats'] } }

  it('are a line under each option, with a field the reader was not given left out', () => {
    const html = question(asking(inputs, undefined, {}, seed), 'Where')
    expect(html).toContain('Floor: Second · seats: 4')
    expect(html).toMatch(/Locker B2.*?seats: 2/s)
    expect(html).not.toContain('Floor: </')
    expect(html.match(/Floor:/g)).toHaveLength(1)
  })

  it('are a line under what is picked, read with the pick', () => {
    const html = question(asking(inputs, { where: 'locker:a1' }, {}, seed), 'Where')
    const [, id] = /<div id="([^"]+)"[^>]*>Floor: Second · seats: 4<\/div>/.exec(html) ?? []
    expect(id).toBeTruthy()
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="[^"]*${id}`))
  })

  it('are a line under each of a list of options too', () => {
    const html = question(asking({ where: { ...inputs.where!, many: true } }, undefined, {}, seed), 'Where')
    expect(html).toContain('Floor: Second · seats: 4')
  })
})

describe('a list a person types', () => {
  const inputs: ActionView['inputs'] = { origins: { type: 'url', title: 'Origins', many: true, required: true } }

  it('is a box a row, in a set named by the question, with a plus under the rows', () => {
    const html = question(asking(inputs, { origins: ['https://a.example.org', 'https://b.example.org'] }), 'Origins')
    expect(html).not.toContain('<textarea')
    expect(html).toContain('<span class="sr-only"> (required)</span>')
    expect(html.match(/<input[^>]*type="text"/g)).toHaveLength(2)
    expect(html).toMatch(/<input[^>]*aria-label="Origins, 1 of 2"[^>]*value="https:\/\/a.example.org"/)
    expect(html).toMatch(/<input[^>]*inputMode="url"|<input[^>]*inputmode="url"/)
    expect(html).toContain('</svg> Add another</span>')
  })

  it('has a remove button on every row that the keyboard reaches, shown on hover, on focus, and always on a touch screen', () => {
    const html = question(asking(inputs, { origins: ['https://a.example.org'] }), 'Origins')
    const remove = /<button[^>]*aria-label="Remove https:\/\/a.example.org"[^>]*>/.exec(html)?.[0]
    expect(remove).toBeDefined()
    expect(remove).not.toContain('tabindex="-1"')
    for (const shows of ['group-hover:opacity-100', 'group-focus-within:opacity-100', 'focus-visible:opacity-100', '[@media(hover:none)]:opacity-100']) expect(remove).toContain(shows)
  })

  it('asks for a review when it changes a list the entity holds, whatever the action says', () => {
    const html = asking({ origins: { type: 'url', title: 'Origins', many: true, current: '{{ entity.fields.origins }}' } })
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*><span[^>]*>Review<\/span>/)
  })
})

describe('the review of a change to a list', () => {
  const action = { id: 'origins', title: 'Origins', inputs: { origins: { type: 'url', title: 'Allowed origins', many: true, current: '{{ entity.fields.origins }}' } }, backend: { type: 'caller' } } as const
  const review = (meant: boolean) =>
    renderToStaticMarkup(
      createElement(Review, {
        heading: { current: null },
        action: { ...action, origin: { kind: 'ui' }, updatedAt: '' },
        waits: true,
        target: null,
        names: ['origins'],
        values: {},
        valueOf: () => null,
        labelOf: () => 'Allowed origins',
        lists: ['origins'],
        changeOf: () => listChange(['https://a', 'https://b', 'https://c'], ['https://a', 'https://d', 'https://c']),
        meant,
        onMeant: () => {},
      }),
    )

  it('shows what is added and removed, with what is kept folded under a count', () => {
    const html = review(false)
    expect(html).toMatch(/Added \(1\)<\/p><ul aria-label="Added"[^>]*><li[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*?https:\/\/d<\/span>/)
    expect(html).toMatch(/Removed \(1\)<\/p><ul aria-label="Removed"[^>]*>.*?line-through[^>]*>https:\/\/b<\/span>/)
    expect(html).toMatch(/<details><summary[^>]*>Unchanged \(2\)<\/summary>/)
  })

  it('asks the person to tick that it is what they want', () => {
    expect(review(false)).toMatch(/<input type="checkbox"[^>]*\/><span>This is what I want<\/span>/)
    expect(review(false)).not.toContain('checked=""')
    expect(review(true)).toContain('checked=""')
  })
})
