import { describe, expect, it } from 'vitest'
import { fitFacts } from './notices.ts'

describe('the facts of a notice', () => {
  it('are cut to what the desk takes, so one long value never has the whole event refused', () => {
    const fit = fitFacts([{ name: 'n'.repeat(120), value: 'v'.repeat(900) }, { name: 'Short', value: 'as it is' }, { name: '', value: 'nameless' }])
    expect(fit.map((f) => [f.name.length, f.value.length])).toEqual([[80, 500], [5, 8]])
    expect(fit[0]!.value.endsWith('…')).toBe(true)
    expect(fit[1]).toEqual({ name: 'Short', value: 'as it is' })
  })
})
