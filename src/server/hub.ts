// Wires every part of the hub together. main.ts and the tests share it.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { Access, parseAliases } from './access.ts'
import { Actions } from './actions.ts'
import { Batches } from './batches.ts'
import { ChangeSets } from './change-sets.ts'
import { Queries } from './queries.ts'
import { Schedules } from './schedules.ts'
import { Reports } from './reports.ts'
import { Approvals } from './approvals.ts'
import { ScheduleRecords } from './schedule-records.ts'
import { askerTimes } from '../shared/filter.ts'
import { entityId, type Identity } from '../shared/model.ts'
import { pruneActivity } from './activity.ts'
import { accessTokenIdentity, identityOf, LOCAL, type AppEnv } from './auth.ts'
import { Alerts } from './alerts.ts'
import { Blueprints } from './blueprints.ts'
import { Bridge } from './bridge.ts'
import { Deriver } from './derive.ts'
import { ensureHubBlueprints, HUB_ACTIONS, retireBuiltinCatalog } from './builtin.ts'
import { Datasets } from './datasets.ts'
import { Checks } from './checks.ts'
import { Scorecards } from './scorecards.ts'
import type { Config } from './config.ts'
import { connectionOf, Db } from './db.ts'
import { Entities } from './entities.ts'
import { Events } from './events.ts'
import { Lists } from './lists.ts'
import { Findings } from './findings.ts'
import { GitSources } from './git.ts'
import { Icons } from './icons.ts'
import { Pictures } from './pictures.ts'
import { createApp } from './http.ts'
import { AGENT_TOOLS } from './mcp.ts'
import { createLogger, type Logger } from './log.ts'
import { Budgets } from './budgets.ts'
import { Previews } from './previews.ts'
import { Load } from './load.ts'
import { Cardinality } from './cardinality.ts'
import { Presence } from './presence.ts'
import { Pins } from './pins.ts'
import { Stars } from './stars.ts'
import { Walks } from './walks.ts'
import { Preferences } from './preferences.ts'
import { Welcome } from './welcome.ts'
import { Reader } from './read.ts'
import { Rules } from './rules.ts'
import { Runs } from './runs.ts'
import { SecretBox } from './secrets.ts'
import { Sources } from './sources.ts'
import { idTokenVerifier, type IdTokenVerifier } from './signin.ts'
import { Behalf, parseDelegates } from './behalf.ts'
import { identityFromEnv, type WorkloadIdentity } from './workload.ts'
import { Visibility } from './visibility.ts'
import { Writes } from './writes.ts'
import { ColumnStandards } from './standard.ts'
import { Conventions } from './conventions.ts'
import { FieldHistory } from './history.ts'
import { BROWSER_EVENTS, CHANGE_EVENTS, HUB_EVENTS } from '../shared/usage.ts'
import { observeFields, observeHub, observeRunners, seedCounts, timeQueries, timed } from './metrics.ts'

export interface Hub {
  app: Hono<AppEnv>
  db: Db
  blueprints: Blueprints
  standards: ColumnStandards
  conventions: Conventions
  welcome: Welcome
  preferences: Preferences
  entities: Entities
  reader: Reader
  rules: Rules
  runs: Runs
  sources: Sources
  writes: Writes
  load: Load
  cardinality: Cardinality
  budgets: Budgets
  previews: Previews
  access: Access
  findings: Findings
  git: GitSources
  scorecards: Scorecards
  history: FieldHistory
  alerts: Alerts
  checks: Checks
  actions: Actions
  batches: Batches
  changeSets: ChangeSets
  queries: Queries
  schedules: Schedules
  reports: Reports
  datasets: Datasets
  approvals: Approvals
  scheduleRecords: ScheduleRecords
  /** Everyone enrolled, as the hub judges each now. */
  people: () => Identity[]
  events: Events
  lists: Lists
  icons: Icons
  pictures: Pictures
  visibility: Visibility
  deriver: Deriver
  log: Logger
  webDir: string | null
  /** The periodic pass: lifecycle, scorecard and field history, stale alerts, check results for gone checks, action runs nobody reported on, old activity. */
  tick(): Promise<void>
  /**
   * Reads again everything the hub keeps in memory, and drops every kept
   * answer and every browser's: another hub that served beside this one may
   * have changed any of it. Run when this hub takes the lead.
   */
  catchUp(): Promise<void>
  /** What this hub and the others on its database tell each other. Started by whoever runs the hub, and stopped with it. */
  bridge: Bridge
  /** Stops asking for traffic: `/readyz` answers 503 from here on. */
  drain(): void
  close(): Promise<void>
}

export async function createHub(config: Config, version: string, opts: { reset?: boolean; idTokens?: IdTokenVerifier } = {}): Promise<Hub> {
  const log = createLogger('orrery')
  const dataDir = resolve(config.DATA_DIR)
  const dbLog = createLogger('db')
  const db = new Db(connectionOf(config), dbLog, { max: config.DATABASE_POOL_MAX, statementSeconds: config.DATABASE_STATEMENT_SECONDS })
  // The ledger is made from the database, so the statements are counted through a holder it fills once it is there.
  const spent: { note: Load['note'] } = { note: () => undefined }
  timeQueries(db.pool, dbLog, (work, ms, rows) => spent.note('db', work, { calls: 1, ms, rows }))
  await db.migrate(log)
  if (opts.reset) await db.reset()
  const secrets = SecretBox.load(config.SECRET_KEY, dataDir, log)
  const events = new Events()
  const blueprints = new Blueprints(db, createLogger('blueprints'))
  const writes = new Writes(db, createLogger('writes'))
  await writes.load()
  const load = new Load(db, createLogger('load'))
  spent.note = (kind, name, add) => load.note(kind, name, add)
  const budgets = new Budgets(db, load, createLogger('budgets'))
  await budgets.read()
  const previews = new Previews(db, createLogger('previews'))
  await previews.read()
  const sources = new Sources(db, secrets, writes, createLogger('sources'))
  await retireBuiltinCatalog(db, log)
  await blueprints.load()
  const standards = new ColumnStandards(db, createLogger('standards'))
  await standards.load()
  const conventions = new Conventions(db, createLogger('conventions'))
  await conventions.load()
  const welcome = new Welcome(db, createLogger('welcome'))
  await welcome.load()
  await sources.load()
  await sources.ensureBuiltins()
  const access = new Access(db, events, createLogger('access'), parseAliases(config.EMAIL_DOMAIN_ALIASES))
  await access.load()
  const entities = new Entities(db, blueprints, events, writes, load, createLogger('entities'))
  entities.full = (blueprint) => budgets.full(blueprint)
  await ensureHubBlueprints(db, blueprints, entities, { editionKeepDays: config.REPORT_KEEP_DAYS })
  const webDir = resolve(import.meta.dirname, '../../dist/web')
  // The built-in brand files: the web app's source beside the server where it is there, the web app's build in the image.
  const brandDir = [resolve(import.meta.dirname, '../web/public/icons'), resolve(webDir, 'icons')].find((dir) => existsSync(dir)) ?? null
  const icons = new Icons(db, events, createLogger('icons'), brandDir)
  await icons.load()
  const reader = new Reader(db, blueprints, sources, icons)
  const pictures = new Pictures(db, createLogger('pictures'))
  await pictures.load()
  reader.pictures = pictures
  const lists = new Lists(reader, events, load, createLogger('lists'), db, version)
  const rules = new Rules(db, blueprints, reader, events, createLogger('rules'), load)
  await rules.load()
  const runs = new Runs(db, blueprints, sources, entities, rules, events, createLogger('runs'))
  await runs.load()
  reader.seenAt = (row) => runs.seenAt(row)
  const findings = new Findings(db, blueprints, sources, rules, reader, lists, budgets, conventions)
  const checks = new Checks(db, blueprints, secrets, events, createLogger('checks'))
  const alerts = new Alerts(db, blueprints, reader, entities, events, createLogger('alerts'))
  await alerts.load()
  reader.attach({ checks, alerts })
  const scorecards = new Scorecards(db, blueprints, reader, createLogger('scorecards'))
  await scorecards.load()
  const history = new FieldHistory(db, blueprints, reader, events, createLogger('history'))
  const cardinality = new Cardinality(db, blueprints, createLogger('cardinality'))
  // What the field gauge reads is in the database, so one hub of a pair reports it: the one that serves.
  if (config.ROLE !== 'worker') observeFields(() => history.readings(), log)
  if (config.ROLE !== 'worker') observeRunners(() => actions.runnerReadings(), log)
  seedCounts([...Object.values(CHANGE_EVENTS).flatMap((e) => (e ? [{ event: e, source: 'api' as const }] : [])), ...HUB_EVENTS.map((e) => ({ event: e, source: 'api' as const })), ...BROWSER_EVENTS.map((e) => ({ event: e, source: 'web' as const }))], AGENT_TOOLS)
  const presence = new Presence(db, createLogger('presence'))
  const pins = new Pins(db, createLogger('pins'))
  const stars = new Stars(db)
  const walks = new Walks(db, createLogger('walks'))
  const preferences = new Preferences(db, createLogger('preferences'))
  observeHub({ queued: async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM derive_queue')).rows[0]?.n ?? 0), present: () => presence.count() }, version, log)
  const visibility = new Visibility(db, blueprints, reader, events, createLogger('visibility'))
  await visibility.load()
  pictures.person = () => visibility.personSetting()
  pictures.peopleOf = async (address) => {
    const ref = await visibility.personOf(address)
    return ref ? [ref] : []
  }
  pictures.custom = (name) => icons.has(name)
  // Derived state: every writer queues what it touched, the leader derives and stores it, and reads are lookups.
  const deriver = new Deriver({ db, reader, blueprints, sources, rules, events, load, log: createLogger('derive') }, { batch: config.DERIVE_BATCH, budgetMs: config.DERIVE_BUDGET_MS, inlineMax: config.DERIVE_INLINE_MAX })
  for (const part of [entities, rules, runs, checks, alerts, history, sources, pictures]) part.queue = deriver
  reader.onUnderived = (refs) => void deriver.enqueue(db, refs).catch((error) => log.warn('could not queue underived rows', { error }))
  reader.ensureDerived = (blueprint, staleBefore, keys) => deriver.ensure(blueprint, staleBefore, keys)
  // A model change moves every entity of the blueprint and of everything that reads it; a scorecard change moves what it scores.
  const dependents = (ids: string[]) => blueprints.list().filter((bp) => ids.includes(bp.id) || [...(reader.readsFor(bp.id) ?? new Set(blueprints.list().map((b) => b.id)))].some((r) => ids.includes(r))).map((bp) => bp.id)
  blueprints.onChanged = (ids) => deriver.enqueueBlueprints(db, dependents(ids))
  scorecards.onChanged = (ids) => deriver.enqueueBlueprints(db, dependents(ids))
  entities.guard((blueprint, names) => visibility.refusesForeignWrite(blueprint, names))
  visibility.attachScorecards(scorecards)
  visibility.attachRules(rules)
  rules.onLoad(() => visibility.refresh())
  // A run asked for by a person carries only what that person may see; one asked for by a machine token is not restricted.
  const viewOf = (requester: string) => {
    const person = access.find(requester)
    return visibility.view(person ? { kind: 'user', name: person.email, admin: person.admin, roles: person.roles, permissions: [] } : { kind: 'token', name: requester, admin: false, roles: [], permissions: [] })
  }
  const delegates = parseDelegates(config.AUTH_DELEGATES)
  let behalfIdentity: WorkloadIdentity | null = null
  if (Object.keys(delegates).length) {
    try {
      behalfIdentity = identityFromEnv(process.env)
      log.info('the hub may call other APIs as the person who asked', { delegates: Object.keys(delegates) })
    } catch (error) {
      log.warn('delegates are set but the hub has no workload identity: a run that calls as a person will fail', { delegates: Object.keys(delegates), reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const behalf = new Behalf(delegates, behalfIdentity, secrets)
  // Everyone who signs in, as the hub judges each now. With no sign-in, every request is the local admin, so a run asked as them acts as them.
  const people = (): Identity[] => [...(config.AUTH_MODE === 'none' ? [LOCAL] : []), ...access.listUsers().map((u) => identityOf(u, access))]
  const actions = new Actions({ identityFor: (email) => people().find((p) => p.name === email) ?? null, db, blueprints, reader, sources, checks, events, viewOf, person: () => visibility.personSetting()?.blueprint ?? null, mayRun: (identity, action) => visibility.mayRun(identity, action), grantsLetIn: (address, grants) => visibility.grantsLetIn(address, grants), gate: (identity, action) => visibility.gate(identity, action), owned: (who) => visibility.ownedKept(who), asker: async (who) => { const ref = who.kind === 'user' ? await visibility.personOf(who.name) : null; const zone = (who.kind === 'user' ? (await preferences.of(who.name)).timeZone : null) ?? 'UTC'; return { address: who.name, person: ref ? entityId(ref) : null, times: askerTimes(new Date(), zone) } }, entities, decides: (blueprint, names) => visibility.refusesRecordWrite(blueprint, names), pinned: async (identity) => (identity.kind === 'user' ? new Set((await pins.of(identity.name)).flatMap((p) => (p.kind === 'action' ? [p.id] : []))) : null), people: () => access.listUsers().map((u) => { const judged = identityOf({ ...u, admin: false }, access); return { ...judged, permissions: judged.permissions.filter((p) => p !== 'actions.approve') } }), deciding: async () => [...people(), ...(await sources.listTokens()).filter((t) => t.kind === 'access').map((t) => accessTokenIdentity(t, access))], seenBy: (identity) => visibility.view(identity), log: createLogger('actions'), publicUrl: config.PUBLIC_URL, githubApi: config.GITHUB_API_URL, behalf, timeoutMinutes: config.ACTION_TIMEOUT_MINUTES })
  await actions.load()
  await actions.ensureBuiltins(HUB_ACTIONS)
  visibility.attach(actions)
  const batches = new Batches({ db, actions, reader, events, log: createLogger('batches') })
  const changeSets = new ChangeSets({ db, actions, events, people, viewOf: (identity) => visibility.view(identity), log: createLogger('change-sets') })
  actions.controlsSetsWith(changeSets)
  const datasets = new Datasets({ db, actions, reader, log: createLogger('datasets') })
  const queries = new Queries({ db, actions, reader, blueprints, datasets, visibility, log: createLogger('queries') })
  const schedules = new Schedules({ db, actions, batches, queries, reader, blueprints, identityFor: (email) => people().find((p) => p.name === email) ?? null, viewOf: (identity) => visibility.view(identity), events, log: createLogger('schedules') })
  const approvals = new Approvals({ db, blueprints, entities, reader, sources, actions, schedules, sets: changeSets, people, viewOf: (identity) => visibility.view(identity), person: () => visibility.personSetting(), publicUrl: config.PUBLIC_URL, log: createLogger('approvals') })
  actions.controlsSchedulesWith(schedules)
  const reports = new Reports({ db, entities, reader, blueprints, sources, queries, actions, schedules, events, identityFor: (email) => people().find((p) => p.name.toLowerCase() === email.toLowerCase()) ?? null, arriving: (email) => identityOf({ email: email.toLowerCase(), admin: false, roles: [], firstSeenAt: null, lastSeenAt: null }, access), viewOf: (identity) => visibility.view(identity), zoneOf: async (person) => (await preferences.of(person)).timeZone, owns: (identity, home) => visibility.homeLetsIn(identity, home, true), publicUrl: config.PUBLIC_URL, log: createLogger('reports') })
  actions.controlsReportsWith(reports)
  const scheduleRecords = new ScheduleRecords({ db, entities, blueprints, actions, sources, schedules, events, publicUrl: config.PUBLIC_URL, log: createLogger('schedule-records') })
  // A change shows in the schedule blueprint at once on the hub that took it; an action's change moves what it links to.
  events.subscribe((event) => {
    if (event.type === 'schedules' || event.type === 'actions') scheduleRecords.soon()
  })
  await approvals.load()
  if (approvals.setting()) await sources.ensureBuiltins([approvals.setting()!.blueprint])
  const git = new GitSources({ db, blueprints, standards, conventions, welcome, entities, rules, runs, scorecards, alerts, actions, icons, sources, events, visibility, log: createLogger('git') }, dataDir)
  const idTokens = opts.idTokens ?? (config.AUTH_MODE === 'proxy' && config.AUTH_ISSUER ? idTokenVerifier(config.AUTH_ISSUER, config.AUTH_AUDIENCE ?? '', undefined, config.AUTH_API_SCOPE) : undefined)
  let draining = false
  const app = createApp({ draining: () => draining, idTokens, config, db, blueprints, standards, conventions, welcome, entities, reader, runs, rules, sources, writes, load, cardinality, budgets, previews, access, findings, git, scorecards, alerts, checks, actions, batches, changeSets, queries, schedules, reports, datasets, approvals, events, visibility, lists, icons, pictures, presence, pins, stars, walks, preferences, log: createLogger('http'), version, webDir: existsSync(webDir) ? webDir : null })
  const tick = () => timed('lifecycle.tick', async () => {
    await runs.tick(config.TOMBSTONE_DAYS, config.RUN_DAYS, config.RELINK_MINUTES)
    await scorecards.recordHistory()
    await history.record()
    await alerts.expire()
    await checks.prune()
    await actions.expire()
    await reports.prune(config.RUN_IMAGE_DAYS)
    await datasets.prune()
    await batches.ended()
    await changeSets.ended()
    await pruneActivity(db, config.ACTIVITY_DAYS, log)
    await presence.prune()
    await load.prune(config.LOAD_DAYS)
    await cardinality.measure()
    await deriver.reconcile()
  })
  const readAgain = async () => {
    await writes.flush()
    await writes.load()
    await budgets.read()
    await previews.read()
    await blueprints.load()
    await standards.load()
    await conventions.load()
    await welcome.load()
    await sources.load()
    await access.load()
    await icons.load()
    await pictures.load()
    await rules.load()
    await runs.load()
    await alerts.load()
    await scorecards.load()
    await visibility.load()
    await actions.load()
  }
  const catchUp = () => timed('hub.catch_up', async () => {
    await readAgain()
    // Only this hub read again: the others kept up all along, and told them, every answer they keep would move.
    for (const type of ['blueprints', 'access', 'icons', 'sources', 'actions'] as const) events.local({ type })
    const all = blueprints.list().map((bp) => bp.id)
    events.local({ type: 'derived', blueprints: all, titled: all })
    log.info('caught up: everything kept in memory read again')
  })
  // A hub that only serves leaves the re-link after a commit to the leader, which hears of the commit.
  if (config.ROLE === 'api') runs.relink = () => undefined
  const bridge = new Bridge(db, events, createLogger('bridge'), {
    // The tables every run moves are read alone; any other change reads everything again, as taking the lead does.
    reload: (tables) =>
      timed('hub.reload', async () => {
        const rest = [...tables].filter((t) => t !== 'sources' && t !== 'scope_seen' && t !== 'source_writes' && t !== 'pictures')
        if (rest.length) return readAgain()
        if (tables.has('pictures')) await pictures.load()
        if (tables.has('source_writes')) await writes.read()
        if (tables.has('sources')) await sources.load()
        if (tables.has('scope_seen')) await runs.load()
      }),
    catchUp,
  })
  return { people, app, db, blueprints, standards, conventions, welcome, preferences, entities, reader, rules, runs, sources, writes, load, cardinality, budgets, previews, access, findings, git, scorecards, history, alerts, checks, actions, batches, changeSets, queries, schedules, reports, datasets, approvals, scheduleRecords, events, visibility, lists, icons, pictures, log, webDir: existsSync(webDir) ? webDir : null, deriver, tick, catchUp, bridge,
    drain: () => {
      draining = true
    },
    close: async () => {
      await bridge.stop()
      // A re-link a save left running behind its answer finishes before the pool it writes through ends.
      await rules.settled()
      await writes.flush()
      await load.flush()
      await lists.store()
      await db.close()
    },
  }
}
