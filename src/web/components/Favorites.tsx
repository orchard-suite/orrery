// Everything the reader starred, across every blueprint, as one table: each
// kind's fields and relations a column, a column shared where kinds share a
// field, and every row read through the reader's view. A star is starred and
// let go where the thing is shown, in a grid or on its page; here the reader
// orders, groups, and reads. What they make of the table is theirs until they
// leave it.

import { Star } from 'lucide-react'
import { useMemo } from 'react'
import type { QueryView } from '../../shared/api.ts'
import { columnFormat, columnKind, shape, type ColumnKind } from '../../shared/answer.ts'
import { useBlueprintName, useQueryKinds, useStarsTable } from '../api.ts'
import { hueOf } from '../query.ts'
import { useVisit } from '../trail.ts'
import { QueryGrid } from './QueryGrid.tsx'
import { Empty, ErrorNote, swatch } from './ui.tsx'

export function FavoritesPage() {
  const table = useStarsTable()
  const all = useQueryKinds()
  const name = useBlueprintName()
  const [view, setView] = useVisit<QueryView | undefined>('favorites.view', undefined)
  const result = table.data
  const kindsRead = useMemo(() => Object.keys(result?.counts ?? {}), [result])
  const hues = useMemo(() => new Map(kindsRead.map((bp, i) => [bp, swatch(hueOf(i))])), [kindsRead])
  const kinds = useMemo<ColumnKind[]>(() => (result ? result.columns.map((c) => columnKind(c, all ?? [])) : []), [result, all])
  const formats = useMemo(() => (result ? result.columns.map((c) => columnFormat(c, all ?? [])) : []), [result, all])
  const shaped = useMemo(() => (result ? shape(result.rows, view, result.columns, kinds) : null), [result, view, kinds])
  const titleOf = (bp: string) => {
    const found = all?.find((b) => b.id === bp)
    return found ? name(found) : bp
  }
  const count = result?.rows.length ?? 0
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 py-3">
      <header>
        <h1 className="page-title">Favorites</h1>
        {result && count > 0 && (
          <p className="mt-1 text-[13px] text-ink-400">
            {count.toLocaleString('en-US')} {count === 1 ? 'thing' : 'things'} you starred, of {kindsRead.length} {kindsRead.length === 1 ? 'kind' : 'kinds'}
          </p>
        )}
      </header>
      <ErrorNote error={table.error} />
      {!result || !shaped ? (
        !table.error && <Empty>Reading your favorites…</Empty>
      ) : count === 0 ? (
        <Empty>
          <span className="inline-flex items-center gap-1.5">
            Star things in the catalog with <Star aria-label="the star" className="size-3.5" /> and they gather here, first in every list of their kind.
          </span>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <QueryGrid result={result} shaped={shaped} view={view} kinds={kinds} formats={formats} hues={hues} sourceTitle={titleOf} fromWords={() => undefined} onView={setView} />
        </div>
      )}
    </div>
  )
}
