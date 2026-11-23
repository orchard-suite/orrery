// The Azure workload identity the pod is given: its projected service account
// token, traded for an access token, never a secret.

import { readFile } from 'node:fs/promises'

export interface WorkloadIdentity {
  tenantId: string
  clientId: string
  tokenFile: string
  authorityHost: string
}

/** Reads the identity from the variables Azure workload identity sets on the pod. */
export function identityFromEnv(env: NodeJS.ProcessEnv): WorkloadIdentity {
  const tenantId = env.AZURE_TENANT_ID ?? ''
  const clientId = env.AZURE_CLIENT_ID ?? ''
  const tokenFile = env.AZURE_FEDERATED_TOKEN_FILE ?? ''
  if (!tenantId || !clientId || !tokenFile) throw new Error('AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_FEDERATED_TOKEN_FILE must be set')
  return { tenantId, clientId, tokenFile, authorityHost: env.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com/' }
}

/** A token is asked for again this long before it expires. */
const RENEW_MS = 5 * 60_000

/**
 * Returns a function that answers an access token for `scope`, kept until
 * shortly before it expires. The kubelet rotates the service account token,
 * so the file is read again on every exchange.
 */
export function tokenSource(id: WorkloadIdentity, scope: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): () => Promise<string> {
  let kept: { token: string; until: number } | null = null
  let pending: Promise<string> | null = null
  const exchange = async (): Promise<string> => {
    const assertion = (await readFile(id.tokenFile, 'utf8')).trim()
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id.clientId,
      scope,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    })
    const url = `${id.authorityHost.replace(/\/$/, '')}/${id.tenantId}/oauth2/v2.0/token`
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) })
    const out = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!out.access_token) throw new Error(`workload identity token: ${out.error_description ?? res.status}`)
    kept = { token: out.access_token, until: now() + (out.expires_in ?? 3600) * 1000 - RENEW_MS }
    return out.access_token
  }
  return async () => {
    if (kept && now() < kept.until) return kept.token
    pending ??= exchange().finally(() => (pending = null))
    return pending
  }
}
