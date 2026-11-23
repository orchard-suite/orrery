import { describe, expect, it } from 'vitest'
import { blueprintNamer } from '../shared/model.ts'
import { stepName, titleOf } from './title.ts'

const name = blueprintNamer([{ id: 'finops_invoice', title: 'Invoice' }])

describe('the window title', () => {
  it('names a blueprint by its title, not its id', () => {
    expect(titleOf({ page: 'inventory', blueprint: 'finops_invoice' }, name)).toBe('Invoice · Catalog · orrery')
    expect(titleOf({ page: 'model', id: 'finops_invoice' }, name)).toBe('Invoice · Model · orrery')
  })

  it('shows the id until the blueprints are known', () => {
    expect(titleOf({ page: 'inventory', blueprint: 'finops_invoice' }, blueprintNamer([]))).toBe('finops_invoice · Catalog · orrery')
  })

  it('names only the page when nothing is open', () => {
    expect(titleOf({ page: 'inventory', blueprint: null }, name)).toBe('Catalog · orrery')
  })
})

describe('what the trail calls a step', () => {
  it('takes what the page says it shows over what the address names', () => {
    expect(stepName({ page: 'action-batch', id: 'b-1' }, name, 'ping on 3 things')).toBe('ping on 3 things')
    expect(titleOf({ page: 'action-batch', id: 'b-1' }, name, 'ping on 3 things')).toBe('ping on 3 things · Self-service · orrery')
  })

  it('falls back to the thing the address names, then to the page', () => {
    expect(stepName({ page: 'model', id: 'finops_invoice' }, name, null)).toBe('Invoice')
    expect(stepName({ page: 'action-schedules', id: null }, name, null)).toBe('Schedules')
  })
})
