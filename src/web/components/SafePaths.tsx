// The safe paths of a thing, on its own page: each way a change reached it
// without changing it in place, with when the watch last proved the path and
// when it last saw it do harm. Drawn only for a thing that has one the reader
// may see.

import { useId } from 'react'
import { SAFE_PATH_BLUEPRINT, SAFE_PATH_OF, type EntityDetail, type StatusLevel } from '../../shared/model.ts'
import { useEntities } from '../api.ts'
import { ago, exact } from '../format.ts'
import { Kicker, Lamp, Link, Panel } from './ui.tsx'

/** The most a page lists; a thing has a few. */
const MOST = 50

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export function SafePaths({ entity }: { entity: EntityDetail }) {
  const id = useId()
  const has = entity.incoming.some((end) => end.declaredOn === SAFE_PATH_BLUEPRINT)
  const params = new URLSearchParams({ limit: String(MOST), sort: 'path', fields: 'path,proven_at,failed_at,status', relations: '', filter: JSON.stringify({ relation: `${SAFE_PATH_OF}${entity.blueprint}`, target: entity.id }) })
  const list = useEntities(SAFE_PATH_BLUEPRINT, params, has)
  const paths = list.data?.entities ?? []
  if (!has || !paths.length) return null
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>
          <span id={id}>Safe paths</span>
        </Kicker>
      </div>
      <ul aria-labelledby={id} className="divide-y divide-ink-800">
        {paths.map((p) => {
          const proven = text(p.fields.proven_at)
          const failed = text(p.fields.failed_at)
          return (
            <li key={p.key} className="flex items-baseline gap-3 px-4 py-2 text-sm">
              <Lamp level={(text(p.fields.status) ?? 'grey') as StatusLevel} className="self-center" />
              <Link to={{ page: 'entity', blueprint: SAFE_PATH_BLUEPRINT, key: p.key }} className="font-mono text-[13px] text-ink-100 hover:underline">
                {text(p.fields.path) ?? p.key}
              </Link>
              <span className="text-[13px] text-ink-300" title={proven ? exact(proven) : undefined}>
                {proven ? `proven ${ago(proven)}` : 'never proven'}
              </span>
              {failed && (
                <span className="ml-auto text-[13px] text-amber" title={exact(failed)}>
                  did harm {ago(failed)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
