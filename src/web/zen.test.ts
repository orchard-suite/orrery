import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Sky } from './components/Sky.tsx'
import { Lamp } from './components/ui.tsx'
import type { Area } from './now.ts'
import { setZen } from './zen.ts'

const lamp = (calm: boolean) => renderToStaticMarkup(createElement(Lamp, { level: 'red', calm }))

const failing: Area = {
  name: 'Catalog',
  count: 12,
  level: 'red',
  notGreen: { red: 2, amber: 0, grey: 0 },
  kinds: [
    { id: 'repository', title: 'Repository', count: 10, level: 'red', notGreen: { red: 2, amber: 0, grey: 0 } },
    { id: 'service', title: 'Service', count: 2, level: 'green', notGreen: { red: 0, amber: 0, grey: 0 } },
  ],
}
const sky = () => renderToStaticMarkup(createElement(Sky, { areas: [failing], total: 12, level: 'red', selected: 'Catalog', onSelect: () => {}, lit: null }))

describe('zen mode', () => {
  afterEach(() => setZen(false))

  it('draws every lamp while it is off', () => {
    expect(lamp(true)).toContain('Status: failing')
    expect(lamp(false)).toContain('Status: failing')
  })

  it('hides the lamps a person browses past, and keeps the ones on a page made for health', () => {
    setZen(true)
    expect(lamp(true)).toBe('')
    expect(lamp(false)).toContain('Status: failing')
  })

  it('draws a failing kind on the sky as a diamond, numbered and named failing, while it is off', () => {
    const drawn = sky()
    expect(drawn).toContain('rotate(45')
    expect(drawn).toContain('2 failing')
    expect(drawn).toContain('Repository: 10, failing')
  })

  it('draws the sky still: quiet dots, and no word, number, or diamond of what fails', () => {
    setZen(true)
    const drawn = sky()
    expect(drawn).not.toContain('rotate(45')
    expect(drawn).not.toContain('failing')
    expect(drawn).toContain('var(--color-calm)')
    expect(drawn).toContain('Repository: 10')
  })
})
