// Reports: a team's report kept as an entity of the hub's report blueprint,
// and each edition it publishes kept as an entity of the edition blueprint,
// with what the edition was drawn from and the data it read kept beside it in
// `report_editions`. The record is the truth of a report; `report_versions`
// keeps every layout it had, so a version can be put back.
//
// Every change comes through a run of an action with the `report` backend,
// judged here as the person who ran it: the report's owner, someone who owns
// its home, or an admin. So who may ask, who approves, and what was asked are
// the actions engine's, and the run list and the ledger are the history.
//
// A publish reads every data set as the report's owner, never as the hub or
// the person who pressed the button: a saved query through the owner's view,
// a runner tool called with the tiers the owner holds. A narrative block's
// prose is written by the report's writer, a runner tool given the block's
// instruction and the data it reads: the hub calls no model. The hub then
// works out the edition's blocks, keeps them with the data, writes the
// edition's record, and writes the activity row the notice forwarder tells
// the recipients from, each only while they may see the report.

import { type ReportVerb, buildContent, capped, DATA_ROWS_MAX, formatNumber, gap, headlineOf, parseLayout, tableOf, writerData, type Before, type DataSet, type EditionContent, type LayoutIssue, type Prose, type ReportLayout } from '../shared/report.ts'
import { drawEdition } from '../shared/report-draw.ts'
import { cadenceWords, type Cadence } from '../shared/cadence.ts'
import { EDITION_BLUEPRINT, entityId, isFinished, parseEntityId, REPORT_BLUEPRINT, type ActionRun, type Entity, type EntityRef, type Identity } from '../shared/model.ts'
import type { OutputValue } from '../shared/run-marks.ts'
import type { QueryAnswer, QueryAnswerGroup, QueryView, ReportLine, ReportSchedule, ReportsResponse, ReportPage, ReportEditionRead, ReportPreviewRead, ReportVersion, ReportEditionLine } from '../shared/api.ts'
import { record } from './activity.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import { ensureHubBlueprints, HOME_OF, reportRelations } from './builtin.ts'
import type { Db } from './db.ts'
import type { Entities } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import type { Queries } from './queries.ts'
import type { Reader } from './read.ts'
import type { Schedules } from './schedules.ts'
import type { Sources } from './sources.ts'
import type { View } from './visibility.ts'

/** The most people one report is sent to: what one event to the notification desk addresses. A wider audience subscribes to the report on the desk. */
export const RECIPIENTS_MAX = 20
/** The most reports one list holds. */
const REPORTS_MAX = 200
/** The most headline numbers a report shows in a list. */
const LINE_STATS = 4
/** How long a publish waits for one tool, data set or writer, to answer. */
const TOOL_WAIT_MS = 10 * 60_000

export class ReportError extends Error {
  readonly status: 400 | 403 | 404 | 409
  readonly input?: string
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400, input?: string) {
    super(message)
    this.status = status
    if (input !== undefined) this.input = input
  }
}

/** How a publish writes into its run as it goes: a step, a line under it, and the outputs it ends with. */
export interface RunPen {
  step(name: string): Promise<void>
  line(message: string): Promise<void>
}

/** What a report run ends with. */
export interface ReportDone {
  summary: string
  link: string
  outputs?: Record<string, OutputValue>
}

export interface ReportsDeps {
  db: Db
  entities: Entities
  reader: Reader
  blueprints: Blueprints
  sources: Sources
  queries: Queries
  actions: Actions
  schedules: Pick<Schedules, 'handOver' | 'find'>
  events: Events
  identityFor: (address: string) => Identity | null
  /** Who an address would be on signing in for the first time: a person with no role, judged by the access rules alone. */
  arriving: (address: string) => Identity
  viewOf: (identity: Identity) => Promise<View>
  /** The time zone a person keeps their day in, or null when they set none. */
  zoneOf: (person: string) => Promise<string | null>
  /** Whether the person owns this entity, in any way the person setting's `owns` paths say. */
  owns: (identity: Identity, home: string) => Promise<boolean>
  publicUrl: string
  log: Logger
}

/** An email address, as a recipient is named. */
const ADDRESS = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/

export class Reports {
  private readonly deps: ReportsDeps

  constructor(deps: ReportsDeps) {
    this.deps = deps
  }

  /** The page of a report, its editions, and an edition, by key. */
  pageUrl(key: string, edition?: number): string {
    return `${this.deps.publicUrl}/reports/${encodeURIComponent(key)}${edition ? `?edition=${edition}` : ''}`
  }

  /**
   * Every problem a layout has for this person: its own grammar, then each
   * saved query they may not read, and each tool that is no tool. A writer is
   * a tool on reports, given `instruction` and `data`.
   */
  async problems(text: string, who: Identity): Promise<LayoutIssue[]> {
    const { layout, issues } = parseLayout(text)
    if (!layout) return issues
    const out: LayoutIssue[] = []
    for (const [name, def] of Object.entries(layout.data)) {
      if ('query' in def) {
        try {
          await this.deps.queries.get(def.query, who)
        } catch {
          out.push({ line: 1, message: `data set "${name}": no saved query "${def.query}" that the report's owner may read` })
        }
      } else {
        const tool = this.deps.actions.get(def.tool)
        if (!tool?.tool) out.push({ line: 1, message: `data set "${name}": "${def.tool}" is not a tool` })
        else if (def.entity && !parseEntityId(def.entity)) out.push({ line: 1, message: `data set "${name}": entity is blueprint:key` })
      }
    }
    if (layout.writer) {
      const writer = this.deps.actions.get(layout.writer)
      if (!writer?.tool) out.push({ line: 1, message: `writer: "${layout.writer}" is not a tool` })
      else {
        const missing = ['instruction', 'data'].filter((n) => !writer.inputs[n])
        if (missing.length) out.push({ line: 1, message: `writer: tool "${layout.writer}" takes no ${missing.join(' or ')} input; a writer is given both` })
        const on = writer.blueprint === undefined ? [] : Array.isArray(writer.blueprint) ? writer.blueprint : [writer.blueprint]
        if (!on.includes(REPORT_BLUEPRINT)) out.push({ line: 1, message: `writer: tool "${layout.writer}" runs on ${on.join(', ') || 'no entity'}; a writer runs on ${REPORT_BLUEPRINT}, so it is called on the report` })
      }
    }
    return out
  }

  /** Why these inputs of a report run would be refused, naming the input, or null. Asked before the run is written. */
  async check(verb: ReportVerb, inputs: Record<string, unknown>, who: Identity, entity: Entity | null): Promise<{ input: string; message: string } | null> {
    if (verb === 'create' || (verb === 'edit' && typeof inputs.version !== 'number' && typeof inputs.layout === 'string' && inputs.layout.trim())) {
      // A layout is checked as its owner reads it: the person creating, or the owner of the report they edit.
      const owner = verb === 'create' ? who : (this.deps.identityFor(String(entity?.fields.owner ?? '')) ?? who)
      const issues = await this.problems(String(inputs.layout ?? ''), owner)
      if (issues.length) return { input: 'layout', message: issues.map((i) => `line ${i.line}: ${i.message}`).join('\n') }
    }
    if (verb === 'edit' && !(typeof inputs.layout === 'string' && inputs.layout.trim()) && typeof inputs.version !== 'number') return { input: 'layout', message: 'give the new layout, or the version to put back' }
    if (verb === 'hand') {
      const to = String(inputs.owner ?? '').trim()
      const next = this.deps.identityFor(to)
      if (!next || next.kind !== 'user') return { input: 'owner', message: `${to || 'nobody'} has never signed in to the hub, so a report cannot be read as them` }
    }
    if (verb === 'create' || verb === 'recipients') {
      const wrong = listOf(inputs.recipients).find((a) => !ADDRESS.test(a))
      if (wrong) return { input: 'recipients', message: `"${wrong}" is not an address` }
      if (listOf(inputs.recipients).length > RECIPIENTS_MAX) return { input: 'recipients', message: `a report is sent to at most ${RECIPIENTS_MAX} people` }
    }
    return null
  }

  /** A report as this person may see it, or a 404. */
  private async seen(key: string, who: Identity, view?: View): Promise<Entity> {
    const e = await this.deps.reader.get({ blueprint: REPORT_BLUEPRINT, key })
    const shown = e && e.state !== 'deleted' ? (view ?? (await this.deps.viewOf(who))).entity(e) : null
    if (!shown) throw new ReportError(`Unknown report "${key}"`, 404)
    return shown
  }

  /** The home of a report, as its entity id, or null. */
  private homeOf(e: Entity): string | null {
    for (const [name, refs] of Object.entries(e.relations)) if (name.startsWith(HOME_OF) && refs[0]) return entityId(refs[0])
    return null
  }

  /** Whether the person may change and publish a report: its owner, someone who owns its home, or an admin. */
  async mayChange(e: Entity, who: Identity): Promise<boolean> {
    if (who.admin) return true
    if (who.kind !== 'user') return false
    if (String(e.fields.owner ?? '').toLowerCase() === who.name.toLowerCase()) return true
    const home = this.homeOf(e)
    return !!home && (await this.deps.owns(who, home))
  }

  private async changeable(key: string, who: Identity): Promise<Entity> {
    const e = await this.seen(key, who)
    if (!(await this.mayChange(e, who))) {
      this.deps.log.warn('report change refused: not its owner, nor of its home', { report: key, by: who.name })
      throw new ReportError(`Only the owner of report "${key}", the people who own its home, or an admin change it`, 403)
    }
    return e
  }

  private hub() {
    const hub = this.deps.sources.get('hub')
    if (!hub) throw new Error('the hub source is missing')
    return hub
  }

  /** Writes the report's record: only the fields given move. */
  private async write(key: string, title: string | undefined, fields: Record<string, unknown>, relations?: Record<string, string | string[] | null>): Promise<void> {
    const result = await this.deps.entities.write({ blueprint: REPORT_BLUEPRINT, key, ...(title ? { title } : {}), fields, ...(relations ? { relations } : {}) }, { source: this.hub(), layer: 'pushed', mode: 'upsert', replace: false })
    if (result.outcome === 'rejected') throw new Error(`report ${key} not written: ${result.errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ')}`)
  }

  /** The fields a layout puts on its report's record. */
  private shapeOf(layout: ReportLayout): Record<string, unknown> {
    return { data_sets: Object.entries(layout.data).map(([name, def]) => ('query' in def ? `${name}: query ${def.query}` : `${name}: tool ${def.tool}`)), writer: layout.writer ?? null }
  }

  /** Makes a report owned by the person who asked, at its first version. */
  async create(input: { title: string; home: string; layout: string; recipients: string[]; note?: string | null }, who: Identity): Promise<string> {
    if (who.kind !== 'user') throw new ReportError('A report belongs to a person: a machine makes none', 403)
    const issues = await this.problems(input.layout, who)
    if (issues.length) throw new ReportError(issues.map((i) => `line ${i.line}: ${i.message}`).join('\n'), 400, 'layout')
    const home = parseEntityId(input.home)
    const homeEntity = home ? await this.deps.reader.get(home) : null
    if (!home || !homeEntity || !(await this.deps.viewOf(who)).entity(homeEntity)) throw new ReportError(`Unknown home "${input.home}"`, 400, 'home')
    // A report links to its home through the relation for the home's blueprint, made the first time a home of it is named.
    const held = this.deps.blueprints.get(REPORT_BLUEPRINT)?.relations ?? {}
    const relations = reportRelations([...Object.values(held).map((r) => r.target), homeEntity.blueprint], this.deps.blueprints)
    if (Object.keys(relations).length !== Object.keys(held).length) {
      await ensureHubBlueprints(this.deps.db, this.deps.blueprints, this.deps.entities, { reports: relations })
      this.deps.events.emit({ type: 'blueprints', offered: [REPORT_BLUEPRINT] })
      this.deps.log.info('the report blueprint links to a new kind of home', { home: homeEntity.blueprint })
    }
    const key = await this.freeKey(input.title)
    const { layout } = parseLayout(input.layout)
    await this.deps.db.query('INSERT INTO report_versions (report, version, layout, note, by) VALUES ($1, 1, $2, $3, $4)', [key, input.layout, input.note ?? null, who.name])
    await this.write(key, input.title, { owner: who.name, layout: input.layout, version: 1, ...this.shapeOf(layout!), recipients: input.recipients, editions: 0, status: 'grey', status_reason: 'never published', created_at: new Date().toISOString(), url: this.pageUrl(key) }, { [`${HOME_OF}${homeEntity.blueprint}`]: [homeEntity.id] })
    await record(this.deps.db, 'report.created', { blueprint: REPORT_BLUEPRINT, key }, null, who.name, { report: key, home: homeEntity.id, version: 1 })
    this.deps.log.info('report created', { report: key, by: who.name, home: homeEntity.id })
    return key
  }

  /** A key from the title no report holds yet, live or removed. */
  private async freeKey(title: string): Promise<string> {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report'
    // A key once used stays used, by a removed report too, so an old link never opens a new report.
    const taken = new Set((await this.deps.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = $1 AND (key = $2 OR key LIKE $2 || '-%') UNION SELECT DISTINCT report FROM report_versions WHERE report = $2 OR report LIKE $2 || '-%'`, [REPORT_BLUEPRINT, base])).rows.map((r) => r.key))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  /** Changes a report's layout to the one given, or puts back an older version, as the next version. Nothing changes when it is the layout it has. */
  async edit(key: string, input: { layout?: string | null; version?: number | null; note?: string | null }, who: Identity): Promise<{ version: number; changed: boolean }> {
    const e = await this.changeable(key, who)
    // A version to put back wins over a layout: a form that fills the layout in from the report sends both.
    let text = typeof input.version === 'number' ? null : input.layout?.trim() ? input.layout : null
    let restored: number | null = null
    if (!text) {
      if (typeof input.version !== 'number') throw new ReportError('Give the new layout, or the version to put back', 400, 'layout')
      const row = (await this.deps.db.query<{ layout: string }>('SELECT layout FROM report_versions WHERE report = $1 AND version = $2', [key, input.version])).rows[0]
      if (!row) throw new ReportError(`Report "${key}" has no version ${input.version}`, 400, 'version')
      text = row.layout
      restored = input.version
    }
    const owner = this.deps.identityFor(String(e.fields.owner ?? '')) ?? who
    const issues = await this.problems(text, owner)
    if (issues.length) throw new ReportError(issues.map((i) => `line ${i.line}: ${i.message}`).join('\n'), 400, 'layout')
    const current = Number(e.fields.version ?? 0)
    if (text === e.fields.layout) {
      this.deps.log.info('report edit changed nothing: the layout is the one it has', { report: key, by: who.name, version: current })
      return { version: current, changed: false }
    }
    const version = await this.deps.db.tx(async (client) => {
      const next = (await client.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM report_versions WHERE report = $1', [key])).rows[0]!.v
      await client.query('INSERT INTO report_versions (report, version, layout, note, by, restored_from) VALUES ($1, $2, $3, $4, $5, $6)', [key, next, text, input.note ?? (restored ? `put back version ${restored}` : null), who.name, restored])
      await record(client, 'report.changed', { blueprint: REPORT_BLUEPRINT, key }, null, who.name, { report: key, version: next, ...(restored ? { restored } : {}), ...(input.note ? { note: input.note } : {}) })
      return next
    })
    await this.write(key, undefined, { layout: text, version, ...this.shapeOf(parseLayout(text).layout!) })
    this.deps.log.info('report layout changed', { report: key, by: who.name, version, restored })
    return { version, changed: true }
  }

  /** Sets who is sent each edition. */
  async setRecipients(key: string, recipients: string[], who: Identity): Promise<boolean> {
    const e = await this.changeable(key, who)
    const next = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))].sort()
    const held = listOf(e.fields.recipients).map((r) => r.toLowerCase()).sort()
    if (next.join('\n') === held.join('\n')) return false
    await this.write(key, undefined, { recipients: next })
    await record(this.deps.db, 'report.changed', { blueprint: REPORT_BLUEPRINT, key }, null, who.name, { report: key, recipients: next.length })
    this.deps.log.info('report recipients changed', { report: key, by: who.name, recipients: next.length })
    return true
  }

  /**
   * Hands a report to a new owner, with every schedule that publishes it: its
   * data is read as them from then on. Refused, saying what, when they may not
   * see the report or cannot read something its layout names.
   */
  async hand(key: string, to: string, who: Identity): Promise<{ changed: boolean; schedules: number }> {
    const e = await this.changeable(key, who)
    const next = this.deps.identityFor(to.trim())
    if (!next || next.kind !== 'user') throw new ReportError(`${to.trim() || 'nobody'} has never signed in to the hub, so a report cannot be read as them`, 400, 'owner')
    const from = String(e.fields.owner ?? '')
    if (from.toLowerCase() === next.name.toLowerCase()) {
      this.deps.log.info('report hand over changed nothing: they own it already', { report: key, by: who.name, owner: next.name })
      return { changed: false, schedules: 0 }
    }
    const view = await this.deps.viewOf(next)
    if (!view.entity(e)) throw new ReportError(`${next.name} may not see report "${key}": open its home to them first`, 400, 'owner')
    const text = String(e.fields.layout ?? '')
    const issues = [...(await this.problems(text, next)), ...(await this.uncallable(text, e, next, view))]
    if (issues.length) {
      this.deps.log.warn('report hand over refused: the new owner cannot read what it names', { report: key, by: who.name, owner: next.name, issues: issues.length })
      throw new ReportError(`${next.name} cannot read everything this report names:\n${issues.map((i) => i.message).join('\n')}`, 400, 'owner')
    }
    await this.write(key, undefined, { owner: next.name })
    const schedules = await this.deps.schedules.handOver({ blueprint: REPORT_BLUEPRINT, key }, next.name, who.name)
    await record(this.deps.db, 'report.changed', { blueprint: REPORT_BLUEPRINT, key }, null, who.name, { report: key, owner: next.name, from, schedules })
    this.deps.log.info('report handed over', { report: key, by: who.name, from, owner: next.name, schedules })
    return { changed: true, schedules }
  }

  /** Each tool a layout names that this person may not call: a data set's, on the entity it is called on, and the writer, on the report. */
  private async uncallable(text: string, report: Entity, who: Identity, view: View): Promise<LayoutIssue[]> {
    const { layout } = parseLayout(text)
    if (!layout) return []
    const out: LayoutIssue[] = []
    const own = { blueprint: REPORT_BLUEPRINT, key: report.key }
    const callable = async (id: string, entity: EntityRef | null) => (await this.deps.actions.tools(who, view, entity)).some((t) => t.id === id)
    for (const [name, def] of Object.entries(layout.data)) {
      if (!('tool' in def)) continue
      if (!(await callable(def.tool, this.calledOn(def, report)))) out.push({ line: 1, message: `data set "${name}": they may not call tool "${def.tool}"` })
    }
    if (layout.writer && !(await callable(layout.writer, own))) out.push({ line: 1, message: `writer: they may not call tool "${layout.writer}"` })
    return out
  }

  /** The entity a tool data set is called on: the one it names, else the report when the tool runs on reports, else none. */
  private calledOn(def: { tool: string; entity?: string }, report: Entity): EntityRef | null {
    const tool = this.deps.actions.get(def.tool)
    const on = tool?.blueprint === undefined ? [] : Array.isArray(tool.blueprint) ? tool.blueprint : [tool.blueprint]
    return def.entity ? parseEntityId(def.entity) : on.includes(REPORT_BLUEPRINT) ? { blueprint: REPORT_BLUEPRINT, key: report.key } : null
  }

  /** Removes a report, its editions, and what they keep. */
  async remove(key: string, who: Identity): Promise<number> {
    await this.changeable(key, who)
    const editions = (await this.deps.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = $1 AND key LIKE $2 AND state <> 'deleted'`, [EDITION_BLUEPRINT, `${key}/%`])).rows.map((r) => ({ blueprint: EDITION_BLUEPRINT, key: r.key }))
    await this.deps.entities.tombstone([{ blueprint: REPORT_BLUEPRINT, key }, ...editions], 'hub', who.name, { reason: 'the report was removed' }, false)
    await this.deps.db.query('DELETE FROM report_editions WHERE report = $1', [key])
    await this.deps.db.query('DELETE FROM report_versions WHERE report = $1', [key])
    await record(this.deps.db, 'report.removed', { blueprint: REPORT_BLUEPRINT, key }, null, who.name, { report: key, editions: editions.length })
    this.deps.log.info('report removed', { report: key, by: who.name, editions: editions.length })
    return editions.length
  }

  /** Carries out the quick verbs of a report run, as the person who asked. */
  async change(verb: Exclude<ReportVerb, 'publish' | 'preview'>, run: ActionRun, who: Identity): Promise<ReportDone> {
    const inputs = run.inputs
    if (verb === 'create') {
      const key = await this.create({ title: String(inputs.title ?? '').trim(), home: String(inputs.home ?? ''), layout: String(inputs.layout ?? ''), recipients: listOf(inputs.recipients), note: textOrNull(inputs.note) }, who)
      return { summary: `created report ${key}`, link: this.pageUrl(key) }
    }
    const key = run.entity?.blueprint === REPORT_BLUEPRINT ? run.entity.key : null
    if (!key) throw new ReportError('this is not one of the hub\'s reports')
    if (verb === 'edit') {
      const { version, changed } = await this.edit(key, { layout: textOrNull(inputs.layout), version: typeof inputs.version === 'number' ? inputs.version : null, note: textOrNull(inputs.note) }, who)
      return { summary: changed ? `report ${key} is at version ${version}` : `report ${key} already had that layout, version ${version}`, link: this.pageUrl(key) }
    }
    if (verb === 'recipients') {
      const changed = await this.setRecipients(key, listOf(inputs.recipients), who)
      return { summary: changed ? `report ${key} is sent to ${listOf(inputs.recipients).length} people` : `report ${key} already had those recipients`, link: this.pageUrl(key) }
    }
    if (verb === 'hand') {
      const { changed, schedules } = await this.hand(key, String(inputs.owner ?? ''), who)
      return { summary: changed ? `report ${key} belongs to ${String(inputs.owner).trim()}${schedules ? `, with ${schedules} ${schedules === 1 ? 'schedule' : 'schedules'}` : ''}` : `report ${key} already belonged to them`, link: this.pageUrl(key) }
    }
    const editions = await this.remove(key, who)
    return { summary: `removed report ${key} and ${editions} editions`, link: `${this.deps.publicUrl}/entities/${encodeURIComponent(REPORT_BLUEPRINT)}` }
  }

  /**
   * Publishes a report's next edition, or draws a preview of it that is kept
   * with the run alone and sent to nobody. Every data set is read as the
   * report's owner. Fails, saying why, when the person may not publish it or
   * the owner no longer signs in.
   */
  async publish(run: ActionRun, preview: boolean, who: Identity, pen: RunPen): Promise<ReportDone> {
    const key = run.entity?.blueprint === REPORT_BLUEPRINT ? run.entity.key : null
    if (!key) throw new ReportError('this is not one of the hub\'s reports')
    const report = await this.changeable(key, who)
    try {
      return await this.draw(key, report, run, preview, pen)
    } catch (error) {
      if (!preview) await this.write(key, undefined, { status: 'red', status_reason: `the last publish failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }).catch((e: unknown) => this.deps.log.warn('report status not written', { report: key, error: e }))
      throw error
    }
  }

  private async draw(key: string, report: Entity, run: ActionRun, preview: boolean, pen: RunPen): Promise<ReportDone> {
    const ownerName = String(report.fields.owner ?? '')
    const owner = this.deps.identityFor(ownerName)
    if (!owner) throw new ReportError(`its owner ${ownerName || '(none)'} no longer signs in, so its data cannot be read as them`)
    const ownerView = await this.deps.viewOf(owner)
    const { layout, issues } = parseLayout(String(report.fields.layout ?? ''))
    if (!layout) throw new ReportError(`its layout no longer reads: ${issues.map((i) => `line ${i.line}: ${i.message}`).join('; ')}`)
    await pen.step('Gather')
    const last = (await this.deps.db.query<{ number: number; content: EditionContent; data: Record<string, DataSet> }>('SELECT number, content, data FROM report_editions WHERE report = $1 ORDER BY number DESC LIMIT 1', [key])).rows[0]
    // A preview reads its saved queries afresh, since they are what its author just changed, and takes a tool's rows from the newest edition while the layout asks the tool the same: a tool is a runner's job each time. `fresh` reads everything.
    const keptOf = preview && run.inputs.fresh !== true && last ? await this.keptTools(key, last.number, layout) : new Set<string>()
    const data: Record<string, DataSet> = {}
    for (const [name, def] of Object.entries(layout.data)) {
      const kept = keptOf.has(name) ? last?.data[name] : undefined
      data[name] = kept && !kept.error ? kept : await this.read(name, def, report, owner, ownerView)
      const said = data[name].error ? `${name}: ${data[name].error}` : `${name}: ${data[name].total.toLocaleString('en-US')} rows${data[name].truncated ? `, the first ${data[name].rows.length.toLocaleString('en-US')} kept` : ''}`
      await pen.line(kept && !kept.error ? `${said}, as edition ${last!.number} read them` : said)
    }
    const before: Before | null = last ? { headline: headlineOf(last.content.blocks), data: last.data } : null
    // Its date is said where it is read: in the zone of the schedule that fired it, else its owner's.
    const fired = run.schedule ? await this.deps.schedules.find(run.schedule) : null
    const zone = fired?.cadence.tz ?? (await this.deps.zoneOf(ownerName))
    const homeRef = parseEntityId(this.homeOf(report) ?? '')
    const homeEntity = homeRef ? await this.deps.reader.get(homeRef) : null
    const home = homeEntity && homeEntity.state !== 'deleted' ? ownerView.entity(homeEntity)?.title : undefined
    const head = { title: report.title, number: (last?.number ?? 0) + 1, publishedAt: new Date().toISOString(), ...(home ? { home } : {}), ...(zone ? { zone } : {}) }
    // The numbers come first, so the writer is given them and never works one out itself.
    const headline = headlineOf(buildContent(layout, data, new Map(), before, head).blocks)
    const prose: Prose = new Map()
    const narratives = layout.blocks.flatMap((b, i) => (b.kind === 'narrative' ? [{ b, i }] : []))
    if (narratives.length) await pen.step('Write')
    for (const { b, i } of narratives) {
      prose.set(i, await this.written(layout.writer!, report, owner, ownerView, b.instruction, writerData(b.data, data, headline)))
      const got = prose.get(i)!
      await pen.line('text' in got ? `narrative on line ${b.line}: ${got.text.length.toLocaleString('en-US')} characters` : `narrative on line ${b.line}: ${got.gap}`)
    }
    await pen.step('Draw')
    const content = buildContent(layout, data, prose, before, head)
    const outputs: Record<string, OutputValue> = Object.fromEntries(Object.entries(headline).flatMap(([name, value]) => (value === null ? [] : [[name, value]])))
    const summary = summaryOf(content)
    if (preview) {
      await this.deps.db.query('INSERT INTO report_previews (run, report, content, data) VALUES ($1, $2, $3, $4) ON CONFLICT (run) DO UPDATE SET content = EXCLUDED.content, data = EXCLUDED.data, created_at = now()', [run.id, key, JSON.stringify(content), JSON.stringify(data)])
      await pen.line(`drawn as edition ${head.number} would be; kept with this run, and sent to nobody`)
      this.deps.log.info('report preview drawn', { report: key, run: run.id, by: run.by })
      return { summary: `preview: ${summary}`, link: `${this.pageUrl(key)}?preview=${encodeURIComponent(run.id)}`, outputs }
    }
    await pen.step('Publish')
    const number = await this.keep(key, report, content, data, run, summary)
    await pen.line(`edition ${number} kept`)
    await pen.step('Deliver')
    const to = await this.recipients(report)
    const facts = content.blocks.flatMap((b) => (b.kind === 'stats' ? b.items.map((i) => ({ name: i.title, value: formatNumber(i.value, i.decimals, i.unit) })) : []))
    await record(this.deps.db, 'report.published', { blueprint: REPORT_BLUEPRINT, key }, null, run.by, { report: key, edition: number, title: report.title, summary, headline, facts, to: to.sent, url: this.pageUrl(key, number), body: `${this.deps.publicUrl}/v1/reports/${encodeURIComponent(key)}/editions/${number}/body?profile=email`, run: run.id, ...(run.schedule ? { schedule: run.schedule } : {}) })
    await pen.line(to.sent.length ? `sent to ${to.sent.length} ${to.sent.length === 1 ? 'person' : 'people'} by the notification desk` : 'sent to nobody: the report names no recipient who may see it')
    if (to.left.length) await pen.line(`not sent to ${to.left.join(', ')}: they may not see the report`)
    await pen.step('Verify')
    const kept = await this.deps.db.query('SELECT 1 FROM report_editions WHERE report = $1 AND number = $2', [key, number])
    const record_ = await this.deps.reader.get({ blueprint: EDITION_BLUEPRINT, key: editionKey(key, number) })
    if (!kept.rowCount || !record_) throw new ReportError(`edition ${number} was not found after it was written`)
    await pen.line(`edition ${number} reads back, with its record`)
    this.deps.log.info('report published', { report: key, edition: number, run: run.id, by: run.by, schedule: run.schedule ?? null, recipients: to.sent.length, left: to.left.length })
    return { summary: `edition ${number}: ${summary}`, link: this.pageUrl(key, number), outputs }
  }

  /** Reads one data set as the report's owner. What cannot be read is a gap that says why, never a failed publish. */
  private async read(name: string, def: ReportLayout['data'][string], report: Entity, owner: Identity, view: View): Promise<DataSet> {
    try {
      if ('query' in def) {
        const saved = await this.deps.queries.get(def.query, owner)
        const result = await this.deps.queries.run(this.deps.queries.sources(saved.spec, view), saved.spec.columns, view, owner)
        return dataOfAnswer(this.deps.queries.shown(result, saved.spec.view, DATA_ROWS_MAX), saved.spec.view)
      }
      const answer = await this.callTool(def.tool, this.calledOn(def, report), def.inputs ?? {}, owner, view)
      return 'text' in answer ? tableOfAnswer(answer.text) : gap(answer.gap)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.log.warn('report data set not read', { report: report.key, dataSet: name, reason })
      return gap(reason)
    }
  }

  /** The tool data sets of a layout that the layout of an edition asked the same way: what a preview may take from that edition. */
  private async keptTools(key: string, edition: number, layout: ReportLayout): Promise<Set<string>> {
    const record_ = await this.deps.reader.get({ blueprint: EDITION_BLUEPRINT, key: editionKey(key, edition) })
    const version = Number(record_?.fields.layout_version ?? 0)
    const row = (await this.deps.db.query<{ layout: string }>('SELECT layout FROM report_versions WHERE report = $1 AND version = $2', [key, version])).rows[0]
    const then = row ? parseLayout(row.layout).layout : null
    const out = new Set<string>()
    if (!then) return out
    for (const [name, def] of Object.entries(layout.data)) if ('tool' in def && JSON.stringify(then.data[name]) === JSON.stringify(def)) out.add(name)
    return out
  }

  /** The prose a writer gives one narrative block, or a gap that says why there is none. */
  private async written(writer: string, report: Entity, owner: Identity, view: View, instruction: string, data: string): Promise<{ text: string } | { gap: string }> {
    try {
      const answer = await this.callTool(writer, { blueprint: REPORT_BLUEPRINT, key: report.key }, { instruction, data }, owner, view)
      if (!('text' in answer)) return answer
      const text = answer.text.trim()
      return text ? { text } : { gap: 'the writer wrote nothing' }
    } catch (error) {
      return { gap: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Calls a tool as the report's owner and waits for its answer. */
  private async callTool(id: string, entity: EntityRef | null, inputs: Record<string, unknown>, owner: Identity, view: View): Promise<{ text: string } | { gap: string }> {
    const action = this.deps.actions.get(id)
    if (!action?.tool) return { gap: `"${id}" is not a tool` }
    const asked = await this.deps.actions.call(id, { ...(entity ? { entity } : {}), inputs }, owner, view)
    const run = isFinished(asked.state) ? asked : await this.deps.actions.settled(asked.id, this.deps.actions.waitOf(action, TOOL_WAIT_MS))
    if (run.state !== 'succeeded') return { gap: `tool ${id} ${run.state === 'queued' || run.state === 'cancelled' ? 'was not taken by its runner in time' : run.state}${run.summary ? `: ${run.summary}` : ''}` }
    const said = this.deps.actions.said(run)
    return said.truncated ? { gap: `tool ${id} answered more than one call carries` } : { text: said.text }
  }

  /** Keeps an edition: what it was drawn from and its data, its record, and the report's newest numbers. Its number is the next. */
  private async keep(key: string, report: Entity, content: EditionContent, data: Record<string, DataSet>, run: ActionRun, summary: string): Promise<number> {
    const number = await this.deps.db.tx(async (client) => {
      // One report's editions are numbered one at a time, whichever hub publishes.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`report:${key}`])
      const next = (await client.query<{ n: number }>('SELECT coalesce(max(number), 0) + 1 AS n FROM report_editions WHERE report = $1', [key])).rows[0]!.n
      await client.query('INSERT INTO report_editions (report, number, content, data, published_at) VALUES ($1, $2, $3, $4, $5)', [key, next, JSON.stringify({ ...content, number: next }), JSON.stringify(data), content.publishedAt])
      return next
    })
    const headline = headlineOf(content.blocks)
    const ek = editionKey(key, number)
    const api = `${this.deps.publicUrl}/v1/reports/${encodeURIComponent(key)}/editions/${number}`
    const written = await this.deps.entities.write(
      {
        blueprint: EDITION_BLUEPRINT,
        key: ek,
        title: `${report.title} · ${number}`,
        fields: { number, published_at: content.publishedAt, summary, headline, layout_version: Number(report.fields.version ?? 0) || null, started_by: run.by, schedule: run.schedule ?? null, run: run.id, body_url: `${api}/body?profile=email`, data_url: `${api}/data`, url: this.pageUrl(key, number) },
        relations: { report: `${REPORT_BLUEPRINT}:${key}` },
      },
      { source: this.hub(), layer: 'pushed', mode: 'upsert', replace: false },
    )
    if (written.outcome === 'rejected') throw new Error(`edition ${ek} not written: ${written.errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ')}`)
    await this.write(key, undefined, { editions: number, last_published_at: content.publishedAt, summary, headline, status: 'green', status_reason: null })
    return number
  }

  /** Who a report is sent to: each recipient who signs in and may see it now. */
  private async recipients(report: Entity): Promise<{ sent: string[]; left: string[] }> {
    const sent: string[] = []
    const left: string[] = []
    for (const address of listOf(report.fields.recipients)) {
      // Someone who never signed in is judged as they would be on arriving: the rules decide, not whether they have visited.
      const who = this.deps.identityFor(address) ?? this.deps.arriving(address)
      const sees = !!(await this.deps.viewOf(who)).entity(report)
      ;(sees ? sent : left).push(address)
    }
    if (left.length) this.deps.log.info('report recipients left out: they may not see it', { report: report.key, left: left.length })
    else this.deps.log.debug('every report recipient may see it', { report: report.key, sent: sent.length })
    return { sent, left }
  }

  // Reads ----------------------------------------------------------------------

  /**
   * The reports one person may see, each with its newest edition and the
   * schedules that publish it: the newest published first, then the ones never
   * published. `home` keeps it to the reports of one entity.
   */
  async list(who: Identity, home?: string): Promise<ReportsResponse> {
    const view = await this.deps.viewOf(who)
    const { entities, total } = await this.deps.reader.list({ blueprint: REPORT_BLUEPRINT, view, limit: REPORTS_MAX, sort: 'title' })
    const seen = home ? entities.filter((e) => this.homeOf(e) === home) : entities
    const keys = seen.map((e) => e.key)
    const newest = new Map((await this.deps.db.query<{ report: string; number: number; published_at: Date; content: EditionContent }>('SELECT DISTINCT ON (report) report, number, published_at, content FROM report_editions WHERE report = ANY($1) ORDER BY report, number DESC', [keys])).rows.map((r) => [r.report, r]))
    const schedules = await this.schedulesOf(keys)
    const reports: ReportLine[] = []
    for (const e of seen) {
      const at = Object.entries(e.relations).find(([name, refs]) => name.startsWith(HOME_OF) && refs[0])?.[1][0]
      const last = newest.get(e.key)
      reports.push({
        key: e.key,
        title: e.title,
        owner: String(e.fields.owner ?? ''),
        home: at ? { id: entityId(at), blueprint: at.blueprint, key: at.key, title: at.title ?? at.key } : null,
        yours: await this.mayChange(e, who),
        status: String(e.fields.status ?? 'grey'),
        statusReason: textOrNull(e.fields.status_reason),
        editions: Number(e.fields.editions ?? 0),
        latest: last ? { number: last.number, publishedAt: last.published_at.toISOString(), summary: summaryOf(last.content), stats: last.content.blocks.flatMap((b) => (b.kind === 'stats' ? b.items : [])).slice(0, LINE_STATS) } : null,
        schedules: schedules.get(e.key) ?? [],
      })
    }
    reports.sort((a, b) => (b.latest?.publishedAt ?? '').localeCompare(a.latest?.publishedAt ?? '') || a.title.localeCompare(b.title))
    return { reports, total: home ? reports.length : total }
  }

  /** The live schedules that publish each of these reports, by report key: the next to fire first. */
  private async schedulesOf(keys: readonly string[]): Promise<Map<string, ReportSchedule[]>> {
    const schedules = new Map<string, ReportSchedule[]>()
    const rows = await this.deps.db.query<{ id: string; key: string; title: string; cadence: Cadence; state: ReportSchedule['state']; next_at: Date | null; owner: string }>(`SELECT id, target->'entity'->>'key' AS key, title, cadence, state, next_at, owner FROM action_schedules WHERE target->'entity'->>'blueprint' = $1 AND target->'entity'->>'key' = ANY($2) AND state IN ('awaiting', 'active', 'paused') ORDER BY next_at NULLS LAST`, [REPORT_BLUEPRINT, keys])
    for (const r of rows.rows) schedules.set(r.key, [...(schedules.get(r.key) ?? []), { id: r.id, title: r.title, when: cadenceWords(r.cadence), state: r.state, nextAt: r.next_at?.toISOString() ?? null, owner: r.owner }])
    return schedules
  }

  /** A report as one person reads it: its record, its versions, and its editions, newest first, with their numbers. */
  async page(key: string, who: Identity): Promise<ReportPage> {
    const report = await this.seen(key, who)
    const versions = await this.deps.db.query<{ version: number; note: string | null; by: string; at: Date; restored_from: number | null }>('SELECT version, note, by, at, restored_from FROM report_versions WHERE report = $1 ORDER BY version DESC', [key])
    const editions = await this.deps.db.query<{ number: number; published_at: Date; content: EditionContent }>('SELECT number, published_at, content FROM report_editions WHERE report = $1 ORDER BY number DESC', [key])
    const lines: ReportEditionLine[] = editions.rows.map((r) => ({ number: r.number, publishedAt: r.published_at.toISOString(), summary: summaryOf(r.content), headline: headlineOf(r.content.blocks) }))
    const stats = editions.rows[0]?.content.blocks.flatMap((b) => (b.kind === 'stats' ? b.items.map((i) => ({ name: i.name, title: i.title, ...(i.unit !== undefined ? { unit: i.unit } : {}), ...(i.decimals !== undefined ? { decimals: i.decimals } : {}), ...(i.better ? { better: i.better } : {}) })) : [])) ?? []
    const vs: ReportVersion[] = versions.rows.map((r) => ({ version: r.version, note: r.note, by: r.by, at: r.at.toISOString(), restoredFrom: r.restored_from }))
    return { report, canChange: await this.mayChange(report, who), versions: vs, editions: lines, stats, schedules: (await this.schedulesOf([key])).get(key) ?? [] }
  }

  /** One edition as one person reads it, whole. */
  async edition(key: string, number: number, who: Identity): Promise<ReportEditionRead> {
    await this.seen(key, who)
    const row = (await this.deps.db.query<{ content: EditionContent; data: Record<string, DataSet> }>('SELECT content, data FROM report_editions WHERE report = $1 AND number = $2', [key, number])).rows[0]
    if (!row) throw new ReportError(`Report "${key}" has no edition ${number}`, 404)
    return { content: row.content, data: row.data }
  }

  /** An edition drawn as a mail, for the desk to send to the recipients the publish named; null when it is gone. */
  async mailOf(key: string, number: number): Promise<string | null> {
    const row = (await this.deps.db.query<{ content: EditionContent }>('SELECT content FROM report_editions WHERE report = $1 AND number = $2', [key, number])).rows[0]
    return row ? drawEdition(row.content, 'email', this.pageUrl(key, number)) : null
  }

  /** One layout version, as whoever may see the report reads it. */
  async version(key: string, version: number, who: Identity): Promise<string> {
    await this.seen(key, who)
    const row = (await this.deps.db.query<{ layout: string }>('SELECT layout FROM report_versions WHERE report = $1 AND version = $2', [key, version])).rows[0]
    if (!row) throw new ReportError(`Report "${key}" has no version ${version}`, 404)
    return row.layout
  }

  /** The preview a run drew, as whoever may see the report reads it. */
  async preview(key: string, run: string, who: Identity): Promise<ReportPreviewRead> {
    await this.seen(key, who)
    const row = (await this.deps.db.query<{ content: EditionContent; data: Record<string, DataSet> }>('SELECT content, data FROM report_previews WHERE report = $1 AND run = $2', [key, run])).rows[0]
    if (!row) throw new ReportError(`No preview of report "${key}" from run "${run}": it was never drawn, or is let go`, 404)
    return { content: row.content, data: row.data }
  }

  /** Lets go of what an edition the lifecycle removed kept, and of previews older than `previewDays`. */
  async prune(previewDays: number): Promise<number> {
    const gone = await this.deps.db.query(
      `DELETE FROM report_editions r WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.blueprint = $1 AND e.key = r.report || '/' || CASE WHEN r.number >= 1000 THEN r.number::text ELSE lpad(r.number::text, 4, '0') END AND e.state <> 'deleted') AND r.published_at < now() - interval '1 hour'`,
      [EDITION_BLUEPRINT],
    )
    const previews = await this.deps.db.query(`DELETE FROM report_previews WHERE created_at < now() - make_interval(days => $1)`, [previewDays])
    const n = (gone.rowCount ?? 0) + (previews.rowCount ?? 0)
    if (n) this.deps.log.info('report editions and previews let go', { editions: gone.rowCount ?? 0, previews: previews.rowCount ?? 0 })
    return n
  }
}

/** The key of a report's edition: the report's key and its number, so they sort in order. */
export function editionKey(report: string, number: number): string {
  return `${report}/${String(number).padStart(4, '0')}`
}

/** What an edition says in a line: its first narrative's opening, else its headline numbers. */
export function summaryOf(content: EditionContent): string {
  for (const b of content.blocks) if (b.kind === 'narrative' && b.text) return firstSentence(b.text)
  const stats = content.blocks.flatMap((b) => (b.kind === 'stats' ? b.items : []))
  return stats.length ? stats.map((s) => `${s.title} ${formatNumber(s.value, s.decimals, s.unit)}`).join(' · ') : `${content.title}, edition ${content.number}`
}

/** Written prose without the marks a writer may use: its first paragraph of words, never a heading, a list, or a table. */
function plainProse(text: string): string {
  const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim())
  const first = paras.find((p) => p && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(p)) ?? paras[0]!.replace(/^#{1,6}\s+/, '')
  return first.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

function firstSentence(text: string): string {
  const para = plainProse(text).replace(/\s+/g, ' ')
  const end = para.search(/[.!?](\s|$)/)
  const line = end >= 0 ? para.slice(0, end + 1) : para
  return line.length > 280 ? `${line.slice(0, 279)}…` : line
}

/** The table a tool answered: the JSON it printed, after any lines it printed first. */
function tableOfAnswer(text: string): DataSet {
  const trimmed = text.trim()
  const starts = ['[', '{'].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0)
  return starts.length ? tableOf(trimmed.slice(Math.min(...starts))) : gap('the tool did not answer with JSON')
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : typeof v === 'string' && v.trim() ? v.split(/[\s,;]+/).filter(Boolean) : []
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** A number a total holds, or null when it is none. */
function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A saved query's answer as a report's data set, as the query's view shapes
 * it. A view that groups gives one row a group: the values it is grouped by,
 * how many rows it holds, and what each column adds up to there, with the
 * column its own chart draws as its chart, else the first of those. Any other view gives its rows. What each column
 * adds up to over every row rides along as the data set's totals.
 */
export function dataOfAnswer(answer: QueryAnswer, view: QueryView | undefined): DataSet {
  const titleOf = (id: string) => answer.columns.find((c) => c.id === id)?.title ?? id
  // In the answer's own column order: the order a view's totals were kept in is the database's, not the author's.
  const placeOf = (id: string) => answer.columns.findIndex((c) => c.id === id)
  const added = Object.entries(view?.totals ?? {}).filter(([id]) => placeOf(id) >= 0).sort(([a], [b]) => placeOf(a) - placeOf(b))
  const totalTitle = (id: string, how: string) => (how === 'sum' ? titleOf(id) : `${titleOf(id)} (${how})`)
  const totals = added.map(([id, how]) => ({ name: id, title: totalTitle(id, how), value: numberOrNull(answer.totals?.[id]) }))
  const shape = totals.length ? { totals } : {}
  if (!answer.groups) {
    const set = capped(answer.columns.map((c) => ({ id: c.id, title: c.title })), answer.rows.map((r) => r.values), answer.kept)
    return totals.length ? { ...set, shape } : set
  }
  const by: string[] = []
  const rows: unknown[][] = []
  const walk = (groups: readonly QueryAnswerGroup[], path: unknown[], depth: number) => {
    for (const g of groups) {
      by[depth] = g.column
      const here = [...path, g.value]
      if (g.groups) walk(g.groups, here, depth + 1)
      else rows.push([...here, g.count, ...added.map(([id]) => g.totals[id] ?? null)])
    }
  }
  walk(answer.groups, [], 0)
  const columns = [...by.map((id) => ({ id, title: titleOf(id) })), { id: 'rows', title: 'Rows' }, ...added.map(([id, how]) => ({ id: `${id}_${how}`, title: totalTitle(id, how) }))]
  // The chart draws the column the query's own chart draws, when it adds one up; else the first it adds up, else how many rows.
  const picked = added.find(([id]) => id === view?.chart?.column) ?? added[0]
  const y = picked ? `${picked[0]}_${picked[1]}` : 'rows'
  return { ...capped(columns, rows), shape: { ...shape, ...(by[0] ? { chart: { x: by[0], y: [y] } } : {}) } }
}
