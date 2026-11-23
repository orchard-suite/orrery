import { ACTION_ICON, type AccessGrant } from '../../shared/model.ts'
import type { PostureItem, PostureResponse } from '../../shared/posture.ts'
import { grantWords, plural } from './security-words.ts'

// What the Security page's Actions tab shows and how its filters decide,
// worked out from the posture alone. The component draws what this says.

/** The filters above the table. Each one set narrows the rows further. */
export interface ActionFilter {
  /** A person or token, as `kind:name`: the actions they may run. */
  person: string | null
  /** A team, by the id `teamsOf` gives it: the actions a grant naming it opens. */
  team: string
  /** An audience, by id: the actions that name it. */
  audience: string
  /** A backend, by type. */
  backend: string
  everyone: boolean
  noApproval: boolean
  neverRun: boolean
}

export const NO_FILTER: ActionFilter = { person: null, team: '', audience: '', backend: '', everyone: false, noApproval: false, neverRun: false }

export function filtering(f: ActionFilter): boolean {
  return !!f.person || !!f.team || !!f.audience || !!f.backend || f.everyone || f.noApproval || f.neverRun
}

/** One action as the table reads it. What a hub one release back does not send is left undefined. */
export interface ActionRow {
  id: string
  title: string
  icon: string
  /** Where it belongs, as the reader of the page sees it. */
  home: { id: string; title: string } | null
  /** Who may run it, one chip each, in the words the page uses elsewhere. */
  who: string[]
  /** How many of the known people may run it. */
  people: number
  approval: 'Always' | 'By rule' | 'None'
  /** The backend's type, and the word for it. */
  type: string
  backend: string
  /** Null when it never ran; undefined when the hub does not say. */
  lastRunAt: string | null | undefined
  runs90: number | undefined
}

const BACKENDS: Record<string, string> = {
  webhook: 'Webhook',
  github_workflow: 'GitHub workflow',
  runner: 'Runner',
  job: 'A container for each run',
  record: 'Record an entity',
  caller: 'Done by whoever asks',
}

/** The word for a backend's type; a type this page does not know is shown as it is. */
export function backendWord(type: string): string {
  return BACKENDS[type] ?? type
}

/** Whether a run waits for someone's yes: every run, the runs some rule takes, or none. */
export function approvalOf(i: PostureItem): 'always' | 'rule' | 'none' {
  if (i.action?.approval) return 'always'
  return i.action?.rules.some((r) => r.approval) ? 'rule' : 'none'
}

const APPROVAL = { always: 'Always', rule: 'By rule', none: 'None' } as const

const actionsOf = (data: PostureResponse): PostureItem[] => data.items.filter((i) => i.target.kind === 'action' && i.action)

const isEveryone = (i: PostureItem): boolean => i.action?.everyone ?? i.open

const audienceTitle = (data: PostureResponse, id: string): string => data.policy.policy.audiences.find((a) => a.id === id)?.title ?? id

function rowOf(i: PostureItem, data: PostureResponse): ActionRow {
  const a = i.action!
  const who = [
    ...(isEveryone(i) ? ['Everyone signed in'] : []),
    ...i.audiences.map((id) => audienceTitle(data, id)),
    ...i.grants.map(grantWords),
    ...(a.homePeople ? ["Its home's people"] : []),
    ...(a.rules.length ? [plural(a.rules.length, 'rule')] : []),
  ]
  return {
    id: i.target.kind === 'action' ? i.target.id : '',
    title: i.title,
    icon: a.icon ?? ACTION_ICON,
    home: a.home ?? null,
    who: who.length ? who : ['Admins only'],
    people: i.people,
    approval: APPROVAL[approvalOf(i)],
    type: a.backend,
    backend: backendWord(a.backend),
    lastRunAt: a.lastRunAt,
    runs90: a.runs90,
  }
}

/** Every action as a row, by title. */
export function actionRows(data: PostureResponse): ActionRow[] {
  return actionsOf(data)
    .map((i) => rowOf(i, data))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

/** Every grant an action carries: its own, and those of its rules. */
const grantsOf = (i: PostureItem): AccessGrant[] => [...i.grants, ...(i.action?.rules.flatMap((r) => [...(r.grants ?? []), ...(r.require ?? [])]) ?? [])]

/** A team's id: where a grant reads from, and one value it names, whatever its case. */
const teamId = (g: AccessGrant, value: string): string => `${g.path ?? ''}|${g.field ?? ''}|${value.toLowerCase()}`

/** The teams the actions' grants name, one for each value, in the words of a grant. */
export function teamsOf(data: PostureResponse): { id: string; words: string }[] {
  const out = new Map<string, string>()
  for (const i of actionsOf(data)) {
    for (const g of grantsOf(i)) {
      for (const value of g.values) {
        const id = teamId(g, value)
        if (!out.has(id)) out.set(id, grantWords({ ...g, values: [value] }))
      }
    }
  }
  return [...out].map(([id, words]) => ({ id, words })).sort((a, b) => a.words.localeCompare(b.words))
}

/** The audiences an action names: in its own rule or one of its rules, or through an audience that holds one it names. */
function audienceIds(i: PostureItem, data: PostureResponse): Set<string> {
  const id = i.target.kind === 'action' ? i.target.id : ''
  const out = new Set([...i.audiences, ...(i.action?.rules.flatMap((r) => r.audiences ?? []) ?? [])])
  for (const a of data.audiences) if (a.targets.some((t) => t.kind === 'action' && t.id === id)) out.add(a.id)
  return out
}

/** The audiences any action names, by title. */
export function audiencesOf(data: PostureResponse): { id: string; title: string }[] {
  const ids = new Set(actionsOf(data).flatMap((i) => [...audienceIds(i, data)]))
  return [...ids].map((id) => ({ id, title: audienceTitle(data, id) })).sort((a, b) => a.title.localeCompare(b.title))
}

/** The backends the actions use, by their word. */
export function backendsOf(data: PostureResponse): { id: string; word: string }[] {
  return [...new Set(actionsOf(data).map((i) => i.action!.backend))].map((id) => ({ id, word: backendWord(id) })).sort((a, b) => a.word.localeCompare(b.word))
}

/**
 * The rows the filters leave, by title. `runs` is what the picked person may
 * run, as the hub judged it: while it is not known, no row is theirs.
 */
export function shownActions(data: PostureResponse, f: ActionFilter, runs: ReadonlySet<string> | null): ActionRow[] {
  const kept = actionsOf(data).filter((i) => {
    const id = i.target.kind === 'action' ? i.target.id : ''
    if (f.person && !runs?.has(id)) return false
    if (f.team && !grantsOf(i).some((g) => g.values.some((v) => teamId(g, v) === f.team))) return false
    if (f.audience && !audienceIds(i, data).has(f.audience)) return false
    if (f.backend && i.action!.backend !== f.backend) return false
    if (f.everyone && !isEveryone(i)) return false
    if (f.noApproval && approvalOf(i) !== 'none') return false
    // Only a hub that says when an action last ran can say it never did.
    if (f.neverRun && i.action!.lastRunAt !== null) return false
    return true
  })
  return kept.map((i) => rowOf(i, data)).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}
