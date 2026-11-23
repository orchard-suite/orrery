// The one way an edition of a report is drawn, in the hub's one style. Two
// profiles share every decision: `web` is drawn into the hub's own page and
// takes its colours from the theme's tokens (the `rp-` classes in
// `styles.css`), so both themes and zen apply; `email` is a whole document
// whose every style is inline and whose charts are tables, so a mail client
// that strips styles and pictures still shows it. Everything a data set or a
// model wrote is escaped: the only markup is the drawer's own.

import { changeOf, formatNumber, type ChartPoint, type EditionBlock, type EditionContent, type EditionStat, type ScoreRow, type Tone } from './report.ts'

export type DrawProfile = 'web' | 'email'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/** The marks inside a line of written prose: bold, italic, code, and a link to an http address. Everything else is escaped text. */
function inline(text: string, linkStyle: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}"${linkStyle}>${label}</a>`)
}

/** The cells of one line of a Markdown table. */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/** How written prose is styled in one profile: the attributes each element takes. */
interface ProseStyle { p: string; h: string; ul: string; li: string; table: string; th: string; td: string; a: string; button: string }
const WEB_PROSE: ProseStyle = { p: '', h: ' class="rp-h4"', ul: '', li: '', table: ' class="rp-table"', th: '', td: '', a: '', button: ' class="btn btn-solid"' }

/**
 * Written prose, drawn from the little Markdown a writer may use: paragraphs,
 * headings, lists, tables, bold, italic, code, and links. Every character it
 * holds is escaped first, so the only markup is the drawer's own. With
 * `buttons`, a paragraph that is one link alone is drawn as a button: a
 * layout's own words may ask for one, a writer's never.
 */
function prose(text: string, style: ProseStyle, buttons = false): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    const only = buttons && para.length === 1 ? /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(para[0]!) : null
    if (only) out.push(`<p${style.p}><a href="${escapeHtml(only[2]!)}"${style.button}>${escapeHtml(only[1]!)}</a></p>`)
    else if (para.length) out.push(`<p${style.p}>${para.map((l) => inline(l, style.a)).join('<br>')}</p>`)
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.+)$/.exec(line)
    if (!line.trim()) {
      flush()
      i++
    } else if (heading) {
      flush()
      out.push(`<h4${style.h}>${inline(heading[1]!, style.a)}</h4>`)
      i++
    } else if (item) {
      flush()
      const tag = item[1] ? 'ol' : 'ul'
      const items: string[] = []
      for (; i < lines.length; i++) {
        const next = /^\s*(?:[-*+]|(\d+)[.)])\s+(.+)$/.exec(lines[i]!)
        if (!next) break
        items.push(`<li${style.li}>${inline(next[2]!, style.a)}</li>`)
      }
      out.push(`<${tag}${style.ul}>${items.join('')}</${tag}>`)
    } else if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(cells(lines[i]!))
      out.push(`<table${style.table}><thead><tr>${head.map((c) => `<th${style.th}>${inline(c, style.a)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_h, k) => `<td${style.td}>${inline(r[k] ?? '', style.a)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
    } else {
      para.push(line.trim())
      i++
    }
  }
  flush()
  return out.join('')
}

/** The email profile's colours: fixed, readable on white whatever the client does. `band` is the header's ground, and `onBand` what is written on it; `lead` is the ground a lead paragraph stands on. */
const MAIL = { ink: '#1f2328', soft: '#57606a', edge: '#d0d7de', panel: '#f6f8fa', accent: '#0969da', good: '#1a7f37', warn: '#9a6700', bad: '#cf222e', band: '#14213d', onBand: '#ffffff', onBandSoft: '#c5d0e0', lead: '#fff8e1', leadEdge: '#e6c66a' }

/** How a tone is marked: a shape of its own and a name, so it is never colour alone. */
const MARK: Record<Tone, { shape: string; name: string }> = { good: { shape: '●', name: 'On track' }, warn: { shape: '▲', name: 'Watch' }, bad: { shape: '■', name: 'Off track' } }

/** When an edition was published, said in its own time zone. */
export function whenOf(content: Pick<EditionContent, 'publishedAt' | 'zone'>): string {
  const say = (timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(content.publishedAt))
  try {
    return say(content.zone ?? 'UTC')
  } catch {
    return say('UTC')
  }
}

/** The days an edition covers, said as a range in its own time zone, its publish day the last; nothing where it names none. */
export function coversOf(content: Pick<EditionContent, 'publishedAt' | 'zone' | 'covers'>): string {
  if (!content.covers) return ''
  const end = new Date(content.publishedAt)
  const start = new Date(end.getTime() - (content.covers - 1) * 86_400_000)
  const say = (timeZone: string) => {
    const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' }).formatToParts(d).map((p) => [p.type, p.value]))
    const [a, b] = [parts(start), parts(end)]
    if (content.covers === 1) return `${b.month} ${b.day}, ${b.year}`
    return a.year === b.year ? `${a.month} ${a.day} to ${b.month} ${b.day}, ${b.year}` : `${a.month} ${a.day}, ${a.year} to ${b.month} ${b.day}, ${b.year}`
  }
  try {
    return say(content.zone ?? 'UTC')
  } catch {
    return say('UTC')
  }
}

/**
 * The range a trend is drawn over. From zero where its numbers reach near
 * it; else from a little under the least of them, so a move among large
 * numbers shows. Whoever draws it says where it starts.
 */
function rangeOf(values: readonly number[]): { lo: number; hi: number } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { lo: Math.min(0, min), hi: max > 0 ? max : min === 0 ? 1 : 0 }
  if (min < 0 || min <= max / 2) return { lo: Math.min(0, min), hi: max }
  return { lo: Math.max(0, min - (max - min) / 3), hi: max }
}

/** How many number tiles stand in a row, so every row but the last is full and no row holds more than four. */
function tilesAcross(count: number): number {
  return Math.ceil(count / Math.ceil(count / 4))
}

/** The heights of a scorecard's trend bars, each as a share of the tallest among all its rows. */
function barShares(rows: readonly ScoreRow[]): (row: ScoreRow) => { label: string; share: number; value: number | null; tone?: Tone }[] {
  const top = Math.max(0, ...rows.flatMap((r) => (r.trend ?? []).map((t) => Math.abs(t.value ?? 0)))) || 1
  return (row) => (row.trend ?? []).map((t) => ({ ...t, share: Math.abs(t.value ?? 0) / top }))
}

/**
 * An edition drawn as HTML. `web` is a fragment for the hub's page; `email`
 * is a whole document. `link` is the edition's page, which the email ends
 * with.
 */
export function drawEdition(content: EditionContent, profile: DrawProfile, link?: string): string {
  const body = content.blocks.map((b) => (profile === 'web' ? webBlock(b) : mailBlock(b))).join('\n')
  const covers = coversOf(content)
  if (profile === 'web') return `<article class="rp">${covers ? `<p class="rp-note">${escapeHtml(covers)}</p>` : ''}${body}</article>`
  const foot = link ? `<p style="margin:24px 0 0;font-size:13px;color:${MAIL.soft}"><a href="${escapeHtml(link)}" style="color:${MAIL.accent}">Open this edition</a> to read it whole and compare it with others.</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.title)}</title></head><body style="margin:0;padding:0;background:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td align="center" style="padding:24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;border-collapse:collapse;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${MAIL.ink};font-size:15px;line-height:1.5"><tr><td bgcolor="${MAIL.band}" style="background:${MAIL.band};padding:20px 24px">${content.home ? `<p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MAIL.onBandSoft}">${escapeHtml(content.home)}</p>` : ''}<h1 style="margin:0;font-size:24px;line-height:1.25;color:${MAIL.onBand}">${escapeHtml(content.title)}</h1>${covers ? `<p style="margin:6px 0 0;font-size:14px;color:${MAIL.onBand}">${escapeHtml(covers)}</p>` : ''}<p style="margin:6px 0 0;font-size:13px;color:${MAIL.onBandSoft}">Edition ${content.number} · ${escapeHtml(whenOf(content))}</p></td></tr><tr><td style="padding:20px 0 0">${body}${foot}</td></tr></table></td></tr></table></body></html>`
}

/** Written prose in a mail: every style inline. */
const MAIL_PROSE: ProseStyle = { p: ' style="margin:0 0 12px"', h: ' style="margin:16px 0 6px;font-size:15px"', ul: ' style="margin:0 0 12px;padding-left:22px"', li: ' style="margin:0 0 4px"', table: ` cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 12px"`, th: ` align="left" style="padding:6px 8px;border-bottom:2px solid ${MAIL.edge};font-size:12px;color:${MAIL.soft}"`, td: ` style="padding:6px 8px;border-bottom:1px solid ${MAIL.edge};font-size:13px"`, a: ` style="color:${MAIL.accent}"`, button: ` style="display:inline-block;padding:10px 18px;background:${MAIL.accent};color:#ffffff;font-weight:600;text-decoration:none;border-radius:6px"` }

// Web -----------------------------------------------------------------------

function webGap(gap?: string): string {
  return gap ? `<p class="rp-gap">${escapeHtml(gap)}</p>` : ''
}

function webTitle(title?: string): string {
  return title ? `<h3 class="rp-h3">${escapeHtml(title)}</h3>` : ''
}

function webStat(s: EditionStat): string {
  const change = changeOf(s)
  return `<div class="rp-stat${s.tone ? ` rp-stat-${s.tone}` : ''}"><div class="rp-stat-name">${s.tone ? `${webMark(s.tone)} ` : ''}${escapeHtml(s.title)}</div><div class="rp-stat-value">${escapeHtml(formatNumber(s.value, s.decimals, s.unit))}</div>${change ? `<div class="rp-change rp-${change.tone}">${escapeHtml(change.text)}</div>` : ''}</div>`
}

/** A tone's mark on the page: its shape in its colour, named for a reader who hears it. */
function webMark(tone: Tone): string {
  return `<span class="rp-mark rp-tone-${tone}" role="img" aria-label="${MARK[tone].name}" title="${MARK[tone].name}">${MARK[tone].shape}</span>`
}

/** A cell, marked and coloured where it was judged. */
function webCell(text: string, tone?: Tone | null): string {
  return tone ? `<td class="rp-tone-${tone}">${webMark(tone)} ${escapeHtml(text)}</td>` : `<td>${escapeHtml(text)}</td>`
}

function webScorecard(b: Extract<EditionBlock, { kind: 'scorecard' }>): string {
  const bars = barShares(b.rows)
  const rows = b.rows.map((r) => {
    const trend = b.trend ? `<td><span class="rp-spark" role="img" aria-label="${escapeHtml(bars(r).map((t) => `${t.label}: ${formatNumber(t.value)}`).join(', '))}">${bars(r).map((t) => `<span class="rp-spark-bar${t.tone ? ` rp-fill-${t.tone}` : ''}" style="height:${Math.max(t.value === null ? 0 : 8, Math.round(t.share * 100))}%" title="${escapeHtml(`${t.label}: ${formatNumber(t.value)}`)}"></span>`).join('')}</span></td>` : ''
    return `<tr><th scope="row">${r.tone ? `${webMark(r.tone)} ` : ''}${escapeHtml(r.label)}</th>${r.cells.map((c) => webCell(c.text, c.tone)).join('')}${trend}</tr>`
  })
  return `<div class="rp-scroll"><table class="rp-table rp-score"><thead><tr><th>${escapeHtml(b.label)}</th>${b.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}${b.trend ? `<th>${escapeHtml(b.trend)}</th>` : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>${b.total > b.rows.length ? `<p class="rp-note">${b.rows.length} of ${b.total.toLocaleString('en-US')} rows</p>` : ''}`
}

function webBlock(b: EditionBlock): string {
  switch (b.kind) {
    case 'heading':
      return `<h${b.level + 1} class="rp-h${b.level + 1}">${escapeHtml(b.text)}</h${b.level + 1}>`
    case 'text':
      return `<div class="rp-text">${prose(b.text, WEB_PROSE, true)}</div>`
    case 'stats':
      return `<section class="rp-block">${webTitle(b.title)}<div class="rp-stats">${b.items.map(webStat).join('')}</div>${webGap(b.gap)}</section>`
    case 'narrative':
      return `<section class="rp-block">${webTitle(b.title)}${b.text ? `<div class="rp-prose${b.lead ? ' rp-lead' : ''}">${prose(b.text, WEB_PROSE)}</div>` : ''}${webGap(b.gap)}</section>`
    case 'table':
      return `<section class="rp-block">${webTitle(b.title)}${b.columns.length ? `<div class="rp-scroll"><table class="rp-table"><thead><tr>${b.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r, i) => `<tr>${r.map((c, k) => webCell(c, b.tones?.[i]?.[k])).join('')}</tr>`).join('')}</tbody></table></div>${b.total > b.rows.length ? `<p class="rp-note">${b.rows.length} of ${b.total.toLocaleString('en-US')} rows</p>` : ''}` : ''}${webGap(b.gap)}</section>`
    case 'scorecard':
      return `<section class="rp-block">${webTitle(b.title)}${b.rows.length ? webScorecard(b) : ''}${webGap(b.gap)}</section>`
    case 'chart':
      return `<section class="rp-block">${webTitle(b.title)}${b.series.length ? webChart(b) : ''}${webGap(b.gap)}</section>`
  }
}

/** The series' colours, by token, in the order a chart's lines take them. */
const SERIES = ['var(--color-orbit)', 'var(--color-v-orange)', 'var(--color-v-green)', 'var(--color-v-purple)']

function webChart(b: Extract<EditionBlock, { kind: 'chart' }>): string {
  if (b.type === 'trend') return webTrend(b.series, b.x)
  const points = b.series[0]!.points
  const max = Math.max(0, ...points.flatMap((p) => [p.value ?? 0, p.was ?? 0]).map(Math.abs)) || 1
  const rows = points.map((p) => {
    const w = (Math.abs(p.value ?? 0) / max) * 100
    const was = b.type === 'delta' && p.was !== undefined && p.was !== null ? (Math.abs(p.was) / max) * 100 : null
    const change = b.type === 'delta' ? changeOf({ value: p.value, was: p.was ?? null }) : null
    return `<div class="rp-bar-row"><div class="rp-bar-label">${escapeHtml(p.label)}</div><div class="rp-bar-track">${was !== null ? `<div class="rp-bar-was" style="width:${was.toFixed(1)}%"></div>` : ''}<div class="rp-bar" style="width:${w.toFixed(1)}%"></div></div><div class="rp-bar-value">${escapeHtml(formatNumber(p.value))}${change ? ` <span class="rp-change rp-flat">${escapeHtml(change.text)}</span>` : ''}</div></div>`
  })
  const key = b.type === 'delta' ? `<p class="rp-note"><span class="rp-key rp-key-now"></span>${escapeHtml(b.series[0]!.name)} now <span class="rp-key rp-key-was"></span>in the edition before</p>` : ''
  return `<div class="rp-bars">${rows.join('')}</div>${key}`
}

function webTrend(series: { name: string; points: ChartPoint[] }[], x: string): string {
  const W = 640
  const H = 200
  const pad = { l: 48, r: 12, t: 12, b: 28 }
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null)
  if (!values.length) return '<p class="rp-gap">nothing to draw</p>'
  const { lo, hi } = rangeOf(values)
  const n = Math.max(...series.map((s) => s.points.length))
  const px = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i / (n - 1)) * (W - pad.l - pad.r))
  const py = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const lines = series.map((s, si) => {
    const pts = s.points.map((p, i) => (p.value === null ? null : `${px(i).toFixed(1)},${py(p.value).toFixed(1)}`)).filter(Boolean)
    const dots = s.points.map((p, i) => (p.value === null ? '' : `<circle cx="${px(i).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="2.5" fill="${SERIES[si % SERIES.length]}"><title>${escapeHtml(`${p.label}: ${formatNumber(p.value)}`)}</title></circle>`)).join('')
    return `<polyline fill="none" stroke="${SERIES[si % SERIES.length]}" stroke-width="2" points="${pts.join(' ')}"/>${dots}`
  })
  const first = series[0]!.points
  const labels = [0, n - 1].filter((i, k, all) => all.indexOf(i) === k && first[i]).map((i) => `<text x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'end'}" class="rp-axis">${escapeHtml(first[i]!.label)}</text>`)
  const ticks = [lo, hi].map((v) => `<text x="${pad.l - 6}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end" class="rp-axis">${escapeHtml(formatNumber(v))}</text><line x1="${pad.l}" x2="${W - pad.r}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" class="rp-grid"/>`)
  const legend = series.length > 1 ? `<p class="rp-note">${series.map((s, si) => `<span class="rp-key" style="background:${SERIES[si % SERIES.length]}"></span>${escapeHtml(s.name)}`).join(' ')}</p>` : ''
  const label = `${series.map((s) => s.name).join(', ')} by ${x}`
  return `<svg class="rp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}">${ticks.join('')}${lines.join('')}${labels.join('')}</svg>${legend}`
}

// Email -----------------------------------------------------------------------

function mailTitle(title?: string): string {
  return title ? `<h3 style="margin:20px 0 8px;font-size:16px">${escapeHtml(title)}</h3>` : ''
}

function mailGap(gap?: string): string {
  return gap ? `<p style="margin:4px 0;font-size:13px;color:${MAIL.soft};font-style:italic">${escapeHtml(gap)}</p>` : ''
}

/** A tone's mark in a mail: its shape in its colour, named in its title. */
function mailMark(tone: Tone): string {
  return `<span title="${MARK[tone].name}" style="color:${MAIL[tone]}">${MARK[tone].shape}</span>`
}

const MAIL_TD = `padding:6px 8px;border-bottom:1px solid ${MAIL.edge};font-size:13px`
const MAIL_TH = `padding:6px 8px;border-bottom:2px solid ${MAIL.edge};font-size:12px;color:${MAIL.soft}`

/** A cell of a mail's table, marked and coloured where it was judged. */
function mailCell(text: string, tone?: Tone | null): string {
  return tone ? `<td style="${MAIL_TD};color:${MAIL[tone]};font-weight:600">${mailMark(tone)} ${escapeHtml(text)}</td>` : `<td style="${MAIL_TD}">${escapeHtml(text)}</td>`
}

/** The most points of a trend a mail writes a number over and a label under. */
const MAIL_TREND_LABELLED = 12
/** How tall a mail's trend stands, in pixels. */
const MAIL_TREND_HEIGHT = 72

/** A trend in a mail: columns of table cells, one a point, over the range `rangeOf` gives, which it says when that is not from zero. */
function mailTrend(points: readonly ChartPoint[]): string {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null)
  if (!values.length) return mailGap('nothing to draw')
  const { lo, hi } = rangeOf(values)
  const labelled = points.length <= MAIL_TREND_LABELLED
  const pad = points.length <= 24 ? 2 : points.length <= 60 ? 1 : 0
  const columns = points.map((p) => {
    const h = p.value === null ? 0 : Math.max(2, Math.round(((p.value - lo) / (hi - lo || 1)) * MAIL_TREND_HEIGHT))
    return `<td valign="bottom" align="center" title="${escapeHtml(`${p.label}: ${formatNumber(p.value)}`)}" style="padding:0 ${pad}px;font-size:11px;color:${MAIL.soft}">${labelled ? escapeHtml(formatNumber(p.value)) : ''}${h ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr><td height="${h}" bgcolor="${MAIL.accent}" style="height:${h}px;background:${MAIL.accent};font-size:0;line-height:0">&nbsp;</td></tr></table>` : ''}</td>`
  })
  const under = labelled
    ? `<tr>${points.map((p) => `<td align="center" style="padding:4px 2px 0;border-top:1px solid ${MAIL.edge};font-size:11px;color:${MAIL.soft}">${escapeHtml(p.label)}</td>`).join('')}</tr>`
    : `<tr><td colspan="${points.length}" style="padding:4px 0 0;border-top:1px solid ${MAIL.edge};font-size:11px;color:${MAIL.soft}"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font-size:11px;color:${MAIL.soft}">${escapeHtml(points[0]!.label)}</td><td align="right" style="font-size:11px;color:${MAIL.soft}">${escapeHtml(points[points.length - 1]!.label)}</td></tr></table></td></tr>`
  const said = [...(labelled ? [] : [`From ${formatNumber(Math.min(...values))} to ${formatNumber(Math.max(...values))}.`]), ...(lo !== 0 ? [`Columns start at ${formatNumber(lo)}.`] : [])]
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;table-layout:fixed"><tr>${columns.join('')}</tr>${under}</table>${said.length ? `<p style="margin:4px 0 0;font-size:11px;color:${MAIL.soft}">${escapeHtml(said.join(' '))}</p>` : ''}`
}

function mailScorecard(b: Extract<EditionBlock, { kind: 'scorecard' }>): string {
  const bars = barShares(b.rows)
  const th = [b.label, ...b.columns, ...(b.trend ? [b.trend] : [])].map((c) => `<th align="left" style="${MAIL_TH}">${escapeHtml(c)}</th>`).join('')
  const trs = b.rows.map((r) => {
    const trend = b.trend ? `<td style="${MAIL_TD}"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse" title="${escapeHtml(bars(r).map((t) => `${t.label}: ${formatNumber(t.value)}`).join(', '))}"><tr>${bars(r).map((t) => {
      // A zero is a value: it stands as a line on the floor, so a week at nothing is told from a week not read.
      const h = t.value === null ? 0 : Math.max(2, Math.round(t.share * 18))
      const colour = t.tone ? MAIL[t.tone] : MAIL.accent
      return `<td valign="bottom" style="padding:0 1px;height:18px">${h ? `<table role="presentation" cellpadding="0" cellspacing="0" width="7" style="border-collapse:collapse"><tr><td height="${h}" bgcolor="${colour}" style="height:${h}px;width:7px;background:${colour};font-size:0;line-height:0">&nbsp;</td></tr></table>` : `<table role="presentation" cellpadding="0" cellspacing="0" width="7"><tr><td style="width:7px;font-size:0;line-height:0">&nbsp;</td></tr></table>`}</td>`
    }).join('')}</tr></table></td>` : ''
    return `<tr><td style="${MAIL_TD};font-weight:600">${r.tone ? `${mailMark(r.tone)} ` : ''}${escapeHtml(r.label)}</td>${r.cells.map((c) => mailCell(c.text, c.tone)).join('')}${trend}</tr>`
  }).join('')
  const more = b.total > b.rows.length ? `<p style="margin:4px 0;font-size:12px;color:${MAIL.soft}">${b.rows.length} of ${b.total.toLocaleString('en-US')} rows</p>` : ''
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><tr>${th}</tr>${trs}</table>${more}`
}

function mailBlock(b: EditionBlock): string {
  switch (b.kind) {
    case 'heading':
      return `<h${b.level + 1} style="margin:24px 0 8px;font-size:${b.level === 1 ? 20 : b.level === 2 ? 17 : 15}px">${escapeHtml(b.text)}</h${b.level + 1}>`
    case 'text':
      return prose(b.text, MAIL_PROSE, true)
    case 'narrative':
      if (b.lead && b.text) return `${mailTitle(b.title)}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 16px"><tr><td bgcolor="${MAIL.lead}" style="background:${MAIL.lead};border-left:4px solid ${MAIL.leadEdge};padding:14px 16px 2px">${prose(b.text, MAIL_PROSE)}</td></tr></table>${mailGap(b.gap)}`
      return `${mailTitle(b.title)}${b.text ? prose(b.text, MAIL_PROSE) : ''}${mailGap(b.gap)}`
    case 'stats': {
      const cells = b.items.map((s) => {
        const change = changeOf(s)
        const colour = change?.tone === 'good' ? MAIL.good : change?.tone === 'bad' ? MAIL.bad : MAIL.soft
        return `<td valign="top" style="padding:12px;border:1px solid ${MAIL.edge};border-top:3px solid ${s.tone ? MAIL[s.tone] : MAIL.edge};background:${MAIL.panel}"><div style="font-size:12px;color:${MAIL.soft}">${s.tone ? `${mailMark(s.tone)} ` : ''}${escapeHtml(s.title)}</div><div style="font-size:22px;font-weight:600">${escapeHtml(formatNumber(s.value, s.decimals, s.unit))}</div>${change ? `<div style="font-size:12px;color:${colour}">${escapeHtml(change.text)}</div>` : ''}</td>`
      })
      if (!cells.length) return `${mailTitle(b.title)}${mailGap(b.gap)}`
      // Every row as wide as the mail, its tiles equal; a last row that is short is filled out with nothing.
      const across = tilesAcross(cells.length)
      const rows: string[] = []
      for (let i = 0; i < cells.length; i += across) rows.push(`<tr>${[...cells.slice(i, i + across), ...Array.from({ length: Math.max(0, i + across - cells.length) }, () => '<td></td>')].join('')}</tr>`)
      return `${mailTitle(b.title)}<table role="presentation" cellpadding="0" cellspacing="6" width="100%" style="border-collapse:separate;table-layout:fixed;width:100%">${rows.join('')}</table>${mailGap(b.gap)}`
    }
    case 'table': {
      if (!b.columns.length) return `${mailTitle(b.title)}${mailGap(b.gap)}`
      const th = b.columns.map((c) => `<th align="left" style="${MAIL_TH}">${escapeHtml(c)}</th>`).join('')
      const trs = b.rows.map((r, i) => `<tr>${r.map((c, k) => mailCell(c, b.tones?.[i]?.[k])).join('')}</tr>`).join('')
      const more = b.total > b.rows.length ? `<p style="margin:4px 0;font-size:12px;color:${MAIL.soft}">${b.rows.length} of ${b.total.toLocaleString('en-US')} rows</p>` : ''
      return `${mailTitle(b.title)}<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><tr>${th}</tr>${trs}</table>${more}${mailGap(b.gap)}`
    }
    case 'scorecard':
      return `${mailTitle(b.title)}${b.rows.length ? mailScorecard(b) : ''}${mailGap(b.gap)}`
    case 'chart': {
      if (!b.series.length) return `${mailTitle(b.title)}${mailGap(b.gap)}`
      const named = (s: { name: string }) => (b.series.length > 1 ? `<p style="margin:8px 0 2px;font-size:12px;color:${MAIL.soft}">${escapeHtml(s.name)}</p>` : '')
      // A mail client draws no picture it was not sent, so every chart is table cells: a trend as columns, one a point, and the rest as bars, one row a point.
      if (b.type === 'trend') return `${mailTitle(b.title)}${b.series.map((s) => `${named(s)}${mailTrend(s.points)}`).join('')}${mailGap(b.gap)}`
      const blocks = b.series.map((s) => {
        const max = Math.max(0, ...s.points.flatMap((p) => [p.value ?? 0, p.was ?? 0]).map(Math.abs)) || 1
        const rows = s.points.map((p) => {
          const w = p.value ? Math.max(1, Math.round((Math.abs(p.value) / max) * 100)) : 0
          const change = b.type === 'delta' ? changeOf({ value: p.value, was: p.was ?? null }) : null
          return `<tr><td style="padding:2px 8px 2px 0;font-size:12px;white-space:nowrap">${escapeHtml(p.label)}</td><td width="100%" style="padding:2px 0">${w ? `<table role="presentation" cellpadding="0" cellspacing="0" width="${w}%"><tr><td bgcolor="${MAIL.accent}" style="background:${MAIL.accent};height:10px;font-size:0;line-height:0">&nbsp;</td></tr></table>` : ''}</td><td style="padding:2px 0 2px 8px;font-size:12px;white-space:nowrap">${escapeHtml(formatNumber(p.value))}${change ? ` <span style="color:${MAIL.soft}">${escapeHtml(change.text)}</span>` : ''}</td></tr>`
        })
        return `${named(s)}<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${rows.join('')}</table>`
      })
      return `${mailTitle(b.title)}${blocks.join('')}${mailGap(b.gap)}`
    }
  }
}
