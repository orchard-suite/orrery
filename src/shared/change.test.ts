import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAction } from './action-spec.ts'
import { canonical, kindFamily, readJudged, readObserved, readStatement, reasonText, routingLines, statementIssue, statementLines, type ChangeObserved, type ChangeStatement } from './change.ts'
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

describe("the watch's verdict, read strictly against the platform kit's event schema", () => {
  const observed = example<ChangeObserved>('event-observed.json')
  const with_ = (patch: Record<string, unknown>) => ({ ...observed, ...patch })

  it('takes the worked example', () => {
    expect(readObserved(observed)).toEqual({ ok: true, event: observed })
  })

  it('refuses a field the contract does not have, at any depth', () => {
    expect(readObserved(with_({ note: 'x' }))).toEqual({ ok: false, error: 'note is not part of a change event' })
    expect(readObserved(with_({ sights: [{ ...observed.sights![0]!, value: 3 }] }))).toEqual({ ok: false, error: 'sights[0].value is not part of a change event' })
    expect(readObserved(with_({ watch: { ...observed.watch, host: 'a' } }))).toEqual({ ok: false, error: 'watch.host is not part of a change event' })
  })

  it('refuses any other event, and an observation that breaks the rules', () => {
    expect(readObserved({ ...observed, event: 'change.ended' })).toEqual({ ok: false, error: "event must be change.observed: the hub takes only the watch's verdict" })
    const { of: _of, ...orphan } = observed
    expect(readObserved(orphan)).toEqual({ ok: false, error: 'of is required' })
    expect(readObserved(with_({ from: '2026-11-26' }))).toEqual({ ok: false, error: 'from must be a time, as RFC 3339 writes one' })
    expect(readObserved(with_({ to: '2026-11-26T20:00:00Z' }))).toEqual({ ok: false, error: 'to is before from' })
    expect(readObserved(with_({ sights: [{ ...observed.sights![0]!, verdict: 'fine' }] }))).toEqual({ ok: false, error: 'sights[0].verdict must be one of clean, harm, blind' })
    expect(readObserved(with_({ sights: [{ ...observed.sights![0]!, path: 'Swap' }] })).ok).toBe(false)
    expect(readObserved(with_({ of: { sender: observed.sender, key: observed.key } }))).toEqual({ ok: false, error: 'of names the event itself; an event cannot belong to itself' })
    expect(readObserved(with_({ incidents: [{ system: 'dispatch', id: 'user@example.com' }] }))).toEqual({ ok: false, error: 'incidents[0].id holds an email address; a person is named only as the actor' })
    expect(readObserved('nope')).toEqual({ ok: false, error: 'the event must be an object' })
  })

  it('knows the family of each base kind, and none of a kind the estate adds', () => {
    expect([kindFamily('stops'), kindFamily('cuts'), kindFamily('opens'), kindFamily('halts')]).toEqual(['disruption', 'disruption', 'exposure', null])
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

describe("the judge's answer, held to the platform kit's route rules", () => {
  const judge = { name: 'trellis', version: '7.0.0', pack: 'gate' }
  const people = { to: 'people', grants: [{ path: 'owner', field: 'team', values: ['user@example.com'] }], quorum: 1 }
  const read = (v: Record<string, unknown>) => readJudged({ judge, ...v }, stated)

  it('takes a route of no one, a route to people with its times, and drafts', () => {
    expect(read({ route: { to: 'no_one' } })).toEqual({ ok: true, routing: { judge, route: { to: 'no_one' } } })
    const timed = { ...people, quorum: 2, by: '2026-11-28T17:00:00Z', start: '2026-11-28T02:00:00Z' }
    const draft = { pack: 'gate-next', route: { to: 'no_one' } }
    expect(read({ route: timed, reasons: [{ effect: 1, proof: 'claimed', rule: 'grants' }, { part: 0, fence: 'unknown' }], drafts: [draft] })).toEqual({ ok: true, routing: { judge, route: timed, reasons: [{ effect: 1, proof: 'claimed', rule: 'grants' }, { part: 0, fence: 'unknown' }], drafts: [draft] } })
  })

  it('refuses what validateRoute refuses, saying where', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ route: { to: 'no_one', quorum: 1 } }, 'route.quorum must not be here'],
      [{ route: { to: 'people', grants: [], quorum: 1 } }, 'route.grants must hold at least 1'],
      [{ route: { to: 'people', grants: people.grants } }, 'route.quorum is required'],
      [{ route: { ...people, quorum: 0 } }, 'route.quorum must be 1 or more'],
      [{ route: { to: 'maybe' } }, 'route.to must be one of no_one, people'],
      [{ route: { ...people, grants: [{ values: [] }] } }, 'route.grants[0].values must hold at least 1'],
      [{ route: { ...people, grants: [{ field: 'user@example.com', values: ['a'] }] } }, 'route.grants[0].field holds an email address; a person is named only as the actor'],
      [{ route: { ...people, grants: [{ values: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw'] }] } }, 'route.grants[0].values[0] holds what reads as a key or a token'],
      [{ route: { ...people, start: 'tomorrow' } }, 'route.start must be a time, as RFC 3339 writes one'],
      [{ route: people, reasons: [{}] }, 'reasons[0] must not be empty'],
      [{ route: people, reasons: [{ fence: 'tired' }] }, 'reasons[0].fence must be one of unknown, asker, judge_down'],
      [{ route: people, reasons: [{ effect: 0, proof: 'vibes' }] }, 'reasons[0].proof must be one of unknown, claimed, rehearsed, measured'],
      [{ route: people, reasons: [{ effect: -1 }] }, 'reasons[0].effect must be 0 or more'],
      [{ route: people, reasons: [{ effect: 2 }] }, 'reasons[0].effect names effect 2, and the statement has 2'],
      [{ route: people, reasons: [{ part: 1 }] }, 'reasons[0].part names part 1, and the statement has 1'],
      [{ route: { to: 'no_one' }, reasons: [{ fence: 'unknown' }] }, 'route: a fence sends the change to people, never to no one'],
      [{ route: people, extra: 1, reasons: [{ rule: 'a', note: 'x' }] }, 'reasons[0].note is not part of a change event'],
      [{ route: people, drafts: [{ route: { to: 'no_one' } }] }, 'drafts[0].pack is required'],
      [{ route: people, drafts: [{ pack: 'p', route: { to: 'no_one' }, reasons: [{ fence: 'asker' }] }] }, 'drafts[0].route: a fence sends the change to people, never to no one'],
    ]
    for (const [answer, error] of cases) expect(read(answer), JSON.stringify(answer)).toEqual({ ok: false, error })
    expect(readJudged({ route: { to: 'no_one' } }, stated)).toEqual({ ok: false, error: 'judge is required' })
    expect(readJudged({ judge: { ...judge, name: 'Trellis' }, route: { to: 'no_one' } }, stated)).toMatchObject({ ok: false, error: expect.stringMatching(/^judge\.name must match/) })
    expect(readJudged(null, stated)).toEqual({ ok: false, error: 'the answer must be an object' })
  })

  it('says each reason, and each draft as one, in words', () => {
    expect(reasonText({ effect: 0, proof: 'measured', rule: 'stops-in-place' }, stated)).toBe('stops workload acme-api-prod, in-place; proof measured; rule stops-in-place')
    expect(reasonText({ part: 0, fence: 'unknown' }, stated)).toBe('workload acme-api-prod: site_config.cors, which the writer could not name; fence unknown: nobody has proof of what it does')
    expect(routingLines({ route: { to: 'people', grants: [{ values: ['sec'] }], quorum: 1 }, reasons: [{ fence: 'judge_down' }], drafts: [{ pack: 'next', route: { to: 'no_one' } }] }, stated)).toEqual([
      'The judge did not answer, so it goes to people.',
      'Why it is asked:',
      '- fence judge_down: the judge did not answer',
      'Draft, not counting yet: pack next would route it to no one. It changes nobody who is asked.',
    ])
  })
})
