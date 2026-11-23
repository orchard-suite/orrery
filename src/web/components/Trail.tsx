// The trail on screen: Back, the breadcrumb of the path that led to the page
// shown, and Recent, the whole trail in a list. Back goes up the path one
// place, as an app's back does, and stops where the path starts; the
// browser's own Back, a mouse's back button, and a swipe still walk every
// step. Every one of them moves along the browser's own history (`go` in
// `trail.ts`), so they never split from it or from each other.

import { ArrowLeft, ChevronRight, Ellipsis, History } from 'lucide-react'
import { useState } from 'react'
import { useBlueprintName } from '../api.ts'
import { parseRoute } from '../router.ts'
import { PAGE_ICON, stepName } from '../title.ts'
import { cameFrom, folded, go, listed, upFrom, useTrail, type Step, type Trail } from '../trail.ts'
import { MenuItem, Popover } from './Popover.tsx'

/** How many places before the shown one the breadcrumb names; the rest fold under its first item. */
const ROOM = 4

function useStepLabel(): (step: Step) => { label: string; page: ReturnType<typeof parseRoute>['page'] } {
  const name = useBlueprintName()
  return (step) => {
    const route = parseRoute(new URL(step.href, location.origin))
    return { label: stepName(route, name, step.name), page: route.page }
  }
}

/** Back up the path to the place before this one, or nothing to go back to where the path starts. */
function BackButton({ trail, size }: { trail: Trail; size: 'desk' | 'phone' }) {
  const labelOf = useStepLabel()
  const up = upFrom(trail)
  const to = up && labelOf(up.step).label
  return (
    <button type="button" className={`grid ${size === 'phone' ? 'size-9' : 'size-7'} shrink-0 place-items-center rounded-md text-ink-300 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-500 disabled:hover:bg-transparent`} disabled={!up} aria-label={to ? `Back to ${to}` : 'Back'} title={to ? `Back to ${to}` : 'This is where the path starts'} onClick={() => up && go(-up.back)}>
      <ArrowLeft className={size === 'phone' ? 'size-5' : 'size-4'} aria-hidden />
    </button>
  )
}

/** Every step of the trail, newest first, the one shown marked; a pick moves the browser there. */
export function RecentList({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const trail = useTrail()
  const labelOf = useStepLabel()
  const rows = listed(trail).map((i) => ({ step: trail.steps[i]!, i }))
  return (
    <Popover anchor={anchor} onClose={onClose} width={320} menu label="Recent" className="max-h-[60vh] overflow-y-auto py-1">
      {rows.map(({ step, i }) => {
        const { label, page } = labelOf(step)
        const Glyph = PAGE_ICON[page]
        const shown = i === trail.at
        return (
          <MenuItem key={step.id} active={shown} onClick={() => (onClose(), go(i - trail.at))}>
            <span className={`flex min-w-0 items-center gap-2 ${i > trail.at ? 'text-ink-400' : ''}`}>
              <Glyph className={`size-3.5 shrink-0 ${shown ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
              <span className="min-w-0 truncate" title={label}>{label}</span>
              {shown && <span className="ml-auto shrink-0 text-[12px] text-ink-400">here</span>}
              {i > trail.at && <span className="sr-only">, ahead</span>}
            </span>
          </MenuItem>
        )
      })}
    </Popover>
  )
}

/**
 * The strip at the top of a desk's page: Back up the path, Recent, and the
 * places of the path that led here, each a step back, ending at where you are.
 */
export function TrailBar() {
  const trail = useTrail()
  const labelOf = useStepLabel()
  const [list, setList] = useState<HTMLElement | null>(null)
  const shown = trail.steps[trail.at]
  if (!shown) return null
  const before = cameFrom(trail, ROOM)
  const more = folded(trail, ROOM)
  const here = labelOf(shown)
  const Here = PAGE_ICON[here.page]
  return (
    <nav aria-label="Trail" className="flex h-10 min-w-0 flex-1 items-center gap-1 text-[13px]">
      <BackButton trail={trail} size="desk" />
      <button type="button" className="grid size-7 shrink-0 place-items-center rounded-md text-ink-300 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-500 disabled:hover:bg-transparent" disabled={trail.steps.length < 2} aria-label="Recent" aria-haspopup="menu" aria-expanded={!!list} title="Recent: every page you opened in this tab" onClick={(e) => setList(e.currentTarget)}>
        <History className="size-4" aria-hidden />
      </button>
      <ol className="ml-1.5 flex min-w-0 items-center gap-0.5">
        {more > 0 && (
          <li className="flex shrink-0 items-center gap-0.5">
            <button type="button" className="grid h-6 place-items-center rounded-sm px-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label={`${more} earlier ${more === 1 ? 'place' : 'places'} on this path`} title={`Back to ${labelOf(cameFrom(trail, ROOM + more)[0]!.step).label}`} onClick={() => go(-cameFrom(trail, ROOM + more)[0]!.back)}>
              <Ellipsis className="size-4" aria-hidden />
            </button>
            <ChevronRight className="size-3.5 text-ink-500" aria-hidden />
          </li>
        )}
        {before.map(({ step, back }) => {
          const { label, page } = labelOf(step)
          const Glyph = PAGE_ICON[page]
          return (
            <li key={step.id} className="flex min-w-0 items-center gap-0.5">
              <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={`Back to ${label}`} onClick={() => go(-back)}>
                <Glyph className="size-3.5 shrink-0" aria-hidden />
                <span className="max-w-[16rem] truncate">{label}</span>
              </button>
              <ChevronRight className="size-3.5 shrink-0 text-ink-500" aria-hidden />
            </li>
          )
        })}
        <li className="flex min-w-0 items-center gap-1.5 px-1 text-ink-200" aria-current="page">
          <Here className="size-3.5 shrink-0 text-orbit" aria-hidden />
          <span className="max-w-[24rem] truncate" title={here.label}>{here.label}</span>
        </li>
      </ol>
      {list && <RecentList anchor={list} onClose={() => setList(null)} />}
    </nav>
  )
}

/** Back on a phone's top bar, shown only while the path has a place to go back to. Recent is under More. */
export function PhoneBack() {
  const trail = useTrail()
  if (!upFrom(trail)) return null
  return <BackButton trail={trail} size="phone" />
}
