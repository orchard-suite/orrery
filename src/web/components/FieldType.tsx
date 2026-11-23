import { AtSign, Binary, ChartLine, Braces, Brackets, Calendar, Calculator, CaseSensitive, FileCode, FileText, Hash, HeartPulse, KeyRound, Link2, List, Sigma, SquareArrowOutUpRight, ToggleLeft, User, type LucideIcon } from 'lucide-react'
import type { FieldDef, FieldType, ValueColor } from '../../shared/model.ts'
import { chipStyle, swatch } from './ui.tsx'

/** How a kind of field looks wherever one is named: its word, its picture, and its colour. */
interface Look {
  label: string
  icon: LucideIcon
  color: ValueColor
}

const TYPES: Record<FieldType, Look> = {
  string: { label: 'Text', icon: CaseSensitive, color: 'grey' },
  number: { label: 'Number', icon: Hash, color: 'blue' },
  boolean: { label: 'Boolean', icon: ToggleLeft, color: 'green' },
  datetime: { label: 'Date-time', icon: Calendar, color: 'turquoise' },
  enum: { label: 'Enum', icon: List, color: 'purple' },
  url: { label: 'URL', icon: SquareArrowOutUpRight, color: 'turquoise' },
  markdown: { label: 'Markdown', icon: FileText, color: 'brown' },
  object: { label: 'Object', icon: Braces, color: 'grey' },
  array: { label: 'Array', icon: Brackets, color: 'grey' },
  email: { label: 'Email', icon: AtSign, color: 'blue' },
  user: { label: 'User', icon: User, color: 'pink' },
  healthcheck: { label: 'Health check', icon: HeartPulse, color: 'red' },
  secretRef: { label: 'Secret', icon: KeyRound, color: 'yellow' },
  openapi: { label: 'OpenAPI', icon: FileCode, color: 'lime' },
  trend: { label: 'Trend', icon: ChartLine, color: 'blue' },
}

/** A field read from elsewhere or worked out is named for that, not for the type of its value. */
export function lookOf(def: Pick<FieldDef, 'type' | 'mirror' | 'aggregation' | 'calculation'>): Look {
  if (def.mirror) return { label: 'Mirror', icon: Link2, color: 'turquoise' }
  if (def.aggregation) return { label: def.aggregation.fn[0]!.toUpperCase() + def.aggregation.fn.slice(1), icon: Sigma, color: 'orange' }
  if (def.calculation) return { label: 'Calculation', icon: Calculator, color: 'orange' }
  return TYPES[def.type] ?? { label: def.type, icon: Binary, color: 'grey' }
}

/** A field's kind as a coloured pill with its picture and its word. `compact` drops the word, for a tight row; the word stays as its name. */
export function TypePill({ def, compact = false, className = '' }: { def: Pick<FieldDef, 'type' | 'mirror' | 'aggregation' | 'calculation'>; compact?: boolean; className?: string }) {
  const look = lookOf(def)
  const Glyph = look.icon
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[12px] font-medium whitespace-nowrap ${className}`} style={chipStyle(swatch(look.color))} title={compact ? look.label : undefined} aria-label={compact ? look.label : undefined} role={compact ? 'img' : undefined}>
      <Glyph className="size-3" aria-hidden />
      {!compact && look.label}
    </span>
  )
}

/** A field's kind as its picture alone, in its colour: for a column heading. */
export function TypeGlyph({ def, className = '' }: { def: Pick<FieldDef, 'type' | 'mirror' | 'aggregation' | 'calculation'>; className?: string }) {
  const look = lookOf(def)
  const Glyph = look.icon
  return <Glyph className={`size-3 shrink-0 ${className}`} style={{ color: `color-mix(in oklab, ${swatch(look.color)} var(--chip-ink), var(--color-ink-50))` }} aria-label={look.label} role="img" />
}
