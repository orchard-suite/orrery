import { describe, expect, it } from 'vitest'
import { checkAction, jobTemplate, templateReads, unbatchable } from './action-spec.ts'
import type { Blueprint } from './model.ts'

const action = (changes: object) => ({ id: 'apply', title: 'Apply', inputs: { changes }, backend: { type: 'caller' } })

describe('a markdown input', () => {
  it('is one text', () => {
    expect(checkAction(action({ type: 'markdown', title: 'What the plan changes' })).issues).toEqual([])
    expect(checkAction(action({ type: 'markdown', many: true })).issues.map((i) => i.message)).toEqual(['input "changes": a markdown input is one value'])
  })
})

const messages = (changes: object, ...rest: [blueprints?: Parameters<typeof checkAction>[1], person?: string | null]) => checkAction(action(changes), ...rest).issues.map((i) => `${i.path.join('.')}: ${i.message}`)

describe('the kinds of input', () => {
  it('each new kind is one a definition may name', () => {
    for (const type of ['text', 'date', 'datetime', 'email']) expect(messages({ type })).toEqual([])
    expect(messages({ type: 'enum', values: ['a', 'b'], display: 'buttons' })).toEqual([])
    expect(checkAction(action({ type: 'money' })).spec).toBeNull()
    expect(checkAction(action({ type: 'enum', values: ['a'], display: 'tiles' })).spec).toBeNull()
  })

  it('a kind that is one value takes no list', () => {
    expect(messages({ type: 'text', many: true })).toEqual(['inputs.changes.many: input "changes": a text input is one value'])
    expect(messages({ type: 'datetime', many: true })).toEqual(['inputs.changes.many: input "changes": a datetime input is one value'])
    expect(messages({ type: 'email', many: true })).toEqual([])
  })

  it('an option or a rule its kind does not take is refused', () => {
    expect(messages({ type: 'string', display: 'buttons' })).toEqual(['inputs.changes.display: input "changes": a string input has no display'])
    expect(messages({ type: 'number', pattern: '\\d+' })).toEqual(['inputs.changes.pattern: input "changes": a number input takes no pattern'])
    expect(messages({ type: 'string', pattern: '(a+)+' })).toEqual(['inputs.changes.pattern: input "changes": the pattern holds a repeat inside a repeat, which can take forever to match: write it without one'])
    expect(messages({ type: 'string', pattern: '[a-z' })[0]).toMatch(/^inputs\.changes\.pattern: input "changes": the pattern does not compile: /)
    expect(messages({ type: 'number', min: 5, max: 3 })).toEqual(['inputs.changes.min: input "changes": min is past max'])
    expect(messages({ type: 'date', min: 'yesterday' })).toEqual(['inputs.changes.min: input "changes": min must be a day, as YYYY-MM-DD, or today, today+30d, today-1y'])
    expect(messages({ type: 'string', pattern: '[A-Z]+-\\d+', minLength: 3, maxLength: 12, hint: 'Give the ticket, such as OPS-12' })).toEqual([])
    expect(checkAction(action({ type: 'string', minLength: -1 })).spec).toBeNull()
    expect(checkAction(action({ type: 'string', maxLength: 1.5 })).spec).toBeNull()
  })

  it('a person input picks from the blueprint the estate says a person is', () => {
    const blueprints = [{ id: 'human', fields: { name: { type: 'string' as const } }, relations: {} }]
    expect(messages({ type: 'person' })).toEqual([])
    expect(messages({ type: 'person', many: true, sort: 'name' }, blueprints, 'human')).toEqual([])
    expect(messages({ type: 'person', sort: 'age' }, blueprints, 'human')).toEqual(['inputs.changes.sort: input "changes": sort names "age", which human has no field for'])
    expect(messages({ type: 'person' }, blueprints, null)).toEqual(['inputs.changes.type: input "changes": a person input needs the estate to say who a person is, which an admin does on the Access page'])
  })

  it('an input that picks a person narrows the target by a relation to people', () => {
    const blueprints: Pick<Blueprint, 'id' | 'fields' | 'relations'>[] = [
      { id: 'human', fields: {}, relations: {} },
      { id: 'app', fields: {}, relations: { lead: { target: 'human' }, team: { target: 'team' } } },
    ]
    const on = (changes: object) => checkAction({ ...action(changes), blueprint: 'app' }, blueprints, 'human').issues.map((i) => i.message)
    expect(on({ type: 'person', narrows: 'lead' })).toEqual([])
    expect(on({ type: 'person', narrows: 'team' })).toEqual(['input "changes": app.team points at team, which the input does not pick from'])
  })
})

/** The issues of an action with these inputs, in this order, and whatever else it carries. */
const form = (inputs: Record<string, object>, more: object = {}, ...rest: [blueprints?: Parameters<typeof checkAction>[1], person?: string | null]) =>
  checkAction({ id: 'apply', title: 'Apply', inputs, backend: { type: 'caller' }, ...more }, ...rest).issues.map((i) => `${i.path.join('.')}: ${i.message}`)

describe('an input asked only when', () => {
  const env = { type: 'enum', values: ['dev', 'prod'] }

  it('reads the inputs declared before it', () => {
    expect(form({ env, reason: { type: 'string', required: true, when: { field: 'env', op: 'eq', value: 'prod' } } })).toEqual([])
    expect(form({ env, size: { type: 'number' }, reason: { type: 'string', when: { and: [{ field: 'env', op: 'eq', value: 'prod' }, { not: { field: 'size', op: 'lt', value: 3 } }] } } })).toEqual([])
  })

  it('is refused when it reads an input declared after it, itself, or nothing that is an input', () => {
    expect(form({ reason: { type: 'string', when: { field: 'env', op: 'eq', value: 'prod' } }, env })).toEqual(['inputs.reason.when: input "reason": when reads "env", which is declared after it: an input is asked by the inputs above it'])
    expect(form({ reason: { type: 'string', when: { field: 'reason', op: 'exists' } } })).toEqual(['inputs.reason.when: input "reason": when reads the input itself'])
    expect(form({ reason: { type: 'string', when: { field: 'tier', op: 'eq', value: 'gold' } } })).toEqual(['inputs.reason.when: input "reason": when reads "tier", which is not an input'])
    expect(form({ env, reason: { type: 'string', when: { field: '$key', op: 'eq', value: 'x' } } })).toEqual(['inputs.reason.when: input "reason": when reads "$key", which is not an input'])
  })

  it('is refused when it tests anything but an input given, or reads the time', () => {
    expect(form({ env, reason: { type: 'string', when: { state: 'active' } } })).toEqual(['inputs.reason.when: input "reason": a when tests only the inputs given, as { field, op, value }: it cannot test state'])
    expect(form({ day: { type: 'date' }, reason: { type: 'string', when: { field: 'day', op: 'within', value: '7d' } } })).toEqual(['inputs.reason.when: input "reason": a when cannot read the time, and within does'])
    expect(form({ env, reason: { type: 'string', when: { field: 'env', op: 'like', value: 'p' } } })).toEqual(['inputs.reason.when: input "reason": when tests "env" with "like", which is not a test'])
  })

  it('is refused on an input that narrows the target, which is asked before everything', () => {
    const blueprints = [{ id: 'app', fields: { tier: { type: 'string' as const } }, relations: {} }]
    expect(form({ env, tier: { type: 'string', narrows: 'tier', when: { field: 'env', op: 'eq', value: 'prod' } } }, { blueprint: 'app' }, blueprints)).toEqual(['inputs.tier.when: input "tier": an input that narrows the target is asked before it, so it is always asked'])
    // An input below may read what narrowed the target.
    expect(form({ tier: { type: 'string', narrows: 'tier' }, reason: { type: 'string', when: { field: 'tier', op: 'eq', value: 'gold' } } }, { blueprint: 'app' }, blueprints)).toEqual([])
  })
})

describe('a worked-out input', () => {
  const name = { type: 'string', required: true }

  it('is an expression over the inputs declared before it', () => {
    expect(form({ name, env: { type: 'enum', values: ['dev', 'prod'] }, slug: { type: 'string', value: "lower(name) + '-' + env", pattern: '[a-z0-9-]+' } })).toEqual([])
    expect(form({ name, long: { type: 'boolean', value: 'len(name) > 20' } })).toEqual([])
  })

  it('is refused when the expression does not parse', () => {
    expect(form({ name, slug: { type: 'string', value: 'lower(name' } })[0]).toMatch(/^inputs\.slug\.value: input "slug": value does not parse: /)
    expect(form({ name, slug: { type: 'string', value: 'shout(name)' } })[0]).toMatch(/^inputs\.slug\.value: input "slug": value does not parse: /)
  })

  it('is refused when it reads an input declared after it, itself, or nothing that is an input', () => {
    expect(form({ slug: { type: 'string', value: 'lower(name)' }, name })).toEqual(['inputs.slug.value: input "slug": value reads "name", which is declared after it: an input is worked out from the inputs above it'])
    expect(form({ slug: { type: 'string', value: "slug + '-x'" } })).toEqual(['inputs.slug.value: input "slug": value reads the input itself'])
    expect(form({ name, slug: { type: 'string', value: 'lower(title)' } })).toEqual(['inputs.slug.value: input "slug": value reads "title", which is not an input'])
  })

  it('is never asked, so it takes nothing that asks', () => {
    expect(form({ name, slug: { type: 'string', value: 'lower(name)', default: 'x' } })).toEqual(['inputs.slug.default: input "slug": a worked-out input is never asked, so it has no default'])
    expect(form({ name, slug: { type: 'string', value: 'lower(name)', required: true } })).toEqual(['inputs.slug.required: input "slug": a worked-out input is never asked, so it is never required: a rule on it refuses what it works out'])
    expect(form({ name, slug: { type: 'string', value: 'lower(name)', many: true } })).toEqual(['inputs.slug.many: input "slug": a worked-out input is one value'])
    expect(form({ name, size: { type: 'enum', values: ['s', 'm'], value: "'s'" } })).toEqual(['inputs.size.value: input "size": an enum input is picked, never worked out'])
    expect(form({ name, lead: { type: 'person', value: 'name' } })).toEqual(['inputs.lead.value: input "lead": a person input is picked, never worked out'])
    const blueprints = [{ id: 'app', fields: { tier: { type: 'string' as const } }, relations: {} }]
    expect(form({ name, tier: { type: 'string', narrows: 'tier', value: 'lower(name)' } }, { blueprint: 'app' }, blueprints)).toEqual(['inputs.tier.value: input "tier": an input that narrows the target is filled from it, never worked out'])
  })
})

describe('an input that must be unique', () => {
  const blueprints = [{ id: 'app', fields: { slug: { type: 'string' as const } }, relations: {} }]

  it('names a blueprint and its key, its title, or one of its fields', () => {
    for (const field of ['key', 'title', 'slug']) expect(form({ name: { type: 'string', unique: { blueprint: 'app', field } } }, {}, blueprints)).toEqual([])
    expect(form({ port: { type: 'number', unique: { blueprint: 'app', field: 'slug' }, hint: 'That port is in use' } }, {}, blueprints)).toEqual([])
    expect(form({ name: { type: 'string', unique: { blueprint: 'apps', field: 'slug' } } }, {}, blueprints)).toEqual(['inputs.name.unique.blueprint: input "name": unknown blueprint "apps"'])
    expect(form({ name: { type: 'string', unique: { blueprint: 'app', field: 'label' } } }, {}, blueprints)).toEqual(['inputs.name.unique.field: input "name": app has no field "label"'])
    expect(checkAction({ id: 'apply', title: 'Apply', inputs: { name: { type: 'string', unique: { blueprint: 'app' } } }, backend: { type: 'caller' } }).spec).toBeNull()
  })

  it('is for one value of text or a number', () => {
    expect(form({ day: { type: 'date', unique: { blueprint: 'app', field: 'key' } } })).toEqual(['inputs.day.unique: input "day": a date input has no value to hold unique'])
    expect(form({ pick: { type: 'entity', blueprint: 'app', unique: { blueprint: 'app', field: 'key' } } })).toEqual(['inputs.pick.unique: input "pick": an entity input has no value to hold unique'])
    expect(form({ names: { type: 'string', many: true, unique: { blueprint: 'app', field: 'key' } } })).toEqual(['inputs.names.unique: input "names": unique holds one value, and the input takes a list'])
  })
})

describe('the fields shown under each option', () => {
  const blueprints: Pick<Blueprint, 'id' | 'fields' | 'relations'>[] = [
    { id: 'app', fields: { tier: { type: 'string' as const }, region: { type: 'string' as const } }, relations: {} },
    { id: 'job', fields: { region: { type: 'string' as const } }, relations: {} },
    { id: 'human', fields: { email: { type: 'string' as const } }, relations: {} },
  ]

  it('are fields of a blueprint the input picks from', () => {
    expect(form({ pick: { type: 'entity', blueprint: 'app', show: ['tier', 'region'] } }, {}, blueprints)).toEqual([])
    // Picking from several, a field is one any of them has: an option without it shows the rest.
    expect(form({ pick: { type: 'entity', blueprint: ['app', 'job'], show: ['tier'] } }, {}, blueprints)).toEqual([])
    expect(form({ who: { type: 'person', show: ['email'] } }, {}, blueprints, 'human')).toEqual([])
    expect(form({ pick: { type: 'entity', blueprint: ['app', 'job'], show: ['tier', 'owner_name'] } }, {}, blueprints)).toEqual(['inputs.pick.show.1: input "pick": show names "owner_name", which no blueprint it picks from has a field for'])
  })

  it('are at most four, each named once, on an input that picks an entity', () => {
    expect(checkAction({ id: 'apply', title: 'Apply', inputs: { pick: { type: 'entity', blueprint: 'app', show: ['a', 'b', 'c', 'd', 'e'] } }, backend: { type: 'caller' } }).spec).toBeNull()
    expect(checkAction({ id: 'apply', title: 'Apply', inputs: { pick: { type: 'entity', blueprint: 'app', show: [] } }, backend: { type: 'caller' } }).spec).toBeNull()
    expect(form({ pick: { type: 'entity', blueprint: 'app', show: ['tier', 'tier'] } })).toEqual(['inputs.pick.show.1: input "pick": show names "tier" twice'])
    expect(form({ name: { type: 'string', show: ['tier'] } })).toEqual(['inputs.name.show: input "name": a string input has no options to show fields of'])
  })
})

describe("a form's sections", () => {
  const inputs = { name: { type: 'string' }, env: { type: 'enum', values: ['dev', 'prod'] }, reason: { type: 'string', when: { field: 'env', op: 'eq', value: 'prod' } }, slug: { type: 'string', value: "lower(name) + '-' + env" } }

  it('each hold inputs of the action, every one in at most one', () => {
    expect(form(inputs, { sections: [{ title: 'What', description: 'The thing to make', inputs: ['name', 'env'] }, { title: 'Why', inputs: ['reason'] }] })).toEqual([])
    expect(form(inputs, { sections: [{ title: 'What', inputs: ['name', 'tier'] }] })).toEqual(['sections.0.inputs.1: sections: "tier" is not an input'])
    expect(form(inputs, { sections: [{ title: 'What', inputs: ['name', 'env'] }, { title: 'Why', inputs: ['env', 'reason'] }] })).toEqual(['sections.1.inputs.0: sections: "env" is in two sections'])
    expect(form(inputs, { sections: [{ title: 'What', inputs: ['name', 'name'] }] })).toEqual(['sections.0.inputs.1: sections: "name" is in the section twice'])
    expect(form(inputs, { sections: [{ title: 'What', inputs: [] }] })).toEqual(['sections.0.inputs: sections: a section holds at least one input'])
    expect(checkAction({ id: 'apply', title: 'Apply', inputs, backend: { type: 'caller' }, sections: [{ inputs: ['name'] }] }).spec).toBeNull()
  })

  it('never put an input before one it reads', () => {
    expect(form(inputs, { sections: [{ title: 'Why', inputs: ['reason'] }, { title: 'What', inputs: ['name', 'env'] }] })).toEqual(['sections.0.inputs.0: sections: "reason" comes before "env", which its when reads'])
    expect(form(inputs, { sections: [{ title: 'What', inputs: ['slug', 'name', 'env'] }] })).toEqual(['sections.0.inputs.0: sections: "slug" comes before "name", which its value reads', 'sections.0.inputs.0: sections: "slug" comes before "env", which its value reads'])
    // What no section names is asked last, so a section's input may not read it.
    expect(form(inputs, { sections: [{ title: 'Why', inputs: ['reason'] }] })).toEqual(['sections.0.inputs.0: sections: "reason" comes before "env", which its when reads'])
  })

  it('never hold an input that narrows the target, which is asked with it', () => {
    const blueprints = [{ id: 'app', fields: { tier: { type: 'string' as const } }, relations: {} }]
    expect(form({ tier: { type: 'string', narrows: 'tier' }, name: { type: 'string' } }, { blueprint: 'app', sections: [{ title: 'What', inputs: ['tier', 'name'] }] }, blueprints)).toEqual(['sections.0.inputs.0: sections: "tier" narrows what the action runs on, so it is asked with that, above every section'])
  })

  it('are what a walk steps through', () => {
    expect(form(inputs, { walk: true, sections: [{ title: 'What', inputs: ['name', 'env'] }] })).toEqual([])
    expect(form(inputs, { walk: true })).toEqual(['walk: walk: a form is walked one section at a time, so the action needs sections'])
  })
})

describe('an action run only from its rows', () => {
  it('needs a blueprint to be run from', () => {
    const base = { id: 'approve', title: 'Approve', inputs: {}, backend: { type: 'decide', verdict: 'approve' } }
    expect(checkAction({ ...base, blueprint: 'approval', listed: false }).issues).toEqual([])
    expect(checkAction({ ...base, listed: false }).issues.map((i) => i.message)).toEqual(['listed: an action run only from what it runs on needs a blueprint'])
  })
})

describe('an input that changes a list the entity holds', () => {
  it('is a list with a current, and cannot be asked once for many', () => {
    expect(messages({ type: 'url', many: true, current: '{{ entity.fields.origins }}' })).toEqual([])
    expect(messages({ type: 'url', current: '{{ entity.fields.origins }}' })).toEqual(['inputs.changes.current: input "changes": current is the list the entity holds now, so the input needs many: true'])
    expect([...unbatchable({ origins: { type: 'url', many: true, current: '{{ inputs.base }}' } })]).toEqual([['origins', 'changes a list each entity holds for itself']])
  })
})

describe('a job template that reads the entity', () => {
  const zones = [{ id: 'workspace', fields: { infra_principal: { type: 'string' as const, overridable: false }, tier: { type: 'enum' as const, values: ['prod', 'non-prod'], overridable: false }, team: { type: 'string' as const }, bad_tier: { type: 'enum' as const, values: ['prod', 'Non Prod'], overridable: false }, zone_principal: { type: 'string' as const, mirror: 'zone.infra_principal', overridable: false }, replicas: { type: 'number' as const, overridable: false }, tags: { type: 'enum' as const, values: ['a'], many: true, overridable: false } }, relations: {} }]
  const job = (template: string, extra: object = {}) => ({ id: 'apply', title: 'Apply', blueprint: 'workspace', backend: { type: 'job', starter: 'jobs', template, image: 'registry.example.org/infra:1' }, ...extra })
  const said = (template: string, extra: object = {}) => checkAction(job(template, extra), zones).issues.map((i) => `${i.path.join('.')}: ${i.message}`)

  it('keeps a fixed name a name', () => {
    expect(said('infra-apply')).toEqual([])
    expect(checkAction({ ...job('infra-apply'), blueprint: undefined }, zones).issues).toEqual([])
    expect(said('../etc/passwd')).toEqual(['backend.template: a job template is named in lowercase letters, digits, - and _: it is one of the starter\'s own, never a path'])
    expect(said('infra-{{ nope')).toEqual(['backend.template: a job template is named in lowercase letters, digits, - and _: it is one of the starter\'s own, never a path'])
  })

  it('reads a locked field of the entity the run is on, and nothing else', () => {
    expect(said('infra-apply-{{ entity.fields.infra_principal }}')).toEqual([])
    expect(said('{{ entity.fields.tier }}-{{ entity.fields.infra_principal }}')).toEqual([])
    expect(templateReads('infra-{{ entity.fields.tier }}-{{ entity.fields.infra_principal }}-{{ entity.fields.tier }}')).toEqual(['tier', 'infra_principal'])
    expect(templateReads('infra-apply')).toEqual([])
    expect(said('infra-apply-{{ inputs.zone }}', { inputs: { zone: { type: 'string' } } })).toEqual(['backend.template: backend: a template names what the job runs as, so it reads only a field of the entity the run is on, as {{ entity.fields.<name> }}: never "inputs.zone", which whoever asks chooses'])
    expect(said('infra-apply-{{ by.name }}')[0]).toContain('never "by.name", which is whoever asks')
    for (const path of ['entity.key', 'entity.title', 'entity.relations.zone', 'entity.fields.tags.0', 'run.id', 'action.id']) expect(said(`infra-apply-{{ ${path} }}`)[0]).toContain(`never "${path}"`)
    expect(said('Infra/{{ entity.fields.infra_principal }}')).toEqual(['backend.template: backend: a job template is named in lowercase letters, digits, - and _: it is one of the starter\'s own, never a path'])
  })

  it('refuses a field a person could change, one the hub works out, and one that is no single name', () => {
    expect(said('infra-apply-{{ entity.fields.team }}')).toEqual(['backend.template: backend: the template reads workspace.team, which is not locked, so a person could change what the job runs as: set overridable: false on it, and only sources write it'])
    expect(said('infra-apply-{{ entity.fields.nope }}')).toEqual(['backend.template: backend: the template reads workspace.nope, which is not a field of it'])
    expect(said('infra-apply-{{ entity.fields.zone_principal }}')[0]).toContain('workspace.zone_principal, which is worked out by the hub (a mirror)')
    expect(said('infra-apply-{{ entity.fields.replicas }}')[0]).toContain('workspace.replicas, which holds a number')
    expect(said('infra-apply-{{ entity.fields.tags }}')[0]).toContain('workspace.tags, which holds a list')
    expect(said('infra-apply-{{ entity.fields.bad_tier }}')).toEqual(['backend.template: backend: the template reads workspace.bad_tier, whose value "Non Prod" no job template is named by: lowercase letters, digits, - and _'])
  })

  it('needs an entity to read, on every blueprint it runs on, and never writes the field back itself', () => {
    expect(checkAction({ ...job('infra-apply-{{ entity.fields.infra_principal }}'), blueprint: undefined }, zones).issues.map((i) => i.message)).toEqual(['backend: a template that reads the entity needs one to read, so the action needs a blueprint'])
    const two = [...zones, { id: 'stack', fields: { infra_principal: { type: 'string' as const } }, relations: {} }]
    expect(checkAction({ ...job('infra-apply-{{ entity.fields.infra_principal }}'), blueprint: ['workspace', 'stack'] }, two).issues.map((i) => i.message)).toEqual(['backend: the template reads stack.infra_principal, which is not locked, so a person could change what the job runs as: set overridable: false on it, and only sources write it'])
    expect(said('infra-apply-{{ entity.fields.infra_principal }}', { refreshes: ['team', 'infra_principal'] })).toEqual(['refreshes.1: refreshes: the job\'s template reads "infra_principal", so it says what the job runs as, and no run writes it'])
  })

  it('names the template from what the hub holds of the entity, and says no value when it refuses', () => {
    const blueprint = zones[0]!
    const on = (fields: Record<string, unknown>) => ({ blueprint, fields })
    expect(jobTemplate('infra-apply', null)).toEqual({ name: 'infra-apply' })
    expect(jobTemplate('infra-apply-{{ entity.fields.infra_principal }}', on({ infra_principal: 'network-prod' }))).toEqual({ name: 'infra-apply-network-prod' })
    expect(jobTemplate('{{ entity.fields.infra_principal }}', on({ infra_principal: 'network-prod' }))).toEqual({ name: 'network-prod' })
    expect(jobTemplate('{{ entity.fields.tier }}_{{ entity.fields.infra_principal }}', on({ infra_principal: 'network', tier: 'prod' }))).toEqual({ name: 'prod_network' })
    expect(jobTemplate('infra-apply-{{ entity.fields.infra_principal }}', null)).toEqual({ refused: 'its template reads the entity the run is on, and the run is on none' })
    for (const held of [undefined, null, '', 'Network Prod', '../kube-system', 'a b', ['prod'], 7, { name: 'prod' }]) {
      const refused = jobTemplate('infra-apply-{{ entity.fields.infra_principal }}', on({ infra_principal: held }))
      expect(refused).toEqual({ refused: 'its template reads "infra_principal", which on this entity holds nothing a job template is named by: lowercase letters, digits, - and _' })
    }
    expect(jobTemplate('{{ entity.fields.infra_principal }}', on({ infra_principal: '-prod' }))).toEqual({ refused: 'its template renders to no name of a job template: lowercase letters, digits, - and _, starting with a letter or a digit' })
    // The field as the model holds it now decides, not as it was when the action was saved.
    expect(jobTemplate('infra-apply-{{ entity.fields.team }}', on({ team: 'platform' }))).toEqual({ refused: 'its template reads workspace.team, which is not locked, so a person could change what the job runs as: set overridable: false on it, and only sources write it' })
  })
})
