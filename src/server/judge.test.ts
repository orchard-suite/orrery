import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChangeStatement } from '../shared/change.ts'
import { changeJudge, JUDGE_TIMEOUT_MS } from './judge.ts'
import { createLogger } from './log.ts'

const { statement } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { statement: ChangeStatement }
const log = createLogger('judge-test')
const context = { run: 'r1', action: 'apply' }

describe('the judge client', () => {
  it('waits a short, fixed time', () => {
    expect(JUDGE_TIMEOUT_MS).toBe(3000)
  })

  it('gives no answer when the judge is slower than its timeout', async () => {
    const slow: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    const started = Date.now()
    expect(await changeJudge('http://judge.test', log, slow, 20).route(statement, context)).toEqual({ ok: false, why: 'the judge did not answer within 20ms' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('gives no answer when no judge is named, or the judge refuses the statement', async () => {
    expect(await changeJudge(undefined, log).route(statement, context)).toEqual({ ok: false, why: 'the hub names no judge' })
    const refusing: typeof fetch = async () => Response.json({ error: 'bad_statement', reason: 'unknown kind' }, { status: 400 })
    expect(await changeJudge('http://judge.test', log, refusing).route(statement, context)).toEqual({ ok: false, why: 'the judge answered 400: bad_statement' })
  })

  it('reads a route, passing over what else the answer says', async () => {
    const judge = { name: 'trellis', version: '7.0.0', pack: 'gate' }
    const answering: typeof fetch = async () => Response.json({ judge, route: { to: 'no_one' }, took_ms: 4 })
    expect(await changeJudge('http://judge.test', log, answering).route(statement, context)).toEqual({ ok: true, routing: { judge, route: { to: 'no_one' } } })
  })
})
