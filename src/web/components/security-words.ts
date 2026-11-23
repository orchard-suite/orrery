import type { AccessGrant } from '../../shared/model.ts'

// The words the Security page uses wherever it says the same thing twice.

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

/** A grant in words, the way the server writes it. */
export function grantWords(g: AccessGrant): string {
  const from = g.path ? `${g.path}${g.field ? `.${g.field}` : ''}` : g.field ? g.field : 'address'
  return `${from} is ${g.values.join(' or ')}`
}
