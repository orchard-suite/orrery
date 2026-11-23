/** A time as a span from now: `5m ago`, or `in 6d` for one still to come. A time under a minute ahead is the clock being off, and reads as now. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const ms = now - new Date(iso).getTime()
  if (ms < -60_000) return `in ${span(-ms)}`
  if (ms < 0) return 'just now'
  return `${span(ms)} ago`
}

function span(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function short(value: unknown, max = 80): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max - 1)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((v) => short(v, 30)).join(', ')
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

/** A moment in full, in the reader's own time: the date, and the time to the second. */
export function exact(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

/** The local day a time fell on, as a heading over what happened then: Today, Yesterday, the weekday within the week, and the date before that. */
export function day(iso: string): string {
  const d = new Date(iso)
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const back = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000)
  if (back <= 0) return 'Today'
  if (back === 1) return 'Yesterday'
  if (back < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}

/** A length of time, in its two largest units: 45s, 3m 5s, 2h 10m, 3d 4h. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** An identifier said as words: `runs_as` reads "Runs as". Anything already written for people is left as it is. */
export function words(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) return name
  const said = name.replaceAll('_', ' ')
  return said[0]!.toUpperCase() + said.slice(1)
}

/** What a change was, said as words: `entity.updated` reads "Updated", `override.cleared` reads "Override cleared". */
export function changeWords(kind: string): string {
  const [what = '', how] = kind.split('.')
  return words(what === 'entity' && how ? how : `${what}_${how ?? ''}`.replace(/_$/, ''))
}

/** A sentence with each timestamp in it said as how long ago it was: "not seen since 2026-11-04T19:30:09Z" reads "not seen since 3h ago". */
export function humanTimes(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})/g, (iso) => ago(iso))
}

/** A long name cut in the middle, so both its start and its end still say which one it is. */
export function middle(name: string, max = 32): string {
  if (name.length <= max) return name
  const half = Math.floor((max - 1) / 2)
  return `${name.slice(0, half)}\u2026${name.slice(name.length - half)}`
}
