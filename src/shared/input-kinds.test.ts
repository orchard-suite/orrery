import { describe, expect, it } from 'vitest'
import { aKind, ATTACHMENT_MAX, INPUT_KINDS, INPUT_RULES, PATTERN_MAX, PATTERN_VALUE_MAX, checkInput, defIssues, inputText, resolveDay, type CheckContext, type InputKindName } from './input-kinds.ts'
import { ACTION_INPUT_TYPES } from './model.ts'

const ctx: CheckContext = { today: '2026-03-10' }
const check = (type: InputKindName, value: unknown, def: object = {}, more: Partial<CheckContext> = {}) => INPUT_KINDS[type].check(def, value, { ...ctx, ...more })
const ok = (value: unknown) => ({ ok: true, value })
const no = (error: string) => ({ ok: false, error })

describe('the registry', () => {
  it('is where the input types come from', () => {
    expect([...ACTION_INPUT_TYPES]).toEqual(Object.keys(INPUT_KINDS))
    expect(ACTION_INPUT_TYPES).toEqual(['string', 'text', 'markdown', 'attachment', 'change', 'number', 'boolean', 'date', 'datetime', 'email', 'url', 'enum', 'entity', 'person'])
  })

  it('says what every kind is, for the builder', () => {
    for (const [name, kind] of Object.entries(INPUT_KINDS)) {
      expect(kind.title, name).toMatch(/^[A-Z]/)
      expect(kind.description, name).toMatch(/\.$/)
      for (const rule of kind.rules) expect(INPUT_RULES).toContain(rule)
    }
  })

  it('knows which kinds pick, and from what', () => {
    expect(Object.entries(INPUT_KINDS).flatMap(([n, k]) => (k.picks ? [[n, k.picks]] : []))).toEqual([
      ['enum', 'values'],
      ['entity', 'entity'],
      ['person', 'entity'],
    ])
    expect(INPUT_KINDS.person.options).not.toContain('blueprint')
    expect(INPUT_KINDS.entity.options).toContain('blueprint')
  })
})

describe('each kind checks one value', () => {
  it('string, text, and markdown take text as it is', () => {
    for (const type of ['string', 'text', 'markdown'] as const) {
      expect(check(type, ' a\nb ')).toEqual(ok(' a\nb '))
      expect(check(type, 3)).toEqual(no('expected text'))
    }
  })

  it('attachment takes text exactly as sent, up to its most', () => {
    const plan = '  # a.b will be updated in-place\n  ~ tags = {}\n\n'
    expect(check('attachment', plan)).toEqual(ok(plan))
    expect(check('attachment', 'x'.repeat(ATTACHMENT_MAX))).toEqual(ok('x'.repeat(ATTACHMENT_MAX)))
    expect(check('attachment', 'x'.repeat(ATTACHMENT_MAX + 1))).toEqual(no('expected at most 1,000,000 characters'))
    expect(check('attachment', 'abcd', { maxLength: 3 })).toEqual(no('expected at most 3 characters'))
    expect(check('attachment', 3)).toEqual(no('expected text'))
    expect(INPUT_KINDS.attachment.shows).toBe('attachment')
  })

  it('number takes a number or its text', () => {
    expect(check('number', 3)).toEqual(ok(3))
    expect(check('number', ' 2.5 ')).toEqual(ok(2.5))
    expect(check('number', '')).toEqual(no('expected a number'))
    expect(check('number', 'three')).toEqual(no('expected a number'))
    expect(check('number', Infinity)).toEqual(no('expected a number'))
  })

  it('boolean takes true or false', () => {
    expect(check('boolean', false)).toEqual(ok(false))
    expect(check('boolean', 'true')).toEqual(ok(true))
    expect(check('boolean', 'yes')).toEqual(no('expected true or false'))
  })

  it('url takes what parses as one', () => {
    expect(check('url', 'https://example.com/a')).toEqual(ok('https://example.com/a'))
    expect(check('url', 'example')).toEqual(no('expected a URL'))
  })

  it('date takes a real day', () => {
    expect(check('date', '2024-02-29')).toEqual(ok('2024-02-29'))
    expect(check('date', ' 2026-03-10 ')).toEqual(ok('2026-03-10'))
    expect(check('date', '2026-02-30')).toEqual(no('expected a date, as YYYY-MM-DD'))
    expect(check('date', '2025-02-29')).toEqual(no('expected a date, as YYYY-MM-DD'))
    expect(check('date', '03/10/2026')).toEqual(no('expected a date, as YYYY-MM-DD'))
    expect(check('date', 20260310)).toEqual(no('expected a date, as YYYY-MM-DD'))
  })

  it('datetime takes an instant with an offset and keeps it in UTC', () => {
    expect(check('datetime', '2026-03-10T09:30:00-05:00')).toEqual(ok('2026-03-10T14:30:00.000Z'))
    expect(check('datetime', '2026-03-10T14:30Z')).toEqual(ok('2026-03-10T14:30:00.000Z'))
    expect(check('datetime', '2026-03-10T14:30:15.250+00:00')).toEqual(ok('2026-03-10T14:30:15.250Z'))
    const refused = no('expected a date and time with an offset, as 2026-03-10T14:30:00Z')
    expect(check('datetime', '2026-03-10T14:30')).toEqual(refused)
    expect(check('datetime', '2026-02-30T14:30:00Z')).toEqual(refused)
    expect(check('datetime', '2026-03-10T25:00:00Z')).toEqual(refused)
    expect(check('datetime', '2026-03-10')).toEqual(refused)
    expect(check('datetime', 1773153000000)).toEqual(refused)
  })

  it('email takes a plain address, trimmed, its domain in lower case', () => {
    expect(check('email', '  A.User@Example.COM ')).toEqual(ok('A.User@example.com'))
    for (const bad of ['user', 'user@', '@example.com', 'user@example', 'a user@example.com', 'user@@example.com', 7]) expect(check('email', bad), String(bad)).toEqual(no('expected an email address'))
  })

  it('enum takes one of the values it was given', () => {
    expect(check('enum', 'b', {}, { allowed: ['a', 'b'] })).toEqual(ok('b'))
    expect(check('enum', 'c', {}, { allowed: ['a', 'b'] })).toEqual(no('expected one of a, b'))
    expect(check('enum', 'c', {}, { allowed: [] })).toEqual(no('no values to pick from'))
    expect(check('enum', 'c')).toEqual(no('no values to pick from'))
  })

  it('entity and person take an id of a blueprint they pick from', () => {
    for (const type of ['entity', 'person'] as const) {
      expect(check(type, 'team:core', {}, { picks: ['team'] })).toEqual(ok('team:core'))
      expect(check(type, 'core', {}, { picks: ['team'] })).toEqual(ok('team:core'))
      expect(check(type, { id: 'team:core' }, {}, { picks: ['team'] })).toEqual(ok('team:core'))
      expect(check(type, 'core', {}, { picks: ['team', 'squad'] })).toEqual(no('expected an entity id, blueprint:key'))
      expect(check(type, 7, {}, { picks: ['team'] })).toEqual(no('expected an entity id, blueprint:key'))
      expect(check(type, 'app:web', {}, { picks: ['team'] })).toEqual(no('expected a team'))
      expect(check(type, 'app:web', {}, { picks: ['team', 'squad'] })).toEqual(no('expected one of team, squad'))
    }
  })
})

describe('empty and text', () => {
  it('nothing given is empty, and false is an answer', () => {
    for (const kind of Object.values(INPUT_KINDS)) {
      for (const nothing of [undefined, null, '', []]) expect(kind.empty(nothing)).toBe(true)
      expect(kind.empty('x')).toBe(false)
    }
    expect(INPUT_KINDS.boolean.empty(false)).toBe(false)
    expect(INPUT_KINDS.number.empty(0)).toBe(false)
  })

  it('each kind reads as text', () => {
    expect(INPUT_KINDS.string.text('a')).toBe('a')
    expect(INPUT_KINDS.number.text(3)).toBe('3')
    expect(INPUT_KINDS.boolean.text(true)).toBe('Yes')
    expect(INPUT_KINDS.boolean.text(false)).toBe('No')
    expect(INPUT_KINDS.datetime.text('2026-03-10T14:30:00.000Z')).toBe('2026-03-10T14:30:00.000Z')
    expect(INPUT_KINDS.entity.text('team:core')).toBe('team:core')
    expect(INPUT_KINDS.string.text({ a: 1 })).toBe('{"a":1}')
  })

  it('a whole input reads as text: nothing as nothing, a list item by item', () => {
    expect(inputText({ type: 'string' }, null)).toBe('')
    expect(inputText({ type: 'boolean' }, false)).toBe('No')
    expect(inputText({ type: 'enum', many: true }, ['a', 'b'])).toBe('a, b')
    expect(inputText({ type: 'enum', many: true }, [])).toBe('')
  })
})

describe('rules', () => {
  it('pattern is matched whole', () => {
    const def = { pattern: '[A-Z]{2,5}-\\d+' }
    expect(check('string', 'OPS-12', def)).toEqual(ok('OPS-12'))
    expect(check('string', 'see OPS-12', def)).toEqual(no('expected text that matches [A-Z]{2,5}-\\d+'))
    expect(check('text', 'ops', def)).toEqual(no('expected text that matches [A-Z]{2,5}-\\d+'))
    expect(check('email', 'user@example.com', { pattern: '.*@example\\.com' })).toEqual(ok('user@example.com'))
    expect(check('email', 'user@example.org', { pattern: '.*@example\\.com' })).toEqual(no('expected text that matches .*@example\\.com'))
    expect(check('url', 'http://example.com', { pattern: 'https://.*' })).toEqual(no('expected text that matches https://.*'))
  })

  it('a value too long to check against a pattern is refused, and says so', () => {
    expect(check('text', 'a'.repeat(PATTERN_VALUE_MAX), { pattern: 'a*' })).toEqual(ok('a'.repeat(PATTERN_VALUE_MAX)))
    expect(check('text', 'a'.repeat(PATTERN_VALUE_MAX + 1), { pattern: 'a*' })).toEqual(no(`expected at most ${PATTERN_VALUE_MAX} characters: more are not checked against a pattern`))
  })

  it('minLength and maxLength count characters', () => {
    expect(check('string', 'abc', { minLength: 3, maxLength: 3 })).toEqual(ok('abc'))
    expect(check('string', 'ab', { minLength: 3 })).toEqual(no('expected at least 3 characters'))
    expect(check('markdown', 'abcd', { maxLength: 3 })).toEqual(no('expected at most 3 characters'))
    expect(check('text', 'a', { minLength: 1 })).toEqual(ok('a'))
    expect(check('string', '', { minLength: 1 })).toEqual(no('expected at least 1 character'))
  })

  it('min and max bound a number', () => {
    expect(check('number', 3, { min: 3, max: 5 })).toEqual(ok(3))
    expect(check('number', '2', { min: 3 })).toEqual(no('expected 3 or more'))
    expect(check('number', 6, { max: 5 })).toEqual(no('expected 5 or less'))
  })

  it('min and max bound a date, by a day or by today in UTC', () => {
    expect(check('date', '2026-03-10', { min: 'today' })).toEqual(ok('2026-03-10'))
    expect(check('date', '2026-03-09', { min: 'today' })).toEqual(no('expected 2026-03-10 or later'))
    expect(check('date', '2026-04-10', { max: 'today+30d' })).toEqual(no('expected 2026-04-09 or earlier'))
    expect(check('date', '2026-04-09', { max: 'today+30d' })).toEqual(ok('2026-04-09'))
    expect(check('date', '2025-01-01', { min: '2025-06-01' })).toEqual(no('expected 2025-06-01 or later'))
  })

  it('min and max bound an instant: a day is its start below and its end above', () => {
    expect(check('datetime', '2026-03-10T00:00:00Z', { min: 'today' })).toEqual(ok('2026-03-10T00:00:00.000Z'))
    expect(check('datetime', '2026-03-09T23:59:59Z', { min: 'today' })).toEqual(no('expected 2026-03-10T00:00:00.000Z or later'))
    expect(check('datetime', '2026-03-10T23:59:59Z', { max: 'today' })).toEqual(ok('2026-03-10T23:59:59.000Z'))
    expect(check('datetime', '2026-03-11T00:00:00Z', { max: 'today' })).toEqual(no('expected 2026-03-10T23:59:59.999Z or earlier'))
    expect(check('datetime', '2026-03-10T12:00:01Z', { max: '2026-03-10T07:00:00-05:00' })).toEqual(no('expected 2026-03-10T12:00:00.000Z or earlier'))
  })

  it('a hint is what a failed rule says, and never what a wrong shape says', () => {
    const def = { pattern: '[A-Z]+-\\d+', hint: 'Give the ticket, such as OPS-12' }
    expect(check('string', 'ops', def)).toEqual(no('Give the ticket, such as OPS-12'))
    expect(check('string', 7, def)).toEqual(no('expected text'))
    expect(check('number', 1, { min: 2, hint: 'Two or more' })).toEqual(no('Two or more'))
    expect(check('number', 'x', { min: 2, hint: 'Two or more' })).toEqual(no('expected a number'))
  })
})

describe('today', () => {
  it('moves by days, weeks, months, and years, in UTC days', () => {
    expect(resolveDay('today', '2026-03-10')).toBe('2026-03-10')
    expect(resolveDay('today+30d', '2026-03-10')).toBe('2026-04-09')
    expect(resolveDay('today-2w', '2026-03-10')).toBe('2026-02-24')
    expect(resolveDay('today-1y', '2026-03-10')).toBe('2025-03-10')
    expect(resolveDay('today+1m', '2026-01-31')).toBe('2026-02-28')
    expect(resolveDay('today+1y', '2024-02-29')).toBe('2025-02-28')
    expect(resolveDay('today-1d', '2026-01-01')).toBe('2025-12-31')
  })

  it('a day is itself, and anything else is nothing', () => {
    expect(resolveDay('2026-03-10', '2020-01-01')).toBe('2026-03-10')
    expect(resolveDay('2026-02-30', '2020-01-01')).toBeNull()
    expect(resolveDay('tomorrow', '2020-01-01')).toBeNull()
    expect(resolveDay('today + 1d', '2020-01-01')).toBeNull()
  })
})

describe('a whole input', () => {
  it('one value is checked by its kind', () => {
    expect(checkInput({ type: 'date' }, '2026-02-30', ctx)).toEqual(no('expected a date, as YYYY-MM-DD'))
    expect(checkInput({ type: 'email' }, 'User@EXAMPLE.com', ctx)).toEqual(ok('User@example.com'))
  })

  it('a list is checked item by item, from a list or one per line', () => {
    expect(checkInput({ type: 'email', many: true }, ['a@Example.com', 'b@example.com'], ctx)).toEqual(ok(['a@example.com', 'b@example.com']))
    expect(checkInput({ type: 'string', many: true }, 'a\n\n b \n', ctx)).toEqual(ok(['a', 'b']))
    expect(checkInput({ type: 'email', many: true }, ['a@example.com', 'b'], ctx)).toEqual(no('expected an email address'))
    expect(checkInput({ type: 'string', many: true }, 7, ctx)).toEqual(no('expected a list'))
  })

  it('a list a person types holds each value once, as its kind stores it', () => {
    expect(checkInput({ type: 'url', many: true }, ['https://a', 'https://b', 'https://a'], ctx)).toEqual(no('expected each value once: https://a is in the list twice'))
    expect(checkInput({ type: 'email', many: true }, ['a@Example.com', 'a@example.COM'], ctx)).toEqual(no('expected each value once: a@example.com is in the list twice'))
    expect(checkInput({ type: 'number', many: true }, ['1', 1], ctx)).toEqual(no('expected each value once: 1 is in the list twice'))
    expect(checkInput({ type: 'string', many: true }, ['a', 'A'], ctx)).toEqual(ok(['a', 'A']))
  })

  it('minLength and maxLength count the picks of a list that picks', () => {
    const def = { type: 'enum', many: true, minLength: 2, maxLength: 3 } as const
    const allowed = ['a', 'b', 'c', 'd']
    expect(checkInput(def, ['a', 'b'], { ...ctx, allowed })).toEqual(ok(['a', 'b']))
    expect(checkInput(def, ['a'], { ...ctx, allowed })).toEqual(no('expected at least 2 picked'))
    expect(checkInput(def, allowed, { ...ctx, allowed })).toEqual(no('expected at most 3 picked'))
    expect(checkInput({ ...def, hint: 'Pick two or three' }, ['a'], { ...ctx, allowed })).toEqual(no('Pick two or three'))
    expect(checkInput({ type: 'entity', many: true, minLength: 2 }, ['team:a'], { ...ctx, picks: ['team'] })).toEqual(no('expected at least 2 picked'))
  })
})

describe('a definition', () => {
  const issues = (type: InputKindName, def: object) => defIssues(type, def).map((i) => `${i.at}: ${i.message}`)

  it('with rules its kind takes has nothing wrong', () => {
    expect(issues('string', { many: true, pattern: '[a-z]+', minLength: 1, maxLength: 9, hint: 'Lower case' })).toEqual([])
    expect(issues('number', { min: 0, max: 10 })).toEqual([])
    expect(issues('date', { min: 'today', max: 'today+1y' })).toEqual([])
    expect(issues('datetime', { min: '2026-01-01T00:00:00Z', max: 'today+30d' })).toEqual([])
    expect(issues('enum', { many: true, display: 'buttons', minLength: 1 })).toEqual([])
    expect(issues('person', { many: true, maxLength: 3 })).toEqual([])
  })

  it('takes current on a list it changes, or on a kind that picks, and nowhere else', () => {
    for (const type of ['string', 'number', 'email', 'url', 'entity', 'person'] as const) expect(issues(type, { many: true, current: '{{ entity.fields.x }}' })).toEqual([])
    expect(issues('entity', { current: '{{ entity.fields.x }}' })).toEqual([])
    expect(issues('url', { current: '{{ entity.fields.x }}' })).toEqual(['current: current is the list the entity holds now, so the input needs many: true'])
    for (const type of ['text', 'boolean', 'date', 'enum'] as const) expect(issues(type, { current: '{{ entity.fields.x }}' })).toEqual([`current: ${aKind(type)} has no current`])
  })

  it('takes only one value where its kind is one value', () => {
    for (const type of ['text', 'markdown', 'boolean', 'date', 'datetime'] as const) expect(issues(type, { many: true })).toEqual([`many: a ${type} input is one value`])
    expect(issues('attachment', { many: true })).toEqual(['many: an attachment input is one value'])
  })

  it('refuses a rule on a kind it does not fit', () => {
    expect(issues('number', { pattern: '\\d+' })).toEqual(['pattern: a number input takes no pattern'])
    expect(issues('string', { min: 1 })).toEqual(['min: a string input takes no min'])
    expect(issues('boolean', { maxLength: 1 })).toEqual(['maxLength: a boolean input takes no maxLength'])
    expect(issues('email', { minLength: 3 })).toEqual(['minLength: an email input takes no minLength'])
    expect(issues('entity', { max: 3 })).toEqual(['max: an entity input takes no max'])
  })

  it('refuses an option on a kind it does not fit', () => {
    expect(issues('string', { display: 'buttons' })).toEqual(['display: a string input has no display'])
    expect(issues('text', { narrows: 'notes' })).toEqual(['narrows: a text input cannot narrow what the action runs on'])
    expect(issues('datetime', { narrows: 'at' })).toEqual(['narrows: a datetime input cannot narrow what the action runs on'])
  })

  it('refuses a pattern that does not compile, is too long, or can take forever', () => {
    expect(issues('string', { pattern: '[a-z' })[0]).toMatch(/^pattern: the pattern does not compile: /)
    expect(issues('string', { pattern: 'a'.repeat(PATTERN_MAX + 1) })).toEqual([`pattern: the pattern is longer than ${PATTERN_MAX} characters`])
    for (const slow of ['(a+)+', '(a*)*b', '([a-z]+\\d*)+', '(?:x+){2,}', '((ab)+)+']) expect(issues('string', { pattern: slow }), slow).toEqual(['pattern: the pattern holds a repeat inside a repeat, which can take forever to match: write it without one'])
    for (const fine of ['(ab)+', '[(+]+', '\\(a+\\)+', '(\\d{1,3}\\.){3}\\d{1,3}', 'a+b+']) expect(issues('string', { pattern: fine }), fine).toEqual([])
  })

  it('refuses a bound that is not one, and a floor past its ceiling', () => {
    expect(issues('number', { min: 'low' })).toEqual(['min: min must be a number'])
    expect(issues('date', { max: 'soon' })).toEqual(['max: max must be a day, as YYYY-MM-DD, or today, today+30d, today-1y'])
    expect(issues('date', { min: 3 })).toEqual(['min: min must be a day, as YYYY-MM-DD, or today, today+30d, today-1y'])
    expect(issues('datetime', { min: '2026-01-01T00:00' })).toEqual(['min: min must be an instant with an offset, as 2026-03-10T14:30:00Z, or a day, as YYYY-MM-DD, or today, today+30d, today-1y'])
    expect(issues('number', { min: 5, max: 3 })).toEqual(['min: min is past max'])
    expect(issues('date', { min: '2026-06-01', max: '2026-01-01' })).toEqual(['min: min is past max'])
    expect(issues('date', { min: 'today+30d', max: 'today' })).toEqual(['min: min is past max'])
    expect(issues('date', { min: '2026-06-01', max: 'today' })).toEqual([])
    expect(issues('string', { minLength: 5, maxLength: 3 })).toEqual(['minLength: minLength is past maxLength'])
  })

  it('counts picks only of a list', () => {
    expect(issues('enum', { minLength: 1 })).toEqual(['minLength: minLength counts what is picked, so the input needs many: true'])
    expect(issues('entity', { maxLength: 2 })).toEqual(['maxLength: maxLength counts what is picked, so the input needs many: true'])
  })

  it('refuses a hint with no rule to speak for', () => {
    expect(issues('string', { hint: 'Anything' })).toEqual(['hint: a hint says what a failed rule means, and the input has no rule'])
  })
})
