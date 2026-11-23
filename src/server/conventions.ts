// The estate's relation conventions (`src/shared/conventions.ts`). A git
// source may declare them under `config.conventions`, and then owns them
// until it stops; otherwise whoever changes the model sets them. They are
// kept in memory and read again with the rest of the settings.

import { z } from 'zod'
import { NO_CONVENTIONS, type Conventions as ConventionsDef, type RelationConvention } from '../shared/conventions.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { equal } from './values.ts'

const KEY = 'model.conventions'

const name = z.string().trim().min(1).max(200)
export const conventionsSchema = z
  .object({
    conventions: z
      .array(
        z
          .object({
            id: name,
            title: z.string().trim().max(200).optional(),
            description: z.string().trim().max(2000).optional(),
            groups: z.array(name).min(1).max(100),
            relations: z.array(name).min(1).max(50),
          })
          .strict(),
      )
      .max(50)
      .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'each convention needs its own id'),
  })
  .strict()

export class ConventionError extends Error {}

export class Conventions {
  private kept: ConventionsDef = NO_CONVENTIONS
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async load(): Promise<void> {
    const row = await this.db.query<{ value: ConventionsDef }>('SELECT value FROM settings WHERE key = $1', [KEY])
    this.kept = row.rows[0]?.value ?? NO_CONVENTIONS
  }

  get(): ConventionsDef {
    return this.kept
  }

  /** A person's change. Refused while a git source declares the conventions. */
  async set(input: unknown): Promise<ConventionsDef> {
    if (this.kept.source) throw new ConventionError(`The relation conventions are declared in git by source "${this.kept.source}"; change them there`)
    return this.write(conventionsSchema.parse(input).conventions, null)
  }

  /** A git source declares the conventions. Refused when another source already does. */
  async declare(input: unknown, source: string): Promise<ConventionsDef> {
    if (this.kept.source && this.kept.source !== source) throw new ConventionError(`the relation conventions are already declared by source "${this.kept.source}"`)
    return this.write(conventionsSchema.parse(input).conventions, source)
  }

  /** A git source that stops declaring the conventions leaves them as they stand for people to change. */
  async release(source: string): Promise<boolean> {
    if (this.kept.source !== source) return false
    await this.save({ conventions: this.kept.conventions })
    await record(this.db, 'model.conventions', null, source, null, { releasedBy: source })
    this.log.info('relation conventions released: the catalog no longer declares them', { source })
    return true
  }

  private async write(conventions: RelationConvention[], source: string | null): Promise<ConventionsDef> {
    const next: ConventionsDef = { conventions, ...(source ? { source } : {}) }
    if (equal(next, this.kept)) return this.kept
    const before = this.kept.conventions.map((c) => c.id)
    await this.save(next)
    await record(this.db, 'model.conventions', null, source, null, { conventions: conventions.map((c) => c.id), before })
    this.log.info('relation conventions set', { conventions: conventions.length, source })
    return next
  }

  private async save(next: ConventionsDef): Promise<void> {
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(next)])
    this.kept = next
  }
}
