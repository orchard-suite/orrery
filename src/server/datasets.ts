// Published datasets: a read tool marked `dataset` answers a table that a
// saved query reads beside the catalog. The tool runs on a runner, under the
// runner's own identity, so the hub holds no key to the store behind it; who
// may read a dataset is the action's own access, or its tier, judged in
// `actions.ts`. An answer is kept in `dataset_answers` until it is older than
// the dataset's `fresh`, so a query costs a runner's job only when its rows
// are stale. Each read that calls the tool is a run of whoever read it.

import { tableOf, numberOf, type DataSet } from '../shared/report.ts'
import { DATASET_FRESH, datasetBlueprint, isFinished, parseDuration, parseEntityId, type Action, type Blueprint, type DatasetColumn, type Identity } from '../shared/model.ts'
import type { DatasetSummary } from '../shared/api.ts'
import type { Actions } from './actions.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { View } from './visibility.ts'

/** How long a read waits for the dataset's tool to answer. */
const READ_WAIT_MS = 2 * 60_000

export class DatasetError extends Error {
  readonly status: 403 | 404 | 409 | 502
  constructor(message: string, status: 403 | 404 | 409 | 502 = 502) {
    super(message)
    this.status = status
  }
}

/** The rows of a dataset as they were last read, and when. */
export interface DatasetRead {
  columns: DatasetColumn[]
  rows: unknown[][]
  total: number
  truncated: boolean
  fetchedAt: string
}

export interface DatasetsDeps {
  db: Db
  actions: Actions
  reader: Reader
  log: Logger
}

export class Datasets {
  private readonly deps: DatasetsDeps
  /** The reads of this hub under way, by dataset: readers that ask together share one call. */
  private readonly reading = new Map<string, Promise<DatasetRead>>()

  constructor(deps: DatasetsDeps) {
    this.deps = deps
  }

  /** Every dataset as the query code reads a blueprint, whoever asks: its columns typed, so a column sorts and adds up as its type. */
  blueprints(): Blueprint[] {
    return this.deps.actions.datasets().map((a) => datasetBlueprint({ id: a.id, title: a.title, description: a.description, icon: a.icon, columns: a.dataset!.columns }))
  }

  /** A dataset by its action id, or null. */
  get(id: string): Action | null {
    const a = this.deps.actions.get(id)
    return a?.dataset && a.tool ? a : null
  }

  /** Whether the reader may read this dataset. */
  async open(id: string, identity: Identity, view: View): Promise<boolean> {
    const a = this.get(id)
    return !!a && (await this.deps.actions.mayReadDataset(a, identity, view))
  }

  /** The datasets one reader may read, each with the record it reads, as they see it, and when it was last read. */
  async list(identity: Identity, view: View): Promise<DatasetSummary[]> {
    const out: DatasetSummary[] = []
    const fetched = new Map((await this.deps.db.query<{ action: string; fetched_at: Date }>('SELECT action, fetched_at FROM dataset_answers')).rows.map((r) => [r.action, r.fetched_at.toISOString()]))
    for (const a of this.deps.actions.datasets()) {
      if (!(await this.deps.actions.mayReadDataset(a, identity, view))) continue
      const ref = a.dataset!.entity ? parseEntityId(a.dataset!.entity) : null
      const entity = ref ? await this.deps.reader.get(ref) : null
      const seen = entity ? view.entity(entity) : null
      out.push({ id: a.id, title: a.title, description: a.description ?? null, icon: a.icon ?? null, columns: a.dataset!.columns, fresh: a.dataset!.fresh ?? DATASET_FRESH, entity: seen ? { blueprint: seen.blueprint, key: seen.key, title: seen.title } : null, fetchedAt: fetched.get(a.id) ?? null })
    }
    return out.sort((x, y) => x.title.localeCompare(y.title))
  }

  /**
   * A dataset's rows for one reader: the kept answer while it is fresh, else
   * a call of its tool as them, kept for the next. `fresh` calls the tool
   * whatever is kept. Refused for whoever may not read it.
   */
  async read(id: string, identity: Identity, view: View, fresh = false): Promise<DatasetRead> {
    const action = this.get(id)
    if (!action) throw new DatasetError(`Unknown dataset "${id}"`, 404)
    if (!(await this.deps.actions.mayReadDataset(action, identity, view))) throw new DatasetError(`Dataset "${id}" is not open to you`, 403)
    if (!fresh) {
      const kept = await this.kept(action)
      if (kept) return kept
    }
    const under = this.reading.get(id)
    if (under) return under
    const read = this.call(action, identity, view).finally(() => this.reading.delete(id))
    this.reading.set(id, read)
    return read
  }

  /** The kept answer of a dataset, when it is no older than its `fresh` and was read after its definition last changed. */
  private async kept(action: Action): Promise<DatasetRead | null> {
    const row = (await this.deps.db.query<{ answer: Omit<DatasetRead, 'fetchedAt'>; fetched_at: Date }>('SELECT answer, fetched_at FROM dataset_answers WHERE action = $1', [action.id])).rows[0]
    if (!row) return null
    const age = Date.now() - row.fetched_at.getTime()
    if (age > parseDuration(action.dataset!.fresh ?? DATASET_FRESH) || row.fetched_at.getTime() < Date.parse(action.updatedAt)) return null
    return { ...row.answer, fetchedAt: row.fetched_at.toISOString() }
  }

  /** Calls the dataset's tool as the reader, waits for its answer, reads it as the columns the dataset names, and keeps it. */
  private async call(action: Action, identity: Identity, view: View): Promise<DatasetRead> {
    const started = Date.now()
    const asked = await this.deps.actions.askDataset(action.id, identity, view)
    const run = isFinished(asked.state) ? asked : await this.deps.actions.settled(asked.id, this.deps.actions.waitOf(action, READ_WAIT_MS))
    if (run.state !== 'succeeded') {
      this.deps.log.warn('dataset not read: its tool did not answer', { dataset: action.id, run: run.id, state: run.state, by: identity.name })
      throw new DatasetError(`Dataset "${action.id}" was not read: its tool ${run.state === 'queued' || run.state === 'cancelled' ? 'was not taken by its runner in time' : run.state}${run.summary ? `: ${run.summary}` : ''}`)
    }
    const said = this.deps.actions.said(run)
    if (said.truncated) throw new DatasetError(`Dataset "${action.id}" answered more than one call carries: publish a smaller table`)
    const table = tableOf(said.text)
    if (table.error) throw new DatasetError(`Dataset "${action.id}" was not read: ${table.error}`)
    const read = typed(action.dataset!.columns, table)
    const fetched = await this.deps.db.query<{ fetched_at: Date }>('INSERT INTO dataset_answers (action, answer, run, fetched_at) VALUES ($1, $2, $3, now()) ON CONFLICT (action) DO UPDATE SET answer = EXCLUDED.answer, run = EXCLUDED.run, fetched_at = EXCLUDED.fetched_at RETURNING fetched_at', [action.id, JSON.stringify(read), run.id])
    this.deps.log.info('dataset read from its tool', { dataset: action.id, run: run.id, by: identity.name, rows: read.rows.length, ms: Date.now() - started })
    return { ...read, fetchedAt: fetched.rows[0]!.fetched_at.toISOString() }
  }

  /** Lets go of the kept answers of datasets that are gone. */
  async prune(): Promise<void> {
    const ids = this.deps.actions.datasets().map((a) => a.id)
    await this.deps.db.query('DELETE FROM dataset_answers WHERE NOT (action = ANY($1))', [ids])
  }
}

/** A tool's table as the dataset's own columns, in their order: each value read as its column's type, a column the tool left out empty, and one the dataset does not name dropped. */
export function typed(columns: readonly DatasetColumn[], table: DataSet): Omit<DatasetRead, 'fetchedAt'> {
  const at = columns.map((c) => table.columns.findIndex((t) => t.id.toLowerCase() === c.id.toLowerCase()))
  const read = (v: unknown, type: DatasetColumn['type']): unknown => {
    if (v === null || v === undefined || v === '') return null
    if (type === 'number') return numberOf(v)
    if (type === 'boolean') return typeof v === 'boolean' ? v : v === 'true' || v === 1 ? true : v === 'false' || v === 0 ? false : null
    if (type === 'datetime') return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : typeof v === 'number' ? new Date(v).toISOString() : null
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return { columns: [...columns], rows: table.rows.map((r) => columns.map((c, i) => (at[i]! < 0 ? null : read(r[at[i]!], c.type)))), total: table.total, truncated: table.truncated }
}
