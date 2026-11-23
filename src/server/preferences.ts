// What each person keeps for themselves on every device: their preferences,
// by the names `PREFERENCES` in src/shared/preferences.ts holds. A preference
// is theirs alone, so setting one is no change to the estate and writes no
// activity row. The table is read on every ask and never kept in memory, so
// hubs have nothing to tell each other about it.

import { PREFERENCES, preferencesOf, type PreferenceName, type PreferenceValues } from '../shared/preferences.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

/** A value a preference does not take. */
export class PreferenceError extends Error {
  readonly status = 400
}

export class Preferences {
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** Every preference of a person, a name they never set as its fallback. */
  async of(person: string): Promise<PreferenceValues> {
    const rows = await this.db.query<{ name: string; value: unknown }>('SELECT name, value FROM person_preferences WHERE person = $1', [person])
    return preferencesOf(Object.fromEntries(rows.rows.map((r) => [r.name, r.value])))
  }

  /** Sets one preference. False when it already held that value, which writes nothing. */
  async set(person: string, name: PreferenceName, given: unknown): Promise<boolean> {
    const value = PREFERENCES[name].read(given)
    if (value === undefined) {
      this.log.info('preference refused: not a value it takes', { person, name })
      throw new PreferenceError(`"${name}" does not take that value: ${PREFERENCES[name].description}`)
    }
    const saved = await this.db.query(
      `INSERT INTO person_preferences (person, name, value) VALUES ($1, $2, $3)
       ON CONFLICT (person, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE person_preferences.value IS DISTINCT FROM EXCLUDED.value`,
      [person, name, JSON.stringify(value)],
    )
    const changed = (saved.rowCount ?? 0) > 0
    this.log.info(changed ? 'preference set' : 'preference saved as it was', { person, name })
    return changed
  }
}
