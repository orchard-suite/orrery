// Health checks and runners. A `healthcheck` field names a URL and what to
// expect. Runners in each network segment pull their checks, run them, and
// push results; the hub has a built-in runner for public URLs. Several
// runners on one check give a reachability matrix.

import { z } from 'zod'
import type { CheckResult, HealthCheck } from '../shared/api.ts'
import type { EntityRef, StatusLevel } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { EntityRow } from './entities.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'
import { fetchTimed } from './metrics.ts'
import { layersOf } from './read.ts'
import type { SecretBox } from './secrets.ts'
import { resolve } from './values.ts'

export const HUB_RUNNER = 'hub'

export const healthcheckSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
  /** A status code, a class like `2xx`, or `ok` for anything below 500 (a login redirect still means the site answers). Defaults to 2xx. */
  expectStatus: z.union([z.number().int(), z.string().regex(/^([1-5]xx|ok)$/)]).default('2xx'),
  /** A substring the body must contain. */
  expectBody: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(5000),
  auth: z.object({ type: z.enum(['bearer', 'basic', 'header']), secretRef: z.string().min(1), header: z.string().optional() }).optional(),
  /** Runner source ids. Defaults to the hub's own runner. */
  runners: z.array(z.string().min(1)).default([HUB_RUNNER]),
  /** What a healthy result looks like from these runners. */
  expect: z.enum(['reachable', 'unreachable']).default('reachable'),
  /** Skip TLS verification, for self-signed LAN certificates. */
  insecure: z.boolean().default(false),
})

export interface AssignedCheck {
  entity: EntityRef
  field: string
  check: HealthCheck
  /** Secret value for the runner to use; never exposed on the read API. */
  secret?: string
}

export const resultSchema = z.object({
  results: z.array(
    z.object({
      blueprint: z.string(),
      key: z.string(),
      field: z.string(),
      ok: z.boolean(),
      status: z.number().int().nullable().optional(),
      latencyMs: z.number().int().nullable().optional(),
      error: z.string().nullable().optional(),
      checkedAt: z.string().optional(),
    }),
  ),
})

export class Checks {

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly secrets: SecretBox
  private readonly events: Events
  private readonly log: Logger

  /** The deriver's queue: a result that lands or goes moves its entity's status. The hub wires it. */
  queue: Queue = NO_QUEUE

  constructor(db: Db, blueprints: Blueprints, secrets: SecretBox, events: Events, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.secrets = secrets
    this.events = events
    this.log = log
  }

  // Secrets -------------------------------------------------------------------

  async setSecret(name: string, value: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) throw new Error('secret names are lowercase letters, digits, and _ . -')
    await this.db.query('INSERT INTO secrets (name, sealed, updated_at) VALUES ($1, $2, now()) ON CONFLICT (name) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()', [name, this.secrets.seal(value)])
    this.log.info('secret stored', { name })
  }

  async listSecrets(): Promise<{ name: string; updatedAt: string }[]> {
    const rows = await this.db.query<{ name: string; updated_at: Date }>('SELECT name, updated_at FROM secrets ORDER BY name')
    return rows.rows.map((r) => ({ name: r.name, updatedAt: r.updated_at.toISOString() }))
  }

  async deleteSecret(name: string): Promise<void> {
    await this.db.query('DELETE FROM secrets WHERE name = $1', [name])
  }

  /** The value of a stored secret, for a runner or an action backend; never for the read API. */
  async openSecret(name: string): Promise<string | undefined> {
    const row = await this.db.query<{ sealed: string }>('SELECT sealed FROM secrets WHERE name = $1', [name])
    if (!row.rows[0]) {
      this.log.warn('check references a secret that does not exist', { secret: name })
      return undefined
    }
    try {
      return this.secrets.open(row.rows[0].sealed)
    } catch (error) {
      this.log.error('secret cannot be opened: it was sealed with a different SECRET_KEY', { secret: name, error })
      return undefined
    }
  }

  // Checks ----------------------------------------------------------------------

  /** Every check on every active entity, or on `of` alone. With `withSecrets`, auth secrets are opened for a runner. */
  async all(withSecrets = false, of?: EntityRef): Promise<AssignedCheck[]> {
    const fields = this.blueprints.list().filter((bp) => !of || bp.id === of.blueprint).flatMap((bp) => Object.entries(bp.fields).filter(([, f]) => f.type === 'healthcheck').map(([name]) => ({ blueprint: bp.id, field: name })))
    if (!fields.length) return []
    const rows = of
      ? await this.db.query<EntityRow>(`SELECT * FROM entities WHERE state = 'active' AND blueprint = $1 AND key = $2`, [of.blueprint, of.key])
      : await this.db.query<EntityRow>(`SELECT * FROM entities WHERE state = 'active' AND blueprint = ANY($1)`, [[...new Set(fields.map((f) => f.blueprint))]])
    const out: AssignedCheck[] = []
    for (const row of rows.rows) {
      for (const f of fields.filter((x) => x.blueprint === row.blueprint)) {
        const value = resolve(f.field, layersOf(row), undefined)?.value
        if (!value || typeof value !== 'object') continue
        const parsed = healthcheckSchema.safeParse(value)
        if (!parsed.success) {
          this.log.warn('health check ignored: does not fit the schema', { blueprint: row.blueprint, key: row.key, field: f.field, issues: parsed.error.issues.map((i) => i.message) })
          continue
        }
        const item: AssignedCheck = { entity: { blueprint: row.blueprint, key: row.key }, field: f.field, check: parsed.data }
        if (withSecrets && parsed.data.auth) item.secret = await this.openSecret(parsed.data.auth.secretRef)
        out.push(item)
      }
    }
    return out
  }

  async forRunner(runner: string): Promise<AssignedCheck[]> {
    return (await this.all(true)).filter((c) => c.check.runners.includes(runner))
  }

  /**
   * Keeps each result as the latest for its check. An entity's status reads
   * whether a check passed and what it failed with, so only a result that is
   * new or says something else of those sends its entity to be derived: a
   * check that passes again every half minute moves nothing.
   */
  async record(runner: string, results: z.infer<typeof resultSchema>['results']): Promise<number> {
    const moved: EntityRef[] = []
    for (const r of results) {
      const kept = await this.db.query<{ had: boolean; was_ok: boolean | null; was_error: string | null }>(
        `WITH was AS (SELECT ok, error FROM check_results WHERE blueprint = $1 AND key = $2 AND field = $3 AND runner = $4)
         INSERT INTO check_results (blueprint, key, field, runner, ok, status, latency_ms, error, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (blueprint, key, field, runner) DO UPDATE SET ok = EXCLUDED.ok, status = EXCLUDED.status, latency_ms = EXCLUDED.latency_ms, error = EXCLUDED.error, at = EXCLUDED.at
         RETURNING EXISTS (SELECT 1 FROM was) AS had, (SELECT ok FROM was) AS was_ok, (SELECT error FROM was) AS was_error`,
        [r.blueprint, r.key, r.field, runner, r.ok, r.status ?? null, r.latencyMs ?? null, r.error ?? null, r.checkedAt ? new Date(r.checkedAt) : new Date()],
      )
      const was = kept.rows[0]!
      if (!was.had || was.was_ok !== r.ok || was.was_error !== (r.error ?? null)) moved.push({ blueprint: r.blueprint, key: r.key })
      this.log.info('check result', { runner, entity: `${r.blueprint}:${r.key}`, field: r.field, ok: r.ok, status: r.status, latencyMs: r.latencyMs, error: r.error })
      this.events.emit({ type: 'entity', blueprint: r.blueprint, key: r.key, values: true })
    }
    await this.queue.enqueue(this.db, moved)
    await this.queue.inline(moved)
    return results.length
  }

  /** Latest result per (entity, field, runner), keyed by entity id: of `refs` when given, else of every entity. */
  async results(refs?: EntityRef[]): Promise<Map<string, CheckResult[]>> {
    type Row = { blueprint: string; key: string; field: string; runner: string; ok: boolean; status: number | null; latency_ms: number | null; error: string | null; at: Date }
    const rows = refs
      ? await this.db.query<Row>('SELECT * FROM check_results WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
      : await this.db.query<Row>('SELECT * FROM check_results')
    const out = new Map<string, CheckResult[]>()
    for (const r of rows.rows) {
      const id = `${r.blueprint}:${r.key}`
      out.set(id, [...(out.get(id) ?? []), { blueprint: r.blueprint, key: r.key, field: r.field, runner: r.runner, ok: r.ok, status: r.status, latencyMs: r.latency_ms, error: r.error, at: r.at.toISOString() }])
    }
    return out
  }

  /** Drops results for checks that no longer exist. */
  async prune(): Promise<void> {
    const live = new Set((await this.all()).flatMap((c) => c.check.runners.map((r) => `${c.entity.blueprint}|${c.entity.key}|${c.field}|${r}`)))
    const rows = await this.db.query<{ blueprint: string; key: string; field: string; runner: string }>('SELECT blueprint, key, field, runner FROM check_results')
    for (const r of rows.rows) {
      if (!live.has(`${r.blueprint}|${r.key}|${r.field}|${r.runner}`)) {
        await this.db.query('DELETE FROM check_results WHERE blueprint = $1 AND key = $2 AND field = $3 AND runner = $4', [r.blueprint, r.key, r.field, r.runner])
        await this.queue.enqueue(this.db, [r])
      }
    }
  }

  // The built-in runner ------------------------------------------------------

  async runHub(): Promise<void> {
    const checks = await this.forRunner(HUB_RUNNER)
    if (!checks.length) return
    const results = await Promise.all(checks.map((c) => execute(c)))
    await this.record(HUB_RUNNER, results.map((r, i) => ({ ...checks[i]!.entity, field: checks[i]!.field, ...r })))
    await this.prune()
  }
}

/** Runs one check with fetch. Shared with nothing: the Go runner has its own. */
export async function execute(c: AssignedCheck): Promise<{ ok: boolean; status: number | null; latencyMs: number; error: string | null; checkedAt: string }> {
  const started = Date.now()
  const headers: Record<string, string> = { 'user-agent': 'orrery-check/1' }
  if (c.check.auth && c.secret !== undefined) {
    if (c.check.auth.type === 'bearer') headers.authorization = `Bearer ${c.secret}`
    else if (c.check.auth.type === 'basic') headers.authorization = `Basic ${Buffer.from(c.secret).toString('base64')}`
    else headers[c.check.auth.header ?? 'x-api-key'] = c.secret
  }
  try {
    const res = await fetchTimed('check', c.check.url, { method: c.check.method, headers, signal: AbortSignal.timeout(c.check.timeoutMs), redirect: 'manual' })
    const latencyMs = Date.now() - started
    const statusOk = typeof c.check.expectStatus === 'number' ? res.status === c.check.expectStatus : c.check.expectStatus === 'ok' ? res.status < 500 : String(res.status)[0] === c.check.expectStatus[0]
    let bodyOk = true
    if (c.check.expectBody) bodyOk = (await res.text()).includes(c.check.expectBody)
    const ok = statusOk && bodyOk
    return { ok, status: res.status, latencyMs, error: ok ? null : !statusOk ? `expected ${c.check.expectStatus}, got ${res.status}` : 'body did not contain the expected text', checkedAt: new Date().toISOString() }
  } catch (error) {
    return { ok: false, status: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() }
  }
}

/** Worst-of over every runner on every check of an entity. */
export function checkLevel(checks: { field: string; check: HealthCheck }[], results: CheckResult[]): { level: StatusLevel; reasons: string[] } {
  let level: StatusLevel = 'green'
  const reasons: string[] = []
  for (const c of checks) {
    for (const runner of c.check.runners) {
      const r = results.find((x) => x.field === c.field && x.runner === runner)
      if (!r) {
        if (level === 'green') level = 'grey'
        reasons.push(`${c.field}: no result from ${runner} yet`)
        continue
      }
      const healthy = c.check.expect === 'reachable' ? r.ok : !r.ok
      if (!healthy) {
        level = 'red'
        reasons.push(`${c.field} from ${runner}: ${c.check.expect === 'reachable' ? (r.error ?? 'failed') : 'reachable but should not be'}`)
      }
    }
  }
  return { level, reasons }
}
