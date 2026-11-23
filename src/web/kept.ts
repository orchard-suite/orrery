// The last answers the front page was given, kept in this browser so the page
// paints at once the next time it opens, while the hub builds the fresh ones.
// A kept answer is one person's: it is given back only to the person it was
// given to, once the hub has said who is signed in, and never while an admin
// views the hub as someone else.

// Named for the shape of what is kept: a page never paints with an answer of a shape it no longer reads.
const KEY = 'orrery.kept.2'
/** Keys of shapes no page reads now, let go of when the shelf is read. */
const GONE = ['orrery.kept']

/** The answers one person was last given, by what each was. */
interface Kept {
  who: string
  at: number
  answers: Record<string, unknown>
}

export interface Shelf {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The browser's storage, or nothing where it is blocked: a page then shows nothing kept and keeps nothing. */
function shelf(): Shelf | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(store: Shelf): Kept | null {
  try {
    for (const key of GONE) store.removeItem(key)
    const raw = store.getItem(KEY)
    if (!raw) return null
    const kept = JSON.parse(raw) as Kept
    return typeof kept.who === 'string' && kept.answers && typeof kept.answers === 'object' ? kept : null
  } catch {
    return null
  }
}

/** The answer `what` was last given to `who`, or undefined when there is none or it was someone else's. */
export function recall<T>(what: string, who: string, store: Shelf | null = shelf()): T | undefined {
  if (!store) return undefined
  const kept = read(store)
  if (!kept || kept.who !== who) return undefined
  return kept.answers[what] as T | undefined
}

/** Keeps the answer `what` was just given to `who`. Another person's answers are let go of first. */
export function remember(what: string, who: string, answer: unknown, store: Shelf | null = shelf(), now = Date.now()): void {
  if (!store) return
  const kept = read(store)
  const mine = kept && kept.who === who ? kept : { who, at: now, answers: {} }
  mine.answers[what] = answer
  mine.at = now
  try {
    store.setItem(KEY, JSON.stringify(mine))
  } catch {
    // Full or blocked: the next page opens cold, as before. Nothing kept is better than a half-written answer.
    try {
      store.removeItem(KEY)
    } catch {}
  }
}
