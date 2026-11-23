// Hygiene problems, computed at read time from the current state. Findings
// are the to-do list that makes the graph richer over time.

import { RUNNER_BLUEPRINT, SOURCE_BLUEPRINT, entityId, type EntityRef, type Finding, type StatusLevel } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { Budgets } from './budgets.ts'
import type { Conventions } from './conventions.ts'
import { unmetConventions } from '../shared/conventions.ts'
import type { Db } from './db.ts'
import type { Lists } from './lists.ts'
import type { Reader } from './read.ts'
import type { Rules } from './rules.ts'
import type { Sources } from './sources.ts'
import { timed } from './metrics.ts'
import { isDeepStrictEqual } from 'node:util'

const PENDING_TOLERANCE_MS = 24 * 3_600_000
/** Findings are the hub's, not a reader's: one answer every reader's view is put on. */
const HUB_READER = '\u0000hub'
const WHOLE = Object.freeze({})

export class Findings {
  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly sources: Sources
  private readonly rules: Rules
  private readonly reader: Reader
  private readonly lists: Lists
  private readonly budgets: Pick<Budgets, 'findings'>
  private readonly conventions: Pick<Conventions, 'get'>

  constructor(db: Db, blueprints: Blueprints, sources: Sources, rules: Rules, reader: Reader, lists: Lists, budgets: Pick<Budgets, 'findings'>, conventions: Pick<Conventions, 'get'>) {
    this.conventions = conventions
    this.budgets = budgets
    this.db = db
    this.blueprints = blueprints
    this.sources = sources
    this.rules = rules
    this.reader = reader
    this.lists = lists
  }

  /** Every finding, worked out once until something moves, the last ones given while the next are worked out. */
  list(): Promise<Finding[]> {
    return this.lists.recent('findings', HUB_READER, WHOLE, () => timed('findings', () => this.collect()))
  }

  private async collect(): Promise<Finding[]> {
    const out: Finding[] = []
    out.push(...(await this.danglingRelations()))
    out.push(...(await this.missingRequired()))
    out.push(...(await this.noRelations()))
    out.push(...(await this.unmatchedRules()))
    out.push(...this.staleSources())
    out.push(...(await this.massDrops()))
    out.push(...(await this.clearedOverrides()))
    out.push(...(await this.fieldConflicts()))
    out.push(...(await this.schemaMismatches()))
    out.push(...this.brokenPaths())
    out.push(...this.unmetConventions())
    out.push(...(await this.budgets.findings()))
    const order: Record<StatusLevel, number> = { red: 0, amber: 1, grey: 2, green: 3 }
    return out.sort((a, b) => order[a.level] - order[b.level] || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
  }

  async counts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const f of await this.list()) counts[f.kind] = (counts[f.kind] ?? 0) + 1
    return counts
  }

  private async danglingRelations(): Promise<Finding[]> {
    // The active entities are read once and both ends of every relation are matched against that one read. Asked
    // per relation instead, each end is a lookup by key: two for every relation in the estate, to name the few
    // whose far end is gone. Only those few then look up what state the far end is in.
    const rows = await this.db.query<{ blueprint: string; key: string; relation: string; target_blueprint: string; target_key: string; at: Date; target_state: string | null; title: string }>(
      `WITH live AS MATERIALIZED (SELECT blueprint, key, title FROM entities WHERE state = 'active')
       SELECT DISTINCT ON (r.blueprint, r.key, r.relation, r.target_blueprint, r.target_key)
         r.blueprint, r.key, r.relation, r.target_blueprint, r.target_key, r.at, t.state AS target_state, e.title
       FROM relations r JOIN live e ON e.blueprint = r.blueprint AND e.key = r.key
       LEFT JOIN entities t ON t.blueprint = r.target_blueprint AND t.key = r.target_key
       WHERE NOT EXISTS (SELECT 1 FROM live a WHERE a.blueprint = r.target_blueprint AND a.key = r.target_key)
         AND (r.blueprint, r.relation) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      this.blueprints.definedRelations(),
    )
    const now = Date.now()
    const out: Finding[] = []
    for (const r of rows.rows) {
      const ref = { blueprint: r.blueprint, key: r.key }
      const target = `${r.target_blueprint}:${r.target_key}`
      if (r.target_state === null) {
        if (now - r.at.getTime() < PENDING_TOLERANCE_MS) continue
        out.push({ kind: 'dangling_relation', level: 'amber', title: `${r.title} → ${target} never arrived`, detail: `Relation "${r.relation}" has pointed at ${target} since ${r.at.toISOString()} and no source has written it.`, entity: ref, target: { blueprint: r.target_blueprint, key: r.target_key } })
      } else {
        // A blueprint that expires by age holds things that happened. A record of one pointing at what has since been removed is history.
        if (r.target_state === 'deleted' && this.blueprints.get(r.blueprint)?.lifecycle?.expire) continue
        out.push({ kind: 'dangling_relation', level: 'amber', title: `${r.title} → ${target} is ${r.target_state}`, detail: `Relation "${r.relation}" points at an entity that is ${r.target_state}.`, entity: ref, target: { blueprint: r.target_blueprint, key: r.target_key } })
      }
    }
    return out
  }

  private async missingRequired(): Promise<Finding[]> {
    const out: Finding[] = []
    for (const bp of this.blueprints.list()) {
      const required = Object.entries(bp.relations).filter(([, r]) => r.required)
      if (!required.length) continue
      for (const [name, def] of required) {
        const rows = await this.db.query<{ blueprint: string; key: string; title: string }>(
          `SELECT e.blueprint, e.key, e.title FROM entities e JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
           WHERE e.blueprint = $1 AND e.state = 'active' AND NOT e.hidden AND jsonb_array_length(coalesce(d.relations->$2::text, '[]'::jsonb)) = 0 ORDER BY e.title, e.key`,
          [bp.id, name],
        )
        for (const e of rows.rows) out.push({ kind: 'missing_required_relation', level: 'amber', title: `${e.title} has no ${def.title ?? name}`, detail: `Blueprint "${bp.id}" requires relation "${name}" to ${def.target}.`, entity: e })
      }
    }
    return out
  }

  private async noRelations(): Promise<Finding[]> {
    const rows = await this.db.query<{ blueprint: string; key: string; title: string }>(
      `WITH defined AS (SELECT * FROM unnest($2::text[], $3::text[]) AS d(blueprint, relation))
       SELECT e.blueprint, e.key, e.title FROM entities e
       WHERE e.state = 'active' AND e.hidden = false AND e.blueprint <> ALL($1)
         AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.blueprint = e.blueprint AND r.key = e.key AND (r.blueprint, r.relation) IN (SELECT * FROM defined))
         AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.target_blueprint = e.blueprint AND r.target_key = e.key AND (r.blueprint, r.relation) IN (SELECT * FROM defined))
       ORDER BY e.blueprint, e.title`,
      [[SOURCE_BLUEPRINT, RUNNER_BLUEPRINT, ...this.blueprints.list().filter((b) => b.standalone).map((b) => b.id)], ...this.blueprints.definedRelations()],
    )
    return rows.rows.map((r) => ({ kind: 'no_relations', level: 'grey', title: `${r.title} (${r.blueprint}) is connected to nothing`, detail: 'No relation points at it and it points at nothing. Add a relation, a relation rule, or a note on why it stands alone.', entity: r }))
  }

  private async unmatchedRules(): Promise<Finding[]> {
    const out: Finding[] = []
    for (const rule of this.rules.list()) {
      if (rule.optional) continue
      const rows = await this.db.query<{ blueprint: string; key: string; title: string }>(
        `SELECT e.blueprint, e.key, e.title FROM entities e JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
         WHERE e.blueprint = $1 AND e.state = 'active' AND NOT e.hidden AND jsonb_array_length(coalesce(d.relations->$2::text, '[]'::jsonb)) = 0 ORDER BY e.title, e.key`,
        [rule.blueprint, rule.relation],
      )
      for (const e of rows.rows) out.push({ kind: 'unmatched_rule', level: 'grey', title: `${e.title} matched no ${rule.match.target}`, detail: `Rule "${rule.id}" (${rule.match.where}) found no target for relation "${rule.relation}".`, entity: e })
    }
    return out
  }

  private staleSources(): Finding[] {
    return this.sources
      .list()
      .filter((s) => s.class !== 'ui' && s.class !== 'hub' && s.status !== 'green' && s.status !== 'amber')
      .map((s) => ({ kind: 'stale_source', level: s.status === 'red' ? 'red' : 'grey', title: `Source ${s.id} is ${s.status}`, detail: s.statusReason ?? 'No run recorded.', source: s.id, entity: { blueprint: SOURCE_BLUEPRINT, key: s.id } }))
  }

  private async massDrops(): Promise<Finding[]> {
    const rows = await this.db.query<{ id: string; source: string; scope: string; counts: { missing?: number }; started_at: Date }>(`SELECT id, source, scope, counts, started_at FROM runs WHERE mass_drop = true AND started_at > now() - interval '7 days' ORDER BY started_at DESC`)
    const out: Finding[] = []
    const seen = new Set<string>()
    for (const r of rows.rows) {
      const k = `${r.source}|${r.scope}`
      if (seen.has(k)) continue
      seen.add(k)
      const still = await this.db.query<EntityRef>(`SELECT blueprint, key FROM entities WHERE owner = $1 AND scope = $2 AND state = 'missing' AND grace_until IS NOT NULL ORDER BY blueprint, key`, [r.source, r.scope])
      if (!still.rows.length) continue
      out.push({
        kind: 'mass_drop',
        level: 'amber',
        title: `${still.rows.length} ${still.rows.length === 1 ? 'entity' : 'entities'} vanished at once from ${r.source} (${r.scope})`,
        detail: `Run ${r.id} at ${r.started_at.toISOString()} removed more than ${30}% of its scope. They are held with extended grace: a permissions blip heals on the next run; a real removal expires by itself. Delete now if the removal is real.`,
        source: r.source,
        run: r.id,
        entities: still.rows,
      })
    }
    return out
  }

  private async clearedOverrides(): Promise<Finding[]> {
    const rows = await this.db.query<{ blueprint: string; key: string; at: Date; detail: { field: string; basis: unknown; pushed: unknown; override: unknown } }>(`SELECT blueprint, key, at, detail FROM changes WHERE kind = 'override.cleared' AND at > now() - interval '30 days' ORDER BY at DESC`)
    // A source that now sends what the person set lost them nothing: there is nothing to re-apply.
    return rows.rows.filter((r) => !isDeepStrictEqual(r.detail.pushed, r.detail.override)).map((r) => ({
      kind: 'cleared_override',
      level: 'grey',
      title: `Override on ${r.blueprint}:${r.key}.${r.detail.field} cleared`,
      detail: `At ${r.at.toISOString()} the pushed value moved from ${JSON.stringify(r.detail.basis)} to ${JSON.stringify(r.detail.pushed)}, so the override ${JSON.stringify(r.detail.override)} was dropped. Re-apply it if it still holds.`,
      entity: { blueprint: r.blueprint, key: r.key },
      field: r.detail.field,
    }))
  }

  /** A source wrote a field another source had written: one of them is pushing what is not its own. */
  private async fieldConflicts(): Promise<Finding[]> {
    const rows = await this.db.query<{ blueprint: string; key: string; source: string; at: Date; detail: { overwrote: Record<string, string> } }>(
      `SELECT blueprint, key, source, at, detail FROM changes WHERE kind = 'entity.updated' AND at > now() - interval '24 hours' AND detail ? 'overwrote' ORDER BY at DESC LIMIT 5000`,
    )
    const perField = new Map<string, { entity: EntityRef; field: string; by: string; from: string; at: Date; times: number }>()
    for (const r of rows.rows) {
      for (const [field, from] of Object.entries(r.detail.overwrote)) {
        const k = `${r.blueprint}:${r.key}|${field}`
        const seen = perField.get(k)
        if (seen) seen.times++
        else perField.set(k, { entity: { blueprint: r.blueprint, key: r.key }, field, by: r.source, from, at: r.at, times: 1 })
      }
    }
    return [...perField.values()].map((v) => ({
      kind: 'field_conflict',
      level: 'amber',
      title: `${entityId(v.entity)}.${v.field}: ${v.by} overwrote ${v.from}`,
      detail: `${v.times === 1 ? 'Once' : `${v.times} times`} in 24 hours, last at ${v.at.toISOString()}. The value was accepted. Decide which source owns the field and stop the other from sending it.`,
      entity: v.entity,
      field: v.field,
      source: v.by,
    }))
  }

  /** A mirror, an aggregation, a rollup, or an inherited relation whose path names something the model no longer has. */
  private brokenPaths(): Finding[] {
    return this.blueprints.brokenPaths().map((b) => ({ kind: 'broken_path', level: 'amber', title: `Blueprint ${b.blueprint} reads a path that does not exist`, detail: b.reason }))
  }

  /** A blueprint of a group a relation convention holds that lacks one of the convention's relations. */
  private unmetConventions(): Finding[] {
    return unmetConventions(this.conventions.get().conventions, this.blueprints.list()).map((u) => ({
      kind: 'unmet_convention',
      level: 'amber',
      title: `${this.blueprints.get(u.blueprint)?.title ?? u.blueprint} has no ${u.missing.join(' or ')}`,
      detail: `Convention "${u.convention.title ?? u.convention.id}" asks every blueprint in ${u.convention.groups.join(', ')} for ${u.convention.relations.join(', ')}. Add ${u.missing.join(' and ')} to blueprint "${u.blueprint}".`,
      blueprint: u.blueprint,
    }))
  }

  private async schemaMismatches(): Promise<Finding[]> {
    // A run's refused writes count until a later run of the same source and scope commits: that run sent what it sends now.
    // The errors are compared with the empty list, which Postgres can estimate: it then expects the few runs that
    // have any, and looks up each one's later runs rather than reading every run to match them.
    const rows = await this.db.query<{ id: string; source: string; errors: { blueprint?: string; key?: string; field?: string; reason: string }[] }>(
      `SELECT r.id, r.source, r.errors FROM runs r
       WHERE r.started_at > now() - interval '24 hours' AND r.errors <> '[]'::jsonb
         AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.source = r.source AND n.scope = r.scope AND n.state = 'committed' AND n.started_at > r.started_at)
       ORDER BY r.started_at DESC`,
    )
    const grouped = new Map<string, { source: string; run: string; count: number; example: string; blueprint: string; field?: string }>()
    for (const r of rows.rows) {
      for (const e of r.errors) {
        // A failed run keeps its reason in the same list, with no blueprint: that is the run failing, not the model refusing a write.
        if (!e.blueprint) continue
        const k = `${r.source}|${e.blueprint}|${e.field ?? ''}|${e.reason}`
        const cur = grouped.get(k)
        if (cur) cur.count++
        else grouped.set(k, { source: r.source, run: r.id, blueprint: e.blueprint, field: e.field, count: 1, example: `${e.blueprint}:${e.key ?? '?'}${e.field ? `.${e.field}` : ''}: ${e.reason}` })
      }
    }
    return [...grouped.values()].map((g) => ({ kind: 'schema_mismatch', level: 'amber', title: `${g.source} sent ${g.count} write(s) the blueprint refused`, detail: g.example, source: g.source, run: g.run, blueprint: g.blueprint, ...(g.field ? { field: g.field } : {}) }))
  }
}

export { entityId }
