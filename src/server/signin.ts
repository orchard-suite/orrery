// The person behind a request, read from a token the identity provider
// signed. On the session port it is the ID token the login proxy passes on, so
// a caller that reaches the port around the proxy cannot make one. On the
// machine port it is an access token another app got for the person to call
// the hub: the person signed in to that app, and the token names the scope it
// was given. Nobody can make either without the issuer's key.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import { fetchTimed } from './metrics.ts'

export interface SignedIn {
  email: string
  groups: string[]
}

export class SignInError extends Error {}

export interface IdTokenVerifier {
  /** The person an ID token names. A token that carries a scope is an access token, and is refused here. */
  verify(token: string): Promise<SignedIn>
  /** The person an access token names, when it carries the hub's scope; undefined when no scope is set. */
  verifyAccess?(token: string): Promise<SignedIn>
}

/**
 * Verifies tokens from one issuer for one audience. `keys` is the issuer's
 * key set; by default it is fetched from the issuer's discovery document and
 * cached by `jose`. With `scope`, it also takes access tokens that carry it.
 */
export function idTokenVerifier(issuer: string, audience: string, keys?: JWTVerifyGetKey, scope?: string): IdTokenVerifier {
  let resolved: Promise<JWTVerifyGetKey> | undefined
  const keySet = () => (resolved ??= keys ? Promise.resolve(keys) : discover(issuer))
  const read = async (token: string, what: string): Promise<{ payload: JWTPayload; person: SignedIn }> => {
    const { payload } = await jwtVerify(token, await keySet(), { issuer, audience }).catch((error: Error) => {
      throw new SignInError(`${what} refused: ${error.message}`)
    })
    const email = emailOf(payload)
    if (!email) throw new SignInError(`${what} names no email or user`)
    return { payload, person: { email, groups: groupsOf(payload) } }
  }
  const verifier: IdTokenVerifier = {
    async verify(token) {
      const { payload, person } = await read(token, 'ID token')
      if (scopesOf(payload).length) throw new SignInError('ID token refused: it is an access token')
      return person
    },
  }
  if (scope) {
    verifier.verifyAccess = async (token) => {
      const { payload, person } = await read(token, 'access token')
      // An ID token carries no scope, so it never passes here: only a token the issuer gave an app to call the hub does.
      if (!scopesOf(payload).includes(scope)) throw new SignInError(`access token refused: it does not carry the ${scope} scope`)
      return person
    }
  }
  return verifier
}

/** The delegated scopes an access token carries; an ID token has none. */
function scopesOf(payload: JWTPayload): string[] {
  return typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : []
}

/** Whether a bearer token is shaped like a signed JWT rather than one the hub issued. */
export function looksSigned(token: string): boolean {
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token)
}

async function discover(issuer: string): Promise<JWTVerifyGetKey> {
  const res = await fetchTimed('issuer', `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new SignInError(`issuer discovery failed: ${res.status}`)
  const { jwks_uri } = (await res.json()) as { jwks_uri?: string }
  if (!jwks_uri) throw new SignInError('issuer discovery names no jwks_uri')
  return createRemoteJWKSet(new URL(jwks_uri))
}

function emailOf(payload: JWTPayload): string | undefined {
  for (const claim of ['email', 'preferred_username', 'upn']) {
    const value = payload[claim]
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
  }
  return undefined
}

/** App roles and groups both decide access; the proxy's groups claim is whichever the issuer puts the person's roles in. */
function groupsOf(payload: JWTPayload): string[] {
  const out: string[] = []
  for (const claim of ['roles', 'groups']) {
    const value = payload[claim]
    if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  return out
}
