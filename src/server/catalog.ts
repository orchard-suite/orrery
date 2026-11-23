// Catalog files: YAML declaring blueprints, entities, relation rules, and
// instance config. A git source holds them and stays their owner; an import
// in the web app brings one in once and leaves everything editable.

import { readFile, readdir } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { ImportReport, ModelTemplate } from '../shared/api.ts'
import type { Source } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Entities, WriteInput } from './entities.ts'
import type { Logger } from './log.ts'
import type { Rules } from './rules.ts'
import type { Runs } from './runs.ts'
import type { Scorecards } from './scorecards.ts'
import type { Visibility } from './visibility.ts'
import { record } from './activity.ts'
import { normalizePolicy } from '../shared/policy.ts'
import type { Alerts } from './alerts.ts'
import type { Actions } from './actions.ts'
import type { Icons } from './icons.ts'
import type { ColumnStandards } from './standard.ts'
import type { Conventions } from './conventions.ts'
import type { Welcome } from './welcome.ts'

export interface CatalogFile {
  file: string
  blueprints: unknown[]
  entities: unknown[]
  relationRules: unknown[]
  scorecards: unknown[]
  alertRules: unknown[]
  actions: unknown[]
  config: Record<string, unknown> | null
}

export interface CatalogReport {
  files: number
  blueprints: number
  entities: number
  rules: number
  scorecards: number
  actions: number
  errors: { file: string; reason: string }[]
  run: string | null
}

export async function readCatalog(dir: string, pattern: string): Promise<{ files: CatalogFile[]; errors: { file: string; reason: string }[] }> {
  const root = resolve(dir)
  const files: CatalogFile[] = []
  const errors: { file: string; reason: string }[] = []
  const paths: string[] = []
  for await (const p of glob(pattern, { cwd: root })) paths.push(p)
  for (const p of paths.sort()) {
    const file = relative(root, resolve(root, p))
    try {
      files.push(parseCatalog(await readFile(resolve(root, p), 'utf8'), file))
    } catch (error) {
      errors.push({ file, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { files, errors }
}

/** Parses one catalog file. Throws on YAML that does not parse. */
export function parseCatalog(text: string, file: string): CatalogFile {
  const entry: CatalogFile = { file, blueprints: [], entities: [], relationRules: [], scorecards: [], alertRules: [], actions: [], config: null }
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('; '))
    const body = doc.toJS() as Record<string, unknown> | null
    if (!body || typeof body !== 'object') continue
    if (Array.isArray(body.blueprints)) entry.blueprints.push(...body.blueprints)
    else if (body.blueprint && typeof body.blueprint === 'string') entry.blueprints.push({ ...body, id: body.blueprint, blueprint: undefined })
    if (Array.isArray(body.entities)) entry.entities.push(...body.entities)
    if (Array.isArray(body.relationRules)) entry.relationRules.push(...body.relationRules)
    if (Array.isArray(body.scorecards)) entry.scorecards.push(...body.scorecards)
    if (Array.isArray(body.alertRules)) entry.alertRules.push(...body.alertRules)
    if (Array.isArray(body.actions)) entry.actions.push(...body.actions)
    if (body.config && typeof body.config === 'object') entry.config = body.config as Record<string, unknown>
  }
  return entry
}

/** Where the models offered for import live. They are read when asked for and never loaded by themselves. */
export const TEMPLATE_DIR = resolve(import.meta.dirname, 'templates')

async function templateFiles(): Promise<{ id: string; text: string }[]> {
  const names = (await readdir(TEMPLATE_DIR)).filter((n) => n.endsWith('.yaml')).sort()
  return Promise.all(names.map(async (name) => ({ id: name.slice(0, -5), text: await readFile(join(TEMPLATE_DIR, name), 'utf8') })))
}

/** The templates in the order they are meant to be imported: each file's `template.order`. */
export async function listTemplates(): Promise<ModelTemplate[]> {
  return (await templateFiles())
    .map(({ id, text }) => {
      const head = (parseAllDocuments(text)[0]?.toJS() as { template?: { title?: string; description?: string; order?: number } } | null)?.template
      const ids = parseCatalog(text, id).blueprints.map((b) => String((b as { id?: unknown }).id ?? ''))
      return { order: head?.order ?? 99, template: { id, title: head?.title ?? id, description: head?.description ?? '', blueprints: ids } }
    })
    .sort((a, b) => a.order - b.order)
    .map((t) => t.template)
}

export async function readTemplate(id: string): Promise<string | null> {
  return (await templateFiles()).find((t) => t.id === id)?.text ?? null
}

/**
 * Brings a model in from the web app. What does not exist is created and is
 * the importer's to edit. A blueprint that exists gains the fields and
 * relations it lacks; a rule, a scorecard, or an entity that exists is left
 * alone. Nothing is ever changed or removed, so importing twice is harmless.
 */
export async function importModel(deps: { blueprints: Blueprints; entities: Entities; reader: { rowsFor(refs: { blueprint: string; key: string }[]): Promise<unknown[]> }; rules: Rules; scorecards: Scorecards; alerts: Alerts; actions: Actions; log: Logger }, text: string, actor: string, admin = false): Promise<ImportReport> {
  const { blueprints, entities, rules, scorecards, alerts, actions, log } = deps
  const file = parseCatalog(text, 'import')
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const offered = await blueprints.offer(file.blueprints, { kind: 'ui' }, actor, (bp, field) => entities.valuesOf(bp, field))
  const report: ImportReport = {
    blueprints: { created: offered.created, extended: offered.extended, kept: offered.kept },
    rules: { created: [], kept: [] },
    scorecards: { created: [], kept: [] },
    alertRules: { created: [], kept: [] },
    actions: { created: [], kept: [] },
    entities: { created: 0, kept: 0 },
    errors: offered.rejected.map((r) => `blueprint ${r.blueprint}: ${r.reason}`),
  }
  const each = async (inputs: unknown[], what: string, idOf: (input: Record<string, unknown>) => string, has: (id: string) => boolean, save: (input: unknown) => Promise<unknown>, into: { created: string[]; kept: string[] }): Promise<void> => {
    for (const input of inputs) {
      const id = input && typeof input === 'object' ? idOf(input as Record<string, unknown>) : ''
      if (has(id)) {
        into.kept.push(id)
        continue
      }
      try {
        await save(input)
        into.created.push(id)
      } catch (error) {
        report.errors.push(`${what} ${id}: ${message(error)}`)
      }
    }
  }
  await each(file.relationRules, 'rule', (r) => String(r.id ?? `${String(r.blueprint)}.${String(r.relation)}`), (id) => rules.list().some((r) => r.id === id), (r) => rules.save(r, { kind: 'ui' }), report.rules)
  await each(file.scorecards, 'scorecard', (s) => scorecards.idFor(s), (id) => !!scorecards.get(id), (s) => scorecards.save(s, { kind: 'ui' }), report.scorecards)
  await each(file.alertRules, 'alert rule', (r) => String(r.id ?? `${String(r.blueprint)}.alerts`), (id) => alerts.listRules().some((r) => r.id === id), (r) => alerts.saveRule(r, { kind: 'ui' }), report.alertRules)
  await each(file.actions, 'action', (a) => String(a.id ?? ''), (id) => !!actions.get(id), (a) => actions.save(a, { kind: 'ui' }, admin), report.actions)
  for (const e of file.entities as Partial<WriteInput>[]) {
    if (!e || typeof e !== 'object' || typeof e.blueprint !== 'string' || typeof e.key !== 'string') {
      report.errors.push(`entity needs blueprint and key: ${JSON.stringify(e).slice(0, 80)}`)
      continue
    }
    if ((await deps.reader.rowsFor([{ blueprint: e.blueprint, key: e.key }])).length) {
      report.entities.kept++
      continue
    }
    try {
      await entities.createFromUi({ blueprint: e.blueprint, key: e.key, title: e.title, icon: e.icon, fields: e.fields ?? {}, relations: e.relations ?? {} }, actor)
      report.entities.created++
    } catch (error) {
      report.errors.push(`entity ${e.blueprint}:${e.key}: ${message(error)}`)
    }
  }
  // The re-link reads the whole estate and can outlast a request, so the import answers once the model is saved and the
  // relations it changes follow in the background, the same way any other model change takes effect.
  void rules.evaluateAll().catch((error) => log.error('re-link after an import failed', { error }))
  log.info('model imported', { actor, created: report.blueprints.created, extended: report.blueprints.extended, kept: report.blueprints.kept.length, rules: report.rules.created.length, scorecards: report.scorecards.created.length, actions: report.actions.created.length, entities: report.entities.created, errors: report.errors.length })
  return report
}

/** Applies a catalog as one snapshot run of the source. */
export async function applyCatalog(
  deps: { db: Db; blueprints: Blueprints; standards: ColumnStandards; conventions: Conventions; welcome: Welcome; entities: Entities; rules: Rules; runs: Runs; scorecards: Scorecards; alerts: Alerts; actions: Actions; icons: Icons; visibility: Visibility; log: Logger },
  source: Source,
  dir: string,
  pattern: string,
): Promise<CatalogReport> {
  const { blueprints, rules, runs, scorecards, alerts, actions, icons, log } = deps
  const { files, errors } = await readCatalog(dir, pattern)
  // The icons beside the catalog files come first, so an entity that names one shows it from its first read.
  const iconErrors = await icons.syncGit(source.id, resolve(dir), [...files.map((f) => f.file), ...errors.map((e) => e.file)].map((f) => dirname(f)))
  const report: CatalogReport = { files: files.length, blueprints: 0, entities: 0, rules: 0, scorecards: 0, actions: 0, errors, run: null }
  const origin = (file: string) => ({ kind: 'git' as const, source: source.id, file })

  // Blueprints may reference each other in any order: retry until nothing more saves.
  let pending = files.flatMap((f) => f.blueprints.map((b) => ({ b: b as { id?: string; blueprint?: string }, file: f.file })))
  const arriving = new Set(pending.map(({ b }) => String(b.id ?? b.blueprint ?? '')))
  const seenBlueprints = new Set<string>()
  // Why each blueprint last failed to save: the reason the report gives once nothing more saves.
  const refused = new Map<string, string>()
  for (let round = 0; pending.length && round < 10; round++) {
    const next: typeof pending = []
    for (const { b, file } of pending) {
      const id = b.id ?? b.blueprint
      try {
        const { blueprint: _b, ...spec } = b
        const saved = await blueprints.save({ ...spec, id }, origin(file), source.id, (bp, field) => deps.entities.valuesOf(bp, field), arriving)
        seenBlueprints.add(saved.id)
        report.blueprints++
      } catch (error) {
        next.push({ b, file })
        refused.set(String(id), error instanceof Error ? error.message : String(error))
      }
    }
    if ((next.length === pending.length && round > 0) || round === 9) {
      for (const { b, file } of next) report.errors.push({ file, reason: `blueprint ${b.id ?? b.blueprint}: ${refused.get(String(b.id ?? b.blueprint))}` })
      break
    }
    pending = next
  }
  // Blueprints this source defined before and no longer does. One may be the target of another's relation, so retry until nothing more goes.
  let gone = blueprints.list().filter((bp) => bp.origin.kind === 'git' && bp.origin.source === source.id && !seenBlueprints.has(bp.id))
  for (;;) {
    const stays: { bp: (typeof gone)[number]; error: unknown }[] = []
    for (const bp of gone) {
      try {
        await blueprints.remove(bp.id, source.id, source.id)
      } catch (error) {
        stays.push({ bp, error })
      }
    }
    if (!stays.length || stays.length === gone.length) {
      for (const { bp, error } of stays) report.errors.push({ file: bp.origin.kind === 'git' ? bp.origin.file : '', reason: `blueprint ${bp.id} was removed from the catalog but stays: ${error instanceof Error ? error.message : String(error)}` })
      break
    }
    gone = stays.map((s) => s.bp)
  }

  // The layout of the catalog: the last file to declare each part wins, and a source that stops declaring every part lets go.
  const isNames = (o: unknown): o is string[] => Array.isArray(o) && o.every((g) => typeof g === 'string')
  const isOrders = (o: unknown): o is Record<string, string[]> => !!o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every(isNames)
  const last = <T>(key: string, fits: (o: unknown) => o is T): T | undefined => files.map((f) => (f.config?.catalog as Record<string, unknown> | undefined)?.[key]).filter(fits).at(-1)
  const declared = { order: last('groupOrder', isNames), closed: last('closedGroups', isNames), blueprints: last('blueprintOrder', isOrders), hidden: last('hiddenBlueprints', isNames) }
  const declares = Object.values(declared).some(Boolean)
  const owner = blueprints.layout().source
  if (declares && owner && owner !== source.id) report.errors.push({ file: '?', reason: `config.catalog: the layout of the catalog is already declared by source "${owner}"` })
  else if (declares) await blueprints.setLayout({ order: declared.order ?? [], closed: declared.closed ?? [], blueprints: declared.blueprints ?? {}, hidden: declared.hidden ?? [] }, source.id)
  else if (await blueprints.releaseLayout(source.id)) log.info('catalog layout released: the catalog no longer declares it', { source: source.id })

  // The column standard: the last file to declare `config.columns` wins, and git owns it while it does.
  const columns = files.map((f) => f.config?.columns).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)).at(-1)
  if (columns) {
    try {
      await deps.standards.declare(columns, source.id)
    } catch (error) {
      report.errors.push({ file: '?', reason: `config.columns: ${error instanceof Error ? error.message : String(error)}` })
    }
  } else if (await deps.standards.release(source.id)) log.info('column standard released: the catalog no longer declares it', { source: source.id })

  // The relation conventions: the last file to declare `config.conventions` wins, and git owns them while it does.
  const conventions = files.map((f) => f.config?.conventions).filter((o): o is unknown[] => Array.isArray(o)).at(-1)
  if (conventions) {
    try {
      await deps.conventions.declare({ conventions }, source.id)
    } catch (error) {
      report.errors.push({ file: '?', reason: `config.conventions: ${error instanceof Error ? error.message : String(error)}` })
    }
  } else await deps.conventions.release(source.id)

  // The welcome tour: the last file to declare `config.welcome` wins, and git owns it while it does.
  const welcome = files.map((f) => f.config?.welcome).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)).at(-1)
  if (welcome) {
    try {
      await deps.welcome.declare(welcome, source.id)
    } catch (error) {
      report.errors.push({ file: '?', reason: `config.welcome: ${error instanceof Error ? error.message : String(error)}` })
    }
  } else await deps.welcome.release(source.id)

  // The audiences and field classes: the last file to declare `config.access` wins, and git owns them while it does.
  const policy = files.map((f) => f.config?.access).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)).at(-1)
  const { visibility } = deps
  const policyOwner = visibility.policyState().source
  if (policy && policyOwner && policyOwner !== source.id) report.errors.push({ file: '?', reason: `config.access: the audiences and classes are already declared by source "${policyOwner}"` })
  else if (policy) {
    try {
      const before = visibility.policyState().policy
      if (await visibility.setPolicy(normalizePolicy(policy as Parameters<typeof normalizePolicy>[0]), source.id)) await record(deps.db, 'access.changed', null, source.id, null, { policy: true, before, after: visibility.policyState().policy })
    } catch (error) {
      report.errors.push({ file: '?', reason: `config.access: ${error instanceof Error ? error.message : String(error)}` })
    }
  } else await visibility.releasePolicy(source.id)

  const seenRules = new Set<string>()
  for (const f of files) {
    for (const r of f.relationRules) {
      try {
        const saved = await rules.save(r, origin(f.file))
        seenRules.add(saved.id)
        report.rules++
      } catch (error) {
        report.errors.push({ file: f.file, reason: `rule: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    // The nesting depth limit is still read from its old place, `canvas.maxNestingDepth`.
    if (f.config?.canvas && typeof f.config.canvas === 'object') {
      const depth = (f.config.canvas as { maxNestingDepth?: number }).maxNestingDepth
      if (typeof depth === 'number') {
        await deps.db.query(`INSERT INTO settings (key, value) VALUES ('canvas.maxNestingDepth', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(depth)])
      }
    }
  }
  for (const r of rules.list()) {
    if (r.origin.kind === 'git' && r.origin.source === source.id && !seenRules.has(r.id)) await rules.remove(r.id, 'git')
  }

  const run = await runs.open(source, 'snapshot', 'catalog')
  report.run = run.id
  const items: WriteInput[] = []
  for (const f of files) {
    for (const e of f.entities as Partial<WriteInput>[]) {
      if (!e || typeof e !== 'object' || typeof e.blueprint !== 'string' || typeof e.key !== 'string') {
        report.errors.push({ file: f.file, reason: `entity needs blueprint and key: ${JSON.stringify(e).slice(0, 80)}` })
        continue
      }
      items.push({ blueprint: e.blueprint, key: e.key, title: e.title, icon: e.icon, fields: e.fields ?? {}, relations: e.relations ?? {}, file: f.file })
    }
  }
  for (let i = 0; i < items.length; i += 200) {
    const { rejected } = await runs.writeBatch(run.id, source, items.slice(i, i + 200))
    for (const r of rejected) report.errors.push({ file: items.find((x) => x.blueprint === r.blueprint && x.key === r.key)?.file ?? '?', reason: `${r.blueprint}:${r.key}${r.field ? `.${r.field}` : ''}: ${r.reason}` })
  }
  report.scorecards = 0
  const seenScorecards = new Set<string>()
  const seenAlertRules = new Set<string>()
  const seenActions = new Set<string>()
  for (const f of files) {
    for (const sc of f.scorecards) {
      try {
        seenScorecards.add((await scorecards.save(sc, origin(f.file))).id)
        report.scorecards++
      } catch (error) {
        report.errors.push({ file: f.file, reason: `scorecard: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    for (const r of f.alertRules) {
      try {
        seenAlertRules.add((await alerts.saveRule(r, origin(f.file))).id)
      } catch (error) {
        report.errors.push({ file: f.file, reason: `alert rule: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    for (const a of f.actions) {
      try {
        seenActions.add((await actions.save(a, origin(f.file))).id)
        report.actions++
      } catch (error) {
        report.errors.push({ file: f.file, reason: `action: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }
  for (const sc of scorecards.list()) if (sc.origin.kind === 'git' && sc.origin.source === source.id && !seenScorecards.has(sc.id)) await scorecards.remove(sc.id, sc.origin)
  for (const r of alerts.listRules()) if (r.origin.kind === 'git' && r.origin.source === source.id && !seenAlertRules.has(r.id)) await alerts.removeRule(r.id, 'git')
  for (const a of actions.list()) if (a.origin.kind === 'git' && a.origin.source === source.id && !seenActions.has(a.id)) await actions.remove(a.id, a.origin)
  report.entities = items.length - report.errors.filter((e) => e.reason.includes(':')).length
  report.errors.push(...iconErrors)
  await runs.commit(run.id, source)
  log.info('catalog applied', { source: source.id, files: report.files, blueprints: report.blueprints, entities: items.length, rules: report.rules, actions: report.actions, errors: report.errors.length })
  return report
}
