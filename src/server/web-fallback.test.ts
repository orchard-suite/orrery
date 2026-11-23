import { describe, expect, it } from 'vitest'
import { answersWithPage, servesWebApp } from './http.ts'

describe('the web app fallback', () => {
  it('serves the app to a person on the session surface', () => {
    expect(servesWebApp('session', '/catalog/service')).toBe(true)
    expect(servesWebApp('session', '/')).toBe(true)
  })

  it('answers JSON where an API or MCP client looks', () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/v1/nothing', '/v1/ingest/nothing']) expect(servesWebApp('session', path)).toBe(false)
  })

  it('never serves a page on the machine surface', () => {
    expect(servesWebApp('machine', '/.well-known/oauth-protected-resource/mcp')).toBe(false)
    expect(servesWebApp('machine', '/catalog/service')).toBe(false)
  })

  it('answers a missing built file with a 404, not the page, so a page from another release sees it fail', () => {
    expect(servesWebApp('session', '/assets/index-OLD.js')).toBe(true)
    expect(answersWithPage('session', '/assets/index-OLD.js')).toBe(false)
    expect(answersWithPage('session', '/catalog/service')).toBe(true)
    expect(answersWithPage('machine', '/catalog/service')).toBe(false)
  })
})
