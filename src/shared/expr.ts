// A small, safe expression language for calculation fields. No assignment,
// no loops, no access to anything but the values it is handed and a few
// functions. Grammar, lowest precedence first:
//   ternary  := or ('?' expr ':' expr)?
//   or       := and ('||' and)*
//   and      := cmp ('&&' cmp)*
//   cmp      := sum (('=='|'!='|'<'|'<='|'>'|'>=') sum)?
//   sum      := prod (('+'|'-') prod)*
//   prod     := unary (('*'|'/'|'%') unary)*
//   unary    := ('!'|'-') unary | primary
//   primary  := number | string | true | false | null | ident ('.' ident | '[' string ']')* | ident '(' args ')' | '(' expr ')'

type Token = { kind: 'num'; value: number } | { kind: 'str'; value: string } | { kind: 'id'; value: string } | { kind: 'op'; value: string } | { kind: 'end' }

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', '.', ',', '?', ':']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!
      out.push({ kind: 'num', value: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end < 0) throw new Error(`unterminated string at ${i}`)
      out.push({ kind: 'str', value: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ kind: 'id', value: m[0] })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`unexpected "${c}" at ${i}`)
    out.push({ kind: 'op', value: op })
    i += op.length
  }
  out.push({ kind: 'end' })
  return out
}

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'ref'; path: string[] }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'tern'; c: Node; a: Node; b: Node }

export interface Expr {
  source: string
  /** The first name of every path the expression reads: the fields it needs before it can run. */
  reads: ReadonlySet<string>
  evaluate(fields: Record<string, unknown>): unknown
}

/** The functions whose answer moves with the clock. */
const CLOCK = /\b(days_until|days_since|hours_since|hour_now|weekday_now)\s*\(/

/** Whether an expression reads the time now, so a value kept from it goes stale on its own. */
export function readsClock(source: string): boolean {
  return CLOCK.test(source)
}

/** Parses once; evaluate many times. Throws on a syntax error. */
export function compile(source: string): Expr {
  const toks = tokenize(source)
  let p = 0
  const peek = () => toks[p]!
  const take = () => toks[p++]!
  const isOp = (v: string) => peek().kind === 'op' && (peek() as { value: string }).value === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}" near token ${p}`)
    p++
  }
  const ternary = (): Node => {
    const c = or()
    if (isOp('?')) {
      p++
      const a = ternary()
      expect(':')
      const b = ternary()
      return { t: 'tern', c, a, b }
    }
    return c
  }
  const or = (): Node => {
    let a = and()
    while (isOp('||')) {
      p++
      a = { t: 'bin', op: '||', a, b: and() }
    }
    return a
  }
  const and = (): Node => {
    let a = cmp()
    while (isOp('&&')) {
      p++
      a = { t: 'bin', op: '&&', a, b: cmp() }
    }
    return a
  }
  const cmp = (): Node => {
    const a = sum()
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (isOp(op)) {
        p++
        return { t: 'bin', op, a, b: sum() }
      }
    }
    return a
  }
  const sum = (): Node => {
    let a = prod()
    while (isOp('+') || isOp('-')) {
      const op = (take() as { value: string }).value
      a = { t: 'bin', op, a, b: prod() }
    }
    return a
  }
  const prod = (): Node => {
    let a = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (take() as { value: string }).value
      a = { t: 'bin', op, a, b: unary() }
    }
    return a
  }
  const unary = (): Node => {
    if (isOp('!') || isOp('-')) {
      const op = (take() as { value: string }).value
      return { t: 'un', op, a: unary() }
    }
    return primary()
  }
  const primary = (): Node => {
    const tok = take()
    if (tok.kind === 'num' || tok.kind === 'str') return { t: 'lit', v: tok.value }
    if (tok.kind === 'id') {
      if (tok.value === 'true') return { t: 'lit', v: true }
      if (tok.value === 'false') return { t: 'lit', v: false }
      if (tok.value === 'null') return { t: 'lit', v: null }
      if (isOp('(')) {
        p++
        const args: Node[] = []
        if (!isOp(')')) {
          args.push(ternary())
          while (isOp(',')) {
            p++
            args.push(ternary())
          }
        }
        expect(')')
        if (!(tok.value in FUNCTIONS)) throw new Error(`unknown function ${tok.value}()`)
        return { t: 'call', fn: tok.value, args }
      }
      const path = [tok.value]
      while (isOp('.') || isOp('[')) {
        if (isOp('.')) {
          p++
          const id = take()
          if (id.kind !== 'id') throw new Error('expected a name after "."')
          path.push(id.value)
        } else {
          p++
          const key = take()
          if (key.kind !== 'str') throw new Error('expected a quoted key inside []')
          expect(']')
          path.push(key.value)
        }
      }
      return { t: 'ref', path }
    }
    if (tok.kind === 'op' && tok.value === '(') {
      const inner = ternary()
      expect(')')
      return inner
    }
    throw new Error(`unexpected ${tok.kind === 'end' ? 'end of expression' : JSON.stringify(tok)}`)
  }
  const root = ternary()
  if (peek().kind !== 'end') throw new Error(`unexpected input after expression at token ${p}`)
  return { source, reads: readsOf(root), evaluate: (fields) => run(root, fields) }
}

function readsOf(node: Node, out = new Set<string>()): Set<string> {
  if (node.t === 'ref') out.add(node.path[0]!)
  else if (node.t === 'call') for (const a of node.args) readsOf(a, out)
  else if (node.t === 'un') readsOf(node.a, out)
  else if (node.t === 'bin') readsOf(node.b, readsOf(node.a, out))
  else if (node.t === 'tern') readsOf(node.b, readsOf(node.a, readsOf(node.c, out)))
  return out
}

const DAY = 86_400_000
const HOUR = 3_600_000
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** One part of the time now in a zone; an unknown zone reads as UTC. */
function zoned(tz: unknown, part: Intl.DateTimeFormatOptions): string {
  const timeZone = typeof tz === 'string' && tz !== '' ? tz : 'UTC'
  try {
    return new Intl.DateTimeFormat('en-US', { ...part, timeZone }).format(new Date())
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...part, timeZone: 'UTC' }).format(new Date())
  }
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toLowerCase() : x)) : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toUpperCase() : x)) : v),
  /** One list of every value given, lists opened up, empty values and repeats left out. */
  list: (...args) => [...new Set(args.flat().filter((a) => a !== null && a !== undefined && a !== ''))],
  coalesce: (...args) => args.find((a) => a !== null && a !== undefined) ?? null,
  round: (v, digits) => (typeof v === 'number' ? Number(v.toFixed(typeof digits === 'number' ? digits : 0)) : v),
  min: (...args) => Math.min(...args.filter((a): a is number => typeof a === 'number')),
  max: (...args) => Math.max(...args.filter((a): a is number => typeof a === 'number')),
  abs: (v) => (typeof v === 'number' ? Math.abs(v) : v),
  /** Days from now until a datetime; negative when past. */
  days_until: (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Math.floor((Date.parse(v) - Date.now()) / DAY) : null),
  days_since: (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Math.floor((Date.now() - Date.parse(v)) / DAY) : null),
  /** Whole hours since a datetime, for what is judged in hours, such as a job's last success. */
  hours_since: (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Math.floor((Date.now() - Date.parse(v)) / HOUR) : null),
  /** The hour of the day now, 0 to 23, in an IANA time zone (UTC when none is given), such as `hour_now('America/Chicago')`. */
  hour_now: (tz) => Number(zoned(tz, { hour: 'numeric', hourCycle: 'h23' })),
  /** The day of the week now, 1 for Monday to 7 for Sunday, in an IANA time zone (UTC when none is given). */
  weekday_now: (tz) => WEEKDAYS.indexOf(zoned(tz, { weekday: 'short' })) + 1,
  contains: (hay, needle) => (typeof hay === 'string' ? hay.includes(String(needle)) : Array.isArray(hay) ? hay.some((x) => x === needle) : hay && typeof hay === 'object' ? String(needle) in (hay as object) : false),
  starts_with: (s, prefix) => typeof s === 'string' && s.startsWith(String(prefix)),
  /** What comes before the last separator, such as the project a repository's key sits in: `before_last(key, '/')`. The whole string when the separator is not in it. */
  before_last: (s, sep) => (typeof s === 'string' ? (s.lastIndexOf(String(sep)) < 0 ? s : s.slice(0, s.lastIndexOf(String(sep)))) : null),
  empty: (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && Object.keys(v).length === 0),
  number: (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null),
}

function run(n: Node, fields: Record<string, unknown>): unknown {
  switch (n.t) {
    case 'lit':
      return n.v
    case 'ref': {
      let cur: unknown = n.path[0] === 'fields' ? fields : fields[n.path[0]!]
      for (const seg of n.path.slice(1)) {
        if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg]
        else return null
      }
      return cur === undefined ? null : cur
    }
    case 'call':
      return FUNCTIONS[n.fn]!(...n.args.map((a) => run(a, fields)))
    case 'un': {
      const v = run(n.a, fields)
      return n.op === '!' ? !truthy(v) : typeof v === 'number' ? -v : null
    }
    case 'tern':
      return truthy(run(n.c, fields)) ? run(n.a, fields) : run(n.b, fields)
    case 'bin': {
      if (n.op === '&&') return truthy(run(n.a, fields)) ? run(n.b, fields) : false
      if (n.op === '||') {
        const a = run(n.a, fields)
        return truthy(a) ? a : run(n.b, fields)
      }
      const a = run(n.a, fields)
      const b = run(n.b, fields)
      switch (n.op) {
        case '==':
          return JSON.stringify(a) === JSON.stringify(b)
        case '!=':
          return JSON.stringify(a) !== JSON.stringify(b)
        case '<':
          return cmpv(a, b) < 0
        case '<=':
          return cmpv(a, b) <= 0
        case '>':
          return cmpv(a, b) > 0
        case '>=':
          return cmpv(a, b) >= 0
        case '+':
          return typeof a === 'number' && typeof b === 'number' ? a + b : a === null || b === null ? null : String(a) + String(b)
        case '-':
          return typeof a === 'number' && typeof b === 'number' ? a - b : null
        case '*':
          return typeof a === 'number' && typeof b === 'number' ? a * b : null
        case '/':
          return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null
        case '%':
          return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a % b : null
      }
      return null
    }
  }
}

function truthy(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === 0 || v === '')
}

function cmpv(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a === null || a === undefined || b === null || b === undefined) return Number.NaN
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}
