// What the query editor says of the text as it is typed: what may come next,
// what a name in it means, and which names nothing the query reads has. The
// parser alone decides where a name stands and what it is read against
// (`readQuery` in `src/shared/query-text.ts`); this reads those answers
// against the blueprints the page holds, so it offers only what the reader
// may see. Pure, and tested alone.

import { RUN_COLUMNS, RUNS_SOURCE } from '../shared/api.ts'
import { defIn, META_COLUMNS, metaIn, pathColumn, pathEnd } from '../shared/answer.ts'
import { META_FIELDS, parsePath } from '../shared/filter.ts'
import { ENTITY_STATES, STATUS_LEVELS, type Blueprint, type FieldDef } from '../shared/model.ts'
import { blueprintName, ident, type Names, type QueryExpected, type QueryMark, type QueryScope } from '../shared/query-text.ts'
import { readableOf, type Readable } from './query.ts'

/** One thing the editor offers: the text it puts in, what kind of thing it is, a word on it, and its description. */
export interface Offer {
  label: string
  kind: 'keyword' | 'operator' | 'blueprint' | 'field' | 'relation' | 'meta' | 'column' | 'value'
  detail?: string
  info?: string
}

/** What a name in the text means, for a reader pointing at it. */
export interface Meaning {
  title: string
  kind: string
  description?: string
}

/** The meanings of the columns every entity has, for a reader who points at one. */
const META_SAID: Readonly<Record<string, string>> = {
  $type: 'The blueprint each row comes from.',
  title: 'What the entity is called.',
  $key: 'The entity’s key, unique in its blueprint.',
  $status: 'How the entity is doing: red, amber, green, or grey.',
  $state: 'Whether the entity is active, missing, or deleted.',
  $owner: 'The source that keeps the entity.',
  $lastSeenAt: 'When its source last saw the entity.',
  $updatedAt: 'When the entity last changed.',
}

/** The blueprints a scope reads: its own, then for a condition inside a relation's brackets, what each relation in turn reaches. */
export function scopeEnds(scope: QueryScope, blueprints: readonly Blueprint[]): Readable[] {
  const own = scope.blueprints.flatMap((id) => readableOf(id, blueprints) ?? [])
  if (scope.kind !== 'filter') return own
  return own.flatMap((bp) => {
    let at: Readable | undefined = bp
    for (const field of scope.path) {
      const path = pathColumn(field)
      at = path && at ? (pathEnd(at, path.path, blueprints) as Readable | undefined) : undefined
    }
    return at ? [at] : []
  })
}

const typeOf = (def: FieldDef): string => def.type

/** A field's offer, written as the text would write it. */
const fieldOffer = (id: string, def: FieldDef): Offer => ({ label: ident(id), kind: 'field', detail: typeOf(def), info: [def.title && def.title !== id ? def.title : '', def.description ?? ''].filter(Boolean).join('. ') || undefined })

/** The relations of the ends, as `r:` and each hop further on where the typed text goes past one. */
function relationOffers(ends: readonly Readable[], typed: string, blueprints: readonly Blueprint[], fieldsAtEnd: boolean): Offer[] {
  const out: Offer[] = []
  const body = typed.startsWith('r:') ? typed.slice(2) : ''
  const at = body.lastIndexOf('@')
  if (fieldsAtEnd && at >= 0) {
    const path = body.slice(0, at)
    for (const bp of ends) {
      const end = pathEnd(bp, path, blueprints)
      if (!end) continue
      for (const m of META_COLUMNS) out.push({ label: `r:${path}@${m.id}`, kind: 'meta', detail: m.type, info: META_SAID[m.id] })
      for (const [id, def] of Object.entries(end.fields)) out.push({ ...fieldOffer(`r:${path}@${id}`, def), label: `r:${path}@${id}` })
    }
    return out
  }
  const dot = body.lastIndexOf('.')
  const before = dot >= 0 ? body.slice(0, dot) : ''
  for (const bp of ends) {
    const from = before ? pathEnd(bp, before, blueprints) : bp
    if (!from) continue
    for (const [name, rel] of Object.entries(from.relations)) {
      const label = `r:${before ? `${before}.` : ''}${name}`
      const target = blueprints.find((b) => b.id === rel.target)
      out.push({ label, kind: 'relation', detail: `to ${target?.title ?? rel.target}${rel.many ? ', many' : ''}`, info: rel.description ?? rel.title })
    }
  }
  return out
}

/** The fields, relations, and columns a scope offers where the text names one, `typed` being what is typed of it so far. */
export function fieldOffers(scope: QueryScope, typed: string, blueprints: readonly Blueprint[]): Offer[] {
  if (scope.kind === 'column') {
    const ids = scope.ids.length ? scope.ids : META_COLUMNS.slice(0, 4).map((m) => m.id)
    return ids.map((id) => {
      const said = columnMeaning(id, scope.blueprints, blueprints)
      return { label: ident(id), kind: 'column', detail: said.kind, info: [said.title !== id ? said.title : '', said.description ?? ''].filter(Boolean).join('. ') || undefined }
    })
  }
  const ends = scopeEnds(scope, blueprints)
  const out: Offer[] = []
  if (ends.some((bp) => bp.id === RUNS_SOURCE)) for (const c of RUN_COLUMNS) out.push({ label: c.id, kind: 'field', detail: c.type ?? 'string', info: c.title })
  if (scope.kind === 'pick') for (const m of META_COLUMNS) out.push({ label: m.id, kind: 'meta', detail: m.type, info: META_SAID[m.id] })
  else for (const name of META_FIELDS) out.push({ label: `$${name}`, kind: 'meta', info: META_SAID[`$${name}`] })
  for (const bp of ends) for (const [id, def] of Object.entries(bp.fields)) out.push(fieldOffer(id, def))
  out.push(...relationOffers(ends, typed, blueprints, scope.kind === 'pick'))
  return dedupe(out)
}

/** What a column of the query is: the column every entity has, or the field the first blueprint that has it fills it with. */
function columnMeaning(id: string, read: readonly string[], blueprints: readonly Blueprint[]): Meaning {
  const meta = META_COLUMNS.find((m) => m.id === id)
  if (meta) return { title: meta.title, kind: meta.type, description: META_SAID[meta.id] }
  for (const bpId of read) {
    const bp = readableOf(bpId, blueprints)
    if (!bp) continue
    const meta = metaIn(bp, id)
    if (meta) return { title: meta.title, kind: meta.type, description: META_SAID[meta.id] }
    const run = bp.id === RUNS_SOURCE ? RUN_COLUMNS.find((c) => c.id === id) : undefined
    if (run) return { title: run.title, kind: run.type ?? 'string' }
    const path = pathColumn(id)
    if (path && path.field === null && pathEnd(bp, path.path, blueprints)) return { title: id, kind: 'relation', description: `The titles of what ${path.path} reaches.` }
    const def = defIn(bp, id, blueprints)
    if (def) return { title: def.title ?? id, kind: def.type, description: def.description }
  }
  return { title: id, kind: 'column' }
}

/** The values offered after a test on a field: an enum's values, true and false, or, for the entity's own status and state, theirs. */
export function valueOffers(field: string, scope: QueryScope, blueprints: readonly Blueprint[]): Offer[] {
  const quoted = (v: string): Offer => ({ label: JSON.stringify(v), kind: 'value' })
  const def = definition(field, scope, blueprints)
  if (def?.type === 'boolean') return [{ label: 'true', kind: 'value' }, { label: 'false', kind: 'value' }]
  if (def?.type === 'enum') return (def.values ?? []).map(quoted)
  if (def) return []
  const bare = field.startsWith('$') ? field.slice(1) : field
  if (bare === 'status') return STATUS_LEVELS.map(quoted)
  if (bare === 'state') return ENTITY_STATES.map(quoted)
  return []
}

/** The definition of the field a name reads in a scope, where one blueprint it reads defines it. */
function definition(field: string, scope: QueryScope, blueprints: readonly Blueprint[]): FieldDef | undefined {
  if (scope.kind === 'column') {
    for (const id of scope.blueprints) {
      const bp = readableOf(id, blueprints)
      const def = bp ? defIn(bp, field, blueprints) : undefined
      if (def) return def
    }
    return undefined
  }
  for (const bp of scopeEnds(scope, blueprints)) {
    const def = pathColumn(field) ? defIn(bp, field, blueprints) : field.startsWith('$') ? undefined : bp.fields[field]
    if (def) return def
  }
  return undefined
}

/** What a name the text marks means, or undefined where nothing the query reads has it. */
export function meaningOf(mark: QueryMark, blueprints: readonly Blueprint[]): Meaning | undefined {
  if (mark.kind === 'blueprint') {
    if (mark.id === RUNS_SOURCE) return { title: 'Action runs', kind: 'source', description: 'Every self-service run you may see.' }
    const bp = blueprints.find((b) => b.id === mark.id)
    return bp ? { title: bp.title, kind: 'blueprint', description: bp.description } : undefined
  }
  const { id, scope } = mark
  if (scope.kind === 'column') {
    if (scope.ids.length && !scope.ids.includes(id)) return undefined
    return columnMeaning(id, scope.blueprints, blueprints)
  }
  const ends = scopeEnds(scope, blueprints)
  if (scope.kind === 'filter') {
    const bare = id.startsWith('$') ? id.slice(1) : id
    for (const bp of ends) {
      if (!id.startsWith('$') && bp.fields[id]) return { title: bp.fields[id]!.title ?? id, kind: bp.fields[id]!.type, description: bp.fields[id]!.description }
      if (bp.id === RUNS_SOURCE && RUN_COLUMNS.some((c) => c.id === id)) return columnMeaning(id, [bp.id], blueprints)
      const path = pathColumn(id)
      if (path) {
        const hops = parsePath(path.path)
        const rel = hops.length === 1 && !hops[0]!.incoming ? bp.relations[hops[0]!.relation] : undefined
        if (rel) return { title: rel.title ?? hops[0]!.relation, kind: `relation to ${blueprints.find((b) => b.id === rel.target)?.title ?? rel.target}`, description: rel.description }
        if (pathEnd(bp, path.path, blueprints)) return { title: id, kind: 'relation' }
      }
    }
    if (META_FIELDS.has(bare)) return { title: META_COLUMNS.find((m) => m.id === `$${bare}`)?.title ?? bare, kind: 'every entity', description: META_SAID[`$${bare}`] }
    return undefined
  }
  const read = ends.map((bp) => bp.id)
  const said = columnMeaning(id, read, blueprints)
  return said.kind === 'column' ? undefined : said
}

/** The fields and columns the text names that nothing the query reads has, so the editor can say so where each stands. */
export function unknownMarks(marks: readonly QueryMark[], blueprints: readonly Blueprint[]): QueryMark[] {
  return marks.filter((m) => m.kind === 'field' && !meaningOf(m, blueprints))
}

/** What the text could go on with where it ends, as offers: `typed` is what is typed of the next word so far. */
export function offers(expected: readonly QueryExpected[], typed: string, names: Names, blueprints: readonly Blueprint[]): Offer[] {
  const out: Offer[] = []
  for (const e of expected) {
    if (e.kind === 'keyword') out.push({ label: e.word, kind: 'keyword' })
    else if (e.kind === 'symbol') {
      if (!typed) out.push({ label: e.symbol, kind: 'operator' })
    } else if (e.kind === 'blueprint') out.push(...names.blueprints.map((b): Offer => ({ label: blueprintName(b.id, names), kind: 'blueprint', detail: b.id, info: blueprints.find((x) => x.id === b.id)?.description })))
    else if (e.kind === 'field') out.push(...fieldOffers(e.scope, typed, blueprints))
    else out.push(...valueOffers(e.field, e.scope, blueprints))
  }
  return dedupe(out)
}

function dedupe(list: readonly Offer[]): Offer[] {
  const seen = new Set<string>()
  return list.filter((o) => !seen.has(o.label) && seen.add(o.label))
}
