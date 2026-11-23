// The welcome tour: the steps the hub ships, the places on the page they
// point at, and what an estate may change of them. The hub brings a tour
// that holds on any hub, with nothing modelled; an estate names the
// blueprint, the entity, and the action that make it its own, and words its
// steps. It never adds a step or reorders one: a step points at a place this
// release draws, and only this release knows where those are.

/**
 * The places a step points at. A component marks one with `spot` from
 * `src/web/spots.ts`; a test holds every name here to a mark in the web app.
 * A place a screen does not draw (the rail on a phone) skips its step there.
 */
export const SPOTS = ['nav', 'now.verdict', 'now.sky', 'now.needs', 'find', 'catalog.kinds', 'catalog.grid', 'entity.page', 'actions.catalog', 'action.page', 'account'] as const
export type SpotName = (typeof SPOTS)[number]

/** The pages a step opens. Each is a route of the web app, as `router.ts` names it. */
export type TourPage = { page: 'now' } | { page: 'inventory'; blueprint: string } | { page: 'entity'; blueprint: string; key: string } | { page: 'actions'; id: string | null }

/** What a step needs of the estate before it can be shown. */
type Needs = 'blueprint' | 'example' | 'action'

interface StepDef {
  spot: SpotName | null
  title: string
  text: string
  needs?: Needs
  /** The words for a reader who may run no action, on a step that is shown to them all the same. */
  empty?: string
}

/**
 * The tour in order. A step's text may name `{{ blueprint }}`, `{{ entity }}`,
 * and `{{ action }}`, each the title the reader sees. A step that needs one
 * the reader cannot see is left out for them.
 */
export const TOUR_STEPS = {
  hello: { spot: null, title: 'Welcome to Orrery', text: 'Orrery is one map of everything the platform runs: what exists, how it connects, who owns it, and whether it is healthy. This short tour shows you around. You can leave it at any time and take it again from your account menu.' },
  nav: { spot: 'nav', title: 'Your pages', text: 'Every page is here. The ones you use every day come first, then the pages that look at the estate whole. The pages that run the hub itself are behind Hub, at the foot.' },
  verdict: { spot: 'now.verdict', title: 'Now', text: 'Now is where you start. It says in one line whether anything needs you, and links straight to the worst of it.' },
  sky: { spot: 'now.sky', title: 'The sky', text: 'The sky draws every kind of thing in the estate, grouped into areas. Red and amber mark what is failing. Pick an area to see its kinds.' },
  needs: { spot: 'now.needs', title: 'What needs you', text: 'This list holds what is failing or firing, yours first. Each line opens the thing itself.' },
  find: { spot: 'find', title: 'Find anything', text: 'Search every kind of thing at once, from the top of any page. Or press ⌘K (Ctrl+K).' },
  grid: { spot: 'catalog.grid', title: 'The catalog', text: 'The catalog lists every {{ blueprint }} as a table. Sort it, filter it, and open any row. Where you may change a value, you change it right here in the table.', needs: 'blueprint' },
  kinds: { spot: 'catalog.kinds', title: 'Every kind', text: 'Every kind of thing in the catalog is listed here, with how many there are and how healthy they are.', needs: 'blueprint' },
  entity: { spot: 'entity.page', title: 'One thing', text: 'Each thing has its own page: its fields, what it is connected to, its checks and alerts, and the actions you may run on it. This is {{ entity }}.', needs: 'example' },
  selfservice: { spot: 'actions.catalog', title: 'Self-service', text: 'Self-service is where you ask the platform to do things for you. Pick an action, fill in its form, and follow the run as it happens. Star the ones you use most to keep them at the top.', empty: 'Self-service is where you ask the platform to do things for you. You have no actions yet: when someone opens one to you, it shows up here.' },
  action: { spot: 'action.page', title: 'Run an action', text: '{{ action }} is one of them. Its page says what it does, who may run it, and how its last runs went.', needs: 'action' },
  account: { spot: 'account', title: 'Your account', text: 'Your API keys, this tour, and the notes on each new release live in this menu.' },
  done: { spot: null, title: 'That is the tour', text: 'Start from Now whenever you come back. Take this tour again any time from your account menu.' },
} as const satisfies Record<string, StepDef>

export type TourStepId = keyof typeof TOUR_STEPS
export const TOUR_STEP_IDS = Object.keys(TOUR_STEPS) as TourStepId[]

/** What an estate may change of one step: its words, its words for a reader with no action (on a step that has them), or `shown: false` to leave it out. */
export interface WelcomeStepDef {
  shown?: boolean
  title?: string
  text?: string
  empty?: string
}

/** The steps that say something else to a reader who may run no action. */
export const EMPTY_STEP_IDS = TOUR_STEP_IDS.filter((id) => 'empty' in TOUR_STEPS[id])

/**
 * An estate's welcome tour. `version` counts up when the estate wants every
 * person to see the tour again. `blueprint` is the catalog the tour opens,
 * `example` the key of one of its entities to show, and `actions` the
 * self-service actions it may show, best first: each reader is shown the
 * first of them they may run, else the first action they may run at all. `source` is the git source that declares it,
 * which then owns it.
 */
export interface WelcomeDef {
  version: number
  blueprint?: string
  example?: string
  actions?: string[]
  steps?: Partial<Record<TourStepId, WelcomeStepDef>>
  source?: string
}

/** The tour a hub with nothing set gives. */
export const DEFAULT_WELCOME: WelcomeDef = { version: 1 }

/** The most a step's title and text may hold, and how many actions the estate may rank. */
export const WELCOME_LIMITS = { title: 120, text: 1200, actions: 20 } as const

/** One step as a reader is shown it: where it goes, what it points at, and what it says. */
export interface TourStep {
  id: TourStepId
  to: TourPage
  spot: SpotName | null
  title: string
  text: string
}

/** `GET /v1/welcome`: the tour as the reader is shown it, with nothing in it they may not see. */
export interface WelcomeResponse {
  version: number
  steps: TourStep[]
}

/** What the hub found of the estate's picks, each as the reader sees it: null where they may not see it, or it is not set. */
export interface WelcomeFound {
  blueprint: { id: string; title: string } | null
  example: { key: string; title: string } | null
  action: { id: string; title: string } | null
}

const fill = (text: string, names: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => names[name] ?? whole)

/** The tour a reader is shown: every step in order, with their words, less those left out and those that need what the reader cannot see. */
export function buildTour(def: WelcomeDef, found: WelcomeFound): WelcomeResponse {
  const names: Record<string, string> = { ...(found.blueprint ? { blueprint: found.blueprint.title } : {}), ...(found.example ? { entity: found.example.title } : {}), ...(found.action ? { action: found.action.title } : {}) }
  const steps = TOUR_STEP_IDS.flatMap((id): TourStep[] => {
    const step: StepDef = TOUR_STEPS[id]
    const own = def.steps?.[id]
    if (own?.shown === false) return []
    const to = pageOf(step, found)
    if (!to) return []
    const text = step.empty && !found.action ? own?.empty || step.empty : own?.text || step.text
    return [{ id, to, spot: step.spot, title: fill(own?.title || step.title, names), text: fill(text, names) }]
  })
  return { version: def.version, steps }
}

/** The page a step opens, or null when it needs what was not found. */
function pageOf(step: StepDef, found: WelcomeFound): TourPage | null {
  if (step.needs === 'blueprint' && !found.blueprint) return null
  if (step.needs === 'example' && !(found.blueprint && found.example)) return null
  if (step.needs === 'action' && !found.action) return null
  if (step.spot === 'catalog.grid' || step.spot === 'catalog.kinds') return { page: 'inventory', blueprint: found.blueprint!.id }
  if (step.spot === 'entity.page') return { page: 'entity', blueprint: found.blueprint!.id, key: found.example!.key }
  if (step.spot === 'actions.catalog') return { page: 'actions', id: null }
  if (step.spot === 'action.page') return { page: 'actions', id: found.action!.id }
  return { page: 'now' }
}
