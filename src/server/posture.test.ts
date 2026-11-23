import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangesResponse } from '../shared/api.ts'
import type { PosturePreview, PostureReach, PostureResponse, PostureWho } from '../shared/posture.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_posture'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// On the help desk, with a role that edits entities.
const desk = as('desk@example.org')
// On the platform team.
const ada = as('ada@example.org')
// On no team.
const bob = as('bob@example.org')

const ACTION = {
  title: 'Add a person to an app',
  blueprint: 'app',
  // Delegated: the help desk runs it only on the apps that name it.
  where: { field: 'assign_teams', op: 'contains', value: 'helpdesk' },
  inputs: { who: { type: 'string', title: 'Who', required: true } },
  backend: { type: 'webhook', url: 'https://hooks.example.org/assign' },
  access: { grants: [{ path: 'team', values: ['helpdesk'] }] },
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', { title: 'Person', fields: { phone: { type: 'string', access: { grants: [{ path: 'team', values: ['platform'] }] } } }, relations: { team: { target: 'team', many: true } } })
  await save('app', { title: 'App', fields: { assign_teams: { type: 'array' }, url: { type: 'url' } }, relations: {} })
  await save('vault', { title: 'Vault', fields: { secret: { type: 'secretRef' } }, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)

  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'helpdesk')
  await create('team', 'platform')
  await create('user', 'desk@example.org', {}, { team: ['helpdesk'] })
  await create('user', 'ada@example.org', {}, { team: ['platform'] })
  await create('user', 'bob@example.org')
  await create('app', 'cmt', { assign_teams: ['helpdesk'] })
  await create('app', 'argocd', { assign_teams: [] })

  expect((await admin('/v1/actions/assign_app', put(ACTION))).status).toBe(200)
  expect((await admin('/v1/actions/ping', put({ title: 'Ping', inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/ping' }, access: { everyone: true } }))).status).toBe(200)

  // Everyone signs in once, and the help desk gets a role that edits entities.
  for (const reader of [desk, ada, bob]) await reader('/v1/whoami')
  expect((await admin('/v1/roles/desk_editor', put({ title: 'Desk editor', permissions: ['entities.edit'] }))).status).toBe(200)
  expect((await admin('/v1/users/desk%40example.org/roles', put({ roles: ['desk_editor'] }))).status).toBe(200)
  expect((await admin('/v1/roles/token_maker', put({ title: 'Token maker', permissions: ['tokens.manage'] }))).status).toBe(200)
  expect((await admin('/v1/users/bob%40example.org/roles', put({ roles: ['token_maker'] }))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

const snapshot = async () => json<PostureResponse>(await admin('/v1/posture'))
const preview = async (change: unknown, save = false) => {
  const r = await admin('/v1/posture/change', post({ change, save }))
  expect(r.status).toBe(200)
  return json<PosturePreview>(r)
}

describe('the security posture', () => {
  it('is an admin\'s alone', async () => {
    for (const path of ['/v1/posture', '/v1/posture/reach?kind=person&name=bob@example.org', '/v1/posture/who?target=action:assign_app']) expect((await desk(path)).status).toBe(403)
    expect((await desk('/v1/posture/change', post({ change: { targets: [{ kind: 'action', id: 'assign_app' }], access: { op: 'clear' } }, save: true }))).status).toBe(403)
  })

  it('maps every blueprint, every field, and every action, counting who may see or run each', async () => {
    const s = await snapshot()
    const item = (id: string) => s.items.find((i) => (i.target.kind === 'field' ? `${i.target.blueprint}.${i.target.field}` : i.target.id) === id)!
    expect(s.principals.map((p) => p.name)).toEqual(['admin@example.org', 'ada@example.org', 'bob@example.org', 'desk@example.org'])
    // The person blueprint, and the team a grant reads through, are an admin's to change.
    expect(item('user').adminOnly).toBe('person')
    expect(item('team').adminOnly).toBe('decides access')
    expect(item('app').adminOnly).toBeNull()
    expect(item('vault')).toMatchObject({ open: false, people: 2 })
    expect(item('vault.secret').sensitive).toContain('holds a reference to a secret')
    // Nobody marked it, yet the delegated action's filter reads it, so it is guarded.
    expect(item('app.assign_teams')).toMatchObject({ open: true, adminEdit: false, sensitive: ['access is decided from it, so only an admin or a holder of access.values changes it'] })
    expect(item('user.phone')).toMatchObject({ open: false, people: 2 })
    // An open field is listed too, so it can be found and locked here.
    expect(item('app.url')).toMatchObject({ open: true, grants: [], sensitive: [], people: 4 })
    expect(item('assign_app')).toMatchObject({ open: false, people: 2, action: { blueprints: ['app'], backend: 'webhook' } })
    expect(item('ping')).toMatchObject({ open: true, people: 4 })
  })

  it('lists every team the rules grant to, who is on it, and what it opens', async () => {
    const { teams } = await snapshot()
    const team = (words: string) => teams.find((t) => t.words === words)!
    expect(teams.map((t) => t.words)).toEqual(['team is platform', 'team is helpdesk'])
    expect(team('team is platform')).toMatchObject({ members: ['ada@example.org'], grant: { path: 'team', values: ['platform'] } })
    expect(team('team is platform').targets).toEqual([{ kind: 'field', blueprint: 'user', field: 'phone' }, { kind: 'blueprint', id: 'vault' }])
    expect(team('team is helpdesk')).toMatchObject({ members: ['desk@example.org'], targets: [{ kind: 'action', id: 'assign_app' }] })
  })

  it('keeps the help desk from widening the delegated action, lists the hand-made values it reads, and finds the other widening paths', async () => {
    const { findings, handmade } = await snapshot()
    const by = (id: string) => findings.find((f) => f.id === id)
    // The help desk edits apps, but the field the action's filter reads is guarded, so it cannot add itself to assign_teams on ArgoCD.
    expect((await desk('/v1/entities/app/argocd', { method: 'PATCH', body: JSON.stringify({ fields: { assign_teams: ['helpdesk'] } }) })).status).toBe(403)
    expect((await desk('/v1/entities/app/argocd', { method: 'PATCH', body: JSON.stringify({ fields: { url: 'https://argocd.example.org' } }) })).status).toBe(200)
    expect(handmade.filter((h) => h.name === 'assign_teams').map((h) => [h.entity.key, h.kind, h.over])).toEqual(expect.arrayContaining([['cmt', 'field', false], ['argocd', 'field', false]]))
    expect(by('everyone:ping')?.severity).toBe('medium')
    expect(by('perm:tokens.manage')).toMatchObject({ severity: 'high', who: ['bob@example.org'] })
    expect(findings.some((f) => f.id.startsWith('decides:'))).toBe(false)
    expect(findings[0]!.severity).toBe('high')
  })

  it('reads the hand-made values of every blueprint access is decided from in one question for fields and one for relations', async () => {
    // A second blueprint whose field an action's filter reads, so two decide access through a field.
    expect((await admin('/v1/actions/rotate', put({ title: 'Rotate', blueprint: 'vault', where: { field: 'secret', op: 'exists' }, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/rotate' }, access: { grants: [{ path: 'team', values: ['platform'] }] } }))).status).toBe(200)
    const asked: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((...args: Parameters<typeof query>) => (asked.push(String(args[0])), query(...args))) as typeof hub.db.query
    try {
      const { handmade } = await snapshot()
      expect(handmade.some((h) => h.name === 'assign_teams')).toBe(true)
    } finally {
      hub.db.query = query
      await admin('/v1/actions/rotate', { method: 'DELETE' })
    }
    expect(asked.filter((sql) => sql.includes('?|')).length).toBe(1)
    expect(asked.filter((sql) => sql.includes("layer = 'ui'") && sql.includes('GROUP BY')).length).toBeLessThanOrEqual(1)
  })

  it('says who may run an action, and through which grant', async () => {
    const who = await json<PostureWho>(await admin('/v1/posture/who?target=action:assign_app'))
    const row = (name: string) => who.rows.find((r) => r.principal.name === name)!
    expect(row('desk@example.org')).toMatchObject({ runs: true, via: 'team is helpdesk' })
    expect(row('ada@example.org').runs).toBe(false)
    expect(row('admin@example.org')).toMatchObject({ runs: true, via: 'admin' })
    const field = await json<PostureWho>(await admin('/v1/posture/who?target=field:user.phone'))
    expect(field.rows.filter((r) => r.sees).map((r) => r.principal.name)).toEqual(['admin@example.org', 'ada@example.org'])
    expect((await admin('/v1/posture/who?target=action:nope')).status).toBe(404)
  })

  it('says what one person may see, change, and run', async () => {
    const reach = await json<PostureReach>(await admin('/v1/posture/reach?kind=person&name=desk@example.org'))
    expect(reach.principal.permissions).toEqual(['entities.edit'])
    expect(reach.actions.find((a) => a.id === 'assign_app')).toMatchObject({ runs: true, offered: true, via: 'team is helpdesk' })
    expect(reach.blueprints.find((b) => b.id === 'app')).toMatchObject({ sees: true, changes: true })
    expect(reach.blueprints.find((b) => b.id === 'vault')?.sees).toBe(false)
    expect(reach.blueprints.find((b) => b.id === 'user')).toMatchObject({ changes: false, hidden: ['phone'] })
  })

  it('previews a change without saving it', async () => {
    const p = await preview({ targets: [{ kind: 'action', id: 'assign_app' }], access: { op: 'set', grants: [{ path: 'team', values: ['platform'] }] } })
    expect(p.saved).toBe(false)
    expect(p.items[0]).toMatchObject({ changed: true, gains: ['ada@example.org'], loses: ['desk@example.org'], refused: null })
    const who = await json<PostureWho>(await admin('/v1/posture/who?target=action:assign_app'))
    expect(who.rows.find((r) => r.principal.name === 'desk@example.org')?.runs).toBe(true)
  })

  it('locks the filter\'s field in one save, and the finding goes', async () => {
    const p = await preview({ targets: [{ kind: 'field', blueprint: 'app', field: 'assign_teams' }, { kind: 'action', id: 'ping' }], adminEdit: true }, true)
    expect(p.saved).toBe(true)
    expect(p.items[0]).toMatchObject({ changed: true, losesChange: ['desk@example.org'] })
    expect(p.items[1]!.refused).toMatch(/no admin-only mark/)
    expect(hub.blueprints.get('app')?.fields.assign_teams?.adminEdit).toBe(true)
    const { findings } = await snapshot()
    expect(findings.find((f) => f.id === 'filter:assign_app')).toBeUndefined()
    const rows = (await json<ChangesResponse>(await admin('/v1/changes?kind=access.changed'))).changes
    expect(rows.some((r) => (r.detail as { posture?: boolean }).posture && r.actor === 'admin@example.org')).toBe(true)
  })

  it('adds and removes grant values across many targets, and refuses what it cannot change', async () => {
    const targets = [{ kind: 'blueprint', id: 'vault' }, { kind: 'field', blueprint: 'user', field: 'phone' }]
    const added = await preview({ targets, access: { op: 'add', grants: [{ path: 'team', values: ['helpdesk'] }] } }, true)
    expect(added.items.map((i) => i.gains)).toEqual([['desk@example.org'], ['desk@example.org']])
    expect(hub.blueprints.get('vault')?.access?.grants).toEqual([{ path: 'team', values: ['platform', 'helpdesk'] }])
    const removed = await preview({ targets, access: { op: 'remove', grants: [{ path: 'team', values: ['helpdesk'] }] } }, true)
    expect(removed.items.map((i) => i.loses)).toEqual([['desk@example.org'], ['desk@example.org']])
    expect(hub.blueprints.get('vault')?.access?.grants).toEqual([{ path: 'team', values: ['platform'] }])
    const bad = await preview({ targets: [{ kind: 'blueprint', id: 'vault' }, { kind: 'blueprint', id: 'nope' }], access: { op: 'set', grants: [{ path: 'squad', values: ['x'] }] } })
    expect(bad.items[0]!.refused).toMatch(/no relation "squad"/)
    expect(bad.items[1]!.refused).toBe('There is no such blueprint')
  })

  it('shows which blueprints a new grant path would make an admin\'s alone', async () => {
    const p = await preview({ targets: [{ kind: 'action', id: 'ping' }], access: { op: 'set', grants: [{ path: 'team', values: ['platform'] }], everyone: false } })
    expect(p.items[0]).toMatchObject({ loses: ['bob@example.org', 'desk@example.org'] })
    expect(p.adminOnly).toEqual({ added: [], removed: [] })
    const cleared = await preview({ targets: [{ kind: 'action', id: 'assign_app' }], access: { op: 'clear' } })
    expect(cleared.items[0]!.loses).toEqual(['desk@example.org'])
  })
})

describe('the actions on the security page', () => {
  const day = 86_400_000
  const action = async (id: string, who = admin) => (await json<PostureResponse>(await who('/v1/posture'))).items.find((i) => i.target.kind === 'action' && i.target.id === id)!
  const finding = async (id: string) => (await snapshot()).findings.find((f) => f.id === `action-unused:${id}`)
  const save = (id: string, spec: Record<string, unknown>) => admin(`/v1/actions/${id}`, put({ title: id, inputs: {}, backend: { type: 'caller' }, ...spec }))
  const run = (id: string, who = admin) => who(`/v1/actions/${id}/run`, post({ inputs: {} }))
  /** Moves when an action's definition last changed, and when its runs were asked for, back by this many days. */
  const age = async (id: string, days: number, what: 'definition' | 'runs') => {
    if (what === 'definition') await hub.db.query(`UPDATE actions SET updated_at = now() - make_interval(days => $2) WHERE id = $1`, [id, days])
    else await hub.db.query(`UPDATE action_runs SET created_at = now() - make_interval(days => $2) WHERE action = $1`, [id, days])
    await hub.actions.load()
  }

  beforeAll(async () => {
    expect((await admin('/v1/blueprints/safe', put({ id: 'safe', title: 'Safe', icon: 'lock', fields: {}, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } }))).status).toBe(200)
    expect((await admin('/v1/entities', post({ blueprint: 'safe', key: 'main', title: 'Main safe', fields: {}, relations: {} }))).status).toBe(201)
    expect((await save('open_safe', { title: 'Open the safe', home: 'safe:main', access: { home: true, rules: [{ grants: [{ path: 'team', values: ['platform'] }], approval: true }] } })).status).toBe(200)
    expect((await save('lost_home', { home: 'safe:gone' })).status).toBe(200)
  })

  it('says where each action belongs, who it opens to, and what it is drawn with', async () => {
    expect((await action('open_safe')).action).toMatchObject({ home: { id: 'safe:main', title: 'Main safe' }, homePeople: true, everyone: false, icon: 'lock', backend: 'caller', approval: false, rules: [{ approval: true }] })
    expect((await action('ping')).action).toMatchObject({ home: null, homePeople: false, everyone: true })
    // A home the catalog does not hold is no home here: the finding beside it says so.
    expect((await action('lost_home')).action).toMatchObject({ home: null, homePeople: false })
  })

  it('gives a home only to a reader who may see it', async () => {
    expect((await admin('/v1/roles/auditor', put({ title: 'Auditor', permissions: ['posture.read'] }))).status).toBe(200)
    expect((await admin('/v1/users/bob%40example.org/roles', put({ roles: ['token_maker', 'auditor'] }))).status).toBe(200)
    // Bob is on no team, so the safe is hidden from him: he reads the action, and not where it belongs.
    const seen = await action('open_safe', bob)
    expect(seen.action).toMatchObject({ home: null, homePeople: true })
    expect(JSON.stringify(seen)).not.toContain('Main safe')
    expect(seen.action!.icon).not.toBe('lock')
    expect((await admin('/v1/users/bob%40example.org/roles', put({ roles: ['token_maker'] }))).status).toBe(200)
  })

  it('reads every action\'s last run and its runs of the last 90 days in one statement', async () => {
    expect((await action('open_safe')).action).toMatchObject({ lastRunAt: null, runs90: 0 })
    expect((await run('open_safe')).status).toBe(201)
    expect((await run('open_safe')).status).toBe(201)
    const fresh = (await action('open_safe')).action!
    expect(fresh.runs90).toBe(2)
    expect(Date.now() - new Date(fresh.lastRunAt!).getTime()).toBeLessThan(60_000)
    // Another action's runs are its own.
    expect((await action('lost_home')).action).toMatchObject({ lastRunAt: null, runs90: 0 })
    await age('open_safe', 100, 'runs')
    const old = (await action('open_safe')).action!
    expect(old.runs90).toBe(0)
    expect(Math.round((Date.now() - new Date(old.lastRunAt!).getTime()) / day)).toBe(100)
  })

  it('finds an action nobody has run in 90 days, once its definition is that old', async () => {
    expect((await save('stale', { title: 'Stale tool', access: { everyone: true } })).status).toBe(200)
    // Made today: too new to say nobody uses it.
    expect(await finding('stale')).toBeUndefined()
    await age('stale', 100, 'definition')
    expect(await finding('stale')).toMatchObject({ severity: 'low', family: 'Actions nobody has run in 90 days', title: 'Stale tool has never run', targets: [{ kind: 'action', id: 'stale' }], who: [] })
    // A run ten days ago is use.
    expect((await run('stale', bob)).status).toBe(201)
    await age('stale', 10, 'runs')
    expect(await finding('stale')).toBeUndefined()
    // Its last run a hundred days ago is not.
    await age('stale', 100, 'runs')
    expect(await finding('stale')).toMatchObject({ title: 'Stale tool has not run in 100 days' })
    // An old definition with old runs, changed yesterday, is new again.
    await age('stale', 1, 'definition')
    expect(await finding('stale')).toBeUndefined()
  })

  it('counts an action with no form by its runs like any other', async () => {
    expect((await save('tool_only', { title: 'Tool only', form: false, access: { everyone: true } })).status).toBe(200)
    await age('tool_only', 120, 'definition')
    expect(await finding('tool_only')).toMatchObject({ severity: 'low' })
    expect((await action('tool_only')).action).toMatchObject({ lastRunAt: null, runs90: 0 })
  })

  it('keeps when a definition last changed through a save that changes nothing', async () => {
    await age('stale', 100, 'definition')
    const was = hub.actions.get('stale')!.updatedAt
    expect((await save('stale', { title: 'Stale tool', access: { everyone: true } })).status).toBe(200)
    expect(hub.actions.get('stale')!.updatedAt).toBe(was)
    expect((await save('stale', { title: 'Stale tool, renamed', access: { everyone: true } })).status).toBe(200)
    expect(Date.now() - new Date(hub.actions.get('stale')!.updatedAt).getTime()).toBeLessThan(60_000)
  })
})

describe('a posture that judges more people than the hub keeps pages for', () => {
  const PEOPLE = 120

  beforeAll(async () => {
    // Everyone owns the teams they are on, and an action opens to the members of a team.
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'member', path: 'team' }] }))).status).toBe(200)
    const entities = Array.from({ length: PEOPLE }, (_, i) => ({ blueprint: 'user', key: `crowd${i}@example.org`, title: `Crowd ${i}`, relations: { team: i % 3 ? ['helpdesk'] : [] } }))
    for (const e of entities) expect((await admin('/v1/entities', post(e))).status).toBe(201)
    expect((await admin('/v1/actions/team_note', put({ title: 'Leave a team a note', blueprint: 'team', inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/note' }, access: { rules: [{ owns: ['member'] }] } }))).status).toBe(200)
    await hub.rules.settled()
  })

  afterAll(async () => {
    await admin('/v1/actions/team_note', { method: 'DELETE' })
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })

  it('works out what each person owns once for all of them, not once a person and action', async () => {
    await snapshot()
    const asked: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((...args: Parameters<typeof query>) => (asked.push(String(args[0])), query(...args))) as typeof hub.db.query
    let answer: PostureResponse
    try {
      answer = await snapshot()
    } finally {
      hub.db.query = query
    }
    // Two of every three in the crowd are on a team, and so are desk and ada; the admin runs everything.
    const note = answer.items.find((i) => i.target.kind === 'action' && i.target.id === 'team_note')!
    expect(note.people).toBe((PEOPLE * 2) / 3 + 2 + 1)
    // A few statements in all, however many people are judged: not one walk for each person each time an action asks.
    expect(asked.length).toBeLessThan(40)
  })
})
