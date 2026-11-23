import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { authenticate } from './auth.ts'
import type { AppEnv } from './auth.ts'
import { createLogger } from './log.ts'
import { idTokenVerifier } from './signin.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const ISSUER = 'https://login.example.com/tenant/v2.0'
const AUDIENCE = 'orrery-login-proxy'

let hub: Hub
let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string }) => Promise<string>
const SCOPE = 'access_as_user'
const machine = (headers: Record<string, string>) => hub.app.request('/v1/whoami', { headers }, { surface: 'machine' })
let foreign: string
let jwk: JWK

const session = (headers: Record<string, string>) => hub.app.request('/v1/whoami', { headers }, { surface: 'session' })

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(privateKey)
  const other = await generateKeyPair('RS256')
  foreign = await new SignJWT({ email: 'admin@example.com', roles: ['Admin'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(other.privateKey)
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, AUTH_API_SCOPE: SCOPE })
  hub = await createHub(config, 'test', { reset: true, idTokens: idTokenVerifier(ISSUER, AUDIENCE, createLocalJWKSet({ keys: [jwk] }), SCOPE) })
})

afterAll(async () => {
  await hub.close()
})

describe('signing in with an ID token', () => {
  it('takes the person and their roles from a token the issuer signed', async () => {
    const res = await session({ authorization: `Bearer ${await sign({ email: 'Admin@Example.com', roles: ['Admin'] })}` })
    expect(res.status).toBe(200)
    const { identity } = (await res.json()) as WhoAmIResponse
    expect(identity).toMatchObject({ kind: 'user', name: 'admin@example.com', admin: true })
  })

  it('ignores identity headers, so a caller around the proxy cannot claim to be someone', async () => {
    expect((await session({ 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin' })).status).toBe(401)
    const res = await session({ authorization: `Bearer ${await sign({ email: 'dev@example.com', roles: ['User'] })}`, 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin' })
    const { identity } = (await res.json()) as WhoAmIResponse
    expect(identity).toMatchObject({ name: 'dev@example.com', admin: false })
  })

  it('refuses a token signed by another key, for another audience or issuer, or expired', async () => {
    expect((await session({ authorization: `Bearer ${foreign}` })).status).toBe(401)
    expect((await session({ authorization: `Bearer ${await sign({ email: 'a@example.com', roles: ['Admin'] }, { audience: 'someone-else' })}` })).status).toBe(401)
    expect((await session({ authorization: `Bearer ${await sign({ email: 'a@example.com', roles: ['Admin'] }, { issuer: 'https://evil.example.com' })}` })).status).toBe(401)
    expect((await session({ authorization: `Bearer ${await sign({ email: 'a@example.com', roles: ['Admin'] }, { expiresIn: '-1m' })}` })).status).toBe(401)
  })

  it('refuses a signed-in person with neither role', async () => {
    expect((await session({ authorization: `Bearer ${await sign({ email: 'stranger@example.com', roles: ['Sales'] })}` })).status).toBe(403)
  })

  it('still takes an access token on the machine port', async () => {
    const res = await hub.app.request('/v1/whoami', { headers: { 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin' } }, { surface: 'machine' })
    expect(res.status).toBe(401)
  })
})

describe('acting as a person through another app', () => {
  it('takes an access token with the hub scope on the machine port as the person it names', async () => {
    const res = await machine({ authorization: `Bearer ${await sign({ preferred_username: 'Dev@Example.com', roles: ['User'], scp: SCOPE })}` })
    expect(res.status).toBe(200)
    const { identity } = (await res.json()) as WhoAmIResponse
    expect(identity).toMatchObject({ kind: 'user', name: 'dev@example.com', admin: false })
  })

  it('refuses an ID token, a token without the scope, and one from another key or audience', async () => {
    expect((await machine({ authorization: `Bearer ${await sign({ email: 'admin@example.com', roles: ['Admin'] })}` })).status).toBe(401)
    expect((await machine({ authorization: `Bearer ${await sign({ email: 'admin@example.com', roles: ['Admin'], scp: 'User.Read' })}` })).status).toBe(401)
    expect((await machine({ authorization: `Bearer ${await sign({ email: 'a@example.com', roles: ['Admin'], scp: SCOPE }, { audience: 'someone-else' })}` })).status).toBe(401)
    expect((await machine({ authorization: `Bearer ${foreign}` })).status).toBe(401)
  })

  it('refuses a person the token gives neither role', async () => {
    expect((await machine({ authorization: `Bearer ${await sign({ email: 'stranger@example.com', roles: ['Sales'], scp: SCOPE })}` })).status).toBe(403)
  })

  it('tells an app, with no token, where to sign a person in and for what scope', async () => {
    const res = await hub.app.request('/v1/sign-in', {}, { surface: 'machine' })
    expect(await res.json()).toEqual({ issuer: ISSUER, scope: `${AUDIENCE}/${SCOPE}` })
    expect((await hub.app.request('/v1/sign-in', {}, { surface: 'session' })).status).toBe(404)
  })

  it('tells an MCP client where to sign a person in, and points to it when /mcp refuses a call', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await hub.app.request(`https://hub.example.com${path}`, {}, { surface: 'machine' })
      expect(await res.json()).toEqual({ resource: 'https://hub.example.com/mcp', authorization_servers: [ISSUER], scopes_supported: [`${AUDIENCE}/${SCOPE}`], bearer_methods_supported: ['header'] })
      expect((await hub.app.request(path, {}, { surface: 'session' })).status).toBe(404)
    }
    const refused = await hub.app.request('https://hub.example.com/mcp', { method: 'POST' }, { surface: 'machine' })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource/mcp", scope="${AUDIENCE}/${SCOPE}"`)
    const signedIn = await hub.app.request('https://hub.example.com/mcp', { method: 'POST', headers: { authorization: `Bearer ${await sign({ preferred_username: 'dev@example.com', roles: ['User'], scp: SCOPE })}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, { surface: 'machine' })
    expect(signedIn.status).toBe(200)
    expect(signedIn.headers.get('www-authenticate')).toBeNull()
  })

  it('never takes an access token as a session sign-in', async () => {
    expect((await session({ authorization: `Bearer ${await sign({ email: 'admin@example.com', roles: ['Admin'], scp: SCOPE })}` })).status).toBe(401)
  })
})

describe('a front door that passes no ID token', () => {
  it('keeps the session port on the identity headers, and still takes an app\'s access token on the machine port', async () => {
    const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, AUTH_API_SCOPE: SCOPE, AUTH_SESSION_HEADERS: 'true' })
    const app = new Hono<AppEnv>()
    app.use('*', authenticate(config, hub.sources, hub.access, createLogger('test'), idTokenVerifier(ISSUER, AUDIENCE, createLocalJWKSet({ keys: [jwk] }), SCOPE)))
    app.get('/who', (c) => c.json(c.get('identity')))
    const fromDoor = await app.request('/who', { headers: { 'x-forwarded-email': 'Dev@Example.com', 'x-forwarded-groups': 'User' } }, { surface: 'session' })
    expect(fromDoor.status).toBe(200)
    expect(await fromDoor.json()).toMatchObject({ kind: 'user', name: 'dev@example.com' })
    const viaApp = await app.request('/who', { headers: { authorization: `Bearer ${await sign({ email: 'dev@example.com', roles: ['User'], scp: SCOPE })}` } }, { surface: 'machine' })
    expect(viaApp.status).toBe(200)
    expect(await viaApp.json()).toMatchObject({ kind: 'user', name: 'dev@example.com' })
  })
})
