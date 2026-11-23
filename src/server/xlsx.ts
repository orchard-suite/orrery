// A spreadsheet a person opens in Excel: one workbook of sheets, each a header
// row and rows of values. An .xlsx is a zip of a few XML parts; this writes the
// smallest set Excel, Numbers, and LibreOffice open, with every text inline so
// no shared table is needed, a bold header row frozen at the top with filters
// on it, and columns as wide as what they hold.

import { crc32, deflateRawSync } from 'node:zlib'

/** One sheet: its name, its header, and its rows, each as long as the header. A column may name the Excel number format its numbers are shown with, such as money. */
export interface Sheet {
  name: string
  columns: string[]
  rows: readonly (readonly unknown[])[]
  formats?: readonly (string | undefined)[]
}

/** The most rows one sheet holds, header included: Excel's own limit. */
export const SHEET_ROWS_MAX = 1_048_576

/** The workbook, as the bytes of an .xlsx file. */
export function workbook(sheets: readonly Sheet[]): Buffer {
  if (!sheets.length) throw new Error('A workbook holds at least one sheet')
  const names = uniqueNames(sheets.map((s) => s.name))
  const codes = [...new Set(sheets.flatMap((s) => (s.formats ?? []).filter((f): f is string => !!f)))]
  const parts: [string, string][] = [
    ['[Content_Types].xml', contentTypes(sheets.length)],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbookXml(names)],
    ['xl/_rels/workbook.xml.rels', workbookRels(sheets.length)],
    ['xl/styles.xml', styles(codes)],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, codes)]),
  ]
  return zip(parts.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })))
}

/** A column's letters: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`

// The cell styles: 0 is plain, 1 is the bold header, and one more for each number format a column names, in order.
function styles(codes: readonly string[]): string {
  const fmts = codes.length ? `<numFmts count="${codes.length}">${codes.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escape(c)}"/>`).join('')}</numFmts>` : ''
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>', ...codes.map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)]
  return `${XML}<styleSheet xmlns="${NS}">${fmts}<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function contentTypes(count: number): string {
  const sheets = Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`
}

function workbookXml(names: string[]): string {
  const sheets = names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  return `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets}</sheets></workbook>`
}

function workbookRels(count: number): string {
  const rels = Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
  rels.push(`<Relationship Id="rId${count + 1}" Type="${REL}/styles" Target="styles.xml"/>`)
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
}

/** A sheet's XML: widths from what each column holds, the header bold and frozen, filters over every column. */
function sheetXml(sheet: Sheet, codes: readonly string[]): string {
  if (sheet.rows.length + 1 > SHEET_ROWS_MAX) throw new Error(`A sheet holds at most ${SHEET_ROWS_MAX - 1} rows`)
  const width = sheet.columns.length
  const widths = sheet.columns.map((c, i) => Math.min(60, Math.max(8, c.length + 2, ...sheet.rows.slice(0, 500).map((r) => text(r[i]).length + 1))))
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  const out: string[] = [`${XML}<worksheet xmlns="${NS}">`]
  if (width) out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>')
  if (cols) out.push(`<cols>${cols}</cols>`)
  out.push('<sheetData>')
  out.push(row(1, sheet.columns, 1))
  const styled = sheet.columns.map((_, i) => { const f = sheet.formats?.[i]; return f ? 2 + codes.indexOf(f) : 0 })
  sheet.rows.forEach((r, i) => out.push(row(i + 2, r.slice(0, width), styled)))
  out.push('</sheetData>')
  if (width) out.push(`<autoFilter ref="A1:${columnName(width - 1)}${sheet.rows.length + 1}"/>`)
  out.push('</worksheet>')
  return out.join('')
}

function row(n: number, values: readonly unknown[], style: number | readonly number[]): string {
  const cells = values.map((v, i) => cell(`${columnName(i)}${n}`, v, typeof style === 'number' ? style : (style[i] ?? 0))).join('')
  return `<row r="${n}">${cells}</row>`
}

/** A number or a boolean stays one; anything else is text, a list joined, an object as JSON. An empty value is no cell. */
function cell(ref: string, value: unknown, style: number): string {
  const s = style ? ` s="${style}"` : ''
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escape(text(value))}</t></is></c>`
}

/** What a value reads as in a cell. A cell holds at most 32,767 characters. */
export function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  const t = Array.isArray(value) ? value.map(text).join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return t.length > 32_767 ? t.slice(0, 32_767) : t
}

// Characters XML 1.0 cannot hold are dropped; the five it reserves are escaped.
function escape(t: string): string {
  return t
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Sheet names are at most 31 characters, without : \ / ? * [ ], and unique whatever their case. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((raw) => {
    const base = (raw.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Sheet').slice(0, 31)
    let name = base
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
    seen.add(name.toLowerCase())
    return name
  })
}

/** A zip of the files, each deflated, in the order given. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const packed = deflateRawSync(f.data)
    const crc = crc32(f.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // names are UTF-8
    head.writeUInt16LE(8, 8) // deflated
    head.writeUInt32LE(DOS_TIME, 10)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(f.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, name, packed)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(DOS_TIME, 12)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(f.data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += head.length + name.length + packed.length
  }
  const size = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

// Every part is dated 1 January 2026 at midnight: a file's bytes depend only on what it holds.
const DOS_TIME = ((2026 - 1980) << 25) | (1 << 21) | (1 << 16)
