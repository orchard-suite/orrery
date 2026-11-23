import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ColumnDistribution } from '../../shared/api.ts'
import type { ValueColor } from '../../shared/model.ts'
import { turning } from './Clauses.tsx'
import { Chip, swatch } from './ui.tsx'

interface Share {
  value: string | null
  label: string
  count: number
  /** A value's colour, or one of the page's own greys for the rows with no value and for the rest. */
  tone: ValueColor | 'none' | 'rest'
}

/**
 * How a column's values share out the rows that matched, as one bar split in
 * proportion. Each share wears its value's colour, so it matches the chips
 * above it. Hovering a share raises it and names it with its count. Given
 * `onPick`, a share is a button: a click keeps only its rows, and a click with
 * Control, Command, or Option held (or the menu's click, which is Control and
 * a click on a Mac) leaves them out. The rest, which no one value names, is
 * never picked.
 */
export function DistributionBar({ dist, total, colorOf, onPick }: { dist: ColumnDistribution; total: number; colorOf: (value: string) => ValueColor; onPick?: (value: string | null, not: boolean) => void }) {
  const [hover, setHover] = useState<{ at: number; box: DOMRect } | null>(null)
  const shares: Share[] = dist.buckets.map((b) => ({ ...b, tone: b.value === null ? 'none' : colorOf(b.value) }))
  if (dist.other) shares.push({ value: null, label: 'Everything else', count: dist.other, tone: 'rest' })
  if (!total || !shares.length) return null
  // Many shares sit closer together, so the small ones keep some width.
  const gap = shares.length > 10 ? 1 : shares.length > 4 ? 2 : 3
  const shown = hover ? shares[hover.at] : undefined
  // What the shares say without a pointer or colour: each one named with its count.
  const summary = shares.map((s) => `${s.label}: ${s.count}`).join(', ')
  const pick = (event: MouseEvent, s: Share) => {
    event.preventDefault()
    onPick?.(s.value, turning(event) || event.type === 'contextmenu')
  }
  return (
    <div role={onPick ? 'group' : 'img'} aria-label={summary} className="flex h-3.5 w-full items-center" style={{ gap }} onMouseLeave={() => setHover(null)}>
      {shares.map((s, i) => {
        const look = `rounded-full transition-[height,opacity] duration-100 ${hover?.at === i ? 'h-3.5' : 'h-1.5'} ${hover && hover.at !== i ? 'opacity-60' : ''} ${s.tone === 'none' ? 'bg-ink-600' : s.tone === 'rest' ? 'bg-ink-400' : ''}`
        const style = { flex: `${s.count} 1 0`, minWidth: 4, background: s.tone === 'none' || s.tone === 'rest' ? undefined : swatch(s.tone) }
        const enter = (ev: MouseEvent<HTMLElement>) => setHover({ at: i, box: ev.currentTarget.getBoundingClientRect() })
        if (!onPick || s.tone === 'rest') return <div key={`${s.value ?? s.label}`} className={look} style={style} onMouseEnter={enter} />
        return (
          <button
            key={`${s.value ?? s.label}`}
            type="button"
            aria-label={`${s.label}: ${s.count} of ${total}. Keep only these; with Control held, leave them out.`}
            className={`${look} cursor-pointer p-0`}
            style={style}
            onMouseEnter={enter}
            onFocus={(ev) => setHover({ at: i, box: ev.currentTarget.getBoundingClientRect() })}
            onBlur={() => setHover(null)}
            onClick={(ev) => pick(ev, s)}
            onContextMenu={(ev) => pick(ev, s)}
          />
        )
      })}
      {hover && shown && <Tip share={shown} total={total} box={hover.box} picks={!!onPick && shown.tone !== 'rest'} />}
    </div>
  )
}

function Tip({ share, total, box, picks }: { share: Share; total: number; box: DOMRect; picks: boolean }) {
  const pct = (share.count / total) * 100
  return createPortal(
    <div className="pointer-events-none fixed z-50 flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 whitespace-nowrap elevate-pop" style={{ left: box.left + box.width / 2, top: box.top - 6 }}>
      <div className="flex items-center gap-2">
        {share.value !== null && share.tone !== 'none' && share.tone !== 'rest' ? <Chip value={share.value} label={share.label} def={{ type: 'string', colors: { [share.value]: share.tone } }} /> : <span className="font-mono text-[12px] text-ink-300">{share.label}</span>}
        <span className="font-mono text-[12px] text-ink-200">
          {share.count}/{total}
        </span>
        <span className="font-mono text-[12px] text-ink-400">({pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)</span>
      </div>
      {picks && <div className="text-[11px] text-ink-400">Click to keep only these. Ctrl-click to leave them out.</div>}
    </div>,
    document.body,
  )
}
