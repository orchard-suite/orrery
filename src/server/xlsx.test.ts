import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { columnName, text, workbook } from './xlsx.ts'

/** One file of a zip, inflated. */
function part(bytes: Buffer, name: string): string {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = bytes.readUInt32LE(end + 16)
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const length = bytes.readUInt16LE(at + 28)
    if (bytes.subarray(at + 46, at + 46 + length).toString() === name) {
      const local = bytes.readUInt32LE(at + 42)
      const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      return inflateRawSync(bytes.subarray(data, data + bytes.readUInt32LE(at + 20))).toString()
    }
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  throw new Error(`no ${name}`)
}

describe('a workbook', () => {
  it('names columns as Excel does', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it('keeps numbers and booleans as such, escapes text, and leaves an empty value out', () => {
    const sheet = part(workbook([{ name: 'S', columns: ['a', 'b', 'c', 'd'], rows: [[7, true, 'x < y & "z"\u0001', null]] }]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="A2"><v>7</v></c>')
    expect(sheet).toContain('<c r="B2" t="b"><v>1</v></c>')
    expect(sheet).toContain('<t xml:space="preserve">x &lt; y &amp; &quot;z&quot;</t>')
    expect(sheet).not.toContain('r="D2"')
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
  })

  it('gives every sheet a name Excel takes: short, without its reserved marks, and unique', () => {
    const book = part(workbook([{ name: 'a/b: c?', columns: [], rows: [] }, { name: 'A/B: C?', columns: [], rows: [] }, { name: 'x'.repeat(40), columns: [], rows: [] }]), 'xl/workbook.xml')
    expect(book).toContain('name="a b  c"')
    expect(book).toContain('name="A B  C 2"')
    expect(book).toContain(`name="${'x'.repeat(31)}"`)
  })

  it('reads a list as its items joined', () => {
    expect(text(['a', 2, null])).toBe('a, 2, ')
  })
})

describe('a column with a number format', () => {
  it('shows its numbers with it, and leaves the other columns plain', () => {
    const book = workbook([{ name: 'S', columns: ['Name', 'Cost'], formats: [undefined, '"$"#,##0.00'], rows: [['a', 24702.77]] }])
    expect(part(book, 'xl/styles.xml')).toContain('<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>')
    expect(part(book, 'xl/styles.xml')).toContain('<cellXfs count="3">')
    const sheet = part(book, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="B2" s="2"><v>24702.77</v></c>')
    expect(sheet).toContain('<c r="A2" t="inlineStr">')
  })
})
