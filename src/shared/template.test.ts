import { describe, expect, it } from 'vitest'
import type { Entity } from './model.ts'
import { hasTemplate, pathsOf, render, scopeEntity } from './template.ts'

const scope = { entity: { fields: { path: 'k8s/orrery', images: ['a:1', 'b:2'] }, relations: { namespace: 'k8s_namespace:home/orrery' } }, inputs: { tag: '0.9.13', n: 3 }, run: { id: 'r1' } }

describe('render', () => {
  it('keeps the type of a whole-string template', () => {
    expect(render('{{ entity.fields.images }}', scope)).toEqual(['a:1', 'b:2'])
    expect(render('{{inputs.n}}', scope)).toBe(3)
    expect(render('{{ entity.fields.images.1 }}', scope)).toBe('b:2')
  })
  it('writes templates into text, nothing as empty, objects as JSON', () => {
    expect(render('tag {{ inputs.tag }} of {{ entity.fields.path }}', scope)).toBe('tag 0.9.13 of k8s/orrery')
    expect(render('x{{ nope.nope }}y', scope)).toBe('xy')
    expect(render('{{ inputs }}', scope)).toEqual({ tag: '0.9.13', n: 3 })
    expect(render('v={{ inputs }}', scope)).toBe('v={"tag":"0.9.13","n":3}')
  })
  it('renders through objects and arrays, and a missing whole value is null', () => {
    expect(render({ relation: 'namespace', target: '{{ entity.relations.namespace }}', list: ['{{ run.id }}', 1, true] }, scope)).toEqual({ relation: 'namespace', target: 'k8s_namespace:home/orrery', list: ['r1', 1, true] })
    expect(render('{{ entity.relations.cluster }}', scope)).toBeNull()
  })
  it('reads a name on every item of a list, and a number picks one', () => {
    const picked = { inputs: { remove: [{ key: 't/a', relations: { user: 'entra_user:t/u' } }, { key: 't/b', relations: { user: null } }] } }
    expect(render('{{ inputs.remove.key }}', picked)).toEqual(['t/a', 't/b'])
    expect(render('{{ inputs.remove.relations.user }}', picked)).toEqual(['entra_user:t/u'])
    expect(render('{{ inputs.remove.1.key }}', picked)).toBe('t/b')
    expect(render('{{ inputs.remove.key.0 }}', picked)).toBe('t/a')
    expect(render('{{ entity.fields.images.tag }}', scope)).toEqual([])
  })
  it('finds templates and their paths', () => {
    expect(hasTemplate({ a: ['{{ x }}'] })).toBe(true)
    expect(hasTemplate({ a: ['x'] })).toBe(false)
    expect(pathsOf({ a: '{{ inputs.workload.fields.images }} {{ run.id }}' })).toEqual(['inputs.workload.fields.images', 'run.id'])
  })
})

describe('scopeEntity', () => {
  const e = { id: 'argocd_app:c/a', blueprint: 'argocd_app', key: 'c/a', title: 'A', icon: null, state: 'active', status: { level: 'green', reasons: [] }, fields: { path: 'p' }, relations: { namespace: [{ blueprint: 'k8s_namespace', key: 'c/ns' }], tags: [{ blueprint: 't', key: '1' }, { blueprint: 't', key: '2' }] } } as unknown as Entity
  it('gives one id for a single relation and a list otherwise', () => {
    const s = scopeEntity(e, { relations: { namespace: { target: 'k8s_namespace', many: false }, tags: { target: 't', many: true }, cluster: { target: 'k8s_cluster', many: false } } })
    expect(s.relations).toEqual({ namespace: 'k8s_namespace:c/ns', tags: ['t:1', 't:2'], cluster: null })
    expect(s.fields).toEqual({ path: 'p' })
    expect(s.id).toBe('argocd_app:c/a')
  })
  it('lists every relation without a blueprint to say', () => {
    expect(scopeEntity(e, undefined).relations).toEqual({ namespace: ['k8s_namespace:c/ns'], tags: ['t:1', 't:2'] })
  })
})
