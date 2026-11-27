import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAction } from './action-spec.ts'
import { canonical, readStatement, statementIssue, statementLines, type ChangeStatement } from './change.ts'
import { changeInput, INPUT_KINDS, inputText } from './input-kinds.ts'

const EXAMPLES = join(import.meta.dirname, 'change', 'examples')
const example = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(EXAMPLES, name), 'utf8')) as T
const stated = example<{ statement: ChangeStatement }>('event-stated.json').statement

describe('a change statement, checked against the platform kit schema', () => {
  it('takes every worked example', () => {
    for (const name of ['statement-app-settings.json', 'statement-unread.json']) expect(statementIssue(example(name)), name).toBeNull()
    expect(statementIssue(stated)).toBeNull()
  })

  it('refuses every bad example, saying where it breaks', () => {
    const bad = readdirSync(join(EXAMPLES, 'bad')).filter((f) => f.startsWith('statement-'))
    expect(bad.length).toBeGreaterThan(0)
    for (const name of bad) expect(statementIssue(example(join('bad', name))), name).not.toBeNull()
    expect(statementIssue(example('bad/statement-bad-applier.json'))).toBe('applier must be one of hub, asker')
    expect(statementIssue(example('bad/statement-extra-field.json'))).toBe('summary is not part of a change statement')
    expect(statementIssue(example('bad/statement-nothing.json'))).toBe('the statement must name at least one of: things, or unknown')
    expect(statementIssue(example('bad/statement-value-in-part.json'))).toMatch(/^unknown\[0\]\.part must match/)
  })

  it('holds the rules nested in its parts', () => {
    const with_ = (patch: Partial<ChangeStatement>) => ({ ...stated, ...patch })
    expect(statementIssue(with_({ actor: { kind: 'person', id: 'user@example.com', on_behalf_of: 'user@example.com' } }))).toBe('actor must not hold on_behalf_of here')
    expect(statementIssue(with_({ things: [stated.things![0]!, stated.things![0]!] }))).toBe('things[1] is in the list twice')
    expect(statementIssue(with_({ effects: [{ ...stated.effects![0]!, size: -1 }] }))).toBe('effects[0].size must be 0 or more')
    expect(statementIssue(with_({ effects: [{ ...stated.effects![0]!, size: 1.5 }] }))).toBe('effects[0].size must be a whole number')
    expect(statementIssue(with_({ artifact: { kind: 'plan', digest: 'sha256:abc' } }))).toMatch(/^artifact\.digest must match/)
    expect(statementIssue(with_({ writer: { name: 'Infra', version: '1' } }))).toMatch(/^writer\.name must match/)
    expect(statementIssue([])).toBe('the statement must be an object')
  })

  it('is read from an object or from JSON text, and is an input of its own kind', () => {
    expect(readStatement(JSON.stringify(stated))).toEqual({ ok: true, statement: stated })
    expect(readStatement('{not json')).toEqual({ ok: false, error: 'expected a change statement, as JSON' })
    const kind = INPUT_KINDS.change
    expect(kind.check({}, stated, { today: '2026-11-26' })).toEqual({ ok: true, value: stated })
    expect(kind.check({}, { ...stated, applier: 'laptop' }, { today: '2026-11-26' })).toEqual({ ok: false, error: 'applier must be one of hub, asker' })
    expect(inputText({ type: 'change' }, stated)).toBe('change plan-7f3a2c')
    expect(changeInput({ reason: { type: 'string' }, plan: { type: 'change' } })).toBe('plan')
    expect(changeInput({ reason: { type: 'string' } })).toBeNull()
  })
})

describe('the canonical form a digest is taken over', () => {
  it('leaves out every empty list, object, string, and null, and sorts keys', () => {
    const plain = { key: 'k', b: 1, a: [{ y: 'x', z: '' }] }
    expect(canonical(plain)).toBe('{"a":[{"y":"x"}],"b":1,"key":"k"}')
    expect(canonical({ ...plain, effects: [], actor: { on_behalf_of: '' }, size: null })).toBe(canonical(plain))
    expect(canonical({ n: 0 })).toBe('{"n":0}')
  })

  it('writes strings as ECMAScript does', () => {
    expect(canonical({ part: 'a"b\\c\n\u0001é' })).toBe('{"part":"a\\"b\\\\c\\n\\u0001é"}')
  })
})

describe('a statement in words', () => {
  it('says what runs where, each effect, and each part nobody could name', () => {
    expect(statementLines(stated)).toEqual([
      'Change plan-7f3a2c, written by infra 3.1.0 for agent agent-1, for user@example.com.',
      'It runs on a job the hub starts, from the plan sha256:9f2c4b1e7a6d3c5b8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d.',
      'It touches workload acme-api-prod.',
      'Effects:',
      "- stops workload acme-api-prod (2), in-place; the old artifact puts it back; claimed by the writer's own table (rule app-settings-restart, azurerm 4.20)",
      "- grants workload acme-api-prod (1), in-place; the old artifact puts it back; claimed by the writer's own table (rule role-assignment)",
      'Parts with no effect named:',
      '- workload acme-api-prod: site_config.cors, which the writer read and has no effect for',
    ])
  })
})

describe('an action with a change input', () => {
  const base = { id: 'apply', title: 'Apply', backend: { type: 'caller' } }
  const issues = (spec: Record<string, unknown>) => checkAction({ ...base, ...spec }).issues.map((i) => i.message)
  it('declares one at most', () => {
    expect(issues({ inputs: { plan: { type: 'change' }, again: { type: 'change' } } })).toEqual(['input "again": an action declares at most one change input, and "plan" is one'])
    expect(issues({ inputs: { plan: { type: 'change', required: true } } })).toEqual([])
  })

  it('never works one out, takes it as a list, or asks it once for many', () => {
    expect(issues({ inputs: { plan: { type: 'change', value: 'inputs.x' }, x: { type: 'string' } } }).join()).toContain("a change statement is the writer's own, never worked out")
    expect(issues({ inputs: { plan: { type: 'change', many: true } } })).not.toEqual([])
    expect(issues({ blueprint: 'workload', batch: { max: 5 }, inputs: { plan: { type: 'change' } } }).join()).toContain('states one change, to the things it names')
  })
})

// The cases of the platform kit's own validator test (change/statement_test.go), held to the hub's check.
describe('the rules the platform kit validator adds to the schema', () => {
  const good = (): ChangeStatement => ({
    key: 'plan-1',
    writer: { name: 'infra', version: '3.1.0' },
    actor: { kind: 'agent', id: 'agent-1', on_behalf_of: 'user@example.com' },
    things: [{ blueprint: 'workload', key: 'acme-api' }],
    artifact: { kind: 'plan', digest: `sha256:${'a'.repeat(64)}` },
    applier: 'hub',
    effects: [{ kind: 'stops', subject: { blueprint: 'workload', key: 'acme-api' }, path: 'in-place', size: 2, undo: 'yes', claim: { from: 'writer' } }],
  })
  const refused = (mutate: (s: ChangeStatement) => void): string | null => {
    const s = good()
    mutate(s)
    return statementIssue(s)
  }

  it('takes the good statement', () => {
    expect(statementIssue(good())).toBeNull()
  })

  it('refuses each case the validator refuses', () => {
    expect(refused((s) => (s.effects![0]!.kind = 'opens'))).toBe('effects[0]: the kind opens has no unit, so it has no size')
    expect(refused((s) => s.things!.push(s.things![0]!))).toBe('things[1] is in the list twice')
    expect(refused((s) => (s.things![0]!.key = 'owner-user@example.com'))).toBe('things[0].key holds an email address; a person is named only as the actor')
    expect(refused((s) => (s.effects![0]!.claim.rule = 'ask user@example.com'))).toBe('effects[0].claim.rule holds an email address; a person is named only as the actor')
    expect(refused((s) => (s.unknown = [{ part: 'xK9mQ2pL7vR4tY8wZ3nB6cF1hJ5dG0sA', why: 'unnamed' }]))).toBe('unknown[0].part holds what reads as a key or a token')
    expect(refused((s) => (s.key = '-----BEGIN PRIVATE KEY'))).toBe('key holds what reads as a key or a token')
    expect(refused((s) => (s.key = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0'))).toBe('key holds what reads as a key or a token')
    expect(refused((s) => (s.unknown = [{ part: 'app_settings.MODE=fast', why: 'unnamed' }]))).toMatch(/^unknown\[0\]\.part must match/)
    expect(refused((s) => (s.actor = { kind: 'person', id: 'p', on_behalf_of: 'q' }))).toBe('actor must not hold on_behalf_of here')
    // A secret is no name anywhere, the actor's included.
    expect(refused((s) => (s.actor.on_behalf_of = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0'))).toBe('actor.on_behalf_of holds what reads as a key or a token')
    expect(refused((s) => (s.effects![0]!.subject.key = 'acme-api user@example.com'))).toMatch(/^effects\[0\]\.subject\.key holds an email address/)
  })

  it('takes a person named as the actor, plain names that are long, and a kind the estate adds', () => {
    const s = good()
    s.actor = { kind: 'person', id: 'user@example.com' }
    s.things![0]!.key = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg-acme-prod/providers/Microsoft.Web/sites/acme-api'
    s.unknown = [{ part: 'azurerm_linux_web_app.api["primary"].site_config.application_stack', why: 'unnamed' }]
    expect(statementIssue(s)).toBeNull()
    // The kit refuses a kind its base set lacks until the estate's kinds are loaded; the hub holds no estate's kinds, so it leaves that to the judge.
    expect(refused((x) => (x.effects![0]!.kind = 'sends'))).toBeNull()
  })
})
