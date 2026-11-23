import { SOURCE_BLUEPRINT } from '../../shared/model.ts'
import { useSeesBlueprint, useWall } from '../api.ts'
import { ago, humanTimes } from '../format.ts'
import { Empty, Kicker, Lamp, Link, LEVEL_TEXT, Panel } from './ui.tsx'

/** The all-green view: every entity of a blueprint shown on the wall, and every source, reduced to one colour. */
export function Wall() {
  const wall = useWall()
  const seesSources = useSeesBlueprint(SOURCE_BLUEPRINT)
  if (wall.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  if (!wall.data) return <Empty>Could not load the wall.</Empty>
  const groups = wall.data.groups
  const all = groups.flatMap((g) => g.cells)
  const worst = all.some((c) => c.level === 'red') ? 'red' : all.some((c) => c.level === 'amber') ? 'amber' : all.some((c) => c.level === 'grey') ? 'grey' : 'green'
  return (
    <div className="space-y-8 py-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Lamp level={worst} size="lg" />
        <h1 className="page-title">{worst === 'green' ? 'All green' : worst === 'red' ? 'Something is down' : worst === 'amber' ? 'Look at this' : 'Some of it is unknown'}</h1>
        <span className="text-[13px] text-ink-400">
          {all.length} things · {all.filter((c) => c.level !== 'green').length} not green
        </span>
      </div>
      {all.length === 0 && <Empty>Nothing on the wall yet. Turn on the wall for a blueprint in the Model, and every entity of it shows here as one colour.</Empty>}
      {groups.map((g) => (
        <section key={g.blueprint}>
          <Kicker className="mb-3">
            <Link to={{ page: 'inventory', blueprint: g.blueprint }}>{g.title}</Link> · {g.cells.length}
          </Kicker>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {g.cells.map((c) => (
              <Link key={c.entity.key} to={{ page: 'entity', ...c.entity }} title={humanTimes(c.reasons.join('\n'))} className="group rounded-md border border-ink-700 bg-ink-900/70 px-3 py-2.5 transition-colors hover:border-ink-500">
                <div className="flex items-center gap-2">
                  <Lamp level={c.level} />
                  <span className="truncate text-sm">{c.title}</span>
                </div>
                {c.reasons[0] && <div className={`mt-1 truncate text-[12px] ${LEVEL_TEXT[c.level]}`}>{humanTimes(c.reasons[0])}</div>}
              </Link>
            ))}
          </div>
        </section>
      ))}
      {seesSources && (
        <section>
          <Kicker className="mb-3">Sources · {wall.data.sources.length}</Kicker>
          <Panel className="divide-y divide-ink-800">
            {wall.data.sources.map((s) => (
              <Link key={s.id} to={{ page: 'entity', blueprint: SOURCE_BLUEPRINT, key: s.id }} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-ink-850">
                <Lamp level={s.status} />
                <span className="w-28 truncate text-[13px] sm:w-40" title={s.id}>{s.title || s.id}</span>
                <span className="hidden w-16 text-[12px] text-ink-400 sm:inline">{s.class}</span>
                <span className="flex-1 truncate text-ink-300">{s.statusReason ?? (s.cadence ? `every ${s.cadence}` : '')}</span>
                <span className="text-[12px] text-ink-400">{s.lastRunAt ? `ran ${ago(s.lastRunAt)}` : s.lastSeenAt ? `seen ${ago(s.lastSeenAt)}` : ''}</span>
              </Link>
            ))}
          </Panel>
        </section>
      )}
    </div>
  )
}
