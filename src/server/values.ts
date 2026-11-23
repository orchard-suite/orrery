// Pure helpers over field values: validation against a field definition,
// precedence across layers, stable hashing, and provenance.

import { createHash } from 'node:crypto'
import { healthcheckSchema } from './checks.ts'
import { trendSchema } from './trend.ts'
import { stable } from '../shared/filter.ts'
import { isDerived, type FieldDef, type FieldProvenance, type Layer } from '../shared/model.ts'

export { stable }

export interface UiEntry {
  value: unknown
  by: string
  at: string
}
export interface PushedEntry {
  value: unknown
  source: string
  at: string
  observedAt?: string
  /** The value this one replaced, for the hover in the UI. */
  prev?: unknown
}
export interface OverrideEntry {
  value: unknown
  basis: unknown
  by: string
  at: string
}
export interface GitEntry {
  value: unknown
  source: string
  file: string
  at: string
}

export interface Layers {
  ui: Record<string, UiEntry>
  pushed: Record<string, PushedEntry>
  override: Record<string, OverrideEntry>
  git: Record<string, GitEntry>
}

export function equal(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

export function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex').slice(0, 32)
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** Returns the reason a value does not fit the field, or null when it does. Null is always allowed: it means "unset". */
export function validateValue(def: FieldDef, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (def.type) {
    case 'string':
    case 'markdown':
    case 'user':
      return typeof value === 'string' ? null : `expected a string, got ${kind(value)}`
    case 'email':
      return typeof value === 'string' && value.includes('@') ? null : 'expected an email address'
    case 'url': {
      if (def.many && Array.isArray(value)) {
        const bad = value.find((v) => typeof v !== 'string' || !URL.canParse(v))
        return bad === undefined ? null : `${typeof bad === 'string' ? `"${bad}"` : kind(bad)} is not a URL`
      }
      if (typeof value !== 'string') return `expected ${def.many ? 'a list of URLs' : 'a URL string'}, got ${kind(value)}`
      return URL.canParse(value) ? null : `"${value}" is not a URL`
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `expected a number, got ${kind(value)}`
      return def.format?.minor && !Number.isInteger(value) ? `expected a whole number of ${def.format.currency} minor units, got ${value}` : null
    case 'boolean':
      return typeof value === 'boolean' ? null : `expected a boolean, got ${kind(value)}`
    case 'datetime':
      return typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'expected an ISO 8601 datetime'
    case 'enum': {
      const allowed = def.values ?? []
      if (def.many && Array.isArray(value)) {
        const bad = value.find((v) => typeof v !== 'string' || !allowed.includes(v))
        return bad === undefined ? null : `${typeof bad === 'string' ? `"${bad}"` : kind(bad)} is not one of ${allowed.join(', ')}`
      }
      if (typeof value !== 'string') return `expected ${def.many ? 'a list of' : 'one of'} ${allowed.join(', ')}`
      return allowed.includes(value) ? null : `"${value}" is not one of ${allowed.join(', ')}`
    }
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? null : `expected an object, got ${kind(value)}`
    case 'openapi': {
      // The document itself, or a link to where it is kept.
      if (typeof value === 'string') return /^https?:\/\//.test(value) && URL.canParse(value) ? null : `"${value}" is neither an OpenAPI document nor a link to one`
      const doc = value as { openapi?: unknown; swagger?: unknown } | null
      return doc && typeof doc === 'object' && !Array.isArray(doc) && (typeof doc.openapi === 'string' || typeof doc.swagger === 'string') ? null : 'expected an OpenAPI or Swagger document, or a link to one'
    }
    case 'array':
      return Array.isArray(value) ? null : `expected an array, got ${kind(value)}`
    case 'healthcheck': {
      const parsed = healthcheckSchema.safeParse(value)
      return parsed.success ? null : `health check: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
    }
    case 'secretRef':
      return typeof value === 'string' ? null : 'expected a secret name'
    case 'trend': {
      const parsed = trendSchema.safeParse(value)
      return parsed.success ? null : `trend: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
    }
  }
}

function kind(value: unknown): string {
  return Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`
}

export interface Resolved {
  value: unknown
  provenance: FieldProvenance
}

/**
 * The value that wins for one field, and where it came from. A field the hub
 * computes has no stored winner: a value kept from before it was computed is
 * neither its value nor where it came from.
 */
export function resolve(field: string, layers: Layers, def: FieldDef | undefined): Resolved | null {
  if (def && isDerived(def)) return null
  const git = layers.git[field]
  const override = layers.override[field]
  const pushed = layers.pushed[field]
  const ui = layers.ui[field]
  const overrideLive = override && pushed && equal(override.basis, pushed.value)
  const overridable = def?.overridable !== false
  const lower = (layer: Layer): unknown => {
    if (layer === 'git' && overrideLive) return override.value
    if ((layer === 'git' || layer === 'override') && pushed) return pushed.value
    if (layer !== 'ui' && ui) return ui.value
    return undefined
  }
  if (git) {
    return {
      value: git.value,
      provenance: { layer: 'git', source: git.source, at: git.at, file: git.file, locked: true, replaced: lower('git'), override: overrideLive ? override : undefined },
    }
  }
  if (overrideLive) {
    return { value: override.value, provenance: { layer: 'override', source: override.by, at: override.at, locked: !overridable, replaced: pushed.value, override } }
  }
  if (pushed) {
    return { value: pushed.value, provenance: { layer: 'pushed', source: pushed.source, at: pushed.at, locked: !overridable, replaced: pushed.prev } }
  }
  if (ui) {
    return { value: ui.value, provenance: { layer: 'ui', source: ui.by, at: ui.at, locked: !overridable } }
  }
  if (def?.default !== undefined) {
    return { value: def.default, provenance: { layer: 'default', source: null, at: null, locked: !overridable } }
  }
  return null
}

export function emptyLayers(): Layers {
  return { ui: {}, pushed: {}, override: {}, git: {} }
}
