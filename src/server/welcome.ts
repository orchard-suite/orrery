// The estate's welcome tour: what it picks to show and how it words the
// steps the hub ships (`src/shared/welcome.ts`). A git source may declare
// it under `config.welcome`, and then owns it until it stops; otherwise an
// admin sets it on the Access page. It is kept in memory and read again with
// the rest of the settings.

import { z } from 'zod'
import { DEFAULT_WELCOME, EMPTY_STEP_IDS, TOUR_STEP_IDS, WELCOME_LIMITS, type WelcomeDef } from '../shared/welcome.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { equal } from './values.ts'

const KEY = 'welcome'

const text = z.string().trim().max(WELCOME_LIMITS.text).optional()
const step = z.object({ shown: z.boolean().optional(), title: z.string().trim().max(WELCOME_LIMITS.title).optional(), text, empty: text }).strict()
const name = z.string().trim().min(1).max(500)
export const welcomeSchema = z
  .object({
    version: z.number().int().min(1).max(1_000_000).default(1),
    blueprint: name.optional(),
    example: name.optional(),
    actions: z.array(name).max(WELCOME_LIMITS.actions).optional(),
    // The one action a page a release back sends, and a tour kept by that release holds: it goes first.
    action: name.optional(),
    steps: z.partialRecord(z.enum(TOUR_STEP_IDS), step).optional(),
  })
  .strict()

export class WelcomeError extends Error {
  readonly status = 409
}

export class Welcome {
  private def: WelcomeDef = DEFAULT_WELCOME
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async load(): Promise<void> {
    const row = await this.db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY])
    if (!row.rows[0]) {
      this.def = DEFAULT_WELCOME
      return
    }
    const parsed = welcomeSchema.extend({ source: z.string().optional() }).safeParse(row.rows[0].value)
    if (!parsed.success) this.log.warn('stored welcome tour does not read; the hub gives its own', { error: parsed.error.message })
    this.def = parsed.success ? tidy(parsed.data) : DEFAULT_WELCOME
  }

  get(): WelcomeDef {
    return this.def
  }

  /** An admin's change. Refused while a git source declares the tour. */
  async set(input: unknown, actor: string): Promise<WelcomeDef> {
    if (this.def.source) throw new WelcomeError(`The welcome tour is declared in git by source "${this.def.source}"; change it there`)
    return this.write(welcomeSchema.parse(input), null, actor)
  }

  /** A git source declares the tour. Refused when another source already does. */
  async declare(input: unknown, source: string): Promise<WelcomeDef> {
    if (this.def.source && this.def.source !== source) throw new WelcomeError(`the welcome tour is already declared by source "${this.def.source}"`)
    return this.write(welcomeSchema.parse(input), source, source)
  }

  /** A git source that stops declaring the tour leaves it as it stands for an admin to change. */
  async release(source: string): Promise<boolean> {
    if (this.def.source !== source) return false
    const { source: _source, ...rest } = this.def
    await this.save(rest)
    await record(this.db, 'welcome.changed', null, null, null, { releasedBy: source })
    this.log.info('welcome tour released: the catalog no longer declares it', { source })
    return true
  }

  private async write(spec: z.infer<typeof welcomeSchema>, source: string | null, actor: string): Promise<WelcomeDef> {
    const next = tidy({ ...spec, ...(source ? { source } : {}) })
    if (equal(next, this.def)) {
      this.log.info('welcome tour saved as it was; nothing changed', { actor })
      return this.def
    }
    const before = this.def
    await this.save(next)
    await record(this.db, 'welcome.changed', null, source, null, { before, after: next })
    this.log.info('welcome tour set', { actor, source, version: next.version, steps: Object.keys(next.steps ?? {}).length })
    return next
  }

  private async save(next: WelcomeDef): Promise<void> {
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(next)])
    this.def = next
  }
}

/** The tour as it is kept: empty words and steps that change nothing left out, in the order the hub shows the steps, and each action once. */
function tidy(def: WelcomeDef & { action?: string }): WelcomeDef {
  const actions = [...new Set([...(def.action ? [def.action] : []), ...(def.actions ?? [])])].slice(0, WELCOME_LIMITS.actions)
  const steps = TOUR_STEP_IDS.flatMap((id) => {
    const own = def.steps?.[id]
    if (!own) return []
    const kept = { ...(own.shown === false ? { shown: false } : {}), ...(own.title ? { title: own.title } : {}), ...(own.text ? { text: own.text } : {}), ...(own.empty && EMPTY_STEP_IDS.includes(id) ? { empty: own.empty } : {}) }
    return Object.keys(kept).length ? [[id, kept] as const] : []
  })
  return { version: def.version, ...(def.blueprint ? { blueprint: def.blueprint } : {}), ...(def.example ? { example: def.example } : {}), ...(actions.length ? { actions } : {}), ...(steps.length ? { steps: Object.fromEntries(steps) } : {}), ...(def.source ? { source: def.source } : {}) }
}
