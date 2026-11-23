// OpenAPI and Swagger documents: read from a file a person picks, summed up
// for a table cell, used to fill in the entity they describe, and read into
// the operations and shapes the entity page shows.

import { parse as parseYaml } from 'yaml'
import { stable } from '../shared/filter.ts'
import type { Blueprint } from '../shared/model.ts'

interface SpecDocument {
  openapi?: string
  swagger?: string
  info?: { title?: string; description?: string; version?: string }
  servers?: { url?: string }[]
  host?: string
  basePath?: string
  schemes?: string[]
  paths?: Record<string, Record<string, unknown>>
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

export function isSpec(value: unknown): value is SpecDocument {
  const doc = value as SpecDocument | null
  return !!doc && typeof doc === 'object' && !Array.isArray(doc) && (typeof doc.openapi === 'string' || typeof doc.swagger === 'string')
}

/** Reads a JSON or YAML file as an OpenAPI or Swagger document. Throws with a reason a person can act on. */
export async function readSpec(file: File): Promise<SpecDocument> {
  const text = await file.text()
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    throw new Error(`${file.name} is neither JSON nor YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isSpec(doc)) throw new Error(`${file.name} is not an OpenAPI or Swagger document: it has no "openapi" or "swagger" version`)
  return doc
}

/** Every operation as `GET /path`, in document order. */
export function operations(doc: SpecDocument): string[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) => METHODS.filter((m) => item && typeof item === 'object' && m in item).map((m) => `${m.toUpperCase()} ${path}`))
}

export function specSummary(doc: SpecDocument): string {
  const n = operations(doc).length
  return `${doc.info?.title ?? 'Untitled'}${doc.info?.version ? ` ${doc.info.version}` : ''} · ${n} operation${n === 1 ? '' : 's'}`
}

function baseUrl(doc: SpecDocument): string | undefined {
  const server = doc.servers?.[0]?.url
  if (server && /^https?:\/\//.test(server)) return server
  return doc.host ? `${doc.schemes?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}` : undefined
}

/**
 * What a document says about the entity it describes: a title, and a value
 * for each field of the blueprint the document can fill. The document itself
 * goes in the blueprint's `openapi` field; description, version, and base URL
 * go in fields of those names when the blueprint has them.
 */
export function prefill(doc: SpecDocument, bp: Blueprint): { title: string | undefined; fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {}
  const holder = Object.entries(bp.fields).find(([, def]) => def.type === 'openapi')?.[0]
  if (holder) fields[holder] = doc
  const offer = (name: string, value: string | undefined, types: string[]) => {
    const def = bp.fields[name]
    if (value && def && types.includes(def.type) && !def.mirror && !def.aggregation && !def.calculation) fields[name] = value
  }
  offer('description', doc.info?.description, ['string', 'markdown'])
  offer('version', doc.info?.version, ['string'])
  offer('base_url', baseUrl(doc), ['url'])
  return { title: doc.info?.title, fields }
}

type Json = Record<string, unknown>

const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** What a local `$ref` such as `#/components/schemas/Pet` names: the node, and the name it was reached by. */
export interface Resolved {
  node: Json | undefined
  ref?: string
}

/** Follows `$ref` through the document, refs to refs included. A ref outside the document, or round in a circle, resolves to nothing. */
export function deref(doc: unknown, value: unknown): Resolved {
  let node = obj(value)
  let ref: string | undefined
  const seen = new Set<string>()
  while (node && typeof node.$ref === 'string') {
    const at = node.$ref
    if (!at.startsWith('#/') || seen.has(at)) return { node: undefined, ref: at.split('/').pop() }
    seen.add(at)
    ref = decodeURIComponent(at.split('/').pop()!.replaceAll('~1', '/').replaceAll('~0', '~'))
    node = at
      .slice(2)
      .split('/')
      .map((part) => decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce<Json | undefined>((at, part) => obj(at?.[part]), obj(doc))
  }
  return { node, ref }
}

export interface SpecParameter {
  name: string
  in: string
  required: boolean
  description?: string
  schema: unknown
}

/** A body in one media type, the schema it holds, and the example the document gives for it, if any. */
export interface SpecContent {
  type: string
  schema: unknown
  example?: unknown
}

export interface SpecBody {
  required: boolean
  description?: string
  contents: SpecContent[]
}

export interface SpecResponse {
  code: string
  description?: string
  contents: SpecContent[]
}

/** One way the document says a caller signs in, as a person reads it, with what a request carries for it. */
export interface SpecAuth {
  /** The scheme's name in the document. */
  name: string
  /** `Bearer token`, `API key in header X-Key`, `OAuth 2`. */
  label: string
  scopes: string[]
  /** Where a request carries it, with a stand-in for the secret. */
  carry?: { in: 'header' | 'query' | 'cookie'; name: string; value: string }
}

export interface SpecOperation {
  /** `GET /path`: what names the operation on the page. */
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  deprecated: boolean
  parameters: SpecParameter[]
  body?: SpecBody
  responses: SpecResponse[]
  /** The ways to sign in, any one of which will do; each is the schemes it needs together. Empty when it is open. */
  auth: SpecAuth[][]
}

export interface SpecGroup {
  tag: string
  description?: string
  operations: SpecOperation[]
}

/** A document as the page reads it: what it is, where it is served, and its operations by tag. */
export interface SpecView {
  title: string
  version?: string
  /** `OpenAPI 3.0.1` or `Swagger 2.0`. */
  standard: string
  description?: string
  servers: string[]
  groups: SpecGroup[]
  /** How its operations are signed in to, each way once, and how many need one. */
  auth: { labels: string[]; guarded: number }
}

/** Where a document says it is served: OpenAPI's servers with each variable at its default, or Swagger's scheme, host, and base path. */
function servers(doc: Json): string[] {
  if (typeof doc.swagger === 'string') {
    const host = text(doc.host)
    if (!host) return text(doc.basePath) ? [doc.basePath as string] : []
    return (list(doc.schemes).filter((s): s is string => typeof s === 'string').length ? list(doc.schemes) : ['https']).map((scheme) => `${String(scheme)}://${host}${text(doc.basePath) ?? ''}`)
  }
  return list(doc.servers).flatMap((s) => {
    const server = obj(s)
    const url = text(server?.url)
    if (!url) return []
    const vars = obj(server?.variables) ?? {}
    return [url.replace(/\{([^}]+)\}/g, (whole, name: string) => String(obj(vars[name])?.default ?? whole))]
  })
}

const MEDIA = 'application/json'

/** A Swagger 2.0 operation's body: its `body` parameter, or its form fields as one object. */
function swaggerBody(params: Json[], consumes: string[]): SpecBody | undefined {
  const body = params.find((p) => p.in === 'body')
  if (body) return { required: body.required === true, description: text(body.description), contents: consumes.map((type) => ({ type, schema: body.schema })) }
  const form = params.filter((p) => p.in === 'formData')
  if (!form.length) return undefined
  const schema = { type: 'object', properties: Object.fromEntries(form.map((p) => [String(p.name), p])), required: form.filter((p) => p.required === true).map((p) => String(p.name)) }
  const type = consumes.find((c) => c.startsWith('multipart/') || c === 'application/x-www-form-urlencoded') ?? (form.some((p) => p.type === 'file') ? 'multipart/form-data' : 'application/x-www-form-urlencoded')
  return { required: form.some((p) => p.required === true), contents: [{ type, schema }] }
}

/** OpenAPI's media types, each with its schema and the example it gives: `example`, or the first of `examples`. */
function contents(doc: Json, content: unknown): SpecContent[] {
  return Object.entries(obj(content) ?? {}).map(([type, value]) => {
    const media = obj(value)
    const named = Object.values(obj(media?.examples) ?? {})[0]
    const example = media && 'example' in media ? media.example : named !== undefined ? deref(doc, named).node?.value : undefined
    return example === undefined ? { type, schema: media?.schema } : { type, schema: media?.schema, example }
  })
}

/** What a security scheme is, said for a person, and what a request carries for it. */
function scheme(doc: Json, name: string, scopes: string[]): SpecAuth {
  const schemes = obj(obj(doc.components)?.securitySchemes) ?? obj(doc.securityDefinitions) ?? {}
  const s = deref(doc, schemes[name]).node
  const type = String(s?.type ?? '')
  const bearer = (label: string): SpecAuth => ({ name, label, scopes, carry: { in: 'header', name: 'Authorization', value: 'Bearer $TOKEN' } })
  if (type === 'http' && String(s?.scheme).toLowerCase() === 'basic') return { name, label: 'Basic sign-in', scopes, carry: { in: 'header', name: 'Authorization', value: 'Basic $CREDENTIALS' } }
  if (type === 'basic') return { name, label: 'Basic sign-in', scopes, carry: { in: 'header', name: 'Authorization', value: 'Basic $CREDENTIALS' } }
  if (type === 'http') return bearer(text(s?.bearerFormat) ? `Bearer token (${String(s?.bearerFormat)})` : 'Bearer token')
  if (type === 'apiKey') {
    const at = s?.in === 'query' ? 'query' : s?.in === 'cookie' ? 'cookie' : 'header'
    const key = text(s?.name) ?? name
    return { name, label: `API key in ${at === 'query' ? 'query parameter' : at} ${key}`, scopes, carry: { in: at, name: key, value: '$API_KEY' } }
  }
  if (type === 'oauth2') return bearer('OAuth 2')
  if (type === 'openIdConnect') return bearer('OpenID Connect')
  if (type === 'mutualTLS') return { name, label: 'Client certificate', scopes }
  return { name, label: name, scopes }
}

/** An operation's ways to sign in: its own `security`, else the document's. An empty list opens it. */
function auth(doc: Json, op: Json): SpecAuth[][] {
  const requirements = Array.isArray(op.security) ? op.security : list(doc.security)
  return requirements
    .map(obj)
    .filter((r): r is Json => !!r && Object.keys(r).length > 0)
    .map((r) => Object.entries(r).map(([name, scopes]) => scheme(doc, name, list(scopes).filter((x): x is string => typeof x === 'string'))))
}

function operation(doc: Json, path: string, method: string, item: Json, op: Json): SpecOperation {
  const swagger = typeof doc.swagger === 'string'
  // An operation's own parameters stand over the path's of the same name and place.
  const byPlace = new Map<string, Json>()
  for (const p of [...list(item.parameters), ...list(op.parameters)]) {
    const param = deref(doc, p).node
    if (param) byPlace.set(`${String(param.in)}:${String(param.name)}`, param)
  }
  const params = [...byPlace.values()]
  const strings = (value: unknown) => list(value).filter((x): x is string => typeof x === 'string')
  const consumes = strings(op.consumes).length ? strings(op.consumes) : strings(doc.consumes).length ? strings(doc.consumes) : [MEDIA]
  const produces = strings(op.produces).length ? strings(op.produces) : strings(doc.produces).length ? strings(doc.produces) : [MEDIA]
  const requestBody = deref(doc, op.requestBody).node
  const body = swagger ? swaggerBody(params, consumes) : requestBody && { required: requestBody.required === true, description: text(requestBody.description), contents: contents(doc, requestBody.content) }
  return {
    id: `${method.toUpperCase()} ${path}`,
    method,
    path,
    summary: text(op.summary),
    description: text(op.description),
    deprecated: op.deprecated === true,
    parameters: params
      .filter((p) => !swagger || (p.in !== 'body' && p.in !== 'formData'))
      .map((p) => ({ name: String(p.name ?? ''), in: String(p.in ?? ''), required: p.required === true || p.in === 'path', description: text(p.description), schema: swagger ? p : p.schema })),
    body,
    responses: Object.entries(obj(op.responses) ?? {})
      .map(([code, r]) => {
        const response = deref(doc, r).node
        const examples = obj(response?.examples) ?? {}
        return {
          code,
          description: text(response?.description),
          contents: swagger ? (response?.schema ? produces.map((type) => (type in examples ? { type, schema: response.schema, example: examples[type] } : { type, schema: response.schema })) : []) : contents(doc, response?.content),
        }
      })
      .sort((a, b) => (a.code === 'default' ? 1 : b.code === 'default' ? -1 : a.code.localeCompare(b.code))),
    auth: auth(doc, op),
  }
}

/**
 * Reads a document into what the page shows. Operations group under their
 * first tag, in the order the document lists its tags and then by name, with
 * the untagged last under `default`; inside a group they sort by path, then
 * method. A stored document has lost the order its author wrote it in.
 */
export function readView(doc: SpecDocument): SpecView {
  const root = doc as Json
  const groups = new Map<string, SpecOperation[]>()
  for (const [path, value] of Object.entries(obj(root.paths) ?? {})) {
    const item = deref(root, value).node
    if (!item) continue
    for (const method of METHODS) {
      const op = obj(item[method])
      if (!op) continue
      const tag = text(list(op.tags)[0]) ?? 'default'
      groups.set(tag, [...(groups.get(tag) ?? []), operation(root, path, method, item, op)])
    }
  }
  const declared = list(root.tags).map(obj).filter((t): t is Json => !!text(t?.name))
  const order = [...declared.map((t) => t.name as string), ...[...groups.keys()].filter((t) => t !== 'default').sort(), 'default']
  const info = obj(root.info)
  const all = [...groups.values()].flat()
  return {
    title: text(info?.title) ?? 'Untitled',
    version: text(info?.version),
    standard: typeof doc.swagger === 'string' ? `Swagger ${doc.swagger}` : `OpenAPI ${doc.openapi}`,
    description: text(info?.description),
    servers: servers(root),
    groups: [...new Set(order)]
      .filter((tag) => groups.has(tag))
      .map((tag) => ({
        tag,
        description: text(declared.find((t) => t.name === tag)?.description),
        operations: groups.get(tag)!.sort((a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method)),
      })),
    auth: { labels: [...new Set(all.flatMap((o) => o.auth.flat().map((a) => a.label)))], guarded: all.filter((o) => o.auth.length > 0).length },
  }
}

/** One property of an object, or one choice of a `oneOf`. */
export interface ShapeField {
  name: string
  required: boolean
  schema: unknown
}

/** A schema as the page shows it: a label for its type, what it says of itself, and what it holds. */
export interface Shape {
  label: string
  /** The name of the schema it refers to, or its items' or values' refer to: a nested copy of itself stops there. */
  ref?: string
  description?: string
  values?: string[]
  nullable: boolean
  fields: ShapeField[]
}

/** Reads a schema: its type as one label (`Pet`, `string · uuid`, `Pet[]`, `map of string`), and the fields under it, an array's items' and a map's values' included. */
export function shapeOf(doc: unknown, schema: unknown): Shape {
  const { node, ref } = deref(doc, schema)
  if (!node) return { label: ref ?? 'any', ref, nullable: false, fields: [] }
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((t): t is string => typeof t === 'string')
  const nullable = node.nullable === true || types.includes('null')
  const type = types.find((t) => t !== 'null')
  const description = text(node.description) ?? text(node.title)
  const values = Array.isArray(node.enum) ? node.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : undefined
  const choices = (['oneOf', 'anyOf'] as const).find((k) => Array.isArray(node[k]))
  if (choices) {
    const options = list(node[choices])
    const labels = options.map((o) => shapeOf(doc, o).label)
    return { label: ref ?? labels.join(' | '), ref, description, nullable, fields: options.map((o, i) => ({ name: `${choices === 'oneOf' ? 'One of' : 'Any of'} ${i + 1}`, required: false, schema: o })) }
  }
  if (type === 'array' || (!type && node.items)) {
    const items = shapeOf(doc, node.items)
    return { label: ref ?? `${items.label.includes(' ') ? `(${items.label})` : items.label}[]`, ref: ref ?? items.ref, description, values, nullable, fields: items.fields }
  }
  const parts = Array.isArray(node.allOf) ? node.allOf.map((p) => deref(doc, p).node).filter((p): p is Json => !!p) : []
  const properties = [node, ...parts].flatMap((n) => Object.entries(obj(n.properties) ?? {}))
  const required = new Set([node, ...parts].flatMap((n) => list(n.required)).filter((r): r is string => typeof r === 'string'))
  const fields = properties.map(([name, schema]) => ({ name, required: required.has(name), schema }))
  const extra = obj(node.additionalProperties)
  if (!fields.length && extra) {
    const values = shapeOf(doc, extra)
    return { label: ref ?? `map of ${values.label}`, ref: ref ?? values.ref, description, nullable, fields: values.fields }
  }
  const named = type ?? (fields.length || parts.length ? 'object' : 'any')
  const format = text(node.format)
  return { label: ref ?? (format ? `${named} · ${format}` : named), ref, description, values, nullable, fields }
}

/** How deep an example or an expanded schema goes before it stops: a schema can nest without end. */
const DEPTH = 8

/** A value of the schema's shape: its own example, default, or first allowed value where it gives one, else a plain value of its type. A schema inside itself stops at null. */
export function exampleOf(doc: unknown, schema: unknown, seen: string[] = []): unknown {
  const { node, ref } = deref(doc, schema)
  if (!node || (ref && seen.includes(ref)) || seen.length > DEPTH) return null
  const below = [...seen, ref ?? '']
  if ('example' in node) return node.example
  if (Array.isArray(node.examples) && node.examples.length) return node.examples[0]
  if ('default' in node) return node.default
  if ('const' in node) return node.const
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0]
  const choice = list(node.oneOf ?? node.anyOf)[0]
  if (choice !== undefined) return exampleOf(doc, choice, below)
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((t): t is string => typeof t === 'string' && t !== 'null')
  const type = types[0]
  if (type === 'array' || (!type && node.items)) return [exampleOf(doc, node.items, below)]
  const parts = Array.isArray(node.allOf) ? node.allOf.map((p) => deref(doc, p).node).filter((p): p is Json => !!p) : []
  const properties = [node, ...parts].flatMap((n) => Object.entries(obj(n.properties) ?? {}))
  if (type === 'object' || properties.length || parts.length || node.additionalProperties) {
    if (!properties.length && obj(node.additionalProperties)) return { key: exampleOf(doc, node.additionalProperties, below) }
    return Object.fromEntries(properties.map(([name, p]) => [name, exampleOf(doc, p, below)]))
  }
  switch (type) {
    case 'integer':
    case 'number':
      return typeof node.minimum === 'number' ? node.minimum : 0
    case 'boolean':
      return true
    case 'string':
    case 'file':
      return FORMAT[String(node.format)] ?? (type === 'file' ? '@file' : 'string')
  }
  return null
}

/** A plain value for each string format a reader will recognise. */
const FORMAT: Record<string, string> = {
  'date-time': '2026-01-01T12:00:00Z',
  date: '2026-01-01',
  time: '12:00:00',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'aGVsbG8=',
  binary: '@file',
  password: '********',
}

/** The media type a reader most likely sends or gets: JSON first, then whatever the document lists first. */
export function preferred(contents: SpecContent[]): SpecContent | undefined {
  return contents.find((c) => c.type === MEDIA) ?? contents.find((c) => /[/+]json\b/.test(c.type)) ?? contents[0]
}

/** The example of a body in one media type, and whether the document gave it or it was made from the schema. */
export function exampleFor(doc: unknown, content: SpecContent): { value: unknown; given: boolean } {
  return content.example !== undefined ? { value: content.example, given: true } : { value: exampleOf(doc, content.schema), given: false }
}

/** A request for an operation, ready to paste: one in curl and one in PowerShell. */
export interface SpecRequest {
  curl: string
  powershell: string
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
/** A shell string that still expands its `$` stand-ins, such as `$TOKEN`. */
const shellLive = (s: string) => (s.includes('$') ? `"${s.replace(/["\\`]/g, (c) => `\\${c}`)}"` : shellQuote(s))
const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`
/** A PowerShell string that still reads its `$` stand-ins, such as `$TOKEN`, as variables. */
const psLive = (s: string) => (s.includes('$') ? `"${s.replaceAll('`', '``').replaceAll('"', '`"')}"` : psQuote(s))
const plain = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * Writes the request an operation takes: its URL on the server, its required
 * query and header parameters with example values, how it signs in (the
 * first way it allows, with `$TOKEN`-style stand-ins for the secret), and an
 * example body in its JSON media type, else its first. A path parameter stays `{name}` for
 * the reader to fill in.
 */
export function requestOf(doc: unknown, op: SpecOperation, server: string | undefined): SpecRequest {
  const carry = (op.auth[0] ?? []).flatMap((a) => (a.carry ? [a.carry] : []))
  const required = op.parameters.filter((p) => p.required)
  const query = [...required.filter((p) => p.in === 'query').map((p) => [p.name, plain(exampleOf(doc, p.schema))] as const), ...carry.filter((c) => c.in === 'query').map((c) => [c.name, c.value] as const)]
  const headers = [...carry.filter((c) => c.in === 'header').map((c) => [c.name, c.value] as const), ...required.filter((p) => p.in === 'header').map((p) => [p.name, plain(exampleOf(doc, p.schema))] as const)]
  const cookies = carry.filter((c) => c.in === 'cookie').map((c) => `${c.name}=${c.value}`)
  if (cookies.length) headers.push(['Cookie', cookies.join('; ')])
  const url = `${(server ?? '').replace(/\/$/, '')}${op.path}${query.length ? `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${v.startsWith('$') ? v : encodeURIComponent(v)}`).join('&')}` : ''}`
  const content = preferred(op.body?.contents ?? [])
  const example = content && exampleFor(doc, content).value
  const method = op.method.toUpperCase()
  const form = content && (content.type.startsWith('multipart/') || content.type === 'application/x-www-form-urlencoded') ? Object.entries(obj(example) ?? {}) : undefined

  const curl = [`curl${method === 'GET' ? '' : ` -X ${method}`} ${shellLive(url)}`]
  for (const [k, v] of headers) curl.push(`  -H ${shellLive(`${k}: ${v}`)}`)
  if (content && !form) curl.push(`  -H ${shellQuote(`Content-Type: ${content.type}`)}`, `  -d ${shellQuote(typeof example === 'string' ? example : JSON.stringify(example, null, 2))}`)
  if (form) for (const [k, v] of form) curl.push(content!.type.startsWith('multipart/') ? `  -F ${shellQuote(`${k}=${plain(v)}`)}` : `  --data-urlencode ${shellQuote(`${k}=${plain(v)}`)}`)

  const ps = [`Invoke-RestMethod -Method ${method[0]}${method.slice(1).toLowerCase()}`, `  -Uri ${psLive(url)}`]
  if (headers.length) ps.push(`  -Headers @{ ${headers.map(([k, v]) => `${/^[A-Za-z_][\w]*$/.test(k) ? k : psQuote(k)} = ${psLive(v)}`).join('; ')} }`)
  if (content && !form) ps.push(`  -ContentType ${psQuote(content.type)}`, `  -Body ${psQuote(typeof example === 'string' ? example : JSON.stringify(example, null, 2))}`)
  if (form) ps.push(`  -${content!.type.startsWith('multipart/') ? 'Form' : 'Body'} @{ ${form.map(([k, v]) => `${psQuote(k)} = ${psQuote(plain(v))}`).join('; ')} }`)
  return { curl: curl.join(' \\\n'), powershell: ps.join(' `\n') }
}

/** A value with every local `$ref` replaced by what it names, a ref inside itself kept as the ref. */
function expand(doc: unknown, value: unknown, seen: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => expand(doc, v, seen))
  const node = obj(value)
  if (!node) return value
  if (typeof node.$ref === 'string') {
    if (seen.includes(node.$ref) || seen.length > DEPTH) return node
    return expand(doc, deref(doc, node).node ?? node, [...seen, node.$ref])
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expand(doc, v, seen)]))
}

/** What moved between two versions of a document: operations by `GET /path`, and the version it says it is. */
export interface SpecChanges {
  added: string[]
  removed: string[]
  changed: string[]
  version?: { from?: string; to?: string }
}

/** Compares two documents operation by operation, each with its refs followed, so a change to a schema it uses counts as a change to it. */
export function changesOf(before: SpecDocument, after: SpecDocument): SpecChanges {
  const ops = (doc: SpecDocument) => new Map(readView(doc).groups.flatMap((g) => g.operations).map((o) => [o.id, stable(expand(doc, o))]))
  const was = ops(before)
  const now = ops(after)
  const from = text(obj(before.info)?.version)
  const to = text(obj(after.info)?.version)
  return {
    added: [...now.keys()].filter((id) => !was.has(id)),
    removed: [...was.keys()].filter((id) => !now.has(id)),
    changed: [...now.keys()].filter((id) => was.has(id) && was.get(id) !== now.get(id)),
    ...(from !== to ? { version: { from, to } } : {}),
  }
}
