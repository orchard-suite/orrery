import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
const local = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' }))

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('a hub that asks nobody to sign in', () => {
  it('counts its local admin as a person, so a run asked as them acts as them', async () => {
    expect(hub.people().map((p) => p.name)).toContain('local')
    expect((await local('/v1/blueprints/team', { method: 'PUT', body: JSON.stringify({ title: 'Team', fields: {}, relations: {} }) })).status).toBe(200)
    await hub.entities.write({ blueprint: 'team', key: 'a', title: 'A' }, { source: hub.sources.get('ui')!, layer: 'pushed', mode: 'upsert', replace: false })
    expect((await local('/v1/actions/new_report', { method: 'PUT', body: JSON.stringify({ title: 'New report', inputs: { title: { type: 'string', required: true }, home: { type: 'entity', blueprint: 'team', required: true }, layout: { type: 'markdown', required: true } }, backend: { type: 'report', verb: 'create' } }) })).status).toBe(200)
    const query = (await (await local('/v1/queries', { method: 'POST', body: JSON.stringify({ title: 'Teams', spec: { sources: [{ blueprint: 'team', clauses: [] }], columns: ['title'] } }) })).json()) as { id: string }
    const asked = (await (await local('/v1/actions/new_report/run', { method: 'POST', body: JSON.stringify({ inputs: { title: 'Mine', home: 'team:a', layout: `---\ndata:\n  d: { query: ${query.id} }\n---\n\`\`\`table\ndata: d\n\`\`\`\n` } }) })).json()) as ActionRun
    const run = (await hub.actions.getRun(asked.id))!
    expect(run.state, run.log.map((l) => l.message).join('\n')).toBe('succeeded')
  })
})
