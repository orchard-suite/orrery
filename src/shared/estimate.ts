/**
 * How long a batch takes: one reading, shared by the drawer that asks for a
 * batch and the page that follows it, so the two never disagree.
 *
 * Before a batch has a pace of its own, its time is read from the action's
 * history: each run costs the action's mean time, and `width` runs go at once.
 * Once enough of its runs have ended lately, its own pace takes over, which
 * holds every cost the history does not: claiming, retries, a slow day.
 */

/** How many runs go at once: a number, or every one, for a backend the hub hands all at once. */
export type BatchWidth = number | 'all'

/** How long is left, in seconds, and what it is read from: the action's history, or the batch's own pace. */
export interface BatchEstimate {
  seconds: number
  basis: 'history' | 'pace'
}

/** How many runs must have ended in the window before a batch's own pace is trusted. */
export const PACE_ENOUGH = 20
/** How far back a batch's pace is read, in seconds: long enough to be steady, short enough to follow a change. */
export const PACE_WINDOW = 300

export interface EstimateInput {
  /** The runs still to run, with whatever waits ahead of them. */
  left: number
  /** The action's mean seconds a run, or null when it has too little history. */
  meanSeconds: number | null
  width: BatchWidth | null
  /** Runs of the batch that ended in the window, and the seconds of the window they ended in. */
  pace?: { ended: number; seconds: number }
}

/** How long is left, or null when nothing says. */
export function estimate(input: EstimateInput): BatchEstimate | null {
  if (input.left <= 0) return { seconds: 0, basis: input.pace ? 'pace' : 'history' }
  const pace = input.pace
  if (pace && pace.ended >= PACE_ENOUGH && pace.seconds > 0) return { seconds: Math.round((input.left * pace.seconds) / pace.ended), basis: 'pace' }
  if (input.meanSeconds === null || input.width === null) return null
  const width = input.width === 'all' ? input.left : Math.max(1, input.width)
  // Runs flow through the runner one after another, not in waves: the last few still take a whole run each.
  return { seconds: Math.round(Math.max(1, input.left / width) * input.meanSeconds), basis: 'history' }
}

/** A time to go, as a person says it: "under a minute", "about 25 min", "about 2 h 10 min". */
export function roughly(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `about ${h} h ${m} min` : `about ${h} h`
}
