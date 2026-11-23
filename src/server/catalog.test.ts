import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('a git catalog', () => {
  it('announces the model only when a pull changed it, so a pull of the same files drops nothing kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-catalog-'))
    const source = await hub.sources.save('quiet', { title: 'Quiet', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/quiet.git', branch: 'main', glob: '**/*.yaml' } })
    const model = (title: string) =>
      `blueprints:\n  - id: desk\n    title: ${title}\n    fields: { floor: { type: number } }\n  - id: lamp\n    title: Lamp\n    fields: { desk_key: { type: string } }\n    relations:\n      desk: { target: desk }\n` +
      'relationRules:\n  - { id: lamp.desk, blueprint: lamp, relation: desk, optional: true, match: { target: desk, where: "target.key == source.desk_key" } }\n' +
      'scorecards:\n  - { id: desk_floor, title: Floor, blueprint: desk, levels: [{ name: Bronze, rules: [{ id: has_floor, title: Has a floor, where: { field: floor, op: exists } }] }] }\n' +
      'actions:\n  - { id: dust, title: Dust, blueprint: desk, inputs: {}, backend: { type: webhook, url: "https://hooks.example.org/dust" } }\n' +
      'entities:\n  - { blueprint: desk, key: one, fields: { floor: 2 } }\n'
    let announced = 0
    const stop = hub.events.subscribe((event) => {
      // What names the blueprints it moved drops only what reads them; the hub's schedule blueprint gains a link to a new kind that way.
      if (event.type === 'blueprints' && !event.offered) announced++
    })
    try {
      writeFileSync(join(dir, 'model.yaml'), model('Desk'))
      expect((await hub.git.apply(source, dir)).errors).toEqual([])
      expect(announced).toBe(1)

      announced = 0
      expect((await hub.git.apply(source, dir)).errors).toEqual([])
      expect(announced).toBe(0)

      // A hub reads what is kept back from the database, where Postgres keeps an object's keys in its own order: a pull of the same files still changes nothing.
      writeFileSync(
        join(dir, 'config.yaml'),
        'config:\n' +
          '  catalog: { groupOrder: [Office], closedGroups: [Office], blueprintOrder: { Office: [lamp, desk] }, hiddenBlueprints: [lamp] }\n' +
          '  columns: { ranks: [{ id: identity, columns: [title, status] }, { id: placement, columns: [r:desk] }], hidden: [f:floor], widths: { title: 240 } }\n' +
          '  conventions: [{ id: office, title: Office, description: Every office thing has a desk, groups: [Office], relations: [desk] }]\n' +
          '  welcome: { version: 2, blueprint: desk, actions: [dust] }\n' +
          '  access: { audiences: [{ id: facilities, title: Facilities, people: [facilities@example.org] }], classes: [{ id: floor, title: Floor, audiences: [facilities], match: [floor] }] }\n',
      )
      expect((await hub.git.apply(source, dir)).errors).toEqual([])
      await hub.catchUp()
      announced = 0
      expect((await hub.git.apply(source, dir)).errors).toEqual([])
      expect(announced).toBe(0)

      writeFileSync(join(dir, 'model.yaml'), model('Standing desk'))
      expect((await hub.git.apply(source, dir)).errors).toEqual([])
      expect(announced).toBe(1)
      expect(hub.blueprints.get('desk')?.title).toBe('Standing desk')
    } finally {
      stop()
    }
  })

  it('removes the blueprints it stops defining, one that points at another first, and keeps one another source defined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-catalog-'))
    const other = mkdtempSync(join(tmpdir(), 'orrery-catalog-'))
    const ours = await hub.sources.save('ours', { title: 'Ours', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/ours.git', branch: 'main', glob: '**/*.yaml' } })
    const theirs = await hub.sources.save('theirs', { title: 'Theirs', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/theirs.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'model.yaml'), 'blueprints:\n  - id: gadget\n    title: Gadget\n  - id: part\n    title: Part\n    relations:\n      of: { target: gadget }\nentities:\n  - { blueprint: gadget, key: one }\n')
    writeFileSync(join(other, 'model.yaml'), 'blueprints:\n  - id: widget\n    title: Widget\n')
    expect((await applyCatalog(hub, ours, dir, '**/*.yaml')).errors).toEqual([])
    expect((await applyCatalog(hub, theirs, other, '**/*.yaml')).errors).toEqual([])
    expect(hub.blueprints.get('gadget')).toBeDefined()

    writeFileSync(join(dir, 'model.yaml'), 'blueprints: []\n')
    const report = await applyCatalog(hub, ours, dir, '**/*.yaml')
    expect(report.errors).toEqual([])
    expect(hub.blueprints.get('gadget')).toBeUndefined()
    expect(hub.blueprints.get('part')).toBeUndefined()
    expect(hub.blueprints.get('widget')).toBeDefined()
  })

  it('says why a blueprint could not be saved once nothing more saves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-catalog-'))
    const source = await hub.sources.save('broken', { title: 'Broken', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/broken.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'model.yaml'), 'blueprints:\n  - id: stand\n    title: Stand\n    relations:\n      on: { target: nowhere }\n')
    const { errors } = await applyCatalog(hub, source, dir, '**/*.yaml')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toMatch(/^blueprint stand: .*nowhere/)
  })
})
