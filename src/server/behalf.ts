// Calling another API as the person who asked. The hub holds no authority
// there: it trades the access token the person's sign-in gave the hub for one
// the issuer makes for that API, in their name (OAuth's on-behalf-of grant),
// proving itself with the pod's workload identity, never a secret. The API
// then sees the person, decides as it would for them anywhere, and logs them.
//
// A run that waits its turn after the approval that started it keeps the
// issuer's refresh-capable grant from that approval, sealed, and asks for a
// fresh token with it when its turn comes (`hold`). It is taken off the run as
// the run is handed on, so a retry or a schedule never finds one.
//
// Where a token may go is the deployment's to say, never an action's: an
// action names a delegate from `AUTH_DELEGATES`, and the hub sends the token
// only to a URL that delegate lists.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { fetchTimed } from './metrics.ts'
import type { SecretBox } from './secrets.ts'
import type { WorkloadIdentity } from './workload.ts'

/** One API the hub may call as a person: the scope asked of the issuer, and the URLs its token may be sent to. */
export interface Delegate {
  scope: string
  urls: string[]
}

/** A hub on a developer's machine may call an API beside it. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//

const delegatesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.object({ scope: z.string().min(1), urls: z.array(z.string().url().refine((u) => u.startsWith('https://') || LOOPBACK.test(u), 'a delegate is called over https')).min(1) }))

/** Reads `AUTH_DELEGATES`: a JSON object of delegates by name. */
export function parseDelegates(text: string | undefined): Record<string, Delegate> {
  if (!text?.trim()) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('AUTH_DELEGATES is not JSON')
  }
  const parsed = delegatesSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`AUTH_DELEGATES: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

/** The person a request is from, with the token their sign-in gave the hub. */
interface Asking {
  person: string
  assertion: string
}

const asking = new AsyncLocalStorage<Asking>()

/** Runs `fn` holding the person's own access token for the hub: what is asked on their behalf inside it is asked with it. */
export function askingAs<T>(person: string, assertion: string, fn: () => T): T {
  return asking.run({ person, assertion }, fn)
}

/** The person whose own token the request under way holds, or null when it holds none: a token the hub made, a schedule, a retry. */
export function askingFor(): string | null {
  return asking.getStore()?.person ?? null
}

/** The people whose request carried a token for the hub beside their sign-in that did not hold: a fresh sign-in gives them one that does. */
const stale = new AsyncLocalStorage<string>()

/** Runs `fn` for a signed-in person whose login proxy passed a token for the hub that did not verify or named someone else. */
export function signInStale<T>(person: string, fn: () => T): T {
  return stale.run(person, fn)
}

/**
 * Refuses, as `SignInAgain`, what needs `person`'s own token for the hub when
 * the request carries none that holds but a fresh sign-in would give one.
 * Does nothing otherwise: a request that carries their token, or one that
 * never could (a token the hub made, an agent), is the caller's to judge.
 */
export function needsOwnSignIn(person: string, what: string): void {
  if (askingFor()?.toLowerCase() === person.toLowerCase()) return
  if (stale.getStore()?.toLowerCase() !== person.toLowerCase()) return
  throw new SignInAgain(`${what} needs your own sign-in, and the one your browser holds has lapsed: sign in again, then do it once more`)
}

/** A request the person's own fresh sign-in would let through: answered 401 with where the login proxy starts one. */
export class SignInAgain extends Error {}

/** Why the hub cannot call as a person. The message is said in the run's log. */
export class BehalfError extends Error {}

/** A token is not handed out this close to its end. */
const MARGIN_MS = 60_000

/** What a run holds from the signed-in approval that started it: whose it is, the delegate it is for, and the issuer's refresh-capable grant. */
interface Held {
  person: string
  name: string
  refresh: string
}

/** What the issuer answers a token request with. */
interface Issued {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

const key = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex')

export class Behalf {
  private readonly kept = new Map<string, { token: string; until: number }>()
  /** The grant one request already holds, by delegate and assertion, so one approval of many runs asks the issuer once. */
  private readonly held = new Map<string, { sealed: string; until: number }>()

  private readonly delegates: Record<string, Delegate>
  /** The hub's own app at the issuer, signed in by workload identity; null where the pod has none. */
  private readonly identity: WorkloadIdentity | null
  /** Seals a grant before a run holds it in the database. */
  private readonly box: SecretBox
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>
  private readonly now: () => number

  constructor(delegates: Record<string, Delegate>, identity: WorkloadIdentity | null, box: SecretBox, fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetchTimed('issuer', url, init), now: () => number = Date.now) {
    this.delegates = delegates
    this.identity = identity
    this.box = box
    this.fetchImpl = fetchImpl
    this.now = now
  }

  /** The names an action may give as `onBehalf`. */
  names(): string[] {
    return Object.keys(this.delegates)
  }

  /**
   * A grant a run keeps from `person`'s own signed-in approval, sealed: what
   * lets the hub ask for a fresh token in their name when the run's turn
   * comes, however long it waits. It is the issuer's refresh-capable grant,
   * never an access token alone, and lasts as long as the issuer lets it.
   * Null when the issuer gives none that lasts. Refused, as `tokenFor` is,
   * unless the request under way is that person's own.
   */
  async hold(name: string, person: string): Promise<string | null> {
    const delegate = this.delegate(name)
    const from = asking.getStore()
    if (!from) throw new BehalfError(`it runs as ${person}, and only their own signed-in approval can keep the right to run as them`)
    if (from.person.toLowerCase() !== person.toLowerCase()) throw new BehalfError(`it runs as ${person}, and this request is from ${from.person}`)
    const at = key(name, from.assertion)
    const had = this.held.get(at)
    if (had && this.now() < had.until) return had.sealed
    const out = await this.ask(name, person, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of', assertion: from.assertion, scope: `${delegate.scope} offline_access` })
    const until = this.keep(at, out)
    if (!out.refresh_token) return null
    // A run handed on inside this request redeems its grant from what was just issued.
    this.keep(key(name, 'refresh', out.refresh_token), out)
    const sealed = this.box.seal(JSON.stringify({ person, name, refresh: out.refresh_token } satisfies Held))
    this.held.set(at, { sealed, until })
    return sealed
  }

  /**
   * A token for the delegate's API in `person`'s name, to send to `url`.
   * Refused unless the request under way is that person's own and carries
   * their token, or the run holds a grant from their own signed-in approval
   * (`held`, from `hold`), and the delegate lists the URL.
   */
  async tokenFor(name: string, person: string, url: string, held?: string | null): Promise<string> {
    const delegate = this.delegate(name)
    if (!delegate.urls.some((prefix) => url.startsWith(prefix))) throw new BehalfError(`"${name}" may not be called at ${new URL(url).origin}`)
    // A grant the run holds comes first: the request it runs inside may be an approval long over, whose token has ended.
    if (held) return this.redeem(name, person, held)
    const from = asking.getStore()
    if (from && from.person.toLowerCase() === person.toLowerCase()) {
      const at = key(name, from.assertion)
      const kept = this.kept.get(at)
      if (kept && this.now() < kept.until) return kept.token
      const out = await this.ask(name, person, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of', assertion: from.assertion, scope: delegate.scope })
      this.keep(at, out)
      return out.access_token
    }
    if (from) throw new BehalfError(`it runs as ${person}, and this request is from ${from.person}`)
    throw new BehalfError(`it runs as ${person}, and only their own signed-in request, or their own signed-in approval, can start it: not a schedule, a retry, or a token the hub made`)
  }

  /** A fresh token from the grant a run holds, for the person and the delegate it was kept for alone. */
  private async redeem(name: string, person: string, sealed: string): Promise<string> {
    let grant: Held
    try {
      grant = JSON.parse(this.box.open(sealed)) as Held
    } catch {
      throw new BehalfError(`it runs as ${person}, and the grant kept from their approval cannot be read: this hub's secret key is not the one that sealed it`)
    }
    if (grant.person.toLowerCase() !== person.toLowerCase() || grant.name !== name) throw new BehalfError(`it runs as ${person}, and the grant it holds is ${grant.person}'s, for "${grant.name}"`)
    const at = key(name, 'refresh', grant.refresh)
    const kept = this.kept.get(at)
    if (kept && this.now() < kept.until) return kept.token
    const out = await this.ask(name, person, { grant_type: 'refresh_token', refresh_token: grant.refresh, scope: this.delegate(name).scope })
    this.keep(at, out)
    return out.access_token
  }

  private delegate(name: string): Delegate {
    const delegate = this.delegates[name]
    if (!delegate) throw new BehalfError(`this hub is not set up to call "${name}" as a person`)
    if (!this.identity) throw new BehalfError('this hub has no workload identity to ask the issuer with')
    return delegate
  }

  /** Keeps an issued token until shortly before it ends, and lets go of what has ended. Says until when. */
  private keep(at: string, out: Issued): number {
    const now = this.now()
    for (const map of [this.kept, this.held]) for (const [k, v] of map) if (now >= v.until) map.delete(k)
    const until = now + (out.expires_in ?? 3600) * 1000 - MARGIN_MS
    this.kept.set(at, { token: out.access_token, until })
    return until
  }

  /** One token request to the issuer, as the hub's own app proven by workload identity. */
  private async ask(name: string, person: string, grant: Record<string, string>): Promise<Issued> {
    const identity = this.identity!
    const body = new URLSearchParams({
      ...grant,
      client_id: identity.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: (await readFile(identity.tokenFile, 'utf8')).trim(),
    })
    const res = await this.fetchImpl(`${identity.authorityHost.replace(/\/$/, '')}/${identity.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) })
    const out = (await res.json().catch(() => ({}))) as Partial<Issued> & { error?: string; error_description?: string }
    // The issuer's first line says why; the rest is trace ids.
    if (!out.access_token) throw new BehalfError(`the issuer gave no token for "${name}" as ${person}: ${(out.error_description ?? out.error ?? String(res.status)).split('\n')[0]!.slice(0, 300)}`)
    return { access_token: out.access_token, ...(out.refresh_token ? { refresh_token: out.refresh_token } : {}), ...(out.expires_in ? { expires_in: out.expires_in } : {}) }
  }
}
