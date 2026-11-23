// Greets a person: the welcome tour on their first visit, and the notes on
// what is new the first time they open a new release. What they have seen
// is kept on the person (`welcomed` and `release` in
// src/shared/preferences.ts), so it holds in every browser. Both are shown
// only inside the `welcome` preview, and never while an admin views as
// someone: that view sets nothing of theirs.

import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { compareReleases } from '../../shared/preferences.ts'
import { RELEASE_NOTES_VIEWED, TOUR_FINISHED, TOUR_LEFT, TOUR_STARTED } from '../../shared/usage.ts'
import { usePreferences, usePreview, useSetPreference, useViewingAs, useWelcome, useWhoAmI } from '../api.ts'
import { BUILT } from '../release.ts'
import { track } from '../telemetry.ts'
import { laidOut, NOTES, unread, type ReleaseNote } from '../whats-new.ts'
import { Markdown } from './Markdown.tsx'
import { Overlay, Tour, type TourEnd } from './Tour.tsx'

/** The notes shown, and whether they are what is new to the reader or the whole list they asked for. */
type Shown = { what: 'tour' } | { what: 'notes'; notes: ReleaseNote[]; fresh: boolean }

/** What a person asked for from their account menu, so the greeting shows it whatever it would have shown by itself. */
let asked: Shown['what'] | null = null
const listeners = new Set<() => void>()
export function askFor(what: Shown['what']): void {
  asked = what
  for (const fn of listeners) fn()
}
const useAsked = () => useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => asked)

/** Whether this reader may be greeted: a person, inside the preview, as themselves. */
export function useGreets(): boolean {
  const me = useWhoAmI().data?.identity
  const open = usePreview('welcome')
  const viewing = useViewingAs()
  return open && !viewing && me?.kind === 'user' && me.name !== 'local'
}

/**
 * Tells the hub the time zone of this browser's clock when it is not the one
 * the hub holds for the person, so what speaks for them where no browser is
 * reads their day right. Only for a person, as themselves.
 */
export function useKeepTimeZone(): void {
  const me = useWhoAmI().data?.identity
  const viewing = useViewingAs()
  const mine = !viewing && me?.kind === 'user' && me.name !== 'local'
  const held = usePreferences(mine).data
  const { mutate } = useSetPreference()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const stale = mine && !!held && !!zone && held.timeZone !== zone
  useEffect(() => {
    if (stale) mutate({ name: 'timeZone', value: zone })
  }, [stale, zone, mutate])
}

export function Welcome() {
  const greets = useGreets()
  const prefs = usePreferences(greets)
  const tour = useWelcome(greets)
  const set = useSetPreference()
  const hub = useWhoAmI().data?.version
  const want = useAsked()
  const [shown, setShown] = useState<Shown | null>(null)
  // What a page shows by itself is decided once a load: a person who leaves the tour is not shown it again until they ask.
  const decided = useRef(false)
  // The notes this page holds are the ones it was built with, so they are what it marks as read.
  const release = BUILT || hub || null
  const held = prefs.data
  const steps = tour.data?.steps ?? []

  useEffect(() => {
    if (!greets || !held || !tour.data || !release) return
    if (want) {
      asked = null
      // Asked for from the menu: what is new to them, or every note when nothing is.
      const fresh = unread(held.release)
      setShown(want === 'tour' ? { what: 'tour' } : { what: 'notes', notes: fresh.length ? fresh : NOTES, fresh: fresh.length > 0 })
      if (want === 'tour') track(TOUR_STARTED, { version: String(tour.data.version), asked: 'true' })
      return
    }
    if (decided.current) return
    decided.current = true
    if (steps.length && held.welcomed < tour.data.version) {
      setShown({ what: 'tour' })
      track(TOUR_STARTED, { version: String(tour.data.version) })
      return
    }
    // A person who has seen no release starts from this one: the tour was their start.
    if (held.release === null) return set.mutate({ name: 'release', value: release })
    if (compareReleases(release, held.release) <= 0) return
    const notes = unread(held.release)
    if (!notes.length) return set.mutate({ name: 'release', value: release })
    setShown({ what: 'notes', notes, fresh: true })
  }, [greets, held, tour.data, release, want, steps.length, set])

  if (!shown || !held || !tour.data) return null
  if (shown.what === 'tour') {
    const version = tour.data.version
    const ended = async ({ how, at }: TourEnd) => {
      setShown(null)
      track(how === 'finished' ? TOUR_FINISHED : TOUR_LEFT, { version: String(version), ...(how === 'left' ? { step: at } : {}) })
      if (held.welcomed < version) await set.mutateAsync({ name: 'welcomed', value: version })
      if (held.release === null && release) await set.mutateAsync({ name: 'release', value: release })
    }
    return <Tour steps={steps} onEnd={(end) => void ended(end)} />
  }
  return (
    <Notes
      notes={shown.notes}
      fresh={shown.fresh}
      onClose={() => {
        setShown(null)
        if (release) {
          track(RELEASE_NOTES_VIEWED, { release })
          if (compareReleases(release, held.release) > 0) set.mutate({ name: 'release', value: release })
        }
      }}
    />
  )
}

/** The notes, newest first: the newest whole, and the rest as titles that open one at a time. */
function Notes({ notes, fresh, onClose }: { notes: ReleaseNote[]; fresh: boolean; onClose: () => void }) {
  const { open, folded } = laidOut(notes)
  return (
    <Overlay box={null} title="What’s new" onLeave={onClose}>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {folded.length > 0 && (
          <p className="text-[13px] text-ink-300">
            {fresh ? `${notes.length} changes since you were last here.` : `The last ${notes.length} changes.`} The newest come first.
          </p>
        )}
        {open.map((n) => (
          <section key={`${n.after}:${n.title}`}>
            <h3 className="text-sm font-semibold text-ink-100">{n.title}</h3>
            <Markdown text={n.text} className="mt-1" />
          </section>
        ))}
        {folded.length > 0 && (
          <section aria-labelledby="notes-earlier">
            <h3 id="notes-earlier" className="label mb-1.5">
              Earlier
            </h3>
            <div className="divide-y divide-ink-800 rounded-md border border-ink-700">
              {folded.map((n) => (
                <details key={`${n.after}:${n.title}`} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] text-ink-200 hover:bg-ink-800 [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-3.5 shrink-0 text-ink-400 transition-transform group-open:rotate-90" aria-hidden />
                    <span className="min-w-0 flex-1">{n.title}</span>
                  </summary>
                  <Markdown text={n.text} className="px-3 pb-3 pl-8" />
                </details>
              ))}
            </div>
          </section>
        )}
        {notes.length === 0 && <p className="text-sm text-ink-300">Nothing new yet.</p>}
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" data-first className="btn btn-solid" onClick={onClose}>
          Got it
        </button>
      </div>
    </Overlay>
  )
}
