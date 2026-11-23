// Who has come in and what each may do. The login proxy decides who gets in
// and who is an admin; the hub keeps a record of each person and the roles
// given to them here.

import { z } from 'zod'
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_IDS, can, type Identity, type Permission, type RoleDef, type User } from '../shared/model.ts'
import { actingAs, record } from './activity.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'

const ID = /^[a-z0-9][a-z0-9_-]*$/
const roleSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.enum(PERMISSION_IDS as [Permission, ...Permission[]])).default([]),
})

const ADMIN: RoleDef = { id: ADMIN_ROLE, title: 'Admin', description: 'Everything. Sign-in gives it to a person; an access token may be bound to it.', permissions: PERMISSION_IDS, locked: true }

/** Offered once, on a hub that has no roles yet. From then on they are the users' own to change or remove. */
const STARTER_ROLES: (Omit<RoleDef, 'locked'>)[] = [
  { id: 'viewer', title: 'Viewer', description: 'Reads everything and changes nothing. For an access token that only reads.', permissions: [] },
  { id: 'contributor', title: 'Contributor', description: 'Edits entities and arranges the views.', permissions: ['entities.edit', 'views.arrange', 'sources.refresh'] },
  { id: 'architect', title: 'Architect', description: 'Shapes the model and the catalog, and everything a contributor does.', permissions: ['entities.edit', 'views.arrange', 'sources.refresh', 'model.edit', 'catalog.organize'] },
]

/** How long a person's last-seen time may lag before it is written again. */
const SEEN_EVERY_MS = 60_000

export class AccessError extends Error {
  readonly status: 400 | 403 | 404 | 409

  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

interface UserRow {
  email: string
  admin: boolean
  roles: string[]
  first_seen_at: Date | null
  last_seen_at: Date | null
}

/**
 * Reads `alias=domain` pairs into a map from alias to sign-in domain. A pair
 * without both sides is ignored.
 */
export function parseAliases(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const pair of text.split(',')) {
    const [alias, domain] = pair.split('=').map((s) => s?.trim().toLowerCase())
    if (alias && domain) out.set(alias, domain)
  }
  return out
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

type Grantor = Pick<Identity, 'admin' | 'permissions'>

export class Access {
  private roles = new Map<string, RoleDef>()
  private users = new Map<string, UserRow>()
  /** A browser's first page makes many requests at once; they share one enrollment. */
  private arriving = new Map<string, Promise<User>>()

  private readonly db: Db
  private readonly events: Events
  private readonly log: Logger
  private readonly aliases: Map<string, string>

  constructor(db: Db, events: Events, log: Logger, aliases: Map<string, string> = new Map()) {
    this.db = db
    this.events = events
    this.log = log
    this.aliases = aliases
  }

  /**
   * The one form a person's address is kept in: lowercase, and on the
   * sign-in domain when it arrived on one of its aliases. Every address the
   * hub is given about a person goes through here, whoever gave it.
   */
  address(email: string): string {
    const e = email.trim().toLowerCase()
    const at = e.lastIndexOf('@')
    const domain = at > 0 ? this.aliases.get(e.slice(at + 1)) : undefined
    return domain ? `${e.slice(0, at)}@${domain}` : e
  }

  async load(): Promise<void> {
    const seeded = await this.db.query(`SELECT 1 FROM settings WHERE key = 'roles.seeded'`)
    if (!seeded.rowCount) {
      for (const r of STARTER_ROLES) await this.db.query('INSERT INTO roles (id, spec) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [r.id, JSON.stringify({ title: r.title, description: r.description, permissions: r.permissions })])
      await this.db.query(`INSERT INTO settings (key, value) VALUES ('roles.seeded', 'true') ON CONFLICT (key) DO NOTHING`)
      this.log.info('starter roles seeded', { roles: STARTER_ROLES.map((r) => r.id) })
    }
    const roles = await this.db.query<{ id: string; spec: z.infer<typeof roleSchema> }>('SELECT id, spec FROM roles ORDER BY id')
    // A permission the hub no longer has is dropped on the way in.
    this.roles = new Map(roles.rows.map((r) => [r.id, { id: r.id, title: r.spec.title, description: r.spec.description, permissions: (r.spec.permissions ?? []).filter((p) => p in PERMISSIONS) }]))
    const users = await this.db.query<UserRow>('SELECT * FROM users ORDER BY email')
    this.users = new Map(users.rows.map((u) => [u.email, u]))
    await this.foldAliases()
  }

  /**
   * People kept under an alias address before the alias was configured move
   * to their sign-in address. Where both rows exist, the roles join and the
   * earliest and latest sign-ins are kept.
   */
  private async foldAliases(): Promise<void> {
    for (const row of [...this.users.values()]) {
      const to = this.address(row.email)
      if (to === row.email) continue
      const there = this.users.get(to)
      const merged: UserRow = there
        ? {
            email: to,
            admin: there.admin || row.admin,
            roles: [...new Set([...there.roles, ...row.roles])],
            first_seen_at: earliest(there.first_seen_at, row.first_seen_at),
            last_seen_at: latest(there.last_seen_at, row.last_seen_at),
          }
        : { ...row, email: to }
      await this.db.tx(async (client) => {
        await client.query('DELETE FROM users WHERE email = $1', [row.email])
        await client.query(
          `INSERT INTO users (email, admin, roles, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (email) DO UPDATE SET admin = EXCLUDED.admin, roles = EXCLUDED.roles, first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at`,
          [merged.email, merged.admin, JSON.stringify(merged.roles), merged.first_seen_at, merged.last_seen_at],
        )
      })
      this.users.delete(row.email)
      this.users.set(to, merged)
      await record(this.db, 'user.changed', null, null, null, { user: to, from: row.email, by: 'alias' })
      this.log.info('person moved from an alias address to their sign-in address', { from: row.email, to, merged: !!there })
    }
  }

  // Roles --------------------------------------------------------------------

  listRoles(): RoleDef[] {
    return [ADMIN, ...[...this.roles.values()].sort((a, b) => a.title.localeCompare(b.title))]
  }

  role(id: string): RoleDef | undefined {
    return id === ADMIN_ROLE ? ADMIN : this.roles.get(id)
  }

  permissionsOf(roleIds: string[]): Permission[] {
    const held = new Set(roleIds.flatMap((id) => this.role(id)?.permissions ?? []))
    return PERMISSION_IDS.filter((p) => held.has(p))
  }

  /** Nobody hands out what they do not hold: not through a role, and not through a token. */
  requireHeld(by: Grantor, permissions: Permission[], what: string): void {
    const lacking = permissions.filter((p) => !can(by, p))
    if (lacking.length) throw new AccessError(`${what} takes permissions you do not hold: ${lacking.join(', ')}`, 403)
  }

  async saveRole(id: string, input: unknown, by: Grantor): Promise<RoleDef> {
    if (id === ADMIN_ROLE) throw new AccessError('The admin role is the hub\'s own and cannot be changed')
    if (!ID.test(id)) throw new AccessError('role ids are lowercase letters, digits, and _ -')
    const parsed = roleSchema.safeParse(input)
    if (!parsed.success) throw new AccessError(`Invalid role: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const existing = this.roles.get(id)
    const before = new Set(existing?.permissions ?? [])
    const after = new Set(parsed.data.permissions)
    const added = [...after].filter((p) => !before.has(p))
    const removed = [...before].filter((p) => !after.has(p))
    this.requireHeld(by, [...added, ...removed], `Changing role "${id}"`)
    const spec = { title: parsed.data.title, description: parsed.data.description || undefined, permissions: PERMISSION_IDS.filter((p) => after.has(p)) }
    await this.db.query('INSERT INTO roles (id, spec) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec', [id, JSON.stringify(spec)])
    const role: RoleDef = { id, ...spec }
    this.roles.set(id, role)
    await record(this.db, 'role.changed', null, null, null, { role: id, created: !existing, added, removed, ...(existing && existing.title !== spec.title ? { title: spec.title } : {}) })
    this.log.info('role saved', { role: id, created: !existing, added, removed })
    this.events.emit({ type: 'access' })
    return role
  }

  /** People who held the role keep their place and lose what it gave. A role a token is bound to stays until the token is revoked. */
  async removeRole(id: string, by: Grantor): Promise<void> {
    if (id === ADMIN_ROLE) throw new AccessError('The admin role is the hub\'s own and cannot be removed')
    const existing = this.roles.get(id)
    if (!existing) throw new AccessError(`Unknown role "${id}"`, 404)
    this.requireHeld(by, existing.permissions, `Removing role "${id}"`)
    const bound = await this.db.query<{ name: string }>('SELECT name FROM tokens WHERE role = $1', [id])
    if (bound.rowCount) throw new AccessError(`Role "${id}" is bound to ${bound.rowCount} token(s): ${bound.rows.map((t) => t.name).join(', ')}. Revoke them first`, 409)
    const holders = [...this.users.values()].filter((u) => u.roles.includes(id))
    for (const u of holders) {
      u.roles = u.roles.filter((r) => r !== id)
      await this.db.query('UPDATE users SET roles = $2 WHERE email = $1', [u.email, JSON.stringify(u.roles)])
    }
    await this.db.query('DELETE FROM roles WHERE id = $1', [id])
    this.roles.delete(id)
    await record(this.db, 'role.changed', null, null, null, { role: id, removed: true, takenFrom: holders.map((u) => u.email) })
    this.log.info('role removed', { role: id, takenFrom: holders.length })
    this.events.emit({ type: 'access' })
  }

  // People ---------------------------------------------------------------------

  /** A person by address, or nothing when they are not here. */
  find(given: string): User | null {
    const u = this.users.get(this.address(given))
    return u ? toUser(u) : null
  }

  listUsers(): User[] {
    return [...this.users.values()].sort((a, b) => a.email.localeCompare(b.email)).map(toUser)
  }

  /** Called for every request a person makes: enrolls them the first time, and keeps what the login proxy says of them current. */
  async seen(given: string, admin: boolean): Promise<User> {
    const email = this.address(given)
    const known = this.users.get(email)
    const now = new Date()
    if (known && known.admin === admin && known.last_seen_at) {
      if (now.getTime() - known.last_seen_at.getTime() > SEEN_EVERY_MS) {
        known.last_seen_at = now
        await this.db.query('UPDATE users SET last_seen_at = $2 WHERE email = $1', [email, now])
      }
      return toUser(known)
    }
    const arriving = this.arriving.get(email) ?? this.enroll(email, admin, now).finally(() => this.arriving.delete(email))
    this.arriving.set(email, arriving)
    return arriving
  }

  /** Notes that a known person was here through their own token: their last visit moves, at most once a minute, and nothing else does. */
  async touch(given: string): Promise<void> {
    const email = this.address(given)
    const known = this.users.get(email)
    const now = new Date()
    if (!known || (known.last_seen_at && now.getTime() - known.last_seen_at.getTime() <= SEEN_EVERY_MS)) return
    known.last_seen_at = now
    await this.db.query('UPDATE users SET last_seen_at = $2 WHERE email = $1', [email, now])
  }

  private async enroll(email: string, admin: boolean, now: Date): Promise<User> {
    const before = this.users.get(email)
    const res = await this.db.query<UserRow>(
      `INSERT INTO users (email, admin, first_seen_at, last_seen_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (email) DO UPDATE SET admin = EXCLUDED.admin, first_seen_at = COALESCE(users.first_seen_at, EXCLUDED.first_seen_at), last_seen_at = EXCLUDED.last_seen_at RETURNING *`,
      [email, admin, now],
    )
    const row = res.rows[0]!
    this.users.set(email, row)
    // A person added ahead of sign-in arrives now, keeping the roles given then.
    const enrolled = !before || !before.first_seen_at
    // The request is not yet anyone's: this is what tells the hub who it is.
    await actingAs({ kind: 'user', name: email }, () => (enrolled ? record(this.db, 'user.enrolled', null, null, null, { admin, roles: row.roles }) : record(this.db, 'user.changed', null, null, null, { user: email, admin, by: 'sign-in' })))
    this.log.info(enrolled ? 'user enrolled' : 'user admin flag changed by the login proxy', { user: email, admin, roles: row.roles, addedAhead: !!before && !before.first_seen_at })
    this.events.emit({ type: 'access' })
    return toUser(row)
  }

  /**
   * Adds a person before they first sign in, with the roles they will have
   * when they do. Sign-in still decides whether they get in.
   */
  async addUser(given: string, roles: string[], by: Grantor): Promise<User> {
    const email = this.address(given)
    if (!EMAIL.test(email)) throw new AccessError(`"${given}" is not an email address`)
    if (this.users.has(email)) throw new AccessError(`${email} is already here`, 409)
    const next = this.checkRoles(roles)
    this.requireHeld(by, this.permissionsOf(next), `Adding ${email}`)
    const res = await this.db.query<UserRow>('INSERT INTO users (email, admin, roles, first_seen_at, last_seen_at) VALUES ($1, false, $2, NULL, NULL) RETURNING *', [email, JSON.stringify(next)])
    const row = res.rows[0]!
    this.users.set(email, row)
    await record(this.db, 'user.changed', null, null, null, { user: email, added: next, ahead: true })
    this.log.info('user added ahead of sign-in', { user: email, roles: next })
    this.events.emit({ type: 'access' })
    return toUser(row)
  }

  private checkRoles(roles: string[]): string[] {
    const next = [...new Set(roles)]
    const unknown = next.filter((id) => !this.roles.has(id))
    if (unknown.length) throw new AccessError(next.includes(ADMIN_ROLE) ? 'The admin role comes from the login proxy; it is not given here' : `Unknown role: ${unknown.join(', ')}`)
    return next
  }

  async setRoles(given: string, roles: string[], by: Grantor): Promise<User> {
    const email = this.address(given)
    const user = this.users.get(email)
    if (!user) throw new AccessError(`Unknown user "${email}"`, 404)
    const next = this.checkRoles(roles)
    const added = next.filter((id) => !user.roles.includes(id))
    const removed = user.roles.filter((id) => !next.includes(id))
    this.requireHeld(by, this.permissionsOf([...added, ...removed]), `Changing the roles of ${email}`)
    user.roles = next
    await this.db.query('UPDATE users SET roles = $2 WHERE email = $1', [email, JSON.stringify(next)])
    await record(this.db, 'user.changed', null, null, null, { user: email, added, removed })
    this.log.info('user roles changed', { user: email, added, removed })
    this.events.emit({ type: 'access' })
    return toUser(user)
  }

  /** Forgets a person. The login proxy still decides whether they get in: one who does is enrolled again, with no roles. */
  async removeUser(given: string, by: Grantor): Promise<void> {
    const email = this.address(given)
    const user = this.users.get(email)
    if (!user) throw new AccessError(`Unknown user "${email}"`, 404)
    this.requireHeld(by, this.permissionsOf(user.roles), `Removing ${email}`)
    await this.db.query('DELETE FROM users WHERE email = $1', [email])
    this.users.delete(email)
    await record(this.db, 'user.removed', null, null, null, { user: email, roles: user.roles })
    this.log.info('user removed', { user: email })
    this.events.emit({ type: 'access' })
  }
}

function toUser(u: UserRow): User {
  return { email: u.email, admin: u.admin, roles: u.roles, firstSeenAt: u.first_seen_at?.toISOString() ?? null, lastSeenAt: u.last_seen_at?.toISOString() ?? null }
}

function earliest(a: Date | null, b: Date | null): Date | null {
  return a && b ? (a < b ? a : b) : (a ?? b)
}

function latest(a: Date | null, b: Date | null): Date | null {
  return a && b ? (a > b ? a : b) : (a ?? b)
}
