// The only model the hub brings itself: its reserved blueprints, and the
// one-time move away from the catalog directory earlier versions loaded as a
// git source. A new hub holds nothing else; the estate brings its own model.

import type { ModelLayout } from '../shared/api.ts'
import { hasRule } from '../shared/policy.ts'
import { actionTargets, parseDuration, EDITION_BLUEPRINT, REPORT_BLUEPRINT, RUNNER_BLUEPRINT, SCHEDULE_BLUEPRINT, SOURCE_BLUEPRINT, type AccessRule, type Action, type Blueprint, type RelationDef } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Entities } from './entities.ts'
import type { Logger } from './log.ts'

type BlueprintSpec = Omit<Blueprint, 'origin' | 'updatedAt'>

const LEVELS = ['red', 'amber', 'green', 'grey']

/** Sources, runners, and schedules are entities so a dead, stale, or failing one shows like anything else. The hub writes them and nobody else may define them. */
const HUB_BLUEPRINTS: BlueprintSpec[] = [
  {
    id: SOURCE_BLUEPRINT,
    title: 'Source',
    group: 'Orrery',
    description:
      'A writer identity: a pusher, an event source, a git repo of catalog files, the web app, or a runner. The hub keeps these entities itself. Status comes from the last run and the expected cadence: grey means a source with a cadence is stale or never reported (one with none is never grey for being quiet), red means the last run failed, amber means a snapshot dropped too much at once.',
    icon: 'upload',
    status: { field: 'status' },
    fields: {
      class: { type: 'enum', values: ['pusher', 'event', 'git', 'ui', 'runner', 'hub'], overridable: false },
      description: { type: 'markdown' },
      cadence: { type: 'string', title: 'Expected cadence', description: 'How often the source is expected to run, e.g. 3m or 26h.', overridable: false },
      status: { type: 'enum', values: LEVELS, overridable: false },
      status_reason: { type: 'string', overridable: false },
      last_run_at: { type: 'datetime', overridable: false },
      last_seen_at: { type: 'datetime', overridable: false },
      last_error: { type: 'string', overridable: false },
      blueprints: { type: 'array', description: 'Blueprints the source may write.', overridable: false, spread: false },
      notes: { type: 'markdown', description: 'Why this source exists and what breaks if it stops.' },
    },
    relations: {},
  },
  {
    id: RUNNER_BLUEPRINT,
    title: 'Runner',
    group: 'Orrery',
    description: 'A small agent in one network segment that runs health checks and pushes results back. Runners only connect out. A dead runner is grey.',
    icon: 'radar',
    wall: true,
    status: { field: 'status' },
    fields: {
      segment: { type: 'string', description: 'The network the runner sits in, e.g. office-lan or dmz.' },
      status: { type: 'enum', values: LEVELS, overridable: false },
      status_reason: { type: 'string', overridable: false },
      last_seen_at: { type: 'datetime', overridable: false },
      version: { type: 'string', overridable: false },
      notes: { type: 'markdown' },
    },
    relations: {},
  },
  {
    id: SCHEDULE_BLUEPRINT,
    title: 'Schedule',
    group: 'Orrery',
    description:
      'Inventory: an action someone set up to run later or on repeat, one record per schedule that runs, waits for approval, or is paused, kept by the hub within half a minute of any change. One removed, declined, or done drops out. Status is green while it fires and its last firing went well, red when that firing failed, amber when the hub paused it because it can no longer fire, and grey while it waits for approval or a person paused it. Each firing stays on the schedule\'s page, not here. It links to what it runs on, one relation for each kind of thing an action runs on (`on_<blueprint>`): what it names, or what its filter or saved query matched when it was last saved or fired. So the page of each thing lists the schedules that run on it.',
    icon: 'schedule',
    standalone: true,
    status: { field: 'status' },
    fields: {
      action: { type: 'string', title: 'Action', description: 'The id of the action it runs.', overridable: false },
      owner: { type: 'user', title: 'Owner', description: 'Who set it up: each firing runs as them.', overridable: false },
      state: { type: 'enum', values: ['awaiting', 'active', 'paused'], description: 'awaiting approval, active and firing, or paused.', overridable: false },
      status: { type: 'enum', values: LEVELS, overridable: false },
      status_reason: { type: 'string', overridable: false },
      when: { type: 'string', title: 'When', description: 'Its cadence, in words.', overridable: false },
      repeats: { type: 'boolean', description: 'On repeat, rather than once.', overridable: false },
      target: { type: 'string', title: 'Runs on', description: 'What each firing runs on.', overridable: false },
      next_at: { type: 'datetime', title: 'Next firing', overridable: false },
      last_at: { type: 'datetime', title: 'Last firing', overridable: false },
      last_result: { type: 'enum', values: ['succeeded', 'failed', 'mixed', 'running'], title: 'Last result', description: 'How the runs of the last firing went: all succeeded, all failed, some of each, or still running.', overridable: false },
      runs_count: { type: 'number', title: 'Runs per firing', overridable: false },
      firings_per_day: { type: 'number', overridable: false },
      runner_minutes_per_day: { type: 'number', description: 'Runner time its firings take in an average day.', overridable: false },
      decided_by: { type: 'user', title: 'Approved by', overridable: false },
      decided_at: { type: 'datetime', title: 'Approved at', overridable: false },
      note: { type: 'string', description: 'Why it is paused, or why its last firing failed.', overridable: false },
      created_at: { type: 'datetime', overridable: false },
      url: { type: 'url', title: 'Schedule page', overridable: false },
    },
    relations: {},
  },
  {
    id: REPORT_BLUEPRINT,
    title: 'Report',
    group: 'Orrery',
    description:
      'Inventory: a report a team keeps, such as a weekly summary of test runs. Its layout is a short Markdown document of blocks (stats, chart, table, scorecard, narrative) over named data sets: saved queries read as its owner, and runner tools called as them. Each publish keeps an edition (Report edition) that people read and compare later. It belongs to one home, usually a team, through a `home_<blueprint>` relation; whoever owns the home, and its owner, change and publish it, and anyone who may see the home reads it. Its schedules are the schedules of its publish action, listed under Schedules. Status is green while its last publish worked, red when it failed, and grey before the first. The hub writes it: change it with its actions, never by hand.',
    icon: 'chart',
    standalone: true,
    status: { field: 'status' },
    fields: {
      owner: { type: 'user', title: 'Owner', description: 'Who the report belongs to. Its data is read as them, so it never shows what they cannot see.', overridable: false },
      layout: { type: 'markdown', title: 'Layout', description: 'The current layout: front matter naming the data sets and the writer, then headings, paragraphs, and fenced blocks.', overridable: false },
      version: { type: 'number', title: 'Version', description: 'The number of the current layout. Every edit, and every restore, makes the next.', overridable: false },
      data_sets: { type: 'array', title: 'Data sets', description: 'What its blocks read, each as name: query <id> or name: tool <id>.', overridable: false, spread: false },
      writer: { type: 'string', title: 'Writer', description: 'The runner tool that writes the prose of its narrative blocks.', overridable: false },
      recipients: { type: 'array', title: 'Recipients', description: 'Who is sent each edition, by sign-in address. Only those who may see the report are sent it.', overridable: false, spread: false },
      editions: { type: 'number', title: 'Editions', description: 'How many editions it has published.', overridable: false },
      last_published_at: { type: 'datetime', title: 'Last published', overridable: false },
      summary: { type: 'string', title: 'Summary', description: 'What the newest edition says, in a line.', overridable: false },
      headline: { type: 'object', title: 'Headline', description: 'The newest edition\'s headline numbers, by stat name.', overridable: false },
      status: { type: 'enum', values: LEVELS, overridable: false },
      status_reason: { type: 'string', overridable: false },
      created_at: { type: 'datetime', overridable: false },
      url: { type: 'url', title: 'Report page', overridable: false },
    },
    relations: {},
  },
  {
    id: EDITION_BLUEPRINT,
    title: 'Report edition',
    group: 'Orrery',
    description:
      'History: one published copy of a report, kept for people to read and compare, counted from when it was published and let go when that is older than the hub keeps editions (two years unless the estate says otherwise). It holds what the edition said in a line, its headline numbers, the layout version it used, and who or what started it. Its body and its data, as read then, are kept by the hub beside it and read from its page. Whoever may see the report sees its editions. A run that published nothing is no edition.',
    icon: 'history',
    fields: {
      number: { type: 'number', title: 'Edition', overridable: false },
      published_at: { type: 'datetime', title: 'Published', overridable: false },
      summary: { type: 'string', title: 'Summary', description: 'What the edition says, in a line: its first narrative\'s opening, else its headline numbers.', overridable: false },
      headline: { type: 'object', title: 'Headline', description: 'Its headline numbers, by stat name, as published.', overridable: false },
      layout_version: { type: 'number', title: 'Layout version', overridable: false },
      started_by: { type: 'user', title: 'Started by', description: 'Who asked for the publish, or whose schedule fired it.', overridable: false },
      schedule: { type: 'string', title: 'Schedule', description: 'The schedule that fired it, when one did.', overridable: false },
      run: { type: 'string', title: 'Run', description: 'The run that published it.', overridable: false },
      body_url: { type: 'url', title: 'Body', description: 'The edition drawn as a mail-ready page.', overridable: false },
      data_url: { type: 'url', title: 'Data', description: 'Its data sets, as read when it was published, as JSON.', overridable: false },
      url: { type: 'url', title: 'Edition page', overridable: false },
    },
    relations: {
      report: { target: REPORT_BLUEPRINT, title: 'Report', inverseTitle: 'Editions', description: 'The report it is an edition of.' },
    },
  },
]

/** The prefix of the report blueprint's relations: `home_<blueprint>` links a report to its home, an entity of that blueprint. */
export const HOME_OF = 'home_'

/** The report blueprint's relations: one for each blueprint a report's home is in, made from those blueprints. */
export function reportRelations(homes: readonly string[], blueprints: Pick<Blueprints, 'get' | 'resolve'>): Record<string, RelationDef> {
  const targets = [...new Set(homes.map((id) => blueprints.resolve(id)))].filter((id) => blueprints.get(id)).sort()
  return Object.fromEntries(targets.map((id) => [`${HOME_OF}${id}`, { target: id, title: 'Home', inverseTitle: 'Reports', description: 'The entity the report belongs to, usually a team: whoever owns it changes and publishes the report.' }]))
}

/** How long editions are kept when the estate says nothing. */
export const EDITION_KEEP_DAYS = 730

/** The prefix of the schedule blueprint's relations: `on_<blueprint>` links a schedule to the entities of that blueprint it runs on. */
const RUNS_ON = 'on_'

/**
 * The schedule blueprint's relations: one for each blueprint an action runs
 * on, so a schedule links to what it runs on whatever kind it is. Made from
 * the actions as they stand, and only for a blueprint that exists.
 */
export function scheduleRelations(actions: Pick<Action, 'blueprint'>[], blueprints: Pick<Blueprints, 'get' | 'resolve'>): Record<string, RelationDef> {
  const targets = [...new Set(actions.flatMap((a) => actionTargets(a).map((id) => blueprints.resolve(id))))].sort()
  // Made from the target's id alone, so a change to its title, or anything else of it, moves no relation here.
  return Object.fromEntries(
    targets.filter((id) => blueprints.get(id)).map((id) => [`${RUNS_ON}${id}`, { target: id, many: true, title: 'Runs on', inverseTitle: 'Schedules', description: 'What this schedule runs on: what it names, or what its filter or saved query matched when it was last saved or fired.' }]),
  )
}

/**
 * The rule a hub blueprint is written with. Subjects are the hub's to name:
 * an admin opens a hub blueprint to whoever sees what its entities link to,
 * or not, and the rule names every relation the blueprint has then.
 */
function ruleOf(id: string, given: AccessRule | undefined, relations: Record<string, RelationDef>): AccessRule {
  // An edition is seen by whoever sees its report, whatever an admin opened: it is the report's, read later.
  if (id === EDITION_BLUEPRINT) return { grants: [], subjects: ['report'] }
  // A report is seen by whoever sees its home until an admin says otherwise: a team's report is the team's to read.
  given ??= id === REPORT_BLUEPRINT ? { grants: [], subjects: ['home'] } : undefined
  if (!given) return ADMINS_ONLY
  const { subjects, ...rest } = given
  const all = Object.keys(relations)
  return subjects?.length && all.length ? { ...rest, subjects: all } : rest
}

/** Where an admin's choice of who sees each of the hub's own blueprints is kept, by blueprint id. */
const HUB_ACCESS_KEY = 'hub.access'

/** A rule with no grants lets nobody in, so only an admin sees the blueprint. That is where every hub blueprint starts. */
const ADMINS_ONLY: AccessRule = { grants: [] }

export function isHubBlueprint(id: string): boolean {
  return HUB_BLUEPRINTS.some((spec) => spec.id === id)
}

async function hubAccess(db: Db): Promise<Record<string, AccessRule>> {
  const row = await db.query<{ value: Record<string, AccessRule> }>('SELECT value FROM settings WHERE key = $1', [HUB_ACCESS_KEY])
  return row.rows[0]?.value ?? {}
}

/** What of the hub's blueprints follows the estate: each part left out keeps what the blueprint holds. */
export interface HubShape {
  /** The schedule blueprint's relations, from the actions (`scheduleRelations`). */
  schedules?: Record<string, RelationDef>
  /** The report blueprint's relations, from the reports' homes (`reportRelations`). */
  reports?: Record<string, RelationDef>
  /** Days an edition is kept, from when it was published. */
  editionKeepDays?: number
}

/**
 * Writes the hub's own blueprints as this version defines them. Everything
 * about them is the hub's except who sees them: that is the access an admin
 * gave, and admins only until one does; a report is seen by whoever sees its
 * home until then, and an edition always by whoever sees its report. What
 * follows the estate (`HubShape`) is written when given; left out, what the
 * blueprint holds is kept, so a hub that starts before it reads its actions
 * or its reports drops no link.
 */
export async function ensureHubBlueprints(db: Db, blueprints: Blueprints, entities: Entities, shape: HubShape = {}): Promise<void> {
  const given = await hubAccess(db)
  for (const spec of HUB_BLUEPRINTS) {
    const held = blueprints.get(spec.id)
    const relations = spec.id === SCHEDULE_BLUEPRINT ? (shape.schedules ?? held?.relations ?? {}) : spec.id === REPORT_BLUEPRINT ? (shape.reports ?? held?.relations ?? {}) : spec.relations
    const days = shape.editionKeepDays ?? (held?.lifecycle?.expire ? Math.round(parseDuration(held.lifecycle.expire.after) / 86_400_000) : EDITION_KEEP_DAYS)
    const lifecycle = spec.id === EDITION_BLUEPRINT ? { lifecycle: { expire: { after: `${days}d`, field: 'published_at' } } } : {}
    await blueprints.save({ ...spec, ...lifecycle, relations, access: ruleOf(spec.id, given[spec.id], relations) }, { kind: 'hub' }, 'hub', (bp, field) => entities.valuesOf(bp, field))
  }
}

/** Sets who sees one of the hub's own blueprints. Null puts it back to admins only. */
export async function setHubAccess(db: Db, blueprints: Blueprints, entities: Entities, id: string, rule: AccessRule | null, log: Logger): Promise<void> {
  const given = await hubAccess(db)
  if (rule && (hasRule(rule) || rule.subjects?.length)) given[id] = rule
  else delete given[id]
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [HUB_ACCESS_KEY, JSON.stringify(given)])
  await ensureHubBlueprints(db, blueprints, entities)
  log.info('access to a hub blueprint changed', { blueprint: id, grants: given[id]?.grants.length ?? 0, bySubjects: !!given[id]?.subjects?.length, adminsOnly: !given[id] })
}

const RENAMED: Record<string, string> = { source: SOURCE_BLUEPRINT, runner: RUNNER_BLUEPRINT }

/**
 * Earlier versions loaded a catalog directory from the image as the `builtin`
 * git source. Where that source is still registered, everything it defined is
 * handed to the web app as editable, its `source` and `runner` blueprints
 * move to their reserved ids with every entity they hold, and the source is
 * dropped. Runs before anything is cached.
 */
export async function retireBuiltinCatalog(db: Db, log: Logger): Promise<void> {
  const found = await db.query(`SELECT 1 FROM sources WHERE id = 'builtin'`)
  if (!found.rowCount) return
  const moved: string[] = []
  const handed = await db.tx(async (client) => {
    for (const [from, to] of Object.entries(RENAMED)) {
      const old = await client.query(`DELETE FROM blueprints WHERE id = $1 AND origin->>'source' = 'builtin'`, [from])
      if (!old.rowCount) continue
      moved.push(from)
      for (const table of ['entities', 'relations', 'changes', 'grid_layouts', 'scorecard_history', 'field_history', 'check_results', 'alerts', 'relation_rules', 'alert_rules']) {
        await client.query(`UPDATE ${table} SET blueprint = $2 WHERE blueprint = $1`, [from, to])
      }
      await client.query(`UPDATE relations SET target_blueprint = $2 WHERE target_blueprint = $1`, [from, to])
      await client.query(`UPDATE relation_rules SET target = $2 WHERE target = $1`, [from, to])
      await client.query(`UPDATE scorecards SET spec = jsonb_set(spec, '{blueprint}', to_jsonb($2::text)) WHERE spec->>'blueprint' = $1`, [from, to])
      const others = await client.query<{ id: string; spec: BlueprintSpec }>('SELECT id, spec FROM blueprints')
      for (const bp of others.rows) {
        const targets = Object.values(bp.spec.relations ?? {}).filter((r) => r.target === from)
        if (!targets.length) continue
        for (const r of targets) r.target = to
        await client.query('UPDATE blueprints SET spec = $2 WHERE id = $1', [bp.id, JSON.stringify(bp.spec)])
      }
      const layout = await client.query<{ value: ModelLayout }>(`SELECT value FROM settings WHERE key = 'model.layout'`)
      const value = layout.rows[0]?.value
      if (value) {
        const positions = Object.fromEntries(Object.entries(value.positions).map(([id, p]) => [id === from ? to : id, p]))
        const next: ModelLayout = { positions, hidden: value.hidden.map((id) => (id === from ? to : id)) }
        await client.query(`UPDATE settings SET value = $1 WHERE key = 'model.layout'`, [JSON.stringify(next)])
      }
    }
    let count = 0
    for (const table of ['blueprints', 'relation_rules', 'scorecards', 'alert_rules']) {
      const res = await client.query(`UPDATE ${table} SET origin = '{"kind":"ui"}' WHERE origin->>'source' = 'builtin'`)
      count += res.rowCount ?? 0
    }
    await client.query(`DELETE FROM tokens WHERE source = 'builtin'`)
    await client.query(`DELETE FROM sources WHERE id = 'builtin'`)
    await record(client, 'source.changed', null, 'builtin', null, { removed: true })
    return count
  })
  log.info('built-in catalog retired: its definitions are now editable in the web app', { definitions: handed, movedToReservedIds: moved })
}

/**
 * The actions the hub brings: the ones its own reports are made, changed,
 * previewed, published, handed over, and removed with. Each is a `report`
 * run, judged in `reports.ts` as the person who asked, so they are open to
 * everyone and refuse there whoever may not change the report. The reports
 * page and a report's own page offer them. An estate that wants one behind an approval defines its own beside it.
 */
export const HUB_ACTIONS: Record<string, unknown>[] = [
  {
    id: 'orrery_report_new',
    title: 'New report',
    description: 'Makes a report owned by whoever asks, in one home, at its first layout version.',
    icon: 'chart',
    access: { everyone: true },
    inputs: {
      title: { type: 'string', required: true, title: 'Title' },
      home: { type: 'string', required: true, title: 'Home', description: 'The entity the report belongs to, as blueprint:key: usually a team.' },
      layout: { type: 'markdown', required: true, title: 'Layout' },
      recipients: { type: 'email', many: true, title: 'Recipients' },
    },
    backend: { type: 'report', verb: 'create' },
  },
  {
    id: 'orrery_report_edit',
    title: 'Edit layout',
    description: 'Changes a report\'s layout, kept as its next version.',
    icon: 'file',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true },
    inputs: { layout: { type: 'markdown', required: true, title: 'Layout', default: '{{ entity.fields.layout }}' }, note: { type: 'string', title: 'What changed' } },
    backend: { type: 'report', verb: 'edit' },
  },
  {
    id: 'orrery_report_restore',
    title: 'Put a version back',
    description: 'Makes an older layout version the report\'s next version.',
    icon: 'history',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true },
    inputs: { version: { type: 'number', required: true, title: 'Version' } },
    backend: { type: 'report', verb: 'edit' },
  },
  {
    id: 'orrery_report_preview',
    title: 'Preview',
    description: 'Draws the next edition without keeping or sending it. Saved queries are read afresh; a tool\'s rows come from the newest edition unless fresh is asked.',
    icon: 'eye',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true, tiers: ['read'] },
    inputs: { fresh: { type: 'boolean', title: 'Read everything afresh' } },
    backend: { type: 'report', verb: 'preview' },
  },
  {
    id: 'orrery_report_publish',
    title: 'Publish',
    description: 'Publishes the report\'s next edition and sends it to its recipients.',
    icon: 'rocket',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    schedule: { min: '1h' },
    access: { everyone: true, tiers: ['read'] },
    backend: { type: 'report', verb: 'publish' },
  },
  {
    id: 'orrery_report_recipients',
    title: 'Change recipients',
    description: 'Sets who each edition is sent to.',
    icon: 'mail',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true },
    inputs: { recipients: { type: 'email', many: true, required: true, title: 'Recipients', default: '{{ entity.fields.recipients }}' } },
    backend: { type: 'report', verb: 'recipients' },
  },
  {
    id: 'orrery_report_hand',
    title: 'Hand over',
    description: 'Gives the report, and every schedule that publishes it, to a new owner. Its data is read as them from then on.',
    icon: 'handshake',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true },
    inputs: { owner: { type: 'email', required: true, title: 'New owner', description: 'Their sign-in address. They must be able to see the report and read everything it names.' } },
    backend: { type: 'report', verb: 'hand' },
  },
  {
    id: 'orrery_report_remove',
    title: 'Remove report',
    description: 'Removes the report, its editions, and what they keep.',
    icon: 'file',
    blueprint: REPORT_BLUEPRINT,
    listed: false,
    access: { everyone: true },
    backend: { type: 'report', verb: 'remove' },
  },
]
