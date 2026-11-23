// Previews: the views the hub holds back until an admin opens them. Each is
// closed to everyone on a new hub, and an admin opens one to the people
// named, then to everyone, on the Access page. What a preview covers is
// answered as if it did not exist to a caller it is not open to.

import { z } from 'zod'
import { PREVIEWS, type PreviewName, type Previews as PreviewSet } from '../shared/api.ts'
import type { Identity } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

const KEY = 'previews'

const settingSchema = z
  .object({
    open: z.enum(['nobody', 'people', 'everyone']),
    people: z.array(z.string().trim().toLowerCase().min(1).max(320)).max(1000).default([]),
  })
  .strict()
  .transform((s) => ({ open: s.open, people: [...new Set(s.people)].sort() }))
const CLOSED = { open: 'nobody' as const, people: [] }
export const previewsSchema = z.object({ garden: settingSchema.default(CLOSED), welcome: settingSchema.default(CLOSED) }).strict()

const NONE: PreviewSet = { garden: CLOSED, welcome: CLOSED }

export class Previews {
  private set: PreviewSet = NONE

  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async read(): Promise<void> {
    const row = await this.db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY])
    const parsed = previewsSchema.safeParse(row.rows[0]?.value ?? {})
    if (!parsed.success) this.log.warn('stored previews do not read; every preview is closed', { error: parsed.error.message })
    this.set = parsed.success ? parsed.data : NONE
  }

  get(): PreviewSet {
    return this.set
  }

  async save(given: unknown): Promise<PreviewSet> {
    const next = previewsSchema.parse(given)
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(next)])
    this.set = next
    return next
  }

  /** Whether a preview is open to this caller. Only a person can be named: a personal token is the person, and a view as someone is theirs. */
  open(name: PreviewName, identity: Pick<Identity, 'kind' | 'name'>): boolean {
    const setting = this.set[name]
    if (setting.open === 'everyone') return true
    return setting.open === 'people' && identity.kind === 'user' && setting.people.includes(identity.name.toLowerCase())
  }

  /** Every preview open to this caller. */
  openTo(identity: Pick<Identity, 'kind' | 'name'>): PreviewName[] {
    return PREVIEWS.filter((name) => this.open(name, identity))
  }
}
