import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EntityRef, Run } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''

interface Batch {
  run: Run
  accepted: number
  wanted: EntityRef[]
}

const machine = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' }))
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T
const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

const gizmo = (key: string, size: number) => ({ blueprint: 'gizmo', key, title: key, fields: { size }, digest: `size-${size}` })
const sighting = (key: string, digest: string) => ({ blueprint: 'gizmo', key, digest })

/** Opens a run, writes each batch into it in turn, and commits it: what each batch answered, and the run as committed. */
async function run(mode: 'snapshot' | 'incremental', ...batches: unknown[][]): Promise<{ opened: { sightings?: boolean }; answers: Batch[]; committed: Run }> {
  const opened = await json<Run & { sightings?: boolean }>(machine('/v1/ingest/runs', send('POST', { mode, scope: 'shelf' })))
  const answers: Batch[] = []
  for (const entities of batches) answers.push(await json<Batch>(machine(`/v1/ingest/runs/${opened.id}/entities`, send('PUT', { entities }))))
  const committed = await json<Run>(machine(`/v1/ingest/runs/${opened.id}/commit`, send('POST', {})))
  return { opened, answers, committed }
}

const stateOf = async (key: string) => (await hub.db.query<{ state: string }>(`SELECT state FROM entities WHERE blueprint = 'gizmo' AND key = $1`, [key])).rows[0]?.state

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  await hub.blueprints.save({ id: 'gizmo', title: 'Gizmo', fields: { size: { type: 'number' } } }, { kind: 'ui' }, 'test', async () => [])
  await hub.sources.save('shelf', { title: 'Shelf', class: 'pusher', blueprints: ['gizmo'], deleteGrant: [], cadence: '5m', grace: { runs: 1, duration: '0' } })
  token = (await hub.sources.issueToken('source', 'shelf pusher', { source: 'shelf' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('sightings', () => {
  it('takes an entity named by the digest it was last sent with, as the full write it names', async () => {
    const first = await run('snapshot', [gizmo('a', 1), gizmo('b', 2), gizmo('c', 3)])
    expect(first.opened.sightings).toBe(true)
    expect(first.committed.counts).toMatchObject({ received: 3, created: 3, sighted: 0 })
    const again = await run('snapshot', [sighting('a', 'size-1'), sighting('b', 'size-2'), sighting('c', 'size-3')])
    expect(again.answers[0]!.wanted).toEqual([])
    expect(again.committed.counts).toMatchObject({ received: 0, sighted: 3, unchanged: 3, missing: 0 })
    expect(await stateOf('a')).toBe('active')
  })

  it('counts a sighted entity as seen by the snapshot, and marks the one it did not name missing', async () => {
    const { committed } = await run('snapshot', [sighting('a', 'size-1'), sighting('b', 'size-2')])
    expect(committed.counts).toMatchObject({ sighted: 2, missing: 1 })
    expect(await stateOf('c')).toBe('missing')
  })

  it('wants in full what it cannot vouch for: a digest not the one kept, an entity it does not hold, and one not active', async () => {
    const { answers, committed } = await run('snapshot', [sighting('a', 'size-9'), sighting('nowhere', 'size-1'), sighting('c', 'size-3'), sighting('b', 'size-2')])
    expect(answers[0]!.wanted).toEqual([
      { blueprint: 'gizmo', key: 'a' },
      { blueprint: 'gizmo', key: 'nowhere' },
      { blueprint: 'gizmo', key: 'c' },
    ])
    expect(answers[0]!.accepted).toBe(1)
    // What was wanted and never sent in full was not seen: the commit marks it missing.
    expect(committed.counts).toMatchObject({ sighted: 1, received: 0 })
    expect(await stateOf('a')).toBe('missing')
    // Sent in full, each is taken, and named by its digest again from then on.
    const back = await run('snapshot', [gizmo('a', 1), gizmo('b', 2), gizmo('c', 3)])
    expect(back.committed.counts).toMatchObject({ received: 3, sighted: 0 })
    expect(await stateOf('a')).toBe('active')
    expect((await run('snapshot', [sighting('a', 'size-1'), sighting('b', 'size-2'), sighting('c', 'size-3')])).committed.counts).toMatchObject({ sighted: 3 })
  })

  it('wants in full an entity something else changed since its digest was kept', async () => {
    await hub.db.query(`UPDATE entities SET updated_at = now() + interval '1 second' WHERE blueprint = 'gizmo' AND key = 'b'`)
    const { answers } = await run('incremental', [sighting('a', 'size-1'), sighting('b', 'size-2')])
    expect(answers[0]!.wanted).toEqual([{ blueprint: 'gizmo', key: 'b' }])
  })

  it('wants everything of a blueprint in full once the blueprint is saved', async () => {
    await new Promise((r) => setTimeout(r, 5))
    await hub.blueprints.save({ id: 'gizmo', title: 'Gizmo', description: 'Now described.', fields: { size: { type: 'number' } } }, { kind: 'ui' }, 'test', async () => [])
    const { answers } = await run('incremental', [sighting('a', 'size-1'), sighting('c', 'size-3')])
    expect(answers[0]!.wanted.map((r) => r.key)).toEqual(['a', 'c'])
  })

  it('notes a sighting in the load ledger apart from what was sent in full', async () => {
    await run('snapshot', [gizmo('a', 1), gizmo('b', 2), gizmo('c', 3)])
    await run('snapshot', [sighting('a', 'size-1'), sighting('b', 'size-2'), sighting('c', 'size-3')])
    await hub.load.flush()
    const row = (await hub.db.query<{ rows: string; sighted: string }>(`SELECT sum(rows)::text AS rows, sum(sighted)::text AS sighted FROM load_hours WHERE kind = 'write' AND name = 'shelf'`)).rows[0]!
    expect(Number(row.sighted)).toBeGreaterThanOrEqual(3)
    const load = await hub.load.read(1)
    expect(load.writing.find((w) => w.source === 'shelf')).toMatchObject({ sighted: Number(row.sighted), received: Number(row.rows) })
  })
})
