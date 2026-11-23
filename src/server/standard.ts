// The estate's column standard: one order and one set of hidden columns for
// every catalog grid. A git source may declare it, and then owns it until it
// stops; otherwise whoever arranges grids changes it. A grid's own layout
// keeps only what a person changed by hand on top of it.

import { z } from 'zod'
import { DEFAULT_STANDARD, type ColumnStandard } from '../shared/columns.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { equal } from './values.ts'

const KEY = 'grid.standard'

const pattern = z.string().min(1).max(200)
export const columnStandardSchema = z.object({
  ranks: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().max(200).optional(), description: z.string().max(2000).optional(), columns: z.array(pattern).max(200) })).min(1).max(50),
  hidden: z.array(pattern).max(500).optional(),
  widths: z.record(pattern, z.number().int().min(40).max(800)).optional(),
})

export class StandardError extends Error {}

export class ColumnStandards {
  private standard: ColumnStandard = DEFAULT_STANDARD
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async load(): Promise<void> {
    const row = await this.db.query<{ value: ColumnStandard }>('SELECT value FROM settings WHERE key = $1', [KEY])
    this.standard = row.rows[0]?.value ?? DEFAULT_STANDARD
  }

  get(): ColumnStandard {
    return this.standard
  }

  /** A person's change. Refused while a git source declares the standard. */
  async set(input: unknown): Promise<ColumnStandard> {
    if (this.standard.source) throw new StandardError(`The column standard is declared in git by source "${this.standard.source}"; change it there`)
    return this.write(columnStandardSchema.parse(input), null)
  }

  /** A git source declares the standard. Refused when another source already does. */
  async declare(input: unknown, source: string): Promise<ColumnStandard> {
    if (this.standard.source && this.standard.source !== source) throw new StandardError(`the column standard is already declared by source "${this.standard.source}"`)
    return this.write(columnStandardSchema.parse(input), source)
  }

  /** A git source that stops declaring the standard leaves it as it stands for people to change. */
  async release(source: string): Promise<boolean> {
    if (this.standard.source !== source) return false
    const { source: _source, ...rest } = this.standard
    await this.save(rest)
    await record(this.db, 'grid.standard', null, null, null, { releasedBy: source })
    return true
  }

  private async write(spec: Omit<ColumnStandard, 'source'>, source: string | null): Promise<ColumnStandard> {
    const next: ColumnStandard = { ranks: spec.ranks, ...(spec.hidden ? { hidden: spec.hidden } : {}), ...(spec.widths ? { widths: spec.widths } : {}), ...(source ? { source } : {}) }
    if (equal(next, this.standard)) return this.standard
    const before = this.standard
    await this.save(next)
    await record(this.db, 'grid.standard', null, source, null, { ranks: next.ranks.map((r) => r.id), before: before.ranks.map((r) => r.id), hidden: next.hidden ?? [] })
    this.log.info('column standard set', { ranks: next.ranks.length, hidden: next.hidden?.length ?? 0, source })
    return next
  }

  private async save(next: ColumnStandard): Promise<void> {
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(next)])
    this.standard = next
  }
}
