// The answers a backend revealed to this person, in this tab, each under its
// run. The hub keeps none, so this is the only copy: it is gone on a reload.

const told = new Map<string, string>()

/** Holds what a run's backend answered, for the page that shows the run. */
export function keepTold(run: string, answer: string): void {
  told.set(run, answer)
}

/** What a run's backend answered, while this tab still holds it. */
export function toldOf(run: string): string | undefined {
  return told.get(run)
}

/** An answer as a person reads it: a JSON answer laid out, anything else as it came. */
export function toldText(answer: string): string {
  try {
    const value: unknown = JSON.parse(answer)
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return answer
  }
}
