import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChangeStatement } from '../shared/change.ts'
import { checkOf, digestOf, endedEvent, outcomeOf, routedEvent, statedEvent } from './change-events.ts'

const EXAMPLES = join(import.meta.dirname, '..', 'shared', 'change', 'examples')
const example = JSON.parse(readFileSync(join(EXAMPLES, 'event-stated.json'), 'utf8')) as { digest: string; statement: ChangeStatement }

describe('the digest of a statement', () => {
  it('is the platform kit digest of its worked example', () => {
    expect(example.digest).toBe('sha256:631648276c5b93648131ddef01fe2882376e690c04284e39cb0a66c048381181')
    expect(digestOf(example.statement)).toBe(example.digest)
  })

  it('is the same whether an empty part is written or left out, and moves with anything stated', () => {
    const s = example.statement
    // The second effect's claim names no version: written as an empty string, it is the same statement.
    expect(digestOf({ ...s, effects: s.effects!.map((e) => ({ ...e, claim: { ...e.claim, version: e.claim.version ?? '' } })) })).toBe(example.digest)
    const { unknown: _unknown, ...noUnknown } = s
    expect(digestOf({ ...noUnknown, unknown: [] })).toBe(digestOf(noUnknown))
    expect(digestOf({ ...s, applier: 'asker' })).not.toBe(example.digest)
  })
})

describe('the events of a stated change', () => {
  const at = new Date('2026-11-26T20:01:04Z')
  it('are keyed by the run, and each later one names the stated one', () => {
    const stated = statedEvent('run1', example.statement, example.digest, at)
    expect(stated).toEqual({ event: 'change.stated', sender: 'orrery', key: 'run1.stated', at: '2026-11-26T20:01:04.000Z', digest: example.digest, statement: example.statement })
    const routed = routedEvent({ id: 'run1', action: 'apply' }, example.digest, at, '2.2.0', [{ values: ['user@example.com'] }], 2)
    expect(routed).toMatchObject({ key: 'run1.routed', of: { sender: 'orrery', key: 'run1.stated' }, judge: { name: 'orrery', version: '2.2.0', pack: 'action.apply' }, route: { to: 'people', grants: [{ values: ['user@example.com'] }], quorum: 2 }, reasons: [{ rule: 'action-approval' }] })
    expect(routedEvent({ id: 'run1', action: 'apply' }, example.digest, at, '2.2.0', null, 1).route).toEqual({ to: 'no_one' })
  })
})

describe("the applier's check", () => {
  it('is read from the run outputs, and is unchecked when the applier said nothing', () => {
    expect(checkOf({})).toEqual({ check: 'unchecked', differs: [] })
    expect(checkOf({ statement_check: 'matched' })).toEqual({ check: 'matched', differs: [] })
    expect(checkOf({ statement_check: 'maybe' })).toEqual({ check: 'unchecked', differs: [] })
    expect(checkOf({ statement_check: 'differed', statement_differs: 'artifact, effects,colour' })).toEqual({ check: 'differed', differs: ['artifact', 'effects'] })
    expect(checkOf({ statement_check: 'matched', statement_differs: 'artifact' })).toEqual({ check: 'matched', differs: [] })
  })

  it('says how the change ended from the state the run reached', () => {
    expect(outcomeOf('succeeded', 'matched')).toEqual({ outcome: 'ok' })
    expect(outcomeOf('failed', 'unchecked').outcome).toBe('failed')
    expect(outcomeOf('failed', 'differed').outcome).toBe('refused')
    expect(outcomeOf('declined', 'unchecked').outcome).toBe('refused')
    expect(outcomeOf('returned', 'unchecked').outcome).toBe('refused')
    expect(outcomeOf('cancelled', 'unchecked').outcome).toBe('refused')
    expect(outcomeOf('cancelled', 'unchecked', true).outcome).toBe('failed')
    expect(outcomeOf('unknown', 'unchecked').outcome).toBe('failed')
    expect(endedEvent('run1', example.digest, new Date(0), 'refused', 'differed', ['artifact'])).toMatchObject({ key: 'run1.ended', check: 'differed', differs: ['artifact'] })
    expect(endedEvent('run1', example.digest, new Date(0), 'ok', 'matched', [])).not.toHaveProperty('differs')
  })
})
