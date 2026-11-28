import { KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { TokenIssued } from '../../shared/api.ts'
import { useMyTokenActions, useMyTokens } from '../api.ts'
import { useEscape } from '../layers.ts'
import { ago, when } from '../format.ts'
import { Button, Empty, ErrorNote, input, Kicker, Panel } from './ui.tsx'

/**
 * A person's own API keys. Each is an agent of theirs, by the key's name
 * (ORY-2002): it sees what they see and may do what they may do, the activity
 * log says it asked, and it never decides a run. A key is shown once, when it
 * is made or rotated.
 *
 * A modal dialog: the page behind is inert, Escape closes it, and focus goes
 * back to what opened it.
 */
export function MyKeys({ onClose }: { onClose: () => void }) {
  const tokens = useMyTokens(true)
  const { issue, rotate, revoke } = useMyTokenActions()
  const [name, setName] = useState('')
  const [shown, setShown] = useState<TokenIssued | null>(null)
  const list = tokens.data?.tokens ?? []
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEscape(onClose, name.trim() !== '')
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    return () => opener?.focus()
  }, [])
  return (
    // A press on the backdrop lands on the dialog itself, outside its panel.
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={(e) => e.preventDefault()} onClick={(e) => e.target === e.currentTarget && onClose()} className="mx-auto mt-[10vh] w-full max-w-xl bg-transparent p-0 text-ink-100 backdrop:bg-ink-950/70">
      <Panel className="bg-ink-900">
        <div>
          <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
            <KeyRound className="size-4 text-ink-300" aria-hidden />
            <h2 id={titleId} className="font-semibold">Your API keys</h2>
            <span className="ml-auto" />
            <Button onClick={onClose}>Close</Button>
          </div>
          <p className="px-4 pt-3 text-sm text-ink-400">Give a key to your own agent or script, named for it. It calls the API for you: it sees only what you see, the activity log says it asked, and it never approves anything.</p>
          {shown && (
            <div className="mx-4 mt-3 rounded-sm border border-amber/50 bg-ink-850 p-3">
              <Kicker>Copy it now: it is shown once</Kicker>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 font-mono text-[12px] break-all text-ink-100">{shown.token}</code>
                <Button onClick={() => void navigator.clipboard.writeText(shown.token)}>Copy</Button>
              </div>
              <div className="mt-1 font-mono text-[10px] text-ink-500">Send it as Authorization: Bearer &lt;key&gt; to the API address.</div>
            </div>
          )}
          <form
            className="flex gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault()
              issue.mutate(name.trim(), { onSuccess: (made) => (setShown(made), setName('')) })
            }}
          >
            <input className={`${input} flex-1`} aria-label="What the key is for" placeholder="The agent it is for, such as agent-laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            <Button type="submit" kind="solid" disabled={issue.isPending || !name.trim()}>
              Create key
            </Button>
          </form>
          <ErrorNote error={tokens.error ?? issue.error ?? rotate.error ?? revoke.error} />
          <div className="border-t border-ink-800">
            {list.length === 0 && !tokens.isLoading && <Empty>You have no keys yet.</Empty>}
            {list.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b border-ink-800 px-4 py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{t.name}</div>
                  <div className="font-mono text-[10px] text-ink-500" title={when(t.createdAt)}>
                    made {ago(t.createdAt)} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : 'never used'}
                  </div>
                </div>
                <button type="button" className="rounded-sm p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" title="Rotate: make a new key and stop the old one at once" aria-label={`Rotate ${t.name}`} disabled={rotate.isPending} onClick={() => confirm(`Rotate "${t.name}"? The old key stops working now.`) && rotate.mutate(t.id, { onSuccess: setShown })}>
                  <RefreshCw className="size-3.5" />
                </button>
                <button type="button" className="rounded-sm p-1 text-ink-400 hover:bg-ink-700 hover:text-red" title="Delete: the key stops working now" aria-label={`Delete ${t.name}`} disabled={revoke.isPending} onClick={() => confirm(`Delete "${t.name}"? It stops working now.`) && revoke.mutate(t.id, { onSuccess: () => shown?.id === t.id && setShown(null) })}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </dialog>
  )
}
