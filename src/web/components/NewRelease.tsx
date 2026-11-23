import { useNewRelease } from '../release.ts'

/** Says when the hub has moved to a new release, so this page's code is older than what serves it. */
export function NewRelease() {
  const newer = useNewRelease()
  if (!newer) return null
  return (
    <div role="status" className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5 text-sm text-ink-100 shadow-lg shadow-ink-950/60">
      <span className="min-w-0 flex-1">Orrery {newer} is ready.</span>
      <button type="button" className="btn btn-solid" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  )
}
