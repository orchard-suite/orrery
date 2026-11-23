import { describe, expect, it } from 'vitest'
import { askedInputs, formSections, isAsked, whenReads, workedOut } from './asked.ts'
import type { ActionInputDef } from './model.ts'

const inputs = (defs: Record<string, Partial<ActionInputDef>>): Record<string, ActionInputDef> => Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, { type: 'string', ...d }]))

describe('whether an input is asked', () => {
  it('asks an input with no when', () => {
    expect(isAsked({}, {})).toBe(true)
  })

  it('judges a when over the inputs before it, each a field by its own name', () => {
    const when = { field: 'env', op: 'eq', value: 'prod' } as const
    expect(isAsked({ when }, { env: 'prod' })).toBe(true)
    expect(isAsked({ when }, { env: 'dev' })).toBe(false)
    expect(isAsked({ when }, {})).toBe(false)
    expect(isAsked({ when: { not: when } }, { env: 'dev' })).toBe(true)
    expect(isAsked({ when: { and: [when, { field: 'count', op: 'gt', value: 2 }] } }, { env: 'prod', count: 3 })).toBe(true)
    expect(isAsked({ when: { field: 'tags', op: 'contains', value: 'db' } }, { tags: ['web', 'db'] })).toBe(true)
  })

  it('reads an input named as something the hub keeps of an entity as the input, never as that', () => {
    // `state` and `title` are an entity's own; here they are inputs, or nothing.
    expect(isAsked({ when: { field: 'state', op: 'eq', value: 'open' } }, { state: 'open' })).toBe(true)
    expect(isAsked({ when: { field: 'title', op: 'exists' } }, { title: null })).toBe(false)
    expect(isAsked({ when: { field: 'title', op: 'exists' } }, {})).toBe(false)
  })

  it('reads an input that holds nothing as unset', () => {
    const when = { field: 'note', op: 'exists' } as const
    for (const empty of [null, undefined, '', []]) expect(isAsked({ when }, { note: empty })).toBe(false)
    expect(isAsked({ when }, { note: false })).toBe(true)
  })
})

describe('what a when reads', () => {
  it('names every input its tests read, once each', () => {
    expect(whenReads({ and: [{ field: 'env', op: 'eq', value: 'prod' }, { or: [{ field: 'size', op: 'gt', value: 2 }, { not: { field: 'env', op: 'exists' } }] }] })).toEqual({ fields: ['env', 'size'], refused: null })
  })

  it('refuses a test of anything but an input given', () => {
    expect(whenReads({ state: 'active' }).refused).toMatch(/only the inputs/)
    expect(whenReads({ search: 'x' }).refused).toMatch(/only the inputs/)
    expect(whenReads({ relation: 'team' }).refused).toMatch(/only the inputs/)
    expect(whenReads({ relatedTo: 'team:core' }).refused).toMatch(/only the inputs/)
    expect(whenReads({ scorecard: 'ready', op: 'eq', value: 'gold' }).refused).toMatch(/only the inputs/)
  })

  it('refuses a test that reads the time, so who was asked never moves', () => {
    expect(whenReads({ field: 'day', op: 'within', value: '7d' }).refused).toMatch(/the time/)
    expect(whenReads({ field: 'day', op: 'older', value: '7d' }).refused).toMatch(/the time/)
  })
})

describe('a worked-out value', () => {
  it('is its expression over the inputs before it', () => {
    expect(workedOut({ value: "lower(name) + '-' + env" }, { name: 'API', env: 'prod' })).toBe('api-prod')
    expect(workedOut({ value: 'count * 2' }, { count: 4 })).toBe(8)
  })

  it('is nothing when an input it reads holds nothing, or when it does not compile', () => {
    expect(workedOut({ value: "name + '-' + env" }, { name: 'api', env: null })).toBeNull()
    expect(workedOut({ value: 'name +' }, { name: 'api' })).toBeNull()
  })
})

describe('the inputs a form asks', () => {
  const form = inputs({
    kind: {},
    reason: { when: { field: 'kind', op: 'eq', value: 'urgent' }, required: true },
    ticket: { when: { field: 'reason', op: 'exists' } },
    slug: { value: "lower(kind) + '-' + coalesce(ticket, 'none')" },
    notes: { many: true, when: { field: 'kind', op: 'eq', value: 'never' } },
  })

  it('asks each in declared order, judged over the ones before it that were asked', () => {
    expect(askedInputs(form, { kind: 'urgent', reason: 'down', ticket: 'OPS-1' })).toEqual({ asked: ['kind', 'reason', 'ticket', 'slug'], values: { kind: 'urgent', reason: 'down', ticket: 'OPS-1', slug: 'urgent-OPS-1', notes: null } })
  })

  it('holds nothing for an input not asked, whatever was given for it', () => {
    // `reason` is not asked, so what was given for it is not there for `ticket` to read.
    expect(askedInputs(form, { kind: 'routine', reason: 'left over', ticket: 'OPS-1', notes: ['a'] })).toEqual({ asked: ['kind', 'slug'], values: { kind: 'routine', reason: null, ticket: null, slug: 'routine-none', notes: null } })
  })

  it('works a value out again, whatever was given for it', () => {
    expect(askedInputs(form, { kind: 'routine', slug: 'mine' }).values.slug).toBe('routine-none')
  })

  it('keeps a stored worked-out value when asked to read a run as it was stored', () => {
    expect(askedInputs(form, { kind: 'routine', slug: 'as-it-was' }, { stored: true }).values.slug).toBe('as-it-was')
  })
})

describe("a form's sections", () => {
  const form = inputs({ a: {}, b: {}, c: {}, d: {} })

  it('is one group with no heading when the action names none', () => {
    expect(formSections({ inputs: form }, ['a', 'b', 'c', 'd'])).toEqual([{ inputs: ['a', 'b', 'c', 'd'] }])
  })

  it('puts each input under its heading, and what no section names in a last group with none', () => {
    const sections = [{ title: 'First', description: 'Start here', inputs: ['b', 'a'] }, { title: 'Second', inputs: ['d'] }]
    expect(formSections({ inputs: form, sections }, ['a', 'b', 'c', 'd'])).toEqual([{ title: 'First', description: 'Start here', inputs: ['b', 'a'] }, { title: 'Second', inputs: ['d'] }, { inputs: ['c'] }])
  })

  it('leaves out an input that is not asked, and a section left holding none', () => {
    const sections = [{ title: 'First', inputs: ['a', 'b'] }, { title: 'Second', inputs: ['c', 'd'] }]
    expect(formSections({ inputs: form, sections }, ['a', 'd'])).toEqual([{ title: 'First', inputs: ['a'] }, { title: 'Second', inputs: ['d'] }])
    expect(formSections({ inputs: form, sections }, ['c'])).toEqual([{ title: 'Second', inputs: ['c'] }])
    expect(formSections({ inputs: form, sections }, [])).toEqual([])
  })
})
