import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChangeStatement } from '../shared/change.ts'
import { changeJudge, JUDGE_TIMEOUT_MS } from './judge.ts'
import { createLogger, type Logger } from './log.ts'

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
    expect(await changeJudge('http://judge.test', 'tok', log, slow, 20).route(statement, context)).toEqual({ ok: false, why: 'the judge did not answer within 20ms' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('gives no answer when no judge is named, or the judge refuses the statement', async () => {
    expect(await changeJudge(undefined, undefined, log).route(statement, context)).toEqual({ ok: false, why: 'the hub names no judge' })
    const refusing: typeof fetch = async () => Response.json({ error: 'bad_statement', reason: 'unknown kind' }, { status: 400 })
    expect(await changeJudge('http://judge.test', 'tok', log, refusing).route(statement, context)).toEqual({ ok: false, why: 'the judge answered 400: bad_statement' })
  })

  it('calls the machine door with its token, and takes a refused token as no answer, never logging it', async () => {
    const lines: string[] = []
    const keep = (msg: string, fields?: Record<string, unknown>) => void lines.push(JSON.stringify({ msg, ...fields }))
    const kept: Logger = { debug: keep, info: keep, warn: keep, error: keep, child: () => kept }
    const sent: Headers[] = []
    for (const status of [401, 403]) {
      const refusing: typeof fetch = async (_url, init) => {
        sent.push(new Headers(init?.headers))
        return Response.json({ error: 'unauthorized', reason: 'bad token' }, { status })
      }
      expect(await changeJudge('http://judge.test', 'orj_secret-token', kept, refusing).route(statement, context)).toEqual({ ok: false, why: `the judge answered ${status}: unauthorized` })
    }
    expect(sent.map((h) => h.get('authorization'))).toEqual(['Bearer orj_secret-token', 'Bearer orj_secret-token'])
    expect(lines.filter((l) => l.includes("judge refused the hub's token"))).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('orj_secret-token')
  })

  it('calls nothing with a URL and no token, as the hub calls no other member without one', async () => {
    let called = false
    const never: typeof fetch = async () => {
      called = true
      return Response.json({})
    }
    expect(await changeJudge('http://judge.test', undefined, log, never).route(statement, context)).toEqual({ ok: false, why: 'the hub names no judge' })
    expect(called).toBe(false)
  })

  it('reads a route, passing over what else the answer says', async () => {
    const judge = { name: 'trellis', version: '7.0.0', pack: 'gate' }
    const answering: typeof fetch = async () => Response.json({ judge, route: { to: 'no_one' }, took_ms: 4 })
    expect(await changeJudge('http://judge.test', 'tok', log, answering).route(statement, context)).toEqual({ ok: true, routing: { judge, route: { to: 'no_one' } } })
  })
})
