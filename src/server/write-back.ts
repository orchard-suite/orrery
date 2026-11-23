// What a run hands back to write on the entity it ran on. A backend names a
// value with a `::refresh:: <field>=<json>` line; the run holds the values of
// the fields its action `refreshes` until it ends. Once it succeeds they are
// written on its own entity as that entity's owning source, the way the
// source's next push writes them, which then replaces them as usual.

import { isDerived, type Action, type ActionRun, type WroteBack } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Entities } from './entities.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { Sources } from './sources.ts'
import { equal, validateValue } from './values.ts'

export interface WriteBackDeps {
  db: Db
  blueprints: Blueprints
  reader: Reader
  sources: Sources
  entities: Entities
  /** Why these names may not be written on this blueprint by a run, whoever owns the entity, or null. */
  decides: (blueprint: string, names: string[]) => string | null
  log: Logger
}

/** What became of a run's handed-back values: the log lines that say so, and what was written. */
export interface WriteBackOutcome {
  lines: string[]
  wrote: WroteBack[]
}

/** The values of a report that the action takes, and a line for each it drops. */
export function heldBack(action: Action | undefined, given: Record<string, unknown>): { kept: Record<string, unknown>; lines: string[] } {
  const named = new Set(action?.refreshes ?? [])
  const kept: Record<string, unknown> = {}
  const lines: string[] = []
  for (const [field, value] of Object.entries(given)) {
    if (named.has(field)) kept[field] = value
    else lines.push(named.size ? `not written back: "${field}" is not a field this action refreshes (${[...named].join(', ')})` : `not written back: "${field}": this action refreshes no field`)
  }
  return { kept, lines }
}

/**
 * Writes what a succeeded run handed back on its own entity, as its owner.
 * A value of a field the action does not refresh never reaches here; a value
 * of the wrong type is refused alone, and the run stays succeeded.
 */
export async function writeBack(deps: WriteBackDeps, run: ActionRun, action: Action, held: Record<string, unknown>): Promise<WriteBackOutcome> {
  const lines: string[] = []
  const skip = (why: string, detail: Record<string, unknown> = {}): WriteBackOutcome => {
    deps.log.info('run wrote nothing back', { run: run.id, action: action.id, why, ...detail })
    return { lines: [`nothing written back: ${why}`], wrote: [] }
  }
  if (!run.entity) return skip('the run is on no entity')
  const ref = run.entity
  const entity = await deps.reader.get(ref)
  if (!entity || entity.state === 'deleted') return skip(`${ref.blueprint}:${ref.key} is gone`)
  const owner = deps.sources.get(entity.owner)
  if (!owner || owner.class === 'git' || owner.class === 'runner') return skip(`${ref.blueprint}:${ref.key} is kept by ${owner ? `${owner.class} source "${owner.id}"` : entity.owner === 'ui' ? 'people' : `"${entity.owner}"`}, not by a source that pushes`, { owner: entity.owner })
  const bp = deps.blueprints.get(ref.blueprint)
  if (!bp) return skip(`blueprint "${ref.blueprint}" is gone`)
  const fields: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(held)) {
    const def = bp.fields[field]
    const wrong = !def ? `${bp.id} has no field "${field}"` : isDerived(def) ? `${bp.id}.${field} is worked out by the hub` : validateValue(def, value)
    if (wrong) {
      lines.push(`not written back: ${field}: ${wrong}`)
      deps.log.warn('run write-back refused a value', { run: run.id, action: action.id, ...ref, field, reason: wrong })
      continue
    }
    fields[field] = value
  }
  const names = Object.keys(fields)
  const refused = names.length ? deps.decides(ref.blueprint, names) : null
  if (refused) {
    deps.log.warn('run write-back refused: access is decided from it', { run: run.id, action: action.id, ...ref, reason: refused })
    return { lines: [...lines, `nothing written back: ${refused}`], wrote: [] }
  }
  const wrote: WroteBack[] = names.filter((f) => !equal(entity.fields[f] ?? null, fields[f])).map((field) => ({ field, was: entity.fields[field] ?? null, now: fields[field] }))
  if (!wrote.length) {
    deps.log.info('run write-back changed nothing', { run: run.id, action: action.id, ...ref, fields: names })
    return { lines: [...lines, ...(names.length ? [`written back: ${names.join(', ')}, as ${owner.id}; each already held what the run handed back`] : [])], wrote: [] }
  }
  const result = await deps.entities.write({ blueprint: ref.blueprint, key: ref.key, fields: Object.fromEntries(wrote.map((w) => [w.field, w.now])) }, { source: owner, layer: 'pushed', mode: 'enrich', replace: false })
  if (result.outcome === 'rejected') {
    const why = result.errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ')
    deps.log.warn('run write-back refused by the entity write', { run: run.id, action: action.id, ...ref, owner: owner.id, reason: why })
    return { lines: [...lines, `nothing written back: ${why}`], wrote: [] }
  }
  await record(deps.db, 'action.wrote_back', ref, owner.id, null, { action: action.id, run: run.id, as: owner.id, fields: wrote })
  deps.log.info('run wrote back on its entity', { run: run.id, action: action.id, ...ref, owner: owner.id, fields: wrote.map((w) => w.field) })
  return { lines: [...lines, `wrote back ${wrote.map((w) => w.field).join(', ')} on ${ref.blueprint}:${ref.key}, as ${owner.id}`], wrote }
}
