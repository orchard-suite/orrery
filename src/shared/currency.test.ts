import { describe, expect, it } from 'vitest'
import { currencyOf, currencyText, formatCurrency, minorDigits, numberText, parseCurrency, sheetMoney, storedText } from './currency.ts'
import type { CurrencyFormat } from './model.ts'

const usd: CurrencyFormat = { kind: 'currency', currency: 'USD', minor: true }

describe('currency display', () => {
  it('shows integer cents as dollars', () => {
    expect(formatCurrency(123456, usd, 'en-US')).toBe('$1,234.56')
    expect(formatCurrency(5, usd, 'en-US')).toBe('$0.05')
    expect(formatCurrency(0, usd, 'en-US')).toBe('$0.00')
    expect(formatCurrency(-250, usd, 'en-US')).toBe('-$2.50')
  })
  it('shows a stored number as it is when it is not in minor units', () => {
    expect(formatCurrency(1234.5, { kind: 'currency', currency: 'USD' }, 'en-US')).toBe('$1,234.50')
  })
  it('takes the decimal places from the currency', () => {
    expect(minorDigits('USD')).toBe(2)
    expect(minorDigits('JPY')).toBe(0)
    expect(formatCurrency(1500, { kind: 'currency', currency: 'JPY', minor: true }, 'en-US')).toBe('¥1,500')
  })
  it('finds a field format only for a currency', () => {
    expect(currencyOf({ format: usd })).toEqual(usd)
    expect(currencyOf({})).toBeUndefined()
  })
})

describe('currency editing', () => {
  it('shows the stored number as a plain decimal', () => {
    expect(currencyText(123456, usd)).toBe('1234.56')
    expect(currencyText(7, usd)).toBe('0.07')
  })
  it('turns what was typed back into minor units exactly', () => {
    expect(parseCurrency('1234.56', usd)).toEqual({ value: 123456 })
    expect(parseCurrency('$1,234.5', usd)).toEqual({ value: 123450 })
    expect(parseCurrency('12', usd)).toEqual({ value: 1200 })
    expect(parseCurrency('1.005', usd)).toEqual({ error: 'At most 2 decimal places' })
    expect(parseCurrency('-2.50', usd)).toEqual({ value: -250 })
    expect(parseCurrency('.5', usd)).toEqual({ value: 50 })
    expect(parseCurrency('abc', usd)).toEqual({ error: 'Not an amount' })
    expect(parseCurrency('', usd)).toEqual({ error: 'Not an amount' })
  })
})

describe('a number as a person reads it', () => {
  it('is money where its format says so, and grouped with at most two decimals where it says nothing', () => {
    expect(numberText(2470277, usd)).toBe('$24,702.77')
    expect(numberText(2470277)).toBe('2,470,277')
    expect(numberText(3.14159)).toBe('3.14')
  })

  it('takes a typed amount as the stored number, and anything typed for a plain field as typed', () => {
    expect(storedText('$1,250.50', usd)).toEqual({ value: '125050' })
    expect(storedText('1.234', usd)).toEqual({ error: 'At most 2 decimal places' })
    expect(storedText('1.234')).toEqual({ value: '1.234' })
  })

  it('goes into a spreadsheet as the amount, with a money format', () => {
    const m = sheetMoney(usd)
    expect(m.amount(2470277)).toBe(24702.77)
    expect(m.code).toBe('"$"#,##0.00;-"$"#,##0.00')
    expect(sheetMoney({ kind: 'currency', currency: 'JPY' }).amount(500)).toBe(500)
  })
})
