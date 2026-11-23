// The usage events the hub and the web app send, when telemetry is on. An
// event says what a person or an agent did: its name is a thing everyone
// knows and what was done to it, in the past tense and Title Case
// (`Blueprint Changed`, `Action Run Requested`), and never says who was
// allowed to do it. Who did it is the `initiatedBy` property, the same on
// every event. Every name lives here; nothing writes one inline.

import type { ChangeKind } from './model.ts'

/**
 * The event each kind of activity row is sent as. A row is sent when a
 * person or an access token did it and it worked, except that a finished
 * action run is always sent, failed or not, on behalf of whoever asked for
 * it. Null is a row that tells nothing about how the hub is used: what a
 * pusher's run did to the estate, and refusals, which the request already
 * shows.
 */
export const CHANGE_EVENTS: Record<ChangeKind, string | null> = {
  'entity.created': 'Entity Created',
  'entity.updated': 'Entity Updated',
  'entity.missing': null,
  'entity.deleted': 'Entity Deleted',
  'entity.restored': 'Entity Restored',
  'entity.hidden': 'Entity Hidden',
  'override.cleared': 'Override Cleared',
  'run.committed': null,
  'run.failed': null,
  'run.mass_drop': null,
  'blueprint.changed': 'Blueprint Changed',
  'rule.changed': 'Relation Rule Changed',
  'scorecard.changed': 'Scorecard Changed',
  'alert_rule.changed': 'Alert Rule Changed',
  'model.imported': 'Model Imported',
  'model.arranged': 'Model Arranged',
  'catalog.ordered': 'Catalog Reordered',
  'catalog.folded': 'Catalog Group Folded',
  'catalog.hidden': 'Catalog Blueprint Hidden',
  'grid.arranged': 'Grid Arranged',
  'grid.standard': 'Column Standard Changed',
  'model.conventions': 'Relation Conventions Changed',
  'canvas.arranged': 'Canvas Arranged',
  'source.changed': 'Source Changed',
  'source.refreshed': 'Source Refreshed',
  'secret.changed': 'Secret Changed',
  'token.issued': 'Token Issued',
  'token.revoked': 'Token Revoked',
  'token.rotated': 'Token Rotated',
  'access.changed': 'Access Rule Changed',
  'access.reviewed': 'Access Reviewed',
  'preview.changed': 'Preview Changed',
  'user.enrolled': 'Person Enrolled',
  'user.changed': 'Person Changed',
  'user.removed': 'Person Removed',
  'role.changed': 'Role Changed',
  'access.refused': null,
  'access.viewed': 'View As Started',
  'ingest.failed': null,
  'action.changed': 'Action Changed',
  'action.requested': 'Action Run Requested',
  'action.approved': 'Action Run Approved',
  'action.declined': 'Action Run Declined',
  'action.returned': 'Action Run Returned',
  'action.cancelled': 'Action Run Cancelled',
  'action.finished': 'Action Run Finished',
  'action.retried': null,
  'action.wrote_back': 'Action Run Wrote Back',
  'schedule.requested': 'Schedule Requested',
  'schedule.approved': 'Schedule Approved',
  'schedule.declined': 'Schedule Declined',
  'schedule.changed': 'Schedule Changed',
  'schedule.paused': 'Schedule Paused',
  'schedule.removed': 'Schedule Removed',
  'schedule.fired': null,
  'action.voted': 'Action Run Approval Given',
  'action.batched': 'Action Batch Asked',
  'action.batch_stopped': 'Action Batch Stopped',
  'action.batch_finished': null,
  'action.set_requested': 'Change Set Requested',
  'action.set_approved': 'Change Set Approved',
  'action.set_rejected': 'Change Set Rejected',
  'action.set_withdrawn': 'Change Set Withdrawn',
  'action.set_finished': null,
  'action.arranged': 'Actions Arranged',
  'icon.changed': 'Icon Changed',
  'icon.removed': 'Icon Removed',
  'picture.changed': 'Photo Changed',
  'picture.removed': 'Photo Removed',
  'picture.picked': 'Picture Picked',
  'budgets.changed': 'Budgets Changed',
  'report.created': 'Report Created',
  'report.changed': 'Report Changed',
  'report.removed': 'Report Removed',
  'report.published': 'Report Published',
  'welcome.changed': 'Welcome Tour Changed',
}

/** An agent called one of the hub's MCP tools; `tool` names it. */
export const AGENT_TOOL_CALLED = 'Agent Tool Called'

/** A person pinned an action to the top of their own self-service page, or let one go; `action` names it. A pin writes no activity row, so the hub sends these itself. */
export const ACTION_PINNED = 'Action Pinned'
export const ACTION_UNPINNED = 'Action Unpinned'
/** A person pinned a blueprint to the top of the catalog's list, or let one go; `blueprint` names it. */
export const BLUEPRINT_PINNED = 'Blueprint Pinned'
export const BLUEPRINT_UNPINNED = 'Blueprint Unpinned'
/** A person starred an entity as one of their favorites, or let it go; `blueprint` names its kind, never the entity. A star writes no activity row. */
export const ENTITY_STARRED = 'Entity Starred'
export const ENTITY_UNSTARRED = 'Entity Unstarred'
/** A person put a stop on their walk through a map, or took one off; `ladder` names its ladder. A walk writes no activity row, so the hub sends these itself. */
export const WALK_STEP_ADDED = 'Walk Step Added'
export const WALK_STEP_REMOVED = 'Walk Step Removed'
/** The events the hub sends for what writes no activity row. */

export const HUB_EVENTS = [AGENT_TOOL_CALLED, ACTION_PINNED, ACTION_UNPINNED, BLUEPRINT_PINNED, BLUEPRINT_UNPINNED, ENTITY_STARRED, ENTITY_UNSTARRED, WALK_STEP_ADDED, WALK_STEP_REMOVED] as const

/** A person opened a page of the web app; `page` names it. */
export const PAGE_VIEWED = 'Page Viewed'
/** A person opened an action's form: where a self-service run starts, before anything is asked of the hub. */
export const ACTION_FORM_OPENED = 'Action Form Opened'

/** A person started the welcome tour, finished it, or left it early; `version` is the tour's, and a tour left early says at which `step`. */
export const TOUR_STARTED = 'Welcome Tour Started'
export const TOUR_FINISHED = 'Welcome Tour Finished'
export const TOUR_LEFT = 'Welcome Tour Left'
/** A person was shown the notes on the releases since they last looked; `release` is the newest. */
export const RELEASE_NOTES_VIEWED = 'Release Notes Viewed'

/** The events only the web app sees, and so the only names it may send. */
export const BROWSER_EVENTS = [PAGE_VIEWED, ACTION_FORM_OPENED, TOUR_STARTED, TOUR_FINISHED, TOUR_LEFT, RELEASE_NOTES_VIEWED] as const
export type BrowserEvent = (typeof BROWSER_EVENTS)[number]

/** The header the web app sends its tab's visit in, so a person's requests and page views read as one session. */
export const SESSION_HEADER = 'x-orrery-session'

/** Which side sent an event, as its `source` property says. */
export type EventSource = 'api' | 'web'

/** The most a web app's batch carries, and the limits on what each event may say. */
export const TELEMETRY_LIMITS = { events: 50, bytes: 256 * 1024, props: 10, propLength: 256, stack: 8000 } as const

/**
 * How a page felt, each in seconds but `cls`: `wait` from what a person did
 * until the answer was on their screen, `ready` from opening the tab to the
 * first useful screen, and the web vitals `lcp`, `inp`, and `cls`.
 */
export const BROWSER_MEASURES = ['wait', 'ready', 'lcp', 'inp', 'cls'] as const
export type BrowserMeasure = (typeof BROWSER_MEASURES)[number]

/** One thing the web app saw: a usage event, a measure of how a page felt, or an error the page did not catch. */
export type BrowserSignal =
  | { kind: 'event'; name: BrowserEvent; props?: Record<string, string> }
  | { kind: 'measure'; name: BrowserMeasure; page: string; value: number }
  | { kind: 'error'; type: string; message: string; stack?: string; page?: string }

/** What the web app posts to `/v1/telemetry`. `session` is one browser tab's visit, random and kept for the tab's life. */
export interface TelemetryBatch {
  session: string
  signals: BrowserSignal[]
}
