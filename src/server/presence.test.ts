import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { Presence } from './presence.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
let hub: Hub

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('presence', () => {
  it('counts the day from the database, so a hub that just started reports the same', async () => {
    const first = new Presence(hub.db, createLogger('presence'))
    await hub.access.seen('one@example.com', false)
    await hub.access.seen('two@example.com', false)
    await first.tab('tab-a')
    await first.tab('tab-b')
    // A second hub, or this one after a restart, remembers nothing of its own and still reads the day.
    expect(await new Presence(hub.db, createLogger('presence')).count()).toEqual({ people: 2, tabs: 2 })
  })

  it('writes a tab at most once a minute, however often it reports', async () => {
    const presence = new Presence(hub.db, createLogger('presence'))
    await presence.tab('tab-busy')
    const at = async () => (await hub.db.query<{ seen_at: Date }>("SELECT seen_at FROM browser_tabs WHERE id = 'tab-busy'")).rows[0]!.seen_at.getTime()
    const written = await at()
    await hub.db.query("UPDATE browser_tabs SET seen_at = seen_at - interval '10 seconds' WHERE id = 'tab-busy'")
    await presence.tab('tab-busy')
    expect(await at()).toBe(written - 10_000)
  })

  it("counts a person seen through their own token, and lets go of a tab after a day", async () => {
    await hub.access.seen('token@example.com', false)
    await hub.db.query("UPDATE users SET last_seen_at = now() - interval '2 days' WHERE email = 'token@example.com'")
    await hub.access.load()
    const before = (await new Presence(hub.db, createLogger('presence')).count()).people
    await hub.access.touch('token@example.com')
    expect((await new Presence(hub.db, createLogger('presence')).count()).people).toBe(before + 1)
    const presence = new Presence(hub.db, createLogger('presence'))
    await presence.tab('tab-old')
    await hub.db.query("UPDATE browser_tabs SET seen_at = now() - interval '2 days' WHERE id = 'tab-old'")
    await presence.prune()
    expect((await hub.db.query("SELECT 1 FROM browser_tabs WHERE id = 'tab-old'")).rowCount).toBe(0)
  })
})
