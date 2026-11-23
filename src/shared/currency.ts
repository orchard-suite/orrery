// Money in a `number` field. A field whose format is `currency` with `minor`
// stores a whole count of the currency's smallest unit; these turn it into
// what a person reads and back. Server and web app share them.
import type { CurrencyFormat, FieldDef, FieldFormat } from './model.ts'

/** The currency format of a field, when it has one. */
export function currencyOf(def: Pick<FieldDef, 'format'> | undefined): CurrencyFormat | undefined {
  return def?.format?.kind === 'currency' ? def.format : undefined
}

/** How many decimal places the currency's major unit has: 2 for USD, 0 for JPY. */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
}

/** A stored number as money: 123456 in USD minor units is $1,234.56. */
export function formatCurrency(value: number, format: CurrencyFormat, locale?: string): string {
  const digits = minorDigits(format.currency)
  const amount = format.minor ? value / 10 ** digits : value
  return new Intl.NumberFormat(locale, { style: 'currency', currency: format.currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
}

/** A stored number as the plain decimal a person edits: 123456 is 1234.56, with no symbol or grouping. */
export function currencyText(value: number, format: CurrencyFormat): string {
  const digits = minorDigits(format.currency)
  return format.minor ? (value / 10 ** digits).toFixed(digits) : String(value)
}

/**
 * What a person typed as the number to store. A currency symbol, spaces, and
 * grouping commas are allowed. More decimals than the currency has is refused
 * rather than rounded, so a typed amount is never changed behind the person's back.
 */
export function parseCurrency(text: string, format: CurrencyFormat): { value: number } | { error: string } {
  const digits = minorDigits(format.currency)
  const t = text.replace(/[\s,]/g, '').replace(/^(-?)[^\d.-]+/, '$1')
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[2] === '' && !m[3])) return { error: 'Not an amount' }
  const fraction = m[3] ?? ''
  if (!format.minor) return { value: Number(t) }
  if (fraction.length > digits) return { error: `At most ${digits} decimal places` }
  const whole = Number(`${m[2] || '0'}${fraction.padEnd(digits, '0')}`)
  return { value: m[1] === '-' ? -whole : whole }
}

/** A number as a person reads it: as its format says, such as money, or grouped with at most two decimals. */
export function numberText(value: number, format?: FieldFormat, locale = 'en-US'): string {
  return format?.kind === 'currency' ? formatCurrency(value, format, locale) : value.toLocaleString(locale, { maximumFractionDigits: 2 })
}

/** What a typed amount stores, in a field shown as money: a number in its stored units, as text, or why it is not one. Anything else is stored as typed. */
export function storedText(typed: string, format?: FieldFormat): { value: string } | { error: string } {
  if (format?.kind !== 'currency') return { value: typed }
  const read = parseCurrency(typed, format)
  return 'error' in read ? read : { value: String(read.value) }
}

/**
 * Money as a spreadsheet holds it: the amount in the currency's major unit,
 * and the number format Excel shows it with, symbol and decimals, so a sum in
 * the sheet adds amounts a person reads.
 */
export function sheetMoney(format: CurrencyFormat): { amount: (value: number) => number; code: string } {
  const digits = minorDigits(format.currency)
  const symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency: format.currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? format.currency
  const number = `#,##0${digits ? `.${'0'.repeat(digits)}` : ''}`
  return { amount: (v) => (format.minor ? v / 10 ** digits : v), code: `"${symbol.replace(/"/g, '')}"${number};-"${symbol.replace(/"/g, '')}"${number}` }
}
