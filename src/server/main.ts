import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadConfig } from './config.ts'
import { createHub } from './hub.ts'
import { Jobs } from './jobs.ts'
import { JournalPruner } from './ownership.ts'
import { Leadership } from './leader.ts'
import { AnnalsForwarder } from './annals.ts'
import { NoticeForwarder } from './notices.ts'
import { createLogger } from './log.ts'
import { observeProcess, startMetrics, timed } from './metrics.ts'
import { startTelemetry } from './telemetry.ts'
import type { ServerEvent } from '../shared/api.ts'

const config = loadConfig()
const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version
const log = createLogger('orrery')
const telemetry = await startMetrics(log, version)
const usage = await startTelemetry(log, version)
const hub = await createHub(config, version)
observeProcess(hub.db.pool, version)
const { app, git, checks } = hub
// The other hubs on the database hear what this one changes, and it hears them.
await hub.bridge.start()
await hub.lists.start(hub.events)

const session = serve({ fetch: (req) => app.fetch(req, { surface: 'session' }), port: config.PORT, hostname: config.HOST }, (info) => {
  log.info('session surface listening', { host: info.address, port: info.port, authMode: config.AUTH_MODE, idToken: config.AUTH_MODE === 'proxy' && Boolean(config.AUTH_ISSUER) && !config.AUTH_SESSION_HEADERS, publicUrl: config.PUBLIC_URL, web: hub.webDir !== null })
})
const machine = serve({ fetch: (req) => app.fetch(req, { surface: 'machine' }), port: config.INGEST_PORT, hostname: config.HOST }, (info) => {
  log.info('machine surface listening', { host: info.address, port: info.port, personScope: config.AUTH_API_SCOPE ?? null })
})

// Background work runs on the leading hub only. During a rollout the new hub
// serves beside the old one and takes the lead when the old one lets go.
const jobs = new Jobs(createLogger('jobs'))
jobs.add('git', config.GIT_POLL_MINUTES * 60_000, () => git.refreshAll('timer'))
jobs.add('derive clock', config.DERIVE_CLOCK_SECONDS * 1000, () => hub.deriver.clock())
jobs.add('checks', config.CHECK_MINUTES * 60_000, () => checks.runHub())
jobs.add('lifecycle', config.LIFECYCLE_MINUTES * 60_000, () => hub.tick())
jobs.add('action watch', config.ACTION_WATCH_SECONDS * 1000, () => hub.actions.watch())
// A retry's wait is a few seconds at its shortest, so its next try is handed on within five of being due.
jobs.add('action retries', 5000, () => hub.actions.retryDue())
// A run waiting its turn is handed on as the one before it ends; this is the backstop for a turn a stopped hub held.
jobs.add('action turns', 5000, () => hub.actions.turns())
// A schedule fires within half a minute of its time.
jobs.add('action schedules', 30_000, () => hub.schedules.due())
// The hub's own approvals reach the estate's approvals blueprint within half a minute.
jobs.add('approval records', 30_000, () => hub.approvals.pass())
// Every schedule that is still a job reaches the hub's schedule blueprint within half a minute, firings on any hub included.
jobs.add('schedule records', 30_000, () => hub.scheduleRecords.pass())
jobs.add('action retention', 60 * 60_000, () => hub.actions.prune(config.RUN_KEEP_DAYS, config.RUN_IMAGE_DAYS))
// The journal of moved links lets go of what every hub has read.
const journal = new JournalPruner(hub.db, createLogger('ownership'))
jobs.add('link journal', 5 * 60_000, () => journal.pass())
const annals = config.ANNALS_URL && config.ANNALS_TOKEN ? new AnnalsForwarder(hub.db, { url: config.ANNALS_URL, token: config.ANNALS_TOKEN }, createLogger('annals')) : null
if (annals) jobs.add('annals', config.ANNALS_EVERY_SECONDS * 1000, () => timed('annals.forward', () => annals.pass()).catch((error) => log.warn('annals forward failed', { error })))
else log.info('annals forwarding off', { reason: 'ANNALS_URL or ANNALS_TOKEN unset' })
const notices = config.DISPATCH_URL && config.DISPATCH_TOKEN
  ? new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, mailOf: (report, edition) => hub.reports.mailOf(report, edition), log: createLogger('notices') }, { url: config.DISPATCH_URL, token: config.DISPATCH_TOKEN, publicUrl: config.PUBLIC_URL, approvers: config.DISPATCH_APPROVERS_GROUP, remindHours: config.DISPATCH_REMIND_HOURS })
  : null
if (notices) jobs.add('notices', config.DISPATCH_EVERY_SECONDS * 1000, () => timed('notices.forward', () => notices.pass()).catch((error) => log.warn('run notices failed', { error })))
else log.info('run notices off', { reason: 'DISPATCH_URL or DISPATCH_TOKEN unset' })

const stopWork = async () => {
  await jobs.stop()
}
/** What another hub tells the leader that moves what inherits or what a rule links: a commit, a derived row, a person's edit, the model. */
const RELINKS = new Set<ServerEvent['type']>(['sources', 'estate', 'derived', 'entity', 'blueprints'])
const leadership = new Leadership(hub.db.connection, createLogger('leader'))
// Deriving is shared: every hub that does background work takes from the queue, the leader and those beside it alike,
// each its own entities. Only the leader links again after what it derived; the others tell it through the event.
const deriving = new Jobs(createLogger('jobs'))
deriving.add('derive', config.DERIVE_EVERY_SECONDS * 1000, () => hub.deriver.drain({ relink: leadership.isLeader }))
if (config.ROLE === 'api') log.info('serving only: the background work runs on a worker hub', { role: config.ROLE })
else {
  deriving.start()
  leadership.start({
    lead: async () => {
      await hub.catchUp()
      // The first lead after the derived table arrives derives every entity before anything else runs; after that this finds nothing to do.
      await hub.deriver.backfill()
      jobs.start()
    },
    follow: stopWork,
  })
  // A run or an edit another hub committed: the leader links again what reads what it moved, as it does after its own.
  hub.events.onHeard((event) => {
    if (!leadership.isLeader) return
    if ((event.type === 'estate' || event.type === 'derived') && event.blueprints) hub.rules.touch(event.blueprints, event.type === 'derived')
    if (RELINKS.has(event.type)) void hub.rules.evaluateMoved().catch(() => undefined)
  })
}

/** Closes a server to new connections and resolves once the ones it holds are done, or cuts them after `STOP_SECONDS`. */
const closeServer = (server: typeof session) =>
  new Promise<void>((resolveClosed) => {
    const cut = setTimeout(() => {
      log.warn('cutting requests still open at stop', { seconds: config.STOP_SECONDS })
      if ('closeAllConnections' in server) server.closeAllConnections()
    }, config.STOP_SECONDS * 1000)
    server.close(() => {
      clearTimeout(cut)
      resolveClosed()
    })
  })

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void (async () => {
      // Stop asking for traffic, and keep answering while the load balancer moves away.
      hub.drain()
      log.info('draining', { signal, seconds: config.DRAIN_SECONDS })
      await sleep(config.DRAIN_SECONDS * 1000)
      // Take no new connections, end the browser streams so they reconnect to the next hub, and let the rest finish.
      log.info('shutting down', { signal })
      hub.events.end()
      await Promise.all([closeServer(session), closeServer(machine), stopWork(), deriving.stop()])
      // What this hub wrote is stored before the lead passes on, so the next leader reads all of it.
      await hub.writes.flush()
      await leadership.stop()
      await Promise.all([hub.close(), telemetry.shutdown(), usage.shutdown()])
      log.info('stopped')
    })()
      .catch((error) => log.error('stop failed', { error }))
      .finally(() => process.exit(0))
  })
}
