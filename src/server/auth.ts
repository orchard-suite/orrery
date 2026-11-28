// Who is calling, and what they may do. On the session surface the login
// proxy vouches for the person, by the signed ID token it passes on or, when
// no issuer is configured, by headers; on the machine surface only a bearer
// token counts: one the hub issued, or an access token the issuer gave another
// app to call the hub as a person.

import type { Context, MiddlewareHandler } from 'hono'
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_IDS, can, type ChangeKind, type Identity, type Permission, type User } from '../shared/model.ts'
import type { Access } from './access.ts'
import { actingAs, record } from './activity.ts'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { askingAs, signInStale } from './behalf.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { recordAuth } from './metrics.ts'
import { SignInError, looksSigned, type IdTokenVerifier, type SignedIn } from './signin.ts'
import type { Sources } from './sources.ts'

export type Surface = 'session' | 'machine'

export interface AppEnv {
  Bindings: { surface: Surface }
  Variables: {
    identity: Identity
    /** What a handler adds to the activity row its route writes. */
    audit?: Record<string, unknown>
    /** Where the caller is, as the trusted proxy header says (`client-address.ts`). */
    address?: string
  }
}

/** The header the login proxy passes the person's access token for the hub in, beside their ID token. */
const ACCESS_TOKEN_HEADER = 'x-forwarded-access-token'

/** Where a caller without a working token is sent to learn the API. */
const SPEC = '/v1/openapi.json'

const nobody = { admin: false, roles: [], permissions: [] }

/** What a run's own credential starts with (`RUN_TOKEN_PREFIX` in `actions.ts`). */
const RUN_TOKEN = 'orr_run_'
/** The routes a run's own credential opens, for its own run: the report, and the read of the run. */
const RUN_ROUTES = /^\/v1\/action-runs\/([^/]+)(\/report)?$/
/** The name every run's job calls under: one name, so nothing that counts callers grows with the runs. */
export const RUN_JOB = 'a run\'s own job'

export function authenticate(config: Config, sources: Sources, access: Access, log: Logger, idTokens?: IdTokenVerifier, runOf?: (token: string) => Promise<string | null>): MiddlewareHandler<AppEnv> {
  const adminGroups = split(config.ROLE_GROUP_ADMIN)
  const userGroups = split(config.ROLE_GROUP_USER)
  const warned = new Set<string>()
  /** The people whose access token beside the session was left out, by why, so the log says it once. */
  const unusable = new Set<string>()
  /** On the session port with an issuer set, only the signed ID token says who the person is. */
  const verified = Boolean(idTokens) && !config.AUTH_SESSION_HEADERS
  /** A signed-in person, by the roles their token gives them: an Identity, or the answer that refuses them. */
  const admit = async (c: Context<AppEnv>, person: SignedIn): Promise<Identity | Response> => {
    const { email, groups } = person
    const admin = adminGroups.some((g) => groups.includes(g))
    if (!admin && !userGroups.some((g) => groups.includes(g))) {
      if (!warned.has(email)) {
        warned.add(email)
        log.warn('signed-in person refused: the login proxy gave them neither the admin nor the user claim', { user: email, groups, surface: c.env.surface })
      }
      recordAuth(c.env.surface, 'refused')
      return c.json({ error: 'You are signed in, but you have not been given access to this hub' }, 403)
    }
    const user = await access.seen(email, admin)
    recordAuth(c.env.surface, 'ok')
    return { kind: 'user', name: user.email, admin, roles: admin ? [ADMIN_ROLE, ...user.roles] : user.roles, permissions: admin ? PERMISSION_IDS : access.permissionsOf(user.roles) }
  }
  /**
   * The access token for the hub the login proxy passes beside the ID token, when it is this person's. It never says
   * who is calling: the ID token did. It is only what the hub trades to call another API as them, so one that does
   * not verify, or names someone else, is left out and said in the log.
   */
  const ownToken = async (c: Context<AppEnv>, person: string): Promise<{ token: string } | { stale: true } | null> => {
    const token = c.req.header(ACCESS_TOKEN_HEADER)?.trim()
    if (!token || !verified || !idTokens?.verifyAccess) return null
    // A login proxy that refreshes a session may pass a token for something else on every request until the person
    // signs in again, so each reason is said once a person, with what the token says it is for.
    const leftOut = (why: string, reason?: string) => {
      if (unusable.has(`${person}\n${why}`)) return
      unusable.add(`${person}\n${why}`)
      log.warn(`access token beside the session left out: ${why}`, { user: person, path: c.req.path, ...(reason ? { reason } : {}), ...unverifiedShape(token) })
    }
    try {
      const named = await idTokens.verifyAccess(token)
      if (named.email.toLowerCase() === person.toLowerCase()) return { token }
      leftOut('it names someone else')
    } catch (error) {
      if (!(error instanceof SignInError)) throw error
      leftOut('it did not verify', error.message)
    }
    return { stale: true }
  }
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header?.toLowerCase().startsWith('bearer ') && !(verified && c.env.surface === 'session')) {
      const token = header.slice(7).trim()
      // On the machine port a signed token is a person's, given to an app that acts for them; the hub's own tokens never look like one.
      if (c.env.surface === 'machine' && idTokens?.verifyAccess && looksSigned(token)) {
        let person: SignedIn
        try {
          person = await idTokens.verifyAccess(token)
        } catch (error) {
          if (!(error instanceof SignInError)) throw error
          log.warn('rejected access token', { path: c.req.path, reason: error.message })
          recordAuth(c.env.surface, 'refused')
          return c.json({ error: 'Unknown token', docs: SPEC }, 401)
        }
        const admitted = await admit(c, person)
        if (admitted instanceof Response) return admitted
        log.info('person acting through an app', { user: admitted.name, path: c.req.path })
        c.set('identity', admitted)
        // The token that says who they are is also what the hub may trade to call another API as them.
        return askingAs(admitted.name, token, next)
      }
      // A run's own credential is no hub token. It opens two routes, on the machine port, for the one run that holds it:
      // the report and the read of that run. Anywhere else it is an unknown token, so it never reaches a view.
      if (token.startsWith(RUN_TOKEN)) {
        const route = c.env.surface === 'machine' ? RUN_ROUTES.exec(c.req.path) : null
        const opens = route && (route[2] ? c.req.method === 'POST' : c.req.method === 'GET')
        const run = opens && runOf ? await runOf(token) : null
        if (!route || !run || run !== decodeURIComponent(route[1]!)) {
          log.warn('rejected run credential', { surface: c.env.surface, method: c.req.method, path: c.req.path, reason: !opens ? 'it opens only the report and the read of its own run' : !run ? 'no run under way holds it' : 'it is another run\'s' })
          recordAuth(c.env.surface, 'refused')
          return c.json({ error: 'Unknown token', docs: SPEC }, 401)
        }
        log.debug('run credential let in for its own run', { run, method: c.req.method })
        c.set('identity', { ...nobody, kind: 'run', name: RUN_JOB, run, permissions: ['actions.report'] })
        recordAuth(c.env.surface, 'ok')
        return next()
      }
      const found = await sources.authenticate(token)
      if (!found) {
        log.warn('rejected bearer token', { surface: c.env.surface, path: c.req.path })
        recordAuth(c.env.surface, 'refused')
        return c.json({ error: 'Unknown token', docs: SPEC }, 401)
      }
      // A source holds no permission but the one an admin grants it on the source itself: defining actions.
      if (found.kind === 'source') c.set('identity', { ...nobody, kind: 'source', name: found.name, source: found.source!, permissions: sources.get(found.source!)?.actions ? ['actions.manage'] : [] })
      else if (found.kind === 'personal') {
        // A personal token is its person's agent (ORY-2002): their roles and what they may see, with the agent, by the token's name, as who asks.
        const user = access.find(found.owner ?? '')
        if (!user) {
          log.warn('rejected personal token: its person is no longer here', { token: found.id, owner: found.owner })
          recordAuth(c.env.surface, 'revoked')
          return c.json({ error: 'This token belongs to someone who is no longer here', docs: SPEC }, 401)
        }
        c.set('identity', { kind: 'user', name: user.email, admin: user.admin, roles: user.admin ? [ADMIN_ROLE, ...user.roles] : user.roles, permissions: user.admin ? PERMISSION_IDS : access.permissionsOf(user.roles), token: found.id, agent: found.name })
        await access.touch(user.email)
      } else c.set('identity', accessTokenIdentity(found, access))
      recordAuth(c.env.surface, 'ok')
      return next()
    }
    if (c.env.surface === 'session') {
      if (config.AUTH_MODE === 'none') {
        c.set('identity', LOCAL)
        recordAuth(c.env.surface, 'ok')
        return next()
      }
      let person: SignedIn | undefined
      if (idTokens && verified) {
        const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
        if (!token) {
          recordAuth(c.env.surface, 'refused')
          return c.json({ error: 'Not signed in' }, 401)
        }
        try {
          person = await idTokens.verify(token)
        } catch (error) {
          if (!(error instanceof SignInError)) throw error
          log.warn('session refused: the ID token did not verify', { path: c.req.path, reason: error.message })
          recordAuth(c.env.surface, 'refused')
          return c.json({ error: 'Not signed in' }, 401)
        }
      } else {
        const email = (c.req.header('x-forwarded-email') ?? c.req.header('x-forwarded-user'))?.trim().toLowerCase()
        if (email) person = { email, groups: split(c.req.header('x-forwarded-groups') ?? '') }
      }
      if (!person) {
        recordAuth(c.env.surface, 'refused')
        return c.json({ error: 'Not signed in' }, 401)
      }
      const admitted = await admit(c, person)
      if (admitted instanceof Response) return admitted
      c.set('identity', admitted)
      const theirs = await ownToken(c, admitted.name)
      if (!theirs) return next()
      return 'token' in theirs ? askingAs(admitted.name, theirs.token, next) : signInStale(admitted.name, next)
    }
    c.set('identity', { ...nobody, kind: 'anonymous', name: 'anonymous' })
    recordAuth(c.env.surface, 'refused')
    return c.json({ error: 'A bearer token is required: send Authorization: Bearer <token>', docs: SPEC }, 401)
  }
}

/** Everything a request records in the activity log is recorded as its caller: while an admin views as someone, the admin. */
export const acting: MiddlewareHandler<AppEnv> = (c, next) => {
  const id = c.get('identity')
  return actingAs({ kind: actorKind(id), name: id.kind === 'source' ? id.source! : (id.viewAs?.by ?? id.name), ...(id.agent ? { agent: id.agent } : {}), ...(c.req.path === '/mcp' ? { door: 'mcp' as const } : {}) }, next)
}

/** The kind of actor a caller is recorded as: a run's own job calls with a token, and a caller nobody knows is the hub's own row. */
function actorKind(id: Identity): 'hub' | 'user' | 'token' | 'source' {
  return id.kind === 'anonymous' ? 'hub' : id.kind === 'run' ? 'token' : id.kind
}

/** The header an admin sends to see the hub as another person. A GET may carry it as this query parameter instead, for what cannot set a header: the event stream and a download link. */
export const VIEW_AS_HEADER = 'x-orrery-view-as'
export const VIEW_AS_QUERY = 'view_as'

/**
 * Lets a signed-in admin see the hub as another person, for checking that the
 * access rules do what was meant. The identity from here on is the other
 * person's, so the view, the permissions, and the previews are theirs; the
 * admin stays on `viewAs` so the activity log and the logs name who is really
 * calling. It is for the session surface and a real admin only: never a token,
 * never the machine port. It only reads: whatever would change something is
 * refused, as is the caller's own token list.
 */
/** A person as the hub would know them signed in: their roles and what those roles grant. */
export function identityOf(user: User, access: Access): Identity {
  return { kind: 'user', name: user.email, admin: user.admin, roles: user.admin ? [ADMIN_ROLE, ...user.roles] : user.roles, permissions: user.admin ? PERMISSION_IDS : access.permissionsOf(user.roles) }
}

/** An access token as the hub knows it on the machine port: its name, and what its role grants. */
export function accessTokenIdentity(token: { name: string; role: string | null }, access: Access): Identity {
  return { kind: 'token', name: token.name, admin: token.role === ADMIN_ROLE, roles: token.role ? [token.role] : [], permissions: access.permissionsOf(token.role ? [token.role] : []) }
}

/** The routes that take a POST only because what they read is too long for an address: they change nothing, so viewing as someone may call them. */
const READ_POSTS: RegExp[] = [/^\/v1\/model\/layout\/place$/, /^\/v1\/query$/, /^\/v1\/query\/export$/, /^\/v1\/actions\/[^/]+\/batch\/preview$/, /^\/v1\/reports\/check$/]

/** Whether a request only reads: a GET, a HEAD, or one of the reads sent as a POST. */
const onlyReads = (method: string, path: string) => method === 'GET' || method === 'HEAD' || (method === 'POST' && READ_POSTS.some((r) => r.test(path)))

/** Who every request on the session port is when the hub asks nobody to sign in: its one local admin. */
export const LOCAL: Identity = { kind: 'user', name: 'local', admin: true, roles: [ADMIN_ROLE], permissions: PERMISSION_IDS }

export function viewingAs(db: Db, access: Access, log: Logger): MiddlewareHandler<AppEnv> {
  const refuse = async (c: Context<AppEnv>, real: Identity, given: string, status: 403 | 404, error: string, reason: string) => {
    const detail = { viewAs: given, reason, surface: c.env.surface, method: c.req.method, path: c.req.path }
    await actingAs({ kind: actorKind(real), name: real.kind === 'source' ? real.source! : real.name }, () => record(db, 'access.refused', null, null, null, detail, new Date(), 'refused'))
    log.warn('view as refused', { actor: real.name, ...detail })
    return c.json({ error }, status)
  }
  return async (c, next) => {
    // Starting to view is a request made as the admin: it checks the person and writes the row.
    if (c.req.path === '/v1/view-as') return next()
    const given = (c.req.header(VIEW_AS_HEADER) ?? (c.req.method === 'GET' ? c.req.query(VIEW_AS_QUERY) : undefined))?.trim()
    if (!given) return next()
    const real = c.get('identity')
    if (c.env.surface !== 'session' || real.kind !== 'user' || real.token) return refuse(c, real, given, 403, 'Viewing as someone else is for a signed-in admin, not a token', 'not a signed-in person on the session surface')
    if (!real.admin) return refuse(c, real, given, 403, 'Only an admin can view the hub as someone else', 'not an admin')
    const user = access.find(given)
    if (!user) return refuse(c, real, given, 404, `Nobody called "${given}" is here`, 'unknown person')
    c.set('identity', { ...identityOf(user, access), viewAs: { by: real.name } })
    if (!onlyReads(c.req.method, c.req.path)) return refuse(c, real, given, 403, 'Viewing as someone else is read-only: exit to make a change', 'a change while viewing as someone else')
    if (c.req.path.startsWith('/v1/me/')) return refuse(c, real, given, 403, 'Your own tokens are not shown while viewing as someone else', 'own tokens while viewing as someone else')
    log.debug('viewing as', { actor: real.name, viewing: user.email, path: c.req.path })
    return next()
  }
}

/**
 * The routes under /api a source token may call: putting a custom icon, as a
 * forge reader does for a repository's logo, putting or removing an action,
 * which its route refuses without the source's `actions` grant, and putting
 * or removing a scorecard, which its route refuses without `scorecards`.
 */
const SOURCE_API: { methods: string[]; path: RegExp }[] = [
  { methods: ['PUT'], path: /^\/v1\/icons\/[^/]+$/ },
  { methods: ['PUT', 'DELETE'], path: /^\/v1\/actions\/(?!layout$)[^/]+$/ },
  { methods: ['PUT', 'DELETE'], path: /^\/v1\/scorecards\/[^/]+$/ },
]

/** Reading is for people and access tokens. A source token writes and nothing else. */
export const requireReader: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kind = c.get('identity').kind
  if (kind === 'source' && SOURCE_API.some((r) => r.methods.includes(c.req.method) && r.path.test(c.req.path))) return next()
  // A run's own job reached here through the only two routes its credential opens (`authenticate`).
  if (kind === 'run') return next()
  if (kind !== 'user' && kind !== 'token') return c.json({ error: 'This needs a person or an access token' }, 403)
  return next()
}

export const requireSource: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('identity').kind !== 'source') return c.json({ error: 'This needs a source token' }, 403)
  return next()
}

export interface Guards {
  /**
   * Guards a route with a permission, and writes the route's activity. A
   * caller without the permission is refused, and the refusal is recorded.
   * A null permission gates nothing: the handler decides, and the route is
   * still recorded.
   * With a `kind`, a request the hub turns down is recorded as failed, and one
   * that succeeds is recorded too unless `deep` says whatever the handler
   * calls records it with more to say.
   */
  allow(permission: Permission | null, kind?: ChangeKind, opts?: { deep?: boolean }): MiddlewareHandler<AppEnv>
  /** Records a machine write the hub turned down. */
  ingest: MiddlewareHandler<AppEnv>
}

export function guards(db: Db, log: Logger): Guards {
  const about = (c: Context<AppEnv>, kind: string) => {
    const p = c.req.param() as Record<string, string>
    const { blueprint, key, ...rest } = p
    return { ref: { blueprint: blueprint ?? (kind.startsWith('blueprint.') || kind.startsWith('grid.') ? p.id : undefined), key }, rest }
  }
  return {
    allow: (permission, kind, opts = {}) => async (c, next) => {
      const id = c.get('identity')
      if (permission && !can(id, permission)) {
        const { ref, rest } = about(c, kind ?? '')
        await record(db, 'access.refused', ref, null, null, { ...rest, permission, method: c.req.method, path: c.req.path }, new Date(), 'refused')
        log.warn('refused: permission not held', { actor: id.name, permission, method: c.req.method, path: c.req.path })
        return c.json({ error: `This needs the "${permission}" permission: ${PERMISSIONS[permission].toLowerCase()}` }, 403)
      }
      await next()
      if (!kind) return
      const { ref, rest } = about(c, kind)
      if (c.res.status >= 400) await record(db, kind, ref, null, null, { ...rest, status: c.res.status, error: c.error?.message }, new Date(), 'failed')
      else if (!opts.deep) await record(db, kind, ref, null, null, { ...rest, ...c.get('audit') })
    },
    ingest: async (c, next) => {
      await next()
      if (c.req.method === 'GET' || c.res.status < 400) return
      await record(db, 'ingest.failed', null, c.get('identity').source ?? null, null, { method: c.req.method, path: c.req.path, status: c.res.status, error: c.error?.message }, new Date(), 'failed')
    },
  }
}

export function actor(c: Context<AppEnv>): string {
  return c.get('identity').name
}

/**
 * What a token that did not hold says it is for, read without trusting it, for the log: its audience and issuer,
 * and whether its header carries a nonce, which only a token for the issuer's own APIs does. Never the token.
 */
function unverifiedShape(token: string): Record<string, unknown> {
  try {
    const { aud, iss } = decodeJwt(token)
    return { audience: aud ?? null, issuer: iss ?? null, nonce: 'nonce' in decodeProtectedHeader(token) }
  } catch {
    return { shape: 'not a JWT' }
  }
}

function split(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
