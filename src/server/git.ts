// Git sources: registered repos of catalog files, pulled on a timer, on
// demand, or from a webhook. Credentials never leave the hub.

import { execFile } from 'node:child_process'
import { createSign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Source } from '../shared/model.ts'
import { applyCatalog, type CatalogReport } from './catalog.ts'
import type { Visibility } from './visibility.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Entities } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import type { Rules } from './rules.ts'
import type { Runs } from './runs.ts'
import type { Sources } from './sources.ts'
import type { Scorecards } from './scorecards.ts'
import type { Alerts } from './alerts.ts'
import type { Actions } from './actions.ts'
import type { Icons } from './icons.ts'
import { fetchTimed, timed } from './metrics.ts'
import type { Welcome } from './welcome.ts'
import type { ColumnStandards } from './standard.ts'
import type { Conventions } from './conventions.ts'

const execRaw = promisify(execFile)

/** Runs git; an error carries stderr only, never the command line with its auth header. */
async function exec(file: string, args: string[], opts: Parameters<typeof execRaw>[2]): Promise<void> {
  try {
    await execRaw(file, args, opts)
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.toString().trim()
    throw new Error(`git ${args.find((a) => ['clone', 'fetch', 'reset'].includes(a)) ?? ''} failed: ${stderr || (error as Error).message.split('\n')[0]?.replace(/Authorization: Basic \S+/g, 'Authorization: [redacted]')}`)
  }
}

export class GitSources {
  private inFlight = new Map<string, Promise<CatalogReport>>()

  private readonly deps: { db: Db; blueprints: Blueprints; standards: ColumnStandards; conventions: Conventions; welcome: Welcome; entities: Entities; rules: Rules; runs: Runs; scorecards: Scorecards; alerts: Alerts; actions: Actions; icons: Icons; sources: Sources; events: Events; visibility: Visibility; log: Logger }
  private readonly dataDir: string

  constructor(deps: { db: Db; blueprints: Blueprints; standards: ColumnStandards; conventions: Conventions; welcome: Welcome; entities: Entities; rules: Rules; runs: Runs; scorecards: Scorecards; alerts: Alerts; actions: Actions; icons: Icons; sources: Sources; events: Events; visibility: Visibility; log: Logger }, dataDir: string) {
    this.deps = deps
    this.dataDir = dataDir
  }

  async refreshAll(trigger: string): Promise<void> {
    for (const s of this.deps.sources.list()) {
      if (s.class !== 'git') continue
      try {
        await this.refresh(s.id, trigger)
      } catch (error) {
        this.deps.log.error('git refresh failed', { source: s.id, trigger, error })
      }
    }
  }

  /** Pulls the repo and applies it. Concurrent calls for the same source share one pull. */
  refresh(id: string, trigger: string): Promise<CatalogReport> {
    const running = this.inFlight.get(id)
    if (running) return running
    const p = timed('git.refresh', () => this.doRefresh(id, trigger)).finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, p)
    return p
  }

  /**
   * Applies a checkout of a git source. The model is announced only when the
   * catalog changed it: most pulls change nothing, and an announcement drops
   * every kept answer, re-links every rule, and has every open browser read
   * the model again.
   */
  async apply(source: Source, dir: string): Promise<CatalogReport> {
    const before = this.model()
    const report = await applyCatalog(this.deps, source, dir, source.git!.glob)
    if (this.model() !== before) this.deps.events.emit({ type: 'blueprints' })
    return report
  }

  /** Everything a catalog defines besides entities, as one value: equal before and after an apply means the apply changed none of it. */
  private model(): string {
    const { blueprints, standards, conventions, rules, scorecards, alerts, actions, visibility } = this.deps
    // A save of what already stands still stamps the time on some of these, so the stamp is left out.
    return JSON.stringify([blueprints.revision(), standards.get(), conventions.get(), rules.list(), scorecards.list(), alerts.listRules(), actions.list(), visibility.policyState()], (key, value: unknown) => (key === 'updatedAt' ? undefined : value))
  }

  private async doRefresh(id: string, trigger: string): Promise<CatalogReport> {
    const { sources, log } = this.deps
    const source = sources.require(id)
    if (!source.git) throw new Error(`source "${id}" is not a git source`)
    log.info('git refresh', { source: id, trigger, url: source.git.url, branch: source.git.branch })
    try {
      const report = await this.apply(source, await this.pull(source))
      if (report.errors.length) {
        await sources.touch(id, { error: null, status: 'amber', reason: `${report.errors.length} catalog problem(s): ${report.errors[0]?.file}: ${report.errors[0]?.reason}` })
        log.warn('catalog applied with errors', { source: id, errors: report.errors })
      }
      this.deps.events.emit({ type: 'sources' })
      return report
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await sources.touch(id, { run: new Date(), error: reason, status: 'red', reason })
      await this.deps.runs.syncSourceEntities(id)
      this.deps.events.emit({ type: 'sources' })
      throw error
    }
  }

  private async pull(source: Source): Promise<string> {
    const git = source.git!
    const dir = join(this.dataDir, 'git', source.id)
    let token = this.deps.sources.gitToken(source.id)
    if (git.auth?.type === 'github-app') {
      if (!token) throw new Error(`source "${source.id}" uses a GitHub App but no private key is stored`)
      token = await installationToken(git.auth.appId, git.auth.installationId, token)
      this.deps.log.info('github app installation token minted', { source: source.id, appId: git.auth.appId })
    }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    // The token travels as a header on each command, never into the stored remote.
    const auth = token ? ['-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : []
    if (existsSync(join(dir, '.git'))) {
      try {
        await exec('git', [...auth, 'fetch', '--depth', '1', 'origin', git.branch], { cwd: dir, env, timeout: 120_000 })
        await exec('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, env })
        return dir
      } catch (error) {
        this.deps.log.warn('git fetch failed; cloning fresh', { source: source.id, error })
        await rm(dir, { recursive: true, force: true })
      }
    }
    await mkdir(join(this.dataDir, 'git'), { recursive: true })
    await exec('git', [...auth, 'clone', '--depth', '1', '--branch', git.branch, git.url, dir], { env, timeout: 300_000 })
    return dir
  }
}

/** Mints a short-lived installation token for a GitHub App: a signed JWT, exchanged at the API. */
export async function installationToken(appId: string, installationId: string, privateKeyPem: string, api = 'https://api.github.com'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = signJwt({ iat: now - 60, exp: now + 9 * 60, iss: appId }, privateKeyPem)
  const res = await fetchTimed('github', `${api}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'orrery' },
  })
  if (!res.ok) throw new Error(`GitHub App token: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error('GitHub App token: no token in the answer')
  return body.token
}

export function signJwt(claims: Record<string, unknown>, privateKeyPem: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`
  const sig = createSign('RSA-SHA256').update(head).sign(privateKeyPem).toString('base64url')
  return `${head}.${sig}`
}
