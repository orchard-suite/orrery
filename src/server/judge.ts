// The estate's judge, asked for the route of one change: `POST <JUDGE_URL>/v1/judge`
// with `{"statement": ...}`. A 200 answers the judge, its route, its reasons,
// and its drafts, read with `readJudged`. Anything else is no answer: a judge
// that is not set, down, slow past `JUDGE_TIMEOUT_MS`, refusing the statement,
// or answering what is not a route. The hub never waits on the judge to pass
// a change: no answer sends the run to people.

import { readJudged, type ChangeJudge, type ChangeRouting, type ChangeStatement } from '../shared/change.ts'
import type { Logger } from './log.ts'

/** How long the hub waits for the judge's answer before it sends the run to people. */
export const JUDGE_TIMEOUT_MS = 3000

/** The judge's route for one statement, or why there is none. */
export type JudgeAnswer = { ok: true; routing: ChangeRouting & { judge: ChangeJudge } } | { ok: false; why: string }

export interface ChangeJudgeClient {
  route(statement: ChangeStatement, context: { run: string; action: string }): Promise<JudgeAnswer>
}

/** A judge at `url`, or none when the hub names no judge: then every run of a judge-approved action goes to people. */
export function changeJudge(url: string | undefined, log: Logger, fetcher: typeof fetch = fetch, timeoutMs = JUDGE_TIMEOUT_MS): ChangeJudgeClient {
  return {
    async route(statement, context) {
      if (!url) {
        log.warn('change not judged: the hub names no judge (JUDGE_URL)', context)
        return { ok: false, why: 'the hub names no judge' }
      }
      const started = Date.now()
      let res: Response
      try {
        res = await fetcher(`${url.replace(/\/+$/, '')}/v1/judge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statement }), signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        log.warn(timedOut ? 'judge did not answer in time' : 'judge could not be reached', { ...context, ms: Date.now() - started, timeoutMs, error: error instanceof Error ? error.message : String(error) })
        return { ok: false, why: timedOut ? `the judge did not answer within ${timeoutMs}ms` : 'the judge could not be reached' }
      }
      let body: unknown
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (res.status !== 200) {
        const said = typeof body === 'object' && body !== null ? (body as { error?: unknown; reason?: unknown }) : {}
        log.warn('judge refused the change', { ...context, status: res.status, error: typeof said.error === 'string' ? said.error : null, reason: typeof said.reason === 'string' ? said.reason : null })
        return { ok: false, why: `the judge answered ${res.status}${typeof said.error === 'string' ? `: ${said.error}` : ''}` }
      }
      const read = readJudged(body, statement)
      if (!read.ok) {
        log.warn('judge answered what is not a route', { ...context, error: read.error })
        return { ok: false, why: `the judge's answer is not a route: ${read.error}` }
      }
      log.info('change judged', { ...context, ms: Date.now() - started, judge: read.routing.judge.name, pack: read.routing.judge.pack, route: read.routing.route.to, drafts: read.routing.drafts?.length ?? 0 })
      return read
    },
  }
}
