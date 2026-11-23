// Where a caller is: the address the proxy in front of the hub saw them call
// from. The hub never sees the caller's own connection, only the proxy's, so
// it takes the address from one header the estate says its proxy writes, and
// from nothing else a caller could send.

import { isIP } from 'node:net'
import type { Config } from './config.ts'

/** Which header the hub takes a caller's address from, and how many proxies in front of it add to that header. */
export interface AddressTrust {
  /** The header, in lower case. Null: no header is trusted, and no request has an address. */
  header: string | null
  /** How many proxies in front of the hub add an entry to the header: the address is that many entries from its end. */
  hops: number
}

/** The trust the hub's settings give. `none` trusts no header. */
export function addressTrust(config: Pick<Config, 'CLIENT_ADDRESS_HEADER' | 'CLIENT_ADDRESS_HOPS'>): AddressTrust {
  const header = config.CLIENT_ADDRESS_HEADER.trim().toLowerCase()
  return { header: header === 'none' || header === '' ? null : header, hops: config.CLIENT_ADDRESS_HOPS }
}

/**
 * The address a request came from, read from the trusted header alone. A
 * header that lists addresses, as `x-forwarded-for` does, has an entry added
 * by each proxy it passed, the caller's own first; only the entries the
 * trusted proxies added are theirs, so the hub reads the one `hops` from the
 * end and never one further in, which the caller could have written. A value
 * that is not an address is no address.
 */
export function clientAddress(header: (name: string) => string | undefined, trust: AddressTrust): string | undefined {
  if (!trust.header) return undefined
  const entries = (header(trust.header) ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  const address = entries[entries.length - trust.hops]
  return address && isIP(address) ? address : undefined
}
