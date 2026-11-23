import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { clientConfig, connectionOf } from './db.ts'
import { identityFromEnv, tokenSource } from './workload.ts'

const tokenFile = join(mkdtempSync(join(tmpdir(), 'workload-')), 'token')
writeFileSync(tokenFile, 'projected-token\n')
const id = { tenantId: 'tenant', clientId: 'client', tokenFile, authorityHost: 'https://login.example.org/' }

function issuer(expiresIn = 3600) {
  const calls: { url: string; body: URLSearchParams }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) })
    return new Response(JSON.stringify({ access_token: `token-${calls.length}`, expires_in: expiresIn }))
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('workload identity', () => {
  it('trades the service account token for an access token to the scope', async () => {
    const { calls, fetchImpl } = issuer()
    const token = await tokenSource(id, 'https://db.example/.default', fetchImpl)()
    expect(token).toBe('token-1')
    expect(calls[0]!.url).toBe('https://login.example.org/tenant/oauth2/v2.0/token')
    expect(calls[0]!.body.get('client_assertion')).toBe('projected-token')
    expect(calls[0]!.body.get('scope')).toBe('https://db.example/.default')
    expect(calls[0]!.body.get('client_id')).toBe('client')
  })

  it('keeps the token until shortly before it expires, then asks again', async () => {
    const { calls, fetchImpl } = issuer(3600)
    let clock = 0
    const token = tokenSource(id, 'scope', fetchImpl, () => clock)
    await Promise.all([token(), token()])
    expect(calls).toHaveLength(1)
    clock = 54 * 60_000
    expect(await token()).toBe('token-1')
    clock = 56 * 60_000
    expect(await token()).toBe('token-2')
  })

  it('refuses to start without the identity the pod should have', () => {
    expect(() => identityFromEnv({})).toThrow(/AZURE_TENANT_ID/)
  })

  it('signs in with the URL alone unless asked to use the identity', async () => {
    expect(connectionOf({ DATABASE_URL: 'postgres://a@b/c', DATABASE_AUTH: 'password' }).password).toBeUndefined()
    const azure = connectionOf({ DATABASE_URL: 'postgres://a@b/c', DATABASE_AUTH: 'azure' }, { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_FEDERATED_TOKEN_FILE: tokenFile })
    expect(typeof azure.password).toBe('function')
  })

  it('opens the database with the token as the password', async () => {
    const password = async () => 'token'
    const client = new pg.Client(clientConfig({ url: 'postgres://orrery@db.example:5432/orrery?sslmode=require', password }))
    expect(client.password).toBe(password)
    expect(client.user).toBe('orrery')
    expect(client.host).toBe('db.example')
    expect(client.database).toBe('orrery')
    expect(client.ssl).toBeTruthy()
  })
})
