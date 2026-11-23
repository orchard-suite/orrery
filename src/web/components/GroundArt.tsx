// The pictures of the ground. One entity is drawn as a bed: a flower whose
// shape and colour are its status, on a stem as tall as it is busy, with a
// stake for each number that has a budget, clouds for how often work on it
// gets stuck, and weeds for what should not be there. Every part stands for
// one number the reader can open, and nothing here moves.

import type { Bucket, GroundItem, GroundMeasure } from '../../shared/ground.ts'
import type { StatusLevel } from '../../shared/model.ts'
import { LEVEL_FILL } from './ui.tsx'

/** The line of the soil in a bed's picture, and the middle the flower stands on. */
const SOIL = 84
const MID = 80
/** How tall the stem stands, by how busy the entity is. */
const STEM: Record<Bucket, number> = { 0: 16, 1: 25, 2: 35, 3: 45 }
/** The most stakes a bed draws; the rest are in its numbers. */
const STAKES = 4

const INK = 'var(--color-ink-300)'
const FAINT = 'var(--color-ink-500)'

/** A status as a shape: the same four the lamps and the sky use. */
export function Flower({ x, y, r, level }: { x: number; y: number; r: number; level: StatusLevel }) {
  if (level === 'grey') return <circle cx={x} cy={y} r={r - 0.75} fill="var(--color-ink-900)" stroke={LEVEL_FILL.grey} strokeWidth={1.5} />
  if (level === 'red') return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={1.5} transform={`rotate(45 ${x} ${y})`} fill={LEVEL_FILL.red} />
  if (level === 'amber') return <rect x={x - r * 0.9} y={y - r * 0.9} width={1.8 * r} height={1.8 * r} rx={1.5} fill={LEVEL_FILL.amber} />
  return <circle cx={x} cy={y} r={r} fill={LEVEL_FILL.green} />
}

function Cloud({ x, y }: { x: number; y: number }) {
  return (
    <g fill="var(--color-ink-400)">
      <ellipse cx={x} cy={y + 2} rx={13} ry={5} />
      <circle cx={x - 5} cy={y - 1} r={5} />
      <circle cx={x + 4} cy={y - 3} r={6.5} />
    </g>
  )
}

function Weed({ x }: { x: number }) {
  return <path d={`M${x},${SOIL} l-4,-9 M${x},${SOIL} l0,-12 M${x},${SOIL} l4,-9`} fill="none" stroke={INK} strokeWidth={1.5} strokeLinecap="round" />
}

/** A stake: upright while its number is inside its budget, leaning and red once it is outside, dashed while nothing is known. */
function Stake({ x, m }: { x: number; m: Pick<GroundMeasure, 'over' | 'value'> }) {
  if (m.value === null) return <line x1={x} y1={SOIL} x2={x} y2={SOIL - 38} stroke={FAINT} strokeWidth={2} strokeDasharray="3 3" strokeLinecap="round" />
  if (m.over) return <line x1={x} y1={SOIL} x2={x} y2={SOIL - 38} stroke="var(--color-signal-red)" strokeWidth={2.5} strokeLinecap="round" transform={`rotate(24 ${x} ${SOIL})`} />
  return <line x1={x} y1={SOIL} x2={x} y2={SOIL - 38} stroke="var(--color-ink-200)" strokeWidth={2} strokeLinecap="round" />
}

const bucketOf = (item: GroundItem, role: GroundMeasure['role']): Bucket => item.measures.find((m) => m.role === role)?.bucket ?? 0

/** One entity as a bed. The picture is for the eye; whatever holds it says the same in words. */
export function BedArt({ item, className = '' }: { item: GroundItem; className?: string }) {
  const top = SOIL - STEM[item.activityBucket]
  const stakes = item.measures.filter((m) => m.budget).slice(0, STAKES)
  const clouds = bucketOf(item, 'friction')
  const weeds = bucketOf(item, 'unwanted')
  return (
    <svg viewBox="0 0 160 100" className={className} aria-hidden focusable="false">
      {Array.from({ length: clouds }, (_, i) => (
        <Cloud key={i} x={40 + i * 40} y={11} />
      ))}
      {item.trial && <path d={`M${MID - 30},${SOIL} V52 a30,26 0 0 1 60,0 V${SOIL}`} fill="var(--color-orbit)" fillOpacity={0.08} stroke="var(--color-orbit)" strokeWidth={1.5} />}
      {Array.from({ length: weeds }, (_, i) => (
        <Weed key={i} x={22 + i * 12} />
      ))}
      <line x1={MID} y1={SOIL} x2={MID} y2={top} stroke={INK} strokeWidth={2} strokeLinecap="round" />
      {item.activityBucket >= 2 && <path d={`M${MID},${SOIL - 12} q9,-2 11,-10 q-9,1 -11,10`} fill={INK} />}
      <Flower x={MID} y={top} r={7} level={item.level} />
      {stakes.map((m, i) => (
        <Stake key={m.field} x={114 + i * 8} m={m} />
      ))}
      <rect x={10} y={SOIL} width={140} height={11} rx={3} fill="var(--color-ink-700)" stroke={FAINT} strokeWidth={1} />
    </svg>
  )
}

/** A fence beside a limit in a list: whole when it holds, a rail down when it does not, dotted when nothing says. */
export function FenceGlyph({ on }: { on: boolean | null }) {
  const stroke = on === null ? FAINT : on ? 'var(--color-ink-200)' : 'var(--color-signal-red)'
  return (
    <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden focusable="false" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeDasharray={on === null ? '1.5 3' : undefined}>
      <path d="M4,18 V5 M10,18 V5 M16,18 V5" />
      {on === false ? <path d="M4,8 H10 M10,8 L16,13 M4,14 H10" /> : <path d="M4,8 H16 M4,14 H16" />}
    </svg>
  )
}
