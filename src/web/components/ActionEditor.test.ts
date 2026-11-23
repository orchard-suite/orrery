import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccessSettingsResponse, ActionsResponse, BlueprintsResponse, WhoAmIResponse } from '../../shared/api.ts'
import { INPUT_KINDS } from '../../shared/input-kinds.ts'
import { ACTION_INPUT_TYPES, type Blueprint } from '../../shared/model.ts'
import { keys } from '../api.ts'
import { ActionEditor, Reference } from './ActionEditor.tsx'

const squad: Blueprint = { id: 'squad', title: 'Squad', fields: { slug: { type: 'string', title: 'Slug' }, tier: { type: 'string' }, floor: { type: 'number' }, city: { type: 'string' }, lead: { type: 'string' } }, relations: {}, origin: { kind: 'ui' }, updatedAt: '' }
const human: Blueprint = { id: 'human', title: 'Human', fields: {}, relations: {}, origin: { kind: 'ui' }, updatedAt: '' }

const YAML = `id: rotate
title: Rotate keys
home: squad:core
inputs: {}
backend:
  type: webhook
  url: https://hooks.example.com/rotate
`

/** The form of the editor over a definition, as an admin or as someone who holds `actions.manage` alone. */
function editor(admin: boolean, yaml = YAML, people: string | null = 'human'): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'user@example.com', admin, roles: [], permissions: admin ? [] : ['actions.manage'] }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
  client.setQueryData(keys.blueprints, { blueprints: [squad, human], counts: {}, held: {}, layout: { order: [], closed: [], blueprints: {}, hidden: [] }, adminOnly: [] } satisfies BlueprintsResponse)
  client.setQueryData(keys.actions, { actions: [], person: people } satisfies ActionsResponse)
  client.setQueryData(keys.access, { person: { blueprint: 'person', owns: ['squads', { as: 'lead', path: '<-lead' }, { as: 'qa', path: '<-qa' }] }, adminOnly: [] } satisfies AccessSettingsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActionEditor, { initial: yaml, id: 'rotate', onDone: () => {} })))
}

/** The control the label with these words names. */
const control = (html: string, label: string): string => {
  const id = new RegExp(`<label for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1]
  return id ? (new RegExp(`<(?:input|select|button)[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '') : ''
}

describe("the home of an action, in its editor", () => {
  it('is for an admin to pick: a blueprint, then one of its entities', () => {
    const html = editor(true)
    expect(html).toContain('Squad: <span class="font-mono text-[12px]">core</span>')
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Change its home/)
    expect(html).toMatch(/<button[^>]*>Take it off its home/)
  })

  it('is read and not changed by anyone else, who is told why', () => {
    const html = editor(false)
    expect(html).toContain('Squad: <span class="font-mono text-[12px]">core</span>')
    expect(html).toContain('title="Only an admin sets the home of an action"')
    expect(html).not.toContain('Change its home')
    expect(html).not.toContain('Take it off its home')
  })

  it("opens the action to its home's people for an admin alone, by any way they own it or by the ways picked", () => {
    const open = editor(true, `${YAML}access:\n  home: [lead]\n`)
    expect(control(open, "Open to its home&#x27;s people")).toContain('checked=""')
    expect(control(open, 'lead')).toContain('checked=""')
    expect(control(open, 'qa')).not.toContain('checked=""')
    expect(control(editor(true), "Open to its home&#x27;s people")).not.toContain('checked=""')
    // Ways to own it are asked only once it is open to them.
    expect(control(editor(true), 'lead')).toBe('')
    expect(editor(false, `${YAML}access:\n  home: true\n`)).not.toContain('Open to its home')
  })

  it('has no one to open it to until it has a home', () => {
    const html = editor(true, YAML.replace('home: squad:core\n', ''))
    expect(control(html, "Open to its home&#x27;s people")).toContain('disabled=""')
  })
})

describe('an input, in the editor', () => {
  /** The editor over an action with one input, `ask`, written as these YAML lines. */
  const asking = (lines: string[], people: string | null = 'human'): string => editor(true, YAML.replace('inputs: {}', `inputs:\n  ask:\n${lines.map((l) => `    ${l}`).join('\n')}`), people)
  /** True when the form holds a control with this label. */
  const asks = (html: string, label: string): boolean => control(html, label) !== ''
  /** The whole question a label heads: its hint, its error, and its control. */
  const question = (html: string, label: string): string => new RegExp(`<label for="[^"]+"[^>]*>${label}</label>.*?<(?:input|select|textarea)[^>]*>`, 's').exec(html)?.[0] ?? ''

  it('picks its kind by the name the registry gives it, and says what the kind is', () => {
    const html = asking(['type: date'])
    for (const type of ACTION_INPUT_TYPES) expect(html).toContain(`<option value="${type}"${type === 'date' ? ' selected=""' : ''}>${INPUT_KINDS[type].title}</option>`)
    expect(question(html, 'Type')).toContain(INPUT_KINDS.date.description)
    expect(question(asking(['type: text']), 'Type')).toContain(INPUT_KINDS.text.description)
  })

  it('asks for the options its kind takes, and no others', () => {
    const short = asking(['type: string'])
    expect(asks(short, 'Takes a list')).toBe(true)
    expect(asks(short, 'Default')).toBe(true)
    expect(asks(short, 'Values')).toBe(false)
    expect(asks(short, 'Shown as')).toBe(false)
    const long = asking(['type: text'])
    expect(asks(long, 'Takes a list')).toBe(false)
    const choice = asking(['type: enum', 'values: [s, m]', 'display: buttons'])
    expect(question(choice, 'Values')).toContain('<textarea')
    expect(control(choice, 'Shown as')).toContain('<select')
    expect(choice).toContain('<option value="buttons" selected="">Buttons</option>')
    const toggle = asking(['type: boolean'])
    expect(asks(toggle, 'On by default')).toBe(true)
    expect(asks(toggle, 'Default')).toBe(false)
    expect(asks(toggle, 'Takes a list')).toBe(false)
    const entity = asking(['type: entity', 'blueprint: squad'])
    expect(asks(entity, 'Picks from: add another')).toBe(true)
    expect(asks(entity, 'Order')).toBe(true)
    expect(asks(entity, 'Default')).toBe(false)
  })

  it('asks for the rules its kind takes, each in the words of what it measures', () => {
    const short = asking(['type: string'])
    for (const label of ['Pattern', 'Fewest characters', 'Most characters']) expect(asks(short, label)).toBe(true)
    for (const label of ['Least', 'Most', 'Earliest', 'Latest', 'Fewest picked']) expect(asks(short, label)).toBe(false)
    const count = asking(['type: number'])
    for (const label of ['Least', 'Most']) expect(asks(count, label)).toBe(true)
    for (const label of ['Pattern', 'Fewest characters', 'Earliest']) expect(asks(count, label)).toBe(false)
    const day = asking(['type: date', 'min: today', 'max: today+30d'])
    expect(control(day, 'Earliest')).toContain('value="today"')
    expect(control(day, 'Latest')).toContain('value="today+30d"')
    expect(question(day, 'Earliest')).toContain('today+30d')
    expect(asks(day, 'Pattern')).toBe(false)
    expect(asks(asking(['type: datetime']), 'Earliest')).toBe(true)
    // The picks of a list are counted, so the count is asked for once the input takes a list.
    expect(asks(asking(['type: enum', 'values: [s, m]']), 'Fewest picked')).toBe(false)
    const several = asking(['type: enum', 'values: [s, m]', 'many: true'])
    for (const label of ['Fewest picked', 'Most picked']) expect(asks(several, label)).toBe(true)
    const toggle = asking(['type: boolean'])
    for (const label of ['Pattern', 'Least', 'Fewest characters', 'What to say when a rule is broken']) expect(asks(toggle, label)).toBe(false)
  })

  it('asks what to say when a rule is broken once the input has a rule', () => {
    expect(asks(asking(['type: string']), 'What to say when a rule is broken')).toBe(false)
    const ruled = asking(['type: string', 'pattern: "[A-Z]+-[0-9]+"', 'hint: Give the ticket, such as OPS-12'])
    expect(control(ruled, 'Pattern')).toContain('value="[A-Z]+-[0-9]+"')
    expect(control(ruled, 'What to say when a rule is broken')).toContain('value="Give the ticket, such as OPS-12"')
    // The words under an input's title are its description, by that name.
    expect(ruled.split('>Description</label>')).toHaveLength(3)
    expect(ruled).not.toContain('>Hint</label>')
  })

  it('says what is wrong with a rule at the rule', () => {
    const upside = asking(['type: number', 'min: 5', 'max: 3'])
    expect(question(upside, 'Least')).toContain('min is past max')
    expect(control(upside, 'Least')).toContain('aria-invalid="true"')
    expect(question(asking(['type: string', 'pattern: "(a+)+"']), 'Pattern')).toContain('a repeat inside a repeat')
    // A rule left from another kind is shown with what is wrong, so it can be taken off.
    expect(question(asking(['type: enum', 'values: [s, m]', 'minLength: 1']), 'Fewest picked')).toContain('needs many: true')
  })

  it('says who a person input picks from, and refuses one when the estate does not say who a person is', () => {
    const person = asking(['type: person'])
    expect(person).toContain('Picks from the people of the estate: Human')
    expect(asks(person, 'Picks from')).toBe(false)
    expect(asks(person, 'Order')).toBe(true)
    expect(question(person, 'Type')).not.toContain('Error: ')
    expect(question(asking(['type: person'], null), 'Type')).toContain('a person input needs the estate to say who a person is')
  })

  it('lists every kind in its reference, from the registry', () => {
    const reference = renderToStaticMarkup(createElement(Reference))
    for (const type of ACTION_INPUT_TYPES) expect(reference).toContain(`<code>${type}</code>: ${INPUT_KINDS[type].description.replace(/'/g, '&#x27;')}`)
  })
})

describe('what the form asks by, in the editor', () => {
  /** The editor over an action with these inputs, written as the YAML under `inputs:`, and whatever else the action holds. */
  const form = (inputs: string, more = ''): string => editor(true, YAML.replace('inputs: {}', `inputs:\n${inputs}`) + more)
  /** The part of the form that edits one input. */
  const part = (html: string, name: string): string => new RegExp(`<legend[^>]*>${name}</legend>.*?</fieldset>`, 's').exec(html)?.[0] ?? ''
  const question = (html: string, label: string): string => new RegExp(`<label for="[^"]+"[^>]*>${label}</label>.*?<(?:input|select|textarea)[^>]*>`, 's').exec(html)?.[0] ?? ''
  /** The option picked in the select with this name. */
  const picked = (html: string, name: string): string | undefined => new RegExp(`<select[^>]*aria-label="${name}"[^>]*>.*?</select>`, 's').exec(html)?.[0].match(/<option[^>]*selected=""[^>]*>([^<]*)</)?.[1]

  const ENV = `  env:\n    type: enum\n    values: [dev, prod]\n`

  it('asks when an input is asked, as conditions over the inputs above it', () => {
    const html = form(`${ENV}  reason:\n    type: string\n    when: { field: env, op: eq, value: prod }\n  later:\n    type: string\n`)
    const reason = part(html, 'reason')
    expect(reason).toContain('>Ask only when</div>')
    // Each condition is a chip that says it as a sentence, and opens to change it.
    expect(reason).toContain('aria-label="Change the condition env is prod"')
    expect(reason).toMatch(/<button[^>]*>(<svg.*?<\/svg>)? ?Add a condition<\/button>/s)
    // The first input has nothing above it to be asked by.
    expect(part(html, 'env')).not.toContain('Ask only when')
    expect(part(html, 'later')).toContain('Always asked.')
  })

  it('leaves a when its conditions cannot hold to the YAML, and says so', () => {
    const html = form(`${ENV}  reason:\n    type: string\n    when: { or: [{ field: env, op: eq, value: prod }, { field: env, op: eq, value: dev }] }\n`)
    expect(part(html, 'reason')).toContain('A when with or, not, or a list of values: change it in the YAML tab.')
    expect(part(html, 'reason')).not.toContain('Change the condition')
  })

  it('says what is wrong with a when at it', () => {
    const html = form(`${ENV}  reason:\n    type: string\n    when: { field: later, op: exists }\n  later:\n    type: string\n`)
    expect(part(html, 'reason')).toMatch(/Error: <\/span>[^<]*when reads &quot;later&quot;, which is declared after it/)
  })

  it('asks for the expression that works an input out, and names the inputs it may read', () => {
    const html = form(`  name:\n    type: string\n  env:\n    type: string\n  slug:\n    type: string\n    value: "lower(name) + '-' + env"\n`)
    const slug = part(html, 'slug')
    expect(control(slug, 'Work it out')).toContain('value="lower(name) + &#x27;-&#x27; + env"')
    expect(question(slug, 'Work it out')).toContain('It may read <code>name</code>, <code>env</code>.')
    // A worked-out input is never asked, so what only an asked one takes is not offered.
    for (const label of ['Required', 'Default', 'Takes a list']) expect(control(slug, label)).toBe('')
    for (const label of ['Required', 'Default', 'Takes a list', 'Work it out']) expect(control(part(html, 'env'), label)).not.toBe('')
    expect(question(part(html, 'name'), 'Work it out')).toContain('No input is above it to read.')
  })

  it('says what is wrong with an expression under it, and keeps what a worked-out input may not hold in view', () => {
    const html = form(`  name:\n    type: string\n  slug:\n    type: string\n    required: true\n    value: "lower(name"\n`)
    expect(question(part(html, 'slug'), 'Work it out')).toMatch(/Error: <\/span>[^<]*value does not parse/)
    expect(control(part(html, 'slug'), 'Work it out')).toContain('aria-invalid="true"')
    expect(control(part(html, 'slug'), 'Required')).toContain('checked=""')
  })

  it('never offers to work out an input that is picked', () => {
    const html = form(`  team:\n    type: entity\n    blueprint: squad\n  size:\n    type: enum\n    values: [s, m]\n`)
    expect(control(part(html, 'team'), 'Work it out')).toBe('')
    expect(control(part(html, 'size'), 'Work it out')).toBe('')
  })

  it('asks what an input must be unique among, for the kinds that can be', () => {
    const html = form(`  name:\n    type: string\n    unique: { blueprint: squad, field: slug }\n  plain:\n    type: string\n  sure:\n    type: boolean\n`)
    const name = part(html, 'name')
    expect(control(name, 'Must be unique among')).toContain('<select')
    expect(question(name, 'Must be unique among') + name).toContain('<option value="squad" selected="">Squad</option>')
    expect(name).toContain('<option value="key">Its key</option><option value="title">Its title</option><option value="slug" selected="">Slug</option>')
    // What to say in place of "is already taken" is the input's hint.
    expect(control(name, 'What to say when a rule is broken')).not.toBe('')
    const plain = part(html, 'plain')
    expect(plain).toContain('<option value="" selected="">No: it may hold what another does</option>')
    expect(control(plain, 'Of all their')).toBe('')
    expect(control(part(html, 'sure'), 'Must be unique among')).toBe('')
  })

  it('says what is wrong with a unique check at it', () => {
    const html = form(`  name:\n    type: string\n    unique: { blueprint: squad, field: gone }\n`)
    expect(question(html, 'Of all their')).toContain('squad has no field &quot;gone&quot;')
  })

  it('asks which fields show under each option of a pick, four at most', () => {
    const html = form(`  team:\n    type: entity\n    blueprint: squad\n    show: [slug, floor]\n  name:\n    type: string\n`)
    const team = part(html, 'team')
    expect(team).toMatch(/<ul aria-label="Show under each option"[^>]*>.*Slug.*floor.*<\/ul>/s)
    expect(team).toMatch(/<button[^>]*aria-label="Take Slug off"/)
    const add = question(team, 'Show under each option: add another') + team.slice(team.indexOf('Show under each option: add another'))
    expect(add).toContain('<option value="tier">tier</option>')
    expect(add).not.toContain('<option value="slug">')
    expect(part(html, 'name')).not.toContain('Show under each option')
    const full = part(form(`  team:\n    type: entity\n    blueprint: squad\n    show: [slug, floor, tier, city]\n`), 'team')
    expect(full).toContain('aria-label="Show under each option"')
    expect(full).not.toContain('Show under each option: add another')
    const none = part(form(`  team:\n    type: entity\n    blueprint: squad\n`), 'team')
    expect(control(none, 'Show under each option')).toContain('<select')
  })

  it("draws the action's sections: a heading, a description, and the inputs of each in order", () => {
    const html = form(`  a:\n    type: string\n  b:\n    type: string\n  c:\n    type: string\n`, `sections:\n  - title: First\n    description: Start here\n    inputs: [b, a]\n  - title: Second\n    inputs: [c]\nwalk: true\n`)
    const first = part(html, 'Section 1')
    expect(control(first, 'Heading')).toContain('value="First"')
    expect(control(first, 'Description')).toContain('value="Start here"')
    expect(first.indexOf('Move b down')).toBeLessThan(first.indexOf('Move a up'))
    expect(first).toMatch(/<button[^>]*aria-label="Move b up in its section"[^>]*disabled=""/)
    expect(first).toMatch(/<button[^>]*aria-label="Move a down in its section"[^>]*disabled=""/)
    expect(first).toMatch(/<button[^>]*aria-label="Move the section First up"[^>]*disabled=""/)
    expect(part(html, 'Section 2')).toMatch(/<button[^>]*aria-label="Move the section Second down"[^>]*disabled=""/)
    // An input moves to another section, or out of them all, by a pick.
    expect(picked(first, 'Section of b')).toBe('First')
    expect(picked(part(html, 'Section 2'), 'Section of c')).toBe('Second')
    expect(html).toMatch(/<button[^>]*>.*?Add a section<\/span><\/button>/s)
    expect(control(html, 'Walk through it as steps')).toContain('checked=""')
  })

  it('lists the inputs no section names, each with a pick to put it in one', () => {
    const html = form(`  a:\n    type: string\n  b:\n    type: string\n`, `sections:\n  - title: First\n    inputs: [a]\n`)
    expect(html).toContain('In no section, so asked last')
    expect(picked(html, 'Section of b')).toBe('None: asked last')
    const bare = form(`  a:\n    type: string\n`)
    expect(bare).not.toContain('In no section, so asked last')
    expect(bare).not.toContain('aria-label="Section of a"')
    // A form is walked a section at a time, so there is nothing to walk until it has one.
    expect(control(bare, 'Walk through it as steps')).toContain('disabled=""')
  })

  it('says what is wrong with a section where it is wrong', () => {
    const html = form(`  a:\n    type: string\n    when: { field: b, op: exists }\n  b:\n    type: string\n`, `sections:\n  - title: First\n    inputs: [zz]\n  - title: Second\n    inputs: []\n`)
    expect(part(html, 'Section 1')).toContain('&quot;zz&quot; is not an input')
    expect(part(html, 'Section 2')).toContain('a section holds at least one input')
    expect(form(`  a:\n    type: string\n`, `walk: true\n`)).toMatch(/Walk through it as steps<\/label>.*?the action needs sections/s)
  })
})
