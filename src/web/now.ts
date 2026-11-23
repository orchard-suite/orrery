// What the Now page says: whose things it speaks for, the areas a reader sees
// with how healthy each is, the one sentence that answers "is it healthy", and
// what needs a person, worst first. Pure, so the page and its tests read the
// same answer.

import type { Alert, MineResponse, NotGreenCounts, SummaryResponse, WallCell } from '../shared/api.ts'
import { entityId, type Blueprint, type StatusLevel } from '../shared/model.ts'

const RANK: Record<StatusLevel, number> = { red: 3, amber: 2, grey: 1, green: 0 }
export const worse = (a: StatusLevel, b: StatusLevel): StatusLevel => (RANK[a] >= RANK[b] ? a : b)

/** A status from counts of what is not green: the worst one present. */
export const levelOf = (n: NotGreenCounts): StatusLevel => (n.red ? 'red' : n.amber ? 'amber' : n.grey ? 'grey' : 'green')

/** How bad a firing alert is. A critical or paging alert is red; a warning is amber; an info or a watchdog says nothing is wrong. */
export function alertLevel(alert: Pick<Alert, 'labels'>): StatusLevel {
  const severity = (alert.labels.severity ?? '').toLowerCase()
  if (/^(critical|page|high|error)$/.test(severity)) return 'red'
  if (severity === 'info' || severity === 'none' || alert.labels.alertname === 'Watchdog') return 'grey'
  return 'amber'
}

export interface Kind {
  id: string
  title: string
  count: number
  notGreen: NotGreenCounts
  level: StatusLevel
}

export interface Area {
  name: string
  kinds: Kind[]
  count: number
  notGreen: NotGreenCounts
  level: StatusLevel
}

const add = (a: NotGreenCounts, b: NotGreenCounts): NotGreenCounts => ({ red: a.red + b.red, amber: a.amber + b.amber, grey: a.grey + b.grey })
const none: NotGreenCounts = { red: 0, amber: 0, grey: 0 }

/** The catalog's groups, in its order, each with its kinds and their health. Kinds a group shares nothing under go in "Other". */
export function areasOf(blueprints: Pick<Blueprint, 'id' | 'title' | 'group'>[], summary: Pick<SummaryResponse, 'blueprints'>, name: (b: Pick<Blueprint, 'id' | 'title' | 'group'>) => string = (b) => b.title): Area[] {
  const counts = new Map(summary.blueprints.map((b) => [b.id, b]))
  const areas = new Map<string, Area>()
  for (const b of blueprints) {
    const s = counts.get(b.id)
    const notGreen = s?.notGreen ?? none
    const kind: Kind = { id: b.id, title: name(b), count: s?.active ?? 0, notGreen, level: levelOf(notGreen) }
    const group = b.group?.trim() || 'Other'
    const area = areas.get(group) ?? { name: group, kinds: [], count: 0, notGreen: none, level: 'green' }
    area.kinds.push(kind)
    area.count += kind.count
    area.notGreen = add(area.notGreen, notGreen)
    area.level = worse(area.level, kind.level)
    areas.set(group, area)
  }
  return [...areas.values()]
}

export interface Verdict {
  level: StatusLevel
  /** The one thing that is red, when only one is: the headline leads with it. */
  lead: WallCell | null
  /** How many are red, when more than one is: the headline leads with the count, so it stays one line. */
  count: string | null
  /** The rest of the sentence after the lead or the count, or the whole of it when nothing is red. */
  rest: string
}

// A number and its noun never part at a line's end.
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')}\u00a0${n === 1 ? one : many}`

/**
 * Whose things a sentence speaks for: the reader's own, everything shared
 * with a reader who does not see it all, or the whole estate for one who does.
 */
export type Whose = 'yours' | 'shared' | 'estate'

/**
 * Who the page speaks to. It leads with what is theirs when the hub knows; it
 * never calls something theirs that it cannot show is, and never calls what a
 * reader sees the estate unless they see all of it.
 */
export interface Perspective {
  whose: Whose
  /** Why the page is not about the reader's own, when it is not. */
  because: 'unset' | 'unknown' | 'none' | null
  seesAll: boolean
}

export function perspectiveOf(mine: Pick<MineResponse, 'seesAll' | 'state' | 'count'>): Perspective {
  const wide: Whose = mine.seesAll ? 'estate' : 'shared'
  if (mine.state !== 'known') return { whose: wide, because: mine.state, seesAll: mine.seesAll }
  if (!mine.count) return { whose: wide, because: 'none', seesAll: mine.seesAll }
  return { whose: 'yours', because: null, seesAll: mine.seesAll }
}

/** The summary's shape, of what is the reader's own: their things not green, worst first, and their counts per kind. */
export function yoursOf(mine: Pick<MineResponse, 'things' | 'blueprints'>): Pick<SummaryResponse, 'notGreen' | 'blueprints'> {
  return {
    notGreen: mine.things.filter((t) => t.level !== 'green'),
    blueprints: Object.entries(mine.blueprints).map(([id, b]) => ({ id, title: id, active: b.count, missing: 0, notGreen: b.notGreen })),
  }
}

/** One kind of the reader's own, as the Yours list shows it: how many, and the worst of them. */
export interface OwnKind {
  id: string
  count: number
  level: StatusLevel
}

/**
 * Every role the reader's things carry, most things first, counted over all of
 * them. A hub one release back counts no roles per kind, and then only the
 * things it sent are counted.
 */
export function ownRoles(mine: Pick<MineResponse, 'things' | 'blueprints'>): [string, number][] {
  const out = new Map<string, number>()
  const kinds = Object.values(mine.blueprints)
  if (kinds.some((b) => b.as)) for (const b of kinds) for (const [r, n] of Object.entries(b.as ?? {})) out.set(r, (out.get(r) ?? 0) + n)
  else for (const t of mine.things) for (const r of t.as) out.set(r, (out.get(r) ?? 0) + 1)
  return [...out].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
}

/**
 * The reader's own kinds, biggest first, green ones too: every kind the hub
 * counted, not only the kinds of the things it sent. With a role, only what
 * that role reaches; the worst of it comes from the things sent, which hold
 * every one that is not green.
 */
export function ownKinds(mine: Pick<MineResponse, 'things' | 'blueprints'>, role: string | null = null): OwnKind[] {
  return Object.entries(mine.blueprints)
    .map(([id, b]) => {
      if (!role) return { id, count: b.count, level: levelOf(b.notGreen) }
      const unwell = mine.things.filter((t) => t.entity.blueprint === id && t.as.includes(role))
      return { id, count: b.as?.[role] ?? unwell.length, level: unwell.reduce<StatusLevel>((w, t) => worse(w, t.level), 'green') }
    })
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/** Alerts on what is the reader's, as the hub marked them, or on what is not. An alert matched to nothing is no one's. */
export const alertsOn = <A extends Pick<Alert, 'yours'>>(alerts: A[], theirs = true): A[] => alerts.filter((a) => (a.yours ?? false) === theirs)

/** The one sentence that says how things are: the reader's own, what they see, or the whole estate. */
export function verdictOf(summary: Pick<SummaryResponse, 'notGreen' | 'blueprints'>, alerts: Pick<Alert, 'labels' | 'status'>[], whose: Whose = 'estate'): Verdict {
  const total = summary.blueprints.reduce((n, b) => add(n, b.notGreen ?? none), none)
  const firing = alerts.filter((a) => a.status === 'firing' && alertLevel(a) !== 'grey')
  const critical = firing.filter((a) => alertLevel(a) === 'red').length
  const reds = summary.notGreen.filter((c) => c.level === 'red')
  const lead = reds[0] ?? null
  const own = whose === 'yours'
  const on = own ? ' on your things' : ''
  const alertWords = firing.length ? `${plural(firing.length, 'alert')} ${firing.length === 1 ? 'is' : 'are'} firing${on}${critical ? `, ${critical}\u00a0critical` : ''}` : ''
  const things = (n: number) => plural(n, own ? 'thing of yours' : 'thing', own ? 'things of yours' : 'things')
  const nothing = own ? 'Nothing of yours is down.' : whose === 'shared' ? 'Nothing you can see is down.' : 'Nothing is down.'
  const tail = alertWords ? ` ${cap(alertWords)}.` : ''
  // Many red things lead with how many; only a lone one is named, since one long name would take the line the count needs.
  if (total.red > 1) return { level: 'red', lead: null, count: things(total.red), rest: ` are failing.${tail}` }
  if (lead) return { level: 'red', lead, count: null, rest: ` is failing.${tail}` }
  if (critical) return { level: 'red', lead: null, count: null, rest: `${cap(alertWords)}.` }
  if (total.amber || firing.length) return { level: 'amber', lead: null, count: null, rest: `${nothing} ${[total.amber ? `${things(total.amber)} want${total.amber === 1 ? 's' : ''} a look` : '', alertWords].filter(Boolean).map(cap).join('. ')}.` }
  if (total.grey) return { level: 'grey', lead: null, count: null, rest: `${nothing} ${things(total.grey)} ${total.grey === 1 ? 'has' : 'have'} not reported.` }
  if (own) {
    const n = summary.blueprints.reduce((k, b) => k + b.active, 0)
    return { level: 'green', lead: null, count: null, rest: n === 1 ? 'Your one thing is green.' : `Your ${n.toLocaleString('en-US')}\u00a0things are all green.` }
  }
  return { level: 'green', lead: null, count: null, rest: whose === 'shared' ? 'All green. Everything you can see answers.' : 'All green. Everything answers.' }
}

/** How many things are failing, how many alerts fire, and how many things want a look. */
export type Tally = { failing: number; firing: number; look: number }

export const tallyOf = (summary: Pick<SummaryResponse, 'blueprints'>, alerts: Pick<Alert, 'labels' | 'status'>[]): Tally => ({
  failing: summary.blueprints.reduce((n, b) => n + b.notGreen.red, 0),
  firing: alerts.filter((a) => a.status === 'firing' && alertLevel(a) !== 'grey').length,
  look: summary.blueprints.reduce((n, b) => n + b.notGreen.amber, 0),
})

/**
 * The line under a verdict about the reader's own that says what is wrong
 * outside it, so their green never reads as everyone's. Null when nothing
 * outside it is wrong.
 */
export function elsewhereOf(tally: Tally, seesAll: boolean): { level: StatusLevel; text: string } | null {
  const where = seesAll ? 'in the estate' : 'you can see'
  const are = (n: number) => (n === 1 ? 'is' : 'are')
  if (tally.failing) return { level: 'red', text: `${plural(tally.failing, 'other thing', 'other things')} ${where} ${are(tally.failing)} failing. None of ${tally.failing === 1 ? 'it is' : 'them are'} yours.` }
  if (tally.firing) return { level: 'amber', text: `${plural(tally.firing, 'alert')} ${are(tally.firing)} firing on things that are not yours.` }
  if (tally.look) return { level: 'amber', text: `${plural(tally.look, 'other thing', 'other things')} ${where} want${tally.look === 1 ? 's' : ''} a look. None of ${tally.look === 1 ? 'it is' : 'them are'} yours.` }
  return null
}

/**
 * The area open under the sky before a reader chooses one: where most of
 * their own things are, when they have some; else the worst, and the biggest
 * of those.
 */
/** An area's kinds, biggest first: the order its list shows them in. */
export const bySize = (area: Area): Kind[] => [...area.kinds].sort((a, b) => b.count - a.count)

/** The failing kinds of an area, in its list's order: each carries a number on the sky and the same number in the list. */
export const numbered = (area: Area): Kind[] => bySize(area).filter((k) => k.level === 'red')

export function firstArea(areas: Area[], yours: Record<string, { count: number }> | null): Area | undefined {
  const theirs = (a: Area) => a.kinds.reduce((n, k) => n + (yours?.[k.id]?.count ?? 0), 0)
  const home = [...areas].sort((a, b) => theirs(b) - theirs(a) || RANK[b.level] - RANK[a.level] || b.count - a.count)[0]
  if (home && theirs(home) > 0) return home
  return [...areas].sort((a, b) => RANK[b.level] - RANK[a.level] || b.count - a.count)[0]
}

/** A sentence without the addresses an alert's text often carries: they are links to follow, not words to read. */
const plain = (s: string) => s.replace(/\s*\(?https?:\/\/\S+\)?/g, '').trim()

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

export interface Need {
  level: StatusLevel
  title: string
  why: string
  /** How many alike: the same alert firing on several things counts once. */
  count: number
  since: string | null
  entity: WallCell['entity'] | null
  /** For an alert on several things, how many other places it fires besides `entity`, which is where it fires most. */
  elsewhere: number
  /** A row that stands for every thing of one kind at this level: the kind's id, so the row opens its grid. */
  blueprint: string | null
  kind: 'entity' | 'alert' | 'kind'
}

/**
 * What needs a person, worst first: red things one by one, then alerts by
 * name, then amber things by kind. Grey waits elsewhere. `byKind` false lists
 * amber things one by one too: a row for a kind opens its whole grid, which is
 * more than a reader's own.
 */
export function needsOf(summary: Pick<SummaryResponse, 'notGreen'>, alerts: Pick<Alert, 'labels' | 'annotations' | 'status' | 'startsAt' | 'entity'>[], byKind = true): Need[] {
  const out: Need[] = []
  const entity = (c: WallCell): Need => ({ level: c.level, title: c.title, why: c.reasons[0] ?? '', count: 1, since: null, entity: c.entity, elsewhere: 0, blueprint: null, kind: 'entity' })
  for (const c of summary.notGreen) if (c.level === 'red') out.push(entity(c))
  const byName = new Map<string, Need>()
  for (const a of alerts) {
    const level = alertLevel(a)
    if (a.status !== 'firing' || level === 'grey') continue
    const name = a.labels.alertname ?? 'Alert'
    const had = byName.get(name)
    if (had) {
      had.count++
      if (a.startsAt && (!had.since || a.startsAt < had.since)) had.since = a.startsAt
      had.level = worse(had.level, level)
      continue
    }
    byName.set(name, { level, title: name, why: plain(a.annotations.summary ?? a.annotations.description ?? ''), count: 1, since: a.startsAt, entity: a.entity, elsewhere: 0, blueprint: null, kind: 'alert' })
  }
  // An alert on several things names the place it fires most, and says how many others there are.
  for (const need of byName.values()) {
    const at = new Map<string, { ref: NonNullable<Need['entity']>; n: number }>()
    for (const a of alerts) {
      if (a.status !== 'firing' || (a.labels.alertname ?? 'Alert') !== need.title || !a.entity) continue
      const key = `${a.entity.blueprint}:${a.entity.key}`
      at.set(key, { ref: a.entity, n: (at.get(key)?.n ?? 0) + 1 })
    }
    const most = [...at.values()].sort((x, y) => y.n - x.n)[0]
    if (most) need.entity = most.ref
    need.elsewhere = Math.max(0, at.size - 1)
  }
  out.push(...[...byName.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || b.count - a.count))
  // One amber thing reads as itself; several of a kind read as one row that names a few of them.
  for (const [blueprint, cells] of Map.groupBy(summary.notGreen.filter((c) => c.level === 'amber'), (c) => c.entity.blueprint)) {
    if (cells.length === 1 || !byKind) {
      out.push(...cells.map(entity))
      continue
    }
    const names = [...new Set(cells.map((c) => c.title))]
    const rest = cells.length - Math.min(names.length, 2)
    out.push({ level: 'amber', title: blueprint, why: `${names.slice(0, 2).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`, count: cells.length, since: null, entity: null, elsewhere: 0, blueprint, kind: 'kind' })
  }
  return out
}
