import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFINITION_PATH, definition, openapi } from './openapi.ts'

describe('the definition kept with the code', () => {
  it('is what the server publishes; run npm run openapi when it is not', () => {
    expect(readFileSync(DEFINITION_PATH, 'utf8')).toBe(definition())
  })
})

describe('the definition names every operation and its errors', () => {
  it('gives each operation a unique operationId and the shared error response', () => {
    const doc = openapi('/', '0.0.0') as { paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> }
    const ids = new Set<string>()
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        expect(op.operationId, `${method} ${path}`).toBeTruthy()
        expect(ids.has(op.operationId!), `${op.operationId} is used twice`).toBe(false)
        ids.add(op.operationId!)
        expect(op.responses?.default).toEqual({ $ref: '#/components/responses/Error' })
      }
    }
  })
})
