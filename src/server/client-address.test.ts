import { describe, expect, it } from 'vitest'
import { addressTrust, clientAddress } from './client-address.ts'

const headers = (given: Record<string, string>) => (name: string) => given[name]

describe('where a caller is', () => {
  it('trusts x-real-ip by default, and reads no other header', () => {
    const trust = addressTrust({ CLIENT_ADDRESS_HEADER: 'x-real-ip', CLIENT_ADDRESS_HOPS: 1 })
    expect(trust).toEqual({ header: 'x-real-ip', hops: 1 })
    expect(clientAddress(headers({ 'x-real-ip': '203.0.113.7' }), trust)).toBe('203.0.113.7')
    // A header the hub does not trust is one a caller could have written: it is never read.
    expect(clientAddress(headers({ 'x-forwarded-for': '198.51.100.4' }), trust)).toBeUndefined()
  })

  it('reads a listing header from its end, as many entries in as the proxies that add to it, never one a caller wrote', () => {
    const trust = addressTrust({ CLIENT_ADDRESS_HEADER: 'X-Forwarded-For', CLIENT_ADDRESS_HOPS: 2 })
    expect(trust.header).toBe('x-forwarded-for')
    // The caller sent 198.51.100.4; the ingress added the caller's own address, and the login proxy the ingress's.
    expect(clientAddress(headers({ 'x-forwarded-for': '198.51.100.4, 203.0.113.7, 10.0.0.5' }), trust)).toBe('203.0.113.7')
    expect(clientAddress(headers({ 'x-forwarded-for': '10.0.0.5' }), trust)).toBeUndefined()
    const one = addressTrust({ CLIENT_ADDRESS_HEADER: 'x-forwarded-for', CLIENT_ADDRESS_HOPS: 1 })
    expect(clientAddress(headers({ 'x-forwarded-for': '198.51.100.4, 203.0.113.7' }), one)).toBe('203.0.113.7')
  })

  it('takes nothing that is not an address, and nothing at all when no header is trusted', () => {
    const trust = addressTrust({ CLIENT_ADDRESS_HEADER: 'x-real-ip', CLIENT_ADDRESS_HOPS: 1 })
    expect(clientAddress(headers({ 'x-real-ip': 'not-an-address' }), trust)).toBeUndefined()
    expect(clientAddress(headers({ 'x-real-ip': '2001:db8::1' }), trust)).toBe('2001:db8::1')
    const none = addressTrust({ CLIENT_ADDRESS_HEADER: 'none', CLIENT_ADDRESS_HOPS: 1 })
    expect(none.header).toBeNull()
    expect(clientAddress(headers({ 'x-real-ip': '203.0.113.7' }), none)).toBeUndefined()
  })
})
