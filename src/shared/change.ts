// The change statement: what one change to a live thing will do, stated
// before it runs, by the tool that will make it. The contract is the platform
// kit's (`change/schema/statement.json`); `change/statement.json` beside this
// file is a copy of it, at the version go.mod requires, and a Go test holds
// the copy to that version byte for byte. This module checks a statement
// against the copy, holds it to the rules the kit's validator adds to the
// schema, reads its canonical form for the digest, and says it in words. It
// runs in the browser and in the hub alike; the hub alone hashes.

import STATEMENT_SCHEMA from './change/statement.json' with { type: 'json' }
import EVENT_SCHEMA from './change/event.json' with { type: 'json' }
import BASE_KINDS from './change/base-kinds.json' with { type: 'json' }

/** One catalog entity, by its blueprint and key. */
export interface ChangeRef {
  blueprint: string
  key: string
}

export interface ChangeActor {
  kind: 'person' | 'agent' | 'system'
  id: string
  on_behalf_of?: string
}

/** What a change does to one live thing, never the tool's verb. */
export interface ChangeEffect {
  kind: string
  subject: ChangeRef
  path: string
  size?: number
  undo: 'yes' | 'no' | 'partial'
  claim: { from: 'writer' | 'estate' | 'model'; rule?: string; version?: string }
}

/** One part of the change the writer could not name an effect for. */
export interface ChangeUnknown {
  thing?: ChangeRef
  part: string
  why: 'unread' | 'unnamed'
}

/** One change, as the tool that will make it states it. */
export interface ChangeStatement {
  key: string
  writer: { name: string; version: string }
  actor: ChangeActor
  things?: ChangeRef[]
  artifact: { kind: string; digest: string }
  /** Where it runs: `hub`, a job the hub starts, or `asker`, the machine that asked. */
  applier: 'hub' | 'asker'
  effects?: ChangeEffect[]
  unknown?: ChangeUnknown[]
}

/** The member that sends the change events of a run. */
export const CHANGE_SENDER = 'orrery'

/** The four change events a run sends, as the contract names them. */
export const CHANGE_EVENTS = ['change.stated', 'change.routed', 'change.decided', 'change.ended'] as const
export type ChangeEventName = (typeof CHANGE_EVENTS)[number]

/** What every change event carries. `of` names the stated event a later one belongs to. */
interface ChangeHeader<E extends string> {
  event: E
  sender: string
  key: string
  at: string
  of?: { sender: string; key: string }
  digest: string
}

export interface ChangeGrant {
  path?: string
  field?: string
  values: string[]
}

export type ChangeStated = ChangeHeader<'change.stated'> & { statement: ChangeStatement }
export type ChangeRouted = ChangeHeader<'change.routed'> & {
  judge: { name: string; version: string; pack: string }
  route: { to: 'no_one' } | { to: 'people'; grants: ChangeGrant[]; quorum: number }
  reasons: { rule: string }[]
}
export type ChangeDecided = ChangeHeader<'change.decided'> & { by: { kind: 'person'; id: string }; answer: 'yes' | 'no' }
export type ChangeEnded = ChangeHeader<'change.ended'> & {
  outcome: 'ok' | 'failed' | 'refused'
  check: ChangeCheck
  differs?: string[]
}
export type ChangeEvent = ChangeStated | ChangeRouted | ChangeDecided | ChangeEnded

/** What the applier found when it recomputed the statement from the artifact it holds. */
export const CHANGE_CHECKS = ['matched', 'differed', 'unchecked'] as const
export type ChangeCheck = (typeof CHANGE_CHECKS)[number]

/** The top-level fields of a statement, in the contract's order: what an applier may say differed. */
export const STATEMENT_FIELDS = ['key', 'writer', 'actor', 'things', 'artifact', 'applier', 'effects', 'unknown'] as const

/** The run outputs the applier reports its check in. */
export const CHECK_OUTPUT = 'statement_check'
export const DIFFERS_OUTPUT = 'statement_differs'

// The schema, read ----------------------------------------------------------------

/** One node of a JSON Schema, as far as the statement's and the event's schemas use it. `false` takes nothing, `true` anything. */
type Node = boolean | NodeObject

interface NodeObject {
  $ref?: string
  type?: string
  enum?: unknown[]
  const?: unknown
  format?: string
  required?: string[]
  properties?: Record<string, Node>
  additionalProperties?: boolean
  minProperties?: number
  items?: Node
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  anyOf?: Node[]
  oneOf?: Node[]
  not?: Node
  if?: Node
  then?: Node
  else?: Node
  $defs?: Record<string, Node>
}

/** The keywords this reading knows. A copy of a schema that uses another is refused as the module loads, never read past. */
const KEYWORDS = new Set(['$schema', 'title', 'description', '$ref', '$defs', 'type', 'enum', 'const', 'format', 'required', 'properties', 'additionalProperties', 'minProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'])
/** The formats this reading checks. */
const FORMATS = new Set(['date-time'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Each keyword of the schema, checked known, with every pattern compiled once. */
function load(node: unknown, at: string, patterns: Map<string, RegExp>): Node {
  if (typeof node === 'boolean') return node
  if (!isObject(node)) throw new Error(`change schema: ${at} is not a schema`)
  for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) throw new Error(`change schema: ${at} uses ${k}, which the hub does not read`)
  const n = node as NodeObject
  if (n.format !== undefined && !FORMATS.has(n.format)) throw new Error(`change schema: ${at} uses the format ${n.format}, which the hub does not read`)
  if (n.pattern !== undefined && !patterns.has(n.pattern)) patterns.set(n.pattern, new RegExp(n.pattern, 'u'))
  for (const [k, child] of Object.entries(n.properties ?? {})) load(child, `${at}.properties.${k}`, patterns)
  for (const [k, child] of Object.entries(n.$defs ?? {})) load(child, `${at}.$defs.${k}`, patterns)
  for (const list of ['anyOf', 'oneOf'] as const) for (const [i, child] of (n[list] ?? []).entries()) load(child, `${at}.${list}[${i}]`, patterns)
  for (const k of ['items', 'not', 'if', 'then', 'else'] as const) if (n[k] !== undefined) load(n[k], `${at}.${k}`, patterns)
  return n
}

const PATTERNS = new Map<string, RegExp>()
/** The schemas by the file name a `$ref` names them by. */
const DOCS: Record<string, NodeObject> = {
  'statement.json': load(STATEMENT_SCHEMA, 'statement.json#', PATTERNS) as NodeObject,
  'event.json': load(EVENT_SCHEMA, 'event.json#', PATTERNS) as NodeObject,
}

/** What a reading is of: the file a node is in, for its refs, what a refusal calls the whole, and what it calls the top of it. */
interface Reading {
  doc: string
  whole: string
  top: string
}

/** The node a `$ref` names, and the file it is in: `#/$defs/x` in the same file, `file.json` or `file.json#/$defs/x` in another. */
function resolve(ref: string, doc: string): { node: Node; doc: string } {
  const m = /^([a-z-]+\.json)?(?:#(?:\/\$defs\/([^/]+))?)?$/.exec(ref)
  const file = m?.[1] ?? doc
  const root = m ? DOCS[file] : undefined
  const node = m?.[2] ? root?.$defs?.[m[2]] : root
  if (node === undefined) throw new Error(`change schema: ${ref} names no definition`)
  return { node, doc: file }
}

const typed: Record<string, (v: unknown) => boolean> = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

/** An RFC 3339 time, as the platform kit reads one. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i
const formats: Record<string, (v: string) => boolean> = { 'date-time': (v) => DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)) }

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/** The first way the value breaks the node, said at the path it breaks at, or null. */
function breaks(node: Node, v: unknown, at: string, r: Reading): string | null {
  const where = at || r.top
  if (node === true) return null
  if (node === false) return `${where} must not be here`
  if (node.$ref) {
    const to = resolve(node.$ref, r.doc)
    const wrong = breaks(to.node, v, at, { ...r, doc: to.doc })
    if (wrong) return wrong
  }
  if (node.type && !typed[node.type]?.(v)) return `${where} must be ${node.type === 'integer' ? 'a whole number' : node.type === 'object' ? 'an object' : node.type === 'array' ? 'a list' : `a ${node.type}`}`
  if (node.enum && !node.enum.some((e) => same(e, v))) return `${where} must be one of ${node.enum.map(shown).join(', ')}`
  if ('const' in node && !same(node.const, v)) return `${where} must be ${shown(node.const)}`
  if (typeof v === 'string') {
    const length = [...v].length
    if (node.minLength !== undefined && length < node.minLength) return node.minLength === 1 ? `${where} must not be empty` : `${where} must hold at least ${node.minLength} characters`
    if (node.maxLength !== undefined && length > node.maxLength) return `${where} must hold at most ${node.maxLength} characters`
    if (node.pattern !== undefined && !PATTERNS.get(node.pattern)!.test(v)) return `${where} must match ${node.pattern}`
    if (node.format !== undefined && !formats[node.format]!(v)) return `${where} must be a time, as RFC 3339 writes one`
  }
  if (typeof v === 'number' && node.minimum !== undefined && v < node.minimum) return `${where} must be ${node.minimum} or more`
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) return `${where} must hold at least ${node.minItems}`
    if (node.maxItems !== undefined && v.length > node.maxItems) return `${where} must hold at most ${node.maxItems}`
    if (node.uniqueItems) {
      const seen = new Set<string>()
      for (const [i, item] of v.entries()) {
        const k = canonical(item)
        if (seen.has(k)) return `${at}[${i}] is in the list twice`
        seen.add(k)
      }
    }
    if (node.items !== undefined) for (const [i, item] of v.entries()) {
      const wrong = breaks(node.items, item, `${at}[${i}]`, r)
      if (wrong) return wrong
    }
  }
  if (isObject(v)) {
    const field = (k: string) => (at ? `${at}.${k}` : k)
    for (const k of node.required ?? []) if (!(k in v)) return `${field(k)} is required`
    if (node.minProperties !== undefined && Object.keys(v).length < node.minProperties) return `${where} must not be empty`
    for (const [k, child] of Object.entries(node.properties ?? {})) {
      if (!(k in v)) continue
      const wrong = breaks(child, v[k], field(k), r)
      if (wrong) return wrong
    }
    if (node.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (node.properties ?? {}))) return `${field(k)} is not part of a ${r.whole}`
  }
  if (node.anyOf && !node.anyOf.some((branch) => breaks(branch, v, at, r) === null)) {
    const needs = node.anyOf.map((b) => (typeof b === 'object' ? b.required?.join(' and ') : undefined)).filter(Boolean)
    return needs.length === node.anyOf.length ? `${where} must name at least one of: ${needs.join(', or ')}` : `${where} matches none of the forms a ${r.whole} takes`
  }
  if (node.oneOf) {
    const fits = node.oneOf.filter((branch) => breaks(branch, v, at, r) === null).length
    if (fits !== 1) return fits ? `${where} matches more than one form a ${r.whole} takes` : `${where} matches none of the forms a ${r.whole} takes`
  }
  if (node.not !== undefined && breaks(node.not, v, at, r) === null) return typeof node.not === 'object' && node.not.required ? `${where} must not hold ${node.not.required.join(' or ')} here` : `${where} is a form a ${r.whole} may not take`
  if (node.if !== undefined) {
    const branch = breaks(node.if, v, at, r) === null ? node.then : node.else
    if (branch !== undefined) return breaks(branch, v, at, r)
  }
  return null
}

// The validator's rules ----------------------------------------------------------

// What the platform kit's validator (`change/statement.go`) holds a statement
// to beyond its schema, so a statement the hub takes is never refused by a
// member downstream: a name is never a person's address, a value, or a secret.

/** An address a person is reached at, anywhere in a name. */
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/
/** A JSON web token's first two parts. */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
/** A run long enough to be a key or a token: it reads as one when it mixes upper case, lower case, and digits, as base64 does. */
const TOKEN_RUN = /[A-Za-z0-9+/]{32,}/g

/** Why a name reads as content rather than a name: an assignment, a key, or a token. Null when it does not. */
function valueIn(at: string, v: string): string | null {
  if (v.includes('=')) return `${at} holds "="; a statement names a part, never what it is set to`
  if (v.includes('-----BEGIN') || JWT.test(v)) return `${at} holds what reads as a key or a token`
  for (const run of v.match(TOKEN_RUN) ?? []) if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return `${at} holds what reads as a key or a token`
  return null
}

/** A name that is never a person: no address, no value, no secret. */
function plainIssue(at: string, v: string | undefined): string | null {
  if (!v) return null
  if (EMAIL.test(v)) return `${at} holds an email address; a person is named only as the actor`
  return valueIn(at, v)
}

/** The base kinds that have no unit, so an effect of one has no size. A kind the estate adds is the estate's to check. */
const UNITLESS = new Set((BASE_KINDS as { kinds: { name: string; unit?: string }[] }).kinds.filter((k) => !k.unit).map((k) => k.name))

/** What the platform kit's validator refuses in a statement the schema takes, or null. */
function contentIssue(s: ChangeStatement): string | null {
  const checks: [string, string | undefined][] = [['key', s.key], ['writer.version', s.writer.version]]
  for (const [i, t] of (s.things ?? []).entries()) checks.push([`things[${i}].key`, t.key])
  for (const [i, e] of (s.effects ?? []).entries()) checks.push([`effects[${i}].subject.key`, e.subject.key], [`effects[${i}].claim.rule`, e.claim.rule], [`effects[${i}].claim.version`, e.claim.version])
  for (const [i, u] of (s.unknown ?? []).entries()) checks.push([`unknown[${i}].thing.key`, u.thing?.key], [`unknown[${i}].part`, u.part])
  for (const [at, v] of checks) {
    const wrong = plainIssue(at, v)
    if (wrong) return wrong
  }
  // The actor is the one place a person may be named, by their address: it still holds no value or secret.
  for (const [at, v] of [['actor.id', s.actor.id], ['actor.on_behalf_of', s.actor.on_behalf_of]] as const) {
    const wrong = v ? valueIn(at, v) : null
    if (wrong) return wrong
  }
  for (const [i, e] of (s.effects ?? []).entries()) if (e.size !== undefined && UNITLESS.has(e.kind)) return `effects[${i}]: the kind ${e.kind} has no unit, so it has no size`
  return null
}

/** What is wrong with a value as a change statement, by the platform kit's schema and the rules its validator adds, or null when it is one. */
export function statementIssue(value: unknown): string | null {
  return breaks(DOCS['statement.json']!, value, '', { doc: 'statement.json', whole: 'change statement', top: 'the statement' }) ?? contentIssue(value as ChangeStatement)
}

/** A value as a statement, or why it is not one: an object, or JSON text of one. */
export function readStatement(value: unknown): { ok: true; statement: ChangeStatement } | { ok: false; error: string } {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return { ok: false, error: 'expected a change statement, as JSON' }
    }
  }
  const wrong = statementIssue(v)
  return wrong ? { ok: false, error: wrong } : { ok: true, statement: v as ChangeStatement }
}

// The watch's verdict -------------------------------------------------------------

/** The event the watch sends when a change's window closes. The hub takes it and never sends one. */
export const OBSERVED_EVENT = 'change.observed'

/** How the watch saw one effect kind on one subject: it looked and nothing happened, it looked and the thing was hurt, or it could not look. */
export const VERDICTS = ['clean', 'harm', 'blind'] as const
export type Verdict = (typeof VERDICTS)[number]

/** What the watch saw of one effect kind on one subject, by the path the change took to it. */
export interface ChangeSight {
  kind: string
  subject: ChangeRef
  path: string
  verdict: Verdict
  /** The signals it read, never their values. */
  signals?: string[]
}

/** What the watch saw of a change over its window, and the incidents it joined to it. */
export type ChangeObserved = ChangeHeader<typeof OBSERVED_EVENT> & {
  of: { sender: string; key: string }
  watch: { name: string; version: string }
  from: string
  to: string
  sights?: ChangeSight[]
  incidents?: { system: string; id: string }[]
}

/** The path that changes a thing where it stands: it absorbs nothing, so it is never a safe path. */
export const PATH_IN_PLACE = 'in-place'

/** The family of a base effect kind, or null for a kind the estate adds, which the hub does not know. */
export function kindFamily(kind: string): 'exposure' | 'disruption' | null {
  const found = (BASE_KINDS as { kinds: { name: string; family: string }[] }).kinds.find((k) => k.name === kind)
  return found ? (found.family as 'exposure' | 'disruption') : null
}

const EVENT_READING: Reading = { doc: 'event.json', whole: 'change event', top: 'the event' }

/** What the platform kit's validator refuses in an observed event the schema takes, or null. */
function observedIssue(e: ChangeObserved): string | null {
  const checks: [string, string | undefined][] = [['key', e.key], ['of.key', e.of.key], ['watch.version', e.watch.version]]
  for (const [i, s] of (e.sights ?? []).entries()) {
    checks.push([`sights[${i}].subject.key`, s.subject.key])
    for (const [j, signal] of (s.signals ?? []).entries()) checks.push([`sights[${i}].signals[${j}]`, signal])
  }
  for (const [i, inc] of (e.incidents ?? []).entries()) checks.push([`incidents[${i}].id`, inc.id])
  for (const [at, v] of checks) {
    const wrong = plainIssue(at, v)
    if (wrong) return wrong
  }
  if (e.of.sender === e.sender && e.of.key === e.key) return 'of names the event itself; an event cannot belong to itself'
  if (Date.parse(e.to) < Date.parse(e.from)) return 'to is before from'
  return null
}

/**
 * A value as the watch's verdict on a change, or why it is not one: by the
 * platform kit's event schema, strictly, so a field the contract does not
 * have is refused, and by the rules its validator adds. A kind the estate
 * adds is the watch's to check, as it is the judge's in a statement.
 */
export function readObserved(value: unknown): { ok: true; event: ChangeObserved } | { ok: false; error: string } {
  if (isObject(value) && value.event !== OBSERVED_EVENT) return { ok: false, error: `event must be ${OBSERVED_EVENT}: the hub takes only the watch's verdict` }
  const observed = DOCS['event.json']!.$defs!.observed!
  const wrong = breaks(observed, value, '', EVENT_READING) ?? breaks(DOCS['event.json']!, value, '', EVENT_READING) ?? observedIssue(value as ChangeObserved)
  return wrong ? { ok: false, error: wrong } : { ok: true, event: value as ChangeObserved }
}

// The digest ----------------------------------------------------------------------

/** Every empty list, empty object, empty string, and null left out, deep; undefined when nothing is left. */
function prune(v: unknown): unknown {
  if (v === null || v === '' || v === undefined) return undefined
  if (Array.isArray(v)) {
    const kept = v.map(prune).filter((x) => x !== undefined)
    return kept.length ? kept : undefined
  }
  if (isObject(v)) {
    const kept = Object.entries(v).flatMap(([k, x]) => {
      const p = prune(x)
      return p === undefined ? [] : [[k, p] as const]
    })
    return kept.length ? Object.fromEntries(kept) : undefined
  }
  return v
}

/** RFC 8785 JSON: keys in UTF-16 order, numbers and strings as ECMAScript writes them. */
function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/**
 * The canonical form the statement's digest is taken over, as the platform
 * kit's digest rule says: RFC 8785 over the value with every empty list,
 * empty object, empty string, and null left out. The digest is
 * `sha256:` and the hex of its SHA-256.
 */
export function canonical(v: unknown): string {
  return jcs(prune(v) ?? null)
}

// In words ------------------------------------------------------------------------

/** Where a change runs, said for whoever approves it. */
export function applierText(applier: ChangeStatement['applier']): string {
  return applier === 'hub' ? 'a job the hub starts' : 'the machine that asked'
}

export const refText = (r: ChangeRef): string => `${r.blueprint} ${r.key}`

const UNDO: Record<ChangeEffect['undo'], string> = { yes: 'the old artifact puts it back', no: 'it cannot be undone', partial: 'the old artifact puts part of it back' }
const CLAIM: Record<ChangeEffect['claim']['from'], string> = { writer: "the writer's own table", estate: "the estate's table", model: "a model's reading of the provider's documents" }

/** One effect in words: what it does, to which thing, by which path, whether it can be undone, and where the claim came from. */
export function effectText(e: ChangeEffect): string {
  const claim = [e.claim.rule && `rule ${e.claim.rule}`, e.claim.version].filter(Boolean).join(', ')
  return `${e.kind} ${refText(e.subject)}${e.size !== undefined ? ` (${e.size})` : ''}, ${e.path}; ${UNDO[e.undo]}; claimed by ${CLAIM[e.claim.from]}${claim ? ` (${claim})` : ''}`
}

/** One part the writer could not name an effect for, in words. */
export function unknownText(u: ChangeUnknown): string {
  return `${u.thing ? `${refText(u.thing)}: ` : ''}${u.part}, ${u.why === 'unread' ? 'which the writer could not read' : 'which the writer read and has no effect for'}`
}

/** Who asks for the change, in words. */
export function actorText(a: ChangeActor): string {
  return a.on_behalf_of ? `${a.kind} ${a.id}, for ${a.on_behalf_of}` : `${a.kind} ${a.id}`
}

/** The whole statement as plain lines, for a notice: what runs where, each effect, and each part nobody could name. */
export function statementLines(s: ChangeStatement): string[] {
  const lines = [`Change ${s.key}, written by ${s.writer.name} ${s.writer.version} for ${actorText(s.actor)}.`, `It runs on ${applierText(s.applier)}, from the ${s.artifact.kind} ${s.artifact.digest}.`]
  if (s.things?.length) lines.push(`It touches ${s.things.map(refText).join(', ')}.`)
  const effects = s.effects ?? []
  lines.push(effects.length ? 'Effects:' : 'Effects: none stated.')
  for (const e of effects) lines.push(`- ${effectText(e)}`)
  const unknown = s.unknown ?? []
  if (unknown.length) {
    lines.push('Parts with no effect named:')
    for (const u of unknown) lines.push(`- ${unknownText(u)}`)
  }
  return lines
}
