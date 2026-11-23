// Alert ingest: an Alertmanager webhook attaches firing alerts to entities
// by label matching, configured like relation rules. Prometheus stays the
// authority on metric-based health; the hub only shows what is firing.

import { z } from 'zod'
import type { Alert, AlertRule } from '../shared/api.ts'
import type { Blueprint, DefinitionOrigin, Entity, EntityRef, Source, StatusLevel } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Entities, WriteInput } from './entities.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import { parseSides, valueAt } from './rules.ts'
import { stable } from './values.ts'
import { DefinitionError } from './definition-error.ts'

export const alertRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).optional(),
  blueprint: z.string().min(1),
  /** e.g. `target.key == alert.labels['namespace']` or `target.name == alert.labels['deployment']`. */
  where: z.string().min(1),
})

export const alertmanagerSchema = z.object({
  alerts: z.array(
    z.object({
      status: z.enum(['firing', 'resolved']),
      labels: z.record(z.string(), z.string()).default({}),
      annotations: z.record(z.string(), z.string()).default({}),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      fingerprint: z.string().min(1),
    }),
  ),
})

export class Alerts {
  private rules: AlertRule[] = []

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly reader: Reader
  private readonly entities: Entities
  private readonly events: Events
  private readonly log: Logger

  /** The deriver's queue: an alert that fires or resolves moves its entity's status. The hub wires it. */
  queue: Queue = NO_QUEUE

  constructor(db: Db, blueprints: Blueprints, reader: Reader, entities: Entities, events: Events, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.reader = reader
    this.entities = entities
    this.events = events
    this.log = log
  }

  async load(): Promise<void> {
    const rows = await this.db.query<{ id: string; blueprint: string; where_expr: string; origin: DefinitionOrigin }>('SELECT * FROM alert_rules ORDER BY id')
    this.rules = rows.rows.map((r) => ({ id: r.id, blueprint: r.blueprint, where: r.where_expr, origin: r.origin }))
  }

  listRules(): AlertRule[] {
    return [...this.rules]
  }

  async saveRule(input: unknown, origin: DefinitionOrigin): Promise<AlertRule> {
    const parsed = alertRuleSchema.safeParse(input)
    if (!parsed.success) throw new DefinitionError(`Invalid alert rule: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const r = parsed.data
    this.blueprints.require(r.blueprint)
    parseSides(r.where, ['alert', 'target'])
    const id = r.id ?? `${r.blueprint}.alerts`
    const existing = this.rules.find((x) => x.id === id)
    if (existing && existing.origin.kind === 'git' && origin.kind !== 'git') throw new DefinitionError(`Alert rule "${id}" is defined in git; edit it there`)
    await this.db.query(`INSERT INTO alert_rules (id, blueprint, where_expr, origin) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET blueprint = EXCLUDED.blueprint, where_expr = EXCLUDED.where_expr, origin = EXCLUDED.origin`, [id, r.blueprint, r.where, JSON.stringify(origin)])
    await this.load()
    // Git saves what it holds on every pass; only a save that changed something is activity.
    const same = existing && existing.blueprint === r.blueprint && existing.where === r.where && stable(existing.origin) === stable(origin)
    if (!same) await record(this.db, 'alert_rule.changed', { blueprint: r.blueprint }, 'source' in origin ? origin.source : null, null, { rule: id, created: !existing, origin })
    this.log.info('alert rule saved', { rule: id })
    return this.rules.find((x) => x.id === id)!
  }

  async removeRule(id: string, origin?: DefinitionOrigin['kind']): Promise<void> {
    const existing = this.rules.find((x) => x.id === id)
    if (!existing) throw new DefinitionError(`Unknown alert rule "${id}"`, 404)
    if (existing.origin.kind === 'git' && origin !== 'git') throw new DefinitionError(`Alert rule "${id}" is defined in git; remove it there`)
    await this.db.query('DELETE FROM alert_rules WHERE id = $1', [id])
    await this.load()
    await record(this.db, 'alert_rule.changed', { blueprint: existing.blueprint }, 'source' in existing.origin && origin === 'git' ? existing.origin.source : null, null, { rule: id, removed: true })
    this.log.info('alert rule removed', { rule: id })
  }

  /**
   * Takes an Alertmanager webhook payload. Firing alerts are stored and
   * matched; resolved ones are removed. When the source keeps history, every
   * alert, firing or resolved, is also written as an entity that stays.
   */
  async ingest(source: Source, payload: z.infer<typeof alertmanagerSchema>): Promise<{ firing: number; resolved: number; matched: number; unmatched: number; kept: number }> {
    const counts = { firing: 0, resolved: 0, matched: 0, unmatched: 0, kept: 0 }
    const touched: EntityRef[] = []
    const history = source.history ? this.blueprints.get(source.history.blueprint) : undefined
    if (source.history && !history) this.log.warn('alert history not kept: the blueprint does not exist', { source: source.id, blueprint: source.history.blueprint })
    const indexes = new Map<string, { rule: AlertRule; sides: Record<string, string[]>; byValue: Map<string, Entity> }>()
    for (const rule of this.rules) {
      const sides = parseSides(rule.where, ['alert', 'target'])
      const { entities } = await this.reader.list({ blueprint: rule.blueprint, includeHidden: true, limit: Infinity })
      const byValue = new Map<string, Entity>()
      for (const e of entities) {
        const v = valueAt(e, sides.target!)
        if (v !== undefined && v !== null) byValue.set(stable(v), e)
      }
      indexes.set(rule.id, { rule, sides, byValue })
    }
    for (const a of payload.alerts) {
      if (a.status === 'resolved') {
        const res = await this.db.query<{ blueprint: string | null; key: string | null }>('DELETE FROM alerts WHERE fingerprint = $1 RETURNING blueprint, key', [a.fingerprint])
        counts.resolved++
        this.log.info('alert resolved', { fingerprint: a.fingerprint, alertname: a.labels.alertname, known: !!res.rowCount })
        const was = res.rows[0]
        if (was?.blueprint && was.key) touched.push({ blueprint: was.blueprint, key: was.key })
        if (history && (await this.keep(source, history, a, was?.blueprint && was.key ? { blueprint: was.blueprint, key: was.key } : null))) counts.kept++
        continue
      }
      counts.firing++
      let target: EntityRef | null = null
      for (const { rule, sides, byValue } of indexes.values()) {
        const v = alertValue({ labels: a.labels, annotations: a.annotations, status: a.status }, sides.alert!)
        if (v === undefined || v === null) continue
        const hit = byValue.get(stable(v))
        if (hit) {
          target = { blueprint: hit.blueprint, key: hit.key }
          this.log.debug('alert matched', { fingerprint: a.fingerprint, rule: rule.id, entity: `${hit.blueprint}:${hit.key}` })
          break
        }
      }
      if (target) {
        counts.matched++
        touched.push(target)
      } else {
        counts.unmatched++
        this.log.info('alert matched no entity', { fingerprint: a.fingerprint, alertname: a.labels.alertname, labels: a.labels })
      }
      await this.db.query(
        `INSERT INTO alerts (fingerprint, source, status, labels, annotations, starts_at, ends_at, blueprint, key, updated_at) VALUES ($1,$2,'firing',$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (fingerprint) DO UPDATE SET status = 'firing', labels = EXCLUDED.labels, annotations = EXCLUDED.annotations, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, blueprint = EXCLUDED.blueprint, key = EXCLUDED.key, updated_at = now()`,
        [a.fingerprint, source.id, JSON.stringify(a.labels), JSON.stringify(a.annotations), a.startsAt ? new Date(a.startsAt) : null, a.endsAt && !a.endsAt.startsWith('0001') ? new Date(a.endsAt) : null, target?.blueprint ?? null, target?.key ?? null],
      )
      if (history && (await this.keep(source, history, a, target))) counts.kept++
    }
    await this.queue.enqueue(this.db, touched)
    await this.queue.inline(touched)
    return counts
  }

  /**
   * Writes one alert as an entity of the source's history blueprint. A field
   * the blueprint lacks is left out, so the blueprint decides what is kept.
   * Returns whether the hub took the write.
   */
  private async keep(source: Source, bp: Blueprint, a: z.infer<typeof alertmanagerSchema>['alerts'][number], target: EntityRef | null): Promise<boolean> {
    const resolved = a.status === 'resolved'
    const startsAt = validDate(a.startsAt)
    const endsAt = resolved ? (validDate(a.endsAt) ?? new Date().toISOString()) : null
    const severity = severityOf(a.labels.severity)
    const all: Record<string, unknown> = {
      summary: a.annotations.summary ?? a.annotations.description ?? a.labels.alertname ?? a.fingerprint,
      status: resolved ? 'resolved' : 'open',
      severity,
      // The same line the live alert's status draws: critical and high are red.
      health: resolved ? 'green' : severity === 'critical' || severity === 'high' ? 'red' : 'amber',
      source: 'alertmanager',
      rule: a.labels.alertname ?? null,
      started_at: startsAt,
      resolved_at: endsAt,
      duration_hours: startsAt && endsAt ? Math.round(((Date.parse(endsAt) - Date.parse(startsAt)) / 3_600_000) * 100) / 100 : null,
      labels: a.labels,
    }
    const fields = Object.fromEntries(Object.entries(all).filter(([name, value]) => name in bp.fields && value !== null && this.fits(bp, name, value)))
    const relations: Record<string, string> = {}
    const relation = source.history?.relation
    if (relation && target) {
      if (bp.relations[relation]?.target === target.blueprint) relations[relation] = `${target.blueprint}:${target.key}`
      else this.log.info('alert history kept without its entity: the relation does not target it', { source: source.id, relation, entity: `${target.blueprint}:${target.key}` })
    }
    const input: WriteInput = { blueprint: bp.id, key: `${source.id}/${a.fingerprint}`, title: a.labels.alertname ?? a.fingerprint, fields, relations }
    const result = await this.entities.write(input, { source, layer: 'pushed', mode: 'upsert', replace: false })
    if (result.outcome === 'rejected') {
      this.log.warn('alert history refused', { source: source.id, fingerprint: a.fingerprint, errors: result.errors })
      return false
    }
    this.log.debug('alert history kept', { source: source.id, key: input.key, outcome: result.outcome })
    return true
  }

  /** An enum field takes only its own values; anything else is left out rather than refusing the whole write. */
  private fits(bp: Blueprint, name: string, value: unknown): boolean {
    const def = bp.fields[name]!
    return def.type !== 'enum' || def.many || (typeof value === 'string' && (def.values ?? []).includes(value))
  }

  async list(refs?: EntityRef[]): Promise<Alert[]> {
    type Row = { fingerprint: string; source: string; status: string; labels: Record<string, string>; annotations: Record<string, string>; starts_at: Date | null; ends_at: Date | null; blueprint: string | null; key: string | null; updated_at: Date }
    const rows = refs
      ? await this.db.query<Row>('SELECT * FROM alerts WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY starts_at DESC NULLS LAST', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
      : await this.db.query<Row>('SELECT * FROM alerts ORDER BY starts_at DESC NULLS LAST')
    return rows.rows.map((r) => ({ fingerprint: r.fingerprint, source: r.source, status: r.status, labels: r.labels, annotations: r.annotations, startsAt: r.starts_at?.toISOString() ?? null, endsAt: r.ends_at?.toISOString() ?? null, entity: r.blueprint && r.key ? { blueprint: r.blueprint, key: r.key } : null, updatedAt: r.updated_at.toISOString() }))
  }

  /** Firing alerts per entity id, for status rollup: of `refs` when given, else of every entity. */
  async byEntity(refs?: EntityRef[]): Promise<Map<string, Alert[]>> {
    const out = new Map<string, Alert[]>()
    for (const a of await this.list(refs)) {
      if (!a.entity) continue
      const id = `${a.entity.blueprint}:${a.entity.key}`
      out.set(id, [...(out.get(id) ?? []), a])
    }
    return out
  }

  /** Alerts older than `hours` without an update are dropped: Alertmanager resends firing alerts, so silence means gone. */
  async expire(hours = 6): Promise<number> {
    const res = await this.db.query<{ blueprint: string | null; key: string | null }>(`DELETE FROM alerts WHERE updated_at < now() - make_interval(hours => $1) RETURNING blueprint, key`, [hours])
    if (res.rowCount) {
      await this.queue.enqueue(this.db, res.rows.filter((r): r is { blueprint: string; key: string } => !!r.blueprint && !!r.key))
      this.log.info('stale alerts expired', { count: res.rowCount })
    }
    return res.rowCount ?? 0
  }
}

/** Alertmanager sends 0001-01-01 for a time it does not have. */
function validDate(v: string | undefined): string | null {
  if (!v || v.startsWith('0001')) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** The four severities a history blueprint keeps, from the labels Prometheus rules use. */
function severityOf(label: string | undefined): string {
  const s = (label ?? '').toLowerCase()
  if (/^(critical|page|p1|sev0|sev1)$/.test(s)) return 'critical'
  if (/^(high|error|p2|sev2)$/.test(s)) return 'high'
  if (/^(warning|warn|medium|p3|sev3)$/.test(s)) return 'medium'
  return 'low'
}

function alertValue(a: { labels: Record<string, string>; annotations: Record<string, string>; status: string }, path: string[]): unknown {
  let cur: unknown = a as unknown
  for (const seg of path) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg]
    else return undefined
  }
  return cur
}

export function alertLevel(alerts: Alert[]): { level: StatusLevel; reasons: string[] } {
  if (!alerts.length) return { level: 'green', reasons: [] }
  const critical = alerts.filter((a) => /^(critical|page|high)$/i.test(a.labels.severity ?? ''))
  const reasons = alerts.map((a) => `alert ${a.labels.alertname ?? a.fingerprint}${a.annotations.summary ? `: ${a.annotations.summary}` : ''}`)
  return { level: critical.length ? 'red' : 'amber', reasons }
}
