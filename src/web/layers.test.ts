import { describe, expect, it } from 'vitest'
import { Layers } from './layers.ts'

describe('Layers', () => {
  it('closes only the newest place', () => {
    const layers = new Layers()
    const closed: string[] = []
    layers.add(() => closed.push('drawer'))
    layers.add(() => closed.push('popover'))
    expect(layers.escape()).toBe(true)
    expect(closed).toEqual(['popover'])
  })

  it('reaches the one below once the newest gives its place back', () => {
    const layers = new Layers()
    const closed: string[] = []
    layers.add(() => closed.push('drawer'))
    const done = layers.add(() => closed.push('popover'))
    done()
    layers.escape()
    expect(closed).toEqual(['drawer'])
  })

  it('gives back a place from the middle without moving the rest', () => {
    const layers = new Layers()
    const closed: string[] = []
    layers.add(() => closed.push('panel'))
    const middle = layers.add(() => closed.push('drawer'))
    layers.add(() => closed.push('popover'))
    middle()
    layers.escape()
    expect(closed).toEqual(['popover'])
  })

  it('says when nothing is open', () => {
    const layers = new Layers()
    const done = layers.add(() => {})
    done()
    done()
    expect(layers.escape()).toBe(false)
  })
})
