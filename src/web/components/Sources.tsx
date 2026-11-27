import { KeyRound, LockKeyhole, Plus } from 'lucide-react'
import { useState } from 'react'
import type { TokenIssued, TokenSummary } from '../../shared/api.ts'
import { ACTS_FOR, SOURCE_BLUEPRINT, SOURCE_CLASSES, TOOL_TIERS, parseEntityId, type Filter, type Run, type RunnerServes, type Source, type ToolTier } from '../../shared/model.ts'
import { useCan, useIsAdmin, useDeleteSecret, useDeleteSource, useIssueToken, useRefreshSource, useRevokeToken, useRoles, useSaveSource, useSecrets, useSeesBlueprint, useSetSecret, useSource, useSources, useTokens } from '../api.ts'
import { ago, when } from '../format.ts'
import { navigate } from '../router.ts'
import { Badge, Button, CopyButton, Empty, ErrorNote, input, Kicker, Lamp, Link, Panel } from './ui.tsx'
import { Drawer } from './Drawer.tsx'
import { useChanged } from '../layers.ts'
import { keysOf, looseKeys, needsKey, ownedByHub, shelves } from '../sources.ts'
import { useHere, useVisit } from '../trail.ts'

/** The source a key is for, by what the drawer says of it. */
type KeyFor = Pick<Source, 'id' | 'title' | 'class'>

type Issuing = { kind: 'source'; source: KeyFor } | { kind: 'access' }

/**
 * Sources and the keys that sign in to the hub. A source's own keys are on its page, made
 * there; the keys no source holds (access and personal keys) and the check secrets are each
 * a shelf in the list. Every key is made in a drawer that shows its secret where it was made.
 */
export function Sources({ id, shelf }: { id: string | null; shelf: 'access' | 'secrets' | null }) {
  const canSources = useCan('sources.manage')
  const canTokens = useCan('tokens.manage')
  const canSecrets = useCan('secrets.manage')
  const sources = useSources()
  const tokens = useTokens(canTokens).data?.tokens ?? []
  const secrets = useSecrets(canSecrets).data?.secrets
  const list = sources.data?.sources ?? []
  const current = list.find((s) => s.id === id)
  const [q, setQ] = useVisit('sources.q', '')
  const [registering, setRegistering] = useState(false)
  const [issuing, setIssuing] = useState<Issuing | null>(null)
  const { groups, loose } = shelves(list, tokens, q)
  const picked = current || shelf
  const row = (on: boolean) => `flex items-center gap-2 rounded-md px-2 py-2.5 text-sm md:py-1.5 ${on ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'}`
  return (
    // Where the window cannot hold both, the list gives way to what is picked; Back leads to it again.
    <div className="flex flex-col gap-6 py-6 lg:flex-row">
      {!picked && <h1 className="sr-only">Sources</h1>}
      <aside aria-label="Sources and keys" className={`shrink-0 space-y-3 lg:block lg:w-72 ${picked ? 'hidden' : ''}`}>
        <div className="flex items-center gap-2">
          <Kicker>Sources · {q ? `${groups.reduce((n, g) => n + g.sources.length, 0)} of ${list.length}` : list.length}</Kicker>
          {canSources && (
            <Button className="ml-auto" opens="dialog" onClick={() => setRegistering(true)}>
              <Plus aria-hidden className="size-3.5" /> Register
            </Button>
          )}
        </div>
        <input type="search" className={`${input} w-full`} aria-label="Find a source or a key" placeholder="Find a source or a key" value={q} onChange={(e) => setQ(e.target.value)} />
        {(canTokens || canSecrets) && (
          <nav aria-label="Keys no source holds" className="space-y-px">
            {canTokens && (!q || loose > 0) && (
              <Link to={{ page: 'sources', id: null, shelf: 'access' }} current={shelf === 'access'} className={row(shelf === 'access')}>
                <KeyRound aria-hidden className="size-3.5 text-ink-400" />
                Access keys
                <span className="ml-auto font-mono text-[12px] text-ink-500">{loose}</span>
              </Link>
            )}
            {canSecrets && !q && (
              <Link to={{ page: 'sources', id: null, shelf: 'secrets' }} current={shelf === 'secrets'} className={row(shelf === 'secrets')}>
                <LockKeyhole aria-hidden className="size-3.5 text-ink-400" />
                Check secrets
                {secrets && <span className="ml-auto font-mono text-[12px] text-ink-500">{secrets.length}</span>}
              </Link>
            )}
          </nav>
        )}
        {groups.map((g) => (
          <nav key={g.class} aria-label={`${g.class} sources`} className="space-y-px">
            <Kicker className="px-2 pt-2">
              {g.class} · {g.sources.length}
            </Kicker>
            {g.sources.map(({ source: s, keys, found }) => (
              <Link key={s.id} to={{ page: 'sources', id: s.id }} current={current?.id === s.id} className={row(current?.id === s.id)} title={s.id}>
                <Lamp level={s.status} size="sm" />
                <span className="min-w-0">
                  <span className="wrap-anywhere">{s.title || s.id}</span>
                  {found && <span className="block font-mono text-[12px] wrap-anywhere text-ink-400">key {found}</span>}
                </span>
                {canTokens && !ownedByHub(s) && <span className={`ml-auto shrink-0 font-mono text-[12px] ${keys || !needsKey(s) ? 'text-ink-500' : 'text-amber'}`}>{keys === 1 ? '1 key' : `${keys} keys`}</span>}
              </Link>
            ))}
          </nav>
        ))}
        {q && groups.length === 0 && <p className="px-2 text-sm text-ink-400">No source or key holds "{q}".</p>}
      </aside>
      <div className="min-w-0 flex-1 space-y-6">
        {current && <SourceDetail source={current} keys={keysOf(tokens, current.id)} onIssue={() => setIssuing({ kind: 'source', source: current })} />}
        {!current && shelf === 'access' && canTokens && <AccessKeys tokens={looseKeys(tokens)} onIssue={() => setIssuing({ kind: 'access' })} />}
        {!current && shelf === 'secrets' && canSecrets && <Secrets />}
        {!picked && <Empty>Pick a source to see its runs and its keys. Pushers and runners sign in with a source key; agents and scripts with an access key, bound to a role.</Empty>}
      </div>
      {registering && (
        <SourceForm
          onDone={(saved) => {
            setRegistering(false)
            if (!saved) return
            navigate({ page: 'sources', id: saved.id })
            // A new source can do nothing until it has a key: make one next.
            if (canTokens && !ownedByHub(saved)) setIssuing({ kind: 'source', source: saved })
          }}
        />
      )}
      {issuing && <IssueKey issuing={issuing} onClose={() => setIssuing(null)} />}
    </div>
  )
}

function SourceDetail({ source, keys, onIssue }: { source: Source; keys: TokenSummary[]; onIssue: () => void }) {
  const detail = useSource(source.id)
  const refresh = useRefreshSource()
  const remove = useDeleteSource()
  const canManage = useCan('sources.manage')
  const canRefresh = useCan('sources.refresh')
  const canTokens = useCan('tokens.manage')
  const seesSources = useSeesBlueprint(SOURCE_BLUEPRINT)
  const [editing, setEditing] = useState(false)
  const s = detail.data?.source ?? source
  useHere(s.title || s.id)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <Lamp level={s.status} size="lg" className="mt-2" />
        <div className="min-w-0 flex-1 basis-64">
          <Kicker>
            <span className="font-mono normal-case tracking-normal">{s.id}</span> · {s.class}
          </Kicker>
          <h1 className="mt-1 page-title">{s.title}</h1>
          <div className="mt-1 font-mono text-[12px] text-ink-400">
            {s.statusReason ?? 'healthy'} · last run {ago(s.lastRunAt)} · seen {ago(s.lastSeenAt)}
            {s.cadence ? ` · expected every ${s.cadence}` : ''}
          </div>
          {s.description && <p className="mt-2 max-w-3xl text-sm text-ink-300">{s.description}</p>}
        </div>
        <div className="flex gap-2">
          {seesSources && (
            <Link to={{ page: 'entity', blueprint: SOURCE_BLUEPRINT, key: s.id }} className="btn btn-ghost">
              Entity
            </Link>
          )}
          {s.class === 'git' && canRefresh && (
            <Button onClick={() => refresh.mutate(s.id)} disabled={refresh.isPending}>
              {refresh.isPending ? 'Pulling…' : 'Refresh now'}
            </Button>
          )}
          {canManage && !ownedByHub(s) && <Button opens="dialog" onClick={() => setEditing(true)}>Edit</Button>}
          {canManage && !ownedByHub(s) && (
            <Button kind="danger" onClick={() => confirm(`Remove source ${s.id}?`) && remove.mutate(s.id, { onSuccess: () => navigate({ page: 'sources', id: null }) })}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={refresh.error ?? remove.error} />
      {refresh.data && refresh.data.errors.length > 0 && (
        <Panel className="px-4 py-2 text-[12px] text-amber">
          {refresh.data.errors.map((e, i) => (
            <div key={i}>
              {e.file}: {e.reason}
            </div>
          ))}
        </Panel>
      )}
      {editing && <SourceForm existing={s} onDone={() => setEditing(false)} />}
      {canTokens && !ownedByHub(s) && <SourceKeys keys={keys} needed={needsKey(s)} onIssue={onIssue} />}
      <Panel className="flex flex-wrap gap-x-8 gap-y-1 px-4 py-3 font-mono text-[12px] text-ink-300">
        <div>
          <span className="text-ink-500">writes </span>
          {s.blueprints.includes('*') ? 'every blueprint' : s.blueprints.join(', ')}
        </div>
        <div>
          <span className="text-ink-500">may delete </span>
          {s.deleteGrant.includes('*') ? 'every blueprint' : s.deleteGrant.length ? s.deleteGrant.join(', ') : 'nothing'}
        </div>
        {s.history && (
          <div>
            <span className="text-ink-500">keeps alerts in </span>
            {s.history.blueprint}
            {s.history.relation ? ` · ${s.history.relation}` : ''}
          </div>
        )}
        <div>
          <span className="text-ink-500">grace </span>
          {s.grace ? `${s.grace.runs ?? 2} runs, ${s.grace.duration ?? '24h'}` : 'blueprint default'}
        </div>
        <div className="min-w-0 wrap-anywhere">
          <span className="text-ink-500">acts for </span>
          {s.actsFor ? <ActsFor reference={s.actsFor} /> : 'nothing'}
        </div>
        <div>
          <span className="text-ink-500">defines actions </span>
          {s.actions ? 'yes' : 'no'}
        </div>
        <div>
          <span className="text-ink-500">puts scorecards </span>
          {s.scorecards ? 'yes' : 'no'}
        </div>
        <div>
          <span className="text-ink-500">posts the watch's verdicts </span>
          {/* A hub one release back sends no such grant. */}
          {s.watches ? 'yes' : 'no'}
        </div>
        {s.class === 'runner' && (
          <div className="min-w-0 wrap-anywhere" title={servesText(s.serves)}>
            <span className="text-ink-500">serves tools </span>
            {servesText(s.serves)}
          </div>
        )}
        {s.git && (
          <div className="min-w-0 wrap-anywhere">
            <span className="text-ink-500">git </span>
            {s.git.url} @ {s.git.branch} · {s.git.glob} {s.git.hasToken ? '· token set' : ''}
          </div>
        )}
      </Panel>
      <Written source={s} />
      <Panel>
        <div className="border-b border-ink-800 px-4 py-2">
          <Kicker>Runs</Kicker>
        </div>
        {(detail.data?.runs ?? []).length === 0 && <div className="px-4 py-3 text-sm text-ink-400">No runs yet.</div>}
        {detail.data?.runs.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </Panel>
    </div>
  )
}

/** The entity a source acts for, linked when it reads as one. */
function ActsFor({ reference }: { reference: string }) {
  const ref = parseEntityId(reference)
  return ref ? (
    <Link to={{ page: 'entity', blueprint: ref.blueprint, key: ref.key }} className="hover:underline">
      {reference}
    </Link>
  ) : (
    <>{reference}</>
  )
}

/** What the hub has seen the source write: entities by blueprint, the blueprints it offered, the actions and scorecards it put. */
function Written({ source }: { source: Source }) {
  // A hub one release back keeps no scorecards in the ledger.
  const { entities, blueprints, actions, scorecards = [] } = source.writes
  const rows: { what: string; target: string; count?: number; lastAt: string }[] = [
    ...entities.map((e) => ({ what: 'entities', target: e.blueprint, count: e.count, lastAt: e.lastAt })),
    ...blueprints.map((b) => ({ what: 'blueprint offered', target: b.id, lastAt: b.lastAt })),
    ...actions.map((a) => ({ what: 'action put', target: a.id, lastAt: a.lastAt })),
    ...scorecards.map((a) => ({ what: 'scorecard put', target: a.id, lastAt: a.lastAt })),
  ]
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Written</Kicker>
      </div>
      {rows.length === 0 && <div className="px-4 py-3 text-sm text-ink-400">Nothing written yet.</div>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.what}:${r.target}`} className="border-b border-ink-800 last:border-0">
                  <td className="px-4 py-1.5 text-[12px] text-ink-400">{r.what}</td>
                  <td className="px-2 py-1.5 font-mono text-[12px] text-ink-200">{r.target}</td>
                  <td className="px-2 py-1.5 font-mono text-[12px] text-ink-400">{r.count === undefined ? '' : `${r.count} writes`}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-[12px] text-ink-500" title={r.lastAt}>
                    {ago(r.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false)
  const c = run.counts
  return (
    <div className="border-b border-ink-800 last:border-0">
      <button type="button" aria-expanded={open} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm hover:bg-ink-850" onClick={() => setOpen(!open)}>
        <Badge className={run.state === 'committed' ? 'border-green/50 text-green' : run.state === 'open' ? 'border-ink-600 text-ink-300' : 'border-red-dim text-red'}>{run.state}</Badge>
        <span className="font-mono text-[12px] text-ink-300">{run.mode}</span>
        <span className="font-mono text-[12px]">{run.scope}</span>
        {run.massDrop && <Badge className="border-amber/60 text-amber">mass drop</Badge>}
        <span className="ml-auto font-mono text-[12px] text-ink-400">
          {c.received} in · {c.created} new · {c.updated} changed · {c.unchanged} same · {c.rejected} rejected · {c.missing} missing · {c.deleted} deleted
        </span>
        <span className="font-mono text-[10px] text-ink-500" title={run.startedAt}>
          {when(run.startedAt)}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 font-mono text-[12px] text-ink-400">
          <div>{run.id}</div>
          {run.errors.map((e, i) => (
            <div key={i} className="text-amber">
              {e.blueprint}:{e.key}
              {e.field ? `.${e.field}` : ''}: {e.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** What a runner lends itself to, in a line: the tiers, who may put a tool on it, and where a tool may be declared. */
export function servesText(serves: RunnerServes | undefined): string {
  if (!serves) return 'none'
  const from = serves.sources?.length ? ` · put by ${serves.sources.join(', ')}` : ''
  const on = serves.on ? ` · declared from a ${serves.on.blueprint}${serves.on.where ? ' that matches its filter' : ''}` : ''
  return `${serves.tiers.join(', ')}${from}${on}`
}

/** A runner's tool rule as its form holds it. */
export interface ServesForm {
  tiers: ToolTier[]
  sources: string
  blueprint: string
  where: string
}

/**
 * The rule a form's values make, or null for a runner that serves no tools.
 * Throws when the filter is not JSON, or is given with no blueprint to apply it to.
 */
export function servesOf(f: ServesForm): RunnerServes | null {
  if (!f.tiers.length) return null
  const sources = f.sources.split(',').map((x) => x.trim()).filter(Boolean)
  const blueprint = f.blueprint.trim()
  let where: Filter | undefined
  if (f.where.trim()) {
    if (!blueprint) throw new Error('A filter needs the blueprint it reads')
    try {
      where = JSON.parse(f.where) as Filter
    } catch {
      throw new Error('The filter is not JSON, such as {"relation": "program", "target": "program:shop"}')
    }
  }
  return { tiers: TOOL_TIERS.filter((t) => f.tiers.includes(t)), ...(sources.length ? { sources } : {}), ...(blueprint ? { on: { blueprint, ...(where ? { where } : {}) } } : {}) }
}

/** Registers a source, or changes one, in a drawer. `onDone` hears what was saved, or nothing when it was let go. */
function SourceForm({ existing, onDone }: { existing?: Source; onDone: (saved?: KeyFor) => void }) {
  const save = useSaveSource()
  const admin = useIsAdmin()
  const [actions, setActions] = useState(existing?.actions ?? false)
  const [scorecards, setScorecards] = useState(existing?.scorecards ?? false)
  const [watches, setWatches] = useState(existing?.watches ?? false)
  const [serves, setServes] = useState<ServesForm>({ tiers: existing?.serves?.tiers ?? [], sources: existing?.serves?.sources?.join(', ') ?? '', blueprint: existing?.serves?.on?.blueprint ?? '', where: existing?.serves?.on?.where ? JSON.stringify(existing.serves.on.where) : '' })
  const [wrong, setWrong] = useState<Error | null>(null)
  const [f, setF] = useState({
    actsFor: existing?.actsFor ?? '',
    id: existing?.id ?? '',
    title: existing?.title ?? '',
    class: existing?.class ?? 'pusher',
    description: existing?.description ?? '',
    blueprints: existing?.blueprints.join(', ') ?? '*',
    deleteGrant: existing?.deleteGrant.join(', ') ?? '',
    cadence: existing?.cadence ?? '',
    graceRuns: existing?.grace?.runs?.toString() ?? '',
    graceDuration: existing?.grace?.duration ?? '',
    historyBlueprint: existing?.history?.blueprint ?? '',
    historyRelation: existing?.history?.relation ?? '',
    gitUrl: existing?.git?.url ?? '',
    gitBranch: existing?.git?.branch ?? 'main',
    gitGlob: existing?.git?.glob ?? 'catalog/**/*.yaml',
    gitAuth: existing?.git?.auth?.type ?? 'token',
    gitAppId: existing?.git?.auth?.type === 'github-app' ? existing.git.auth.appId : '',
    gitInstallationId: existing?.git?.auth?.type === 'github-app' ? existing.git.auth.installationId : '',
    gitToken: '',
  })
  const changed = useChanged([f, serves, actions, scorecards, watches])
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="block">
      <Kicker>{label}</Kicker>
      <div className="mt-1">{node}</div>
      {hint && <div className="mt-0.5 text-[12px] text-ink-500">{hint}</div>}
    </label>
  )
  return (
    <Drawer title={existing ? `Edit ${existing.title || existing.id}` : 'Register a source'} subtitle={existing ? <span className="font-mono text-[12px]">{existing.id}</span> : 'Then give it a key to sign in with.'} onClose={() => onDone()} unsaved={changed} width={680}>
      <form
        className="grid gap-3 px-5 py-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          let lends: RunnerServes | null = null
          try {
            lends = f.class === 'runner' ? servesOf(serves) : null
            setWrong(null)
          } catch (err) {
            setWrong(err as Error)
            return
          }
          const spec: Record<string, unknown> = {
            title: f.title || f.id,
            class: f.class,
            description: f.description || undefined,
            blueprints: csv(f.blueprints).length ? csv(f.blueprints) : ['*'],
            deleteGrant: csv(f.deleteGrant),
            cadence: f.cadence || null,
            grace: f.graceRuns || f.graceDuration ? { runs: f.graceRuns ? Number(f.graceRuns) : undefined, duration: f.graceDuration || undefined } : undefined,
            history: f.class === 'event' && f.historyBlueprint ? { blueprint: f.historyBlueprint.trim(), relation: f.historyRelation.trim() || undefined } : undefined,
            git: f.class === 'git' ? { url: f.gitUrl, branch: f.gitBranch, glob: f.gitGlob, auth: f.gitAuth === 'github-app' ? { type: 'github-app', appId: f.gitAppId, installationId: f.gitInstallationId } : { type: 'token' } } : undefined,
            gitToken: f.gitToken || undefined,
            // Only an admin sets these; anyone else's save leaves them as they are.
            ...(admin ? { actsFor: f.actsFor.trim() || null, actions, scorecards, watches, serves: lends } : {}),
          }
          save.mutate({ id: f.id.trim(), spec }, { onSuccess: () => onDone({ id: f.id.trim(), title: f.title || f.id.trim(), class: f.class }) })
        }}
      >
        {field('Id', <input className={`${input} w-full font-mono`} value={f.id} onChange={set('id')} disabled={!!existing} placeholder="k8s@home" required />, 'Stable writer identity. Instances, not job types: one per cluster.')}
        {field('Title', <input className={`${input} w-full`} value={f.title} onChange={set('title')} />)}
        {field(
          'Class',
          <select className={input} value={f.class} onChange={set('class')}>
            {SOURCE_CLASSES.filter((c) => c !== 'ui' && c !== 'hub').map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>,
        )}
        {field('Cadence', <input className={`${input} w-full font-mono`} value={f.cadence} onChange={set('cadence')} placeholder="3m, 26h" />, 'Stale after twice this. Leave empty for on-demand sources.')}
        {field('Blueprints it may write', <input className={`${input} w-full font-mono`} value={f.blueprints} onChange={set('blueprints')} placeholder="* or k8s_workload, k8s_pod" />)}
        {field('Blueprints it may delete', <input className={`${input} w-full font-mono`} value={f.deleteGrant} onChange={set('deleteGrant')} placeholder="empty for none, * for all" />, 'Explicit deletes take effect at once and block re-creation for an hour.')}
        {field('Grace runs', <input className={`${input} w-full font-mono`} value={f.graceRuns} onChange={set('graceRuns')} placeholder="blueprint default" />, 'Committed snapshots an entity must be absent from before it is deleted.')}
        {field('Grace duration', <input className={`${input} w-full font-mono`} value={f.graceDuration} onChange={set('graceDuration')} placeholder="24h, 0" />)}
        {f.class === 'event' && (
          <>
            {field('Keep alerts in', <input className={`${input} w-full font-mono`} value={f.historyBlueprint} onChange={set('historyBlueprint')} placeholder="incident" />, 'A blueprint every alert is also written to, so it outlives the alert. The source must be allowed to write it. Leave empty to keep only firing alerts.')}
            {field('Linked through', <input className={`${input} w-full font-mono`} value={f.historyRelation} onChange={set('historyRelation')} placeholder="service" />, "The relation on that blueprint that points at the entity the alert matched.")}
          </>
        )}
        {admin && (
          <>
            {field(
              'Acts for',
              <input className={`${input} w-full font-mono`} value={f.actsFor} onChange={set('actsFor')} placeholder="service:shop" pattern={ACTS_FOR.source} title="An entity reference: blueprint:key" />,
              'The entity this source speaks for, such as the service whose token it is. Leave empty for none.',
            )}
            <label className="flex items-center gap-2 self-end pb-1 text-sm">
              <input type="checkbox" checked={actions} onChange={(e) => setActions(e.target.checked)} />
              May define self-service actions with its token
            </label>
            <label className="flex items-center gap-2 self-end pb-1 text-sm">
              <input type="checkbox" checked={scorecards} onChange={(e) => setScorecards(e.target.checked)} />
              May put its own scorecards with its token
            </label>
            <label className="flex items-center gap-2 self-end pb-1 text-sm">
              <input type="checkbox" checked={watches} onChange={(e) => setWatches(e.target.checked)} />
              May post the watch's verdicts on changes this hub stated
            </label>
          </>
        )}
        {admin && f.class === 'runner' && (
          <fieldset className="space-y-3 rounded-md border border-ink-800 px-3 py-3 sm:col-span-2">
            <legend className="px-1">
              <Kicker>Tools it serves</Kicker>
            </legend>
            <p className="text-[12px] text-ink-400">A tool's command runs with everything this runner holds. Tick the tiers a tool on it may have; with none ticked it serves no tools.</p>
            <div className="flex flex-wrap gap-4 text-sm">
              {TOOL_TIERS.map((t) => (
                <label key={t} className="flex items-center gap-2">
                  <input type="checkbox" checked={serves.tiers.includes(t)} onChange={(e) => setServes({ ...serves, tiers: e.target.checked ? [...serves.tiers, t] : serves.tiers.filter((x) => x !== t) })} />
                  {t}
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {field('Sources that may put a tool on it', <input className={`${input} w-full font-mono`} value={serves.sources} onChange={(e) => setServes({ ...serves, sources: e.target.value })} placeholder="empty: only an admin and git" />, 'Each needs the grant to define actions too.')}
              {field('Tools declared from a', <input className={`${input} w-full font-mono`} value={serves.blueprint} onChange={(e) => setServes({ ...serves, blueprint: e.target.value })} placeholder="repository" />, 'The blueprint a tool must say it was declared from. Empty lets it serve tools of no entity.')}
              <div className="sm:col-span-2">{field('That matches', <input className={`${input} w-full font-mono`} value={serves.where} onChange={(e) => setServes({ ...serves, where: e.target.value })} placeholder='{"relation": "program", "target": "program:shop"}' />, 'A filter, as JSON, the declaring entity must match. Empty takes every entity of the blueprint.')}</div>
            </div>
          </fieldset>
        )}
        <div className="sm:col-span-2">{field('Description', <textarea className={`${input} w-full`} value={f.description} onChange={set('description')} rows={2} />)}</div>
        {f.class === 'git' && (
          <>
            {field('Repo URL', <input className={`${input} w-full font-mono`} value={f.gitUrl} onChange={set('gitUrl')} placeholder="https://github.com/org/estate-catalog.git" required />)}
            {field('Branch', <input className={`${input} w-full font-mono`} value={f.gitBranch} onChange={set('gitBranch')} required />)}
            {field('Path glob', <input className={`${input} w-full font-mono`} value={f.gitGlob} onChange={set('gitGlob')} required />)}
            {field(
              'Auth',
              <select className={input} value={f.gitAuth} onChange={set('gitAuth')}>
                <option value="token">static token</option>
                <option value="github-app">GitHub App</option>
              </select>,
              'A GitHub App mints a short-lived installation token on every pull; nothing long-lived is stored but the private key.',
            )}
            {f.gitAuth === 'github-app' && field('App id', <input className={`${input} w-full font-mono`} value={f.gitAppId} onChange={set('gitAppId')} required />)}
            {f.gitAuth === 'github-app' && field('Installation id', <input className={`${input} w-full font-mono`} value={f.gitInstallationId} onChange={set('gitInstallationId')} required />)}
            {f.gitAuth === 'github-app'
              ? field('Private key (PEM)', <textarea className={`${input} w-full font-mono text-[12px]`} rows={4} value={f.gitToken} onChange={set('gitToken')} placeholder={existing?.git?.hasToken ? 'unchanged' : '-----BEGIN RSA PRIVATE KEY-----'} />, 'Stored encrypted. Never shown again.')
              : field('Token', <input className={`${input} w-full font-mono`} type="password" value={f.gitToken} onChange={set('gitToken')} placeholder={existing?.git?.hasToken ? 'unchanged' : 'optional, for private repos'} />, 'Stored encrypted. Never shown again.')}
          </>
        )}
        <div className="sticky bottom-0 -mx-5 -mb-4 flex flex-wrap items-center gap-2 border-t border-ink-700 bg-ink-900 px-5 py-3 sm:col-span-2">
          <Button type="submit" kind="solid" disabled={save.isPending}>
            {existing ? 'Save' : 'Register'}
          </Button>
          <Button onClick={() => onDone()}>Cancel</Button>
          <ErrorNote error={wrong ?? save.error} />
        </div>
      </form>
    </Drawer>
  )
}

/** One key: its name, when it was made and last used, and the one thing done to it here. */
function KeyRow({ token, children }: { token: TokenSummary; children?: React.ReactNode }) {
  const revoke = useRevokeToken()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-sm wrap-anywhere text-ink-100">{token.name}</div>
        <div className="font-mono text-[12px] text-ink-500">
          {children}
          <span title={when(token.createdAt)}>made {ago(token.createdAt)}</span> · {token.lastUsedAt ? <span title={when(token.lastUsedAt)}>used {ago(token.lastUsedAt)}</span> : <span className="text-amber">never used</span>}
        </div>
      </div>
      <ErrorNote error={revoke.error} />
      <Button kind="danger" disabled={revoke.isPending} onClick={() => confirm(`Revoke ${token.name}? It stops working now.`) && revoke.mutate(token.id)}>
        Revoke
      </Button>
    </li>
  )
}

/** A panel's head: what it holds, and the one button that adds to it. */
function ShelfHead({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 px-4 py-2.5">
      <div className="min-w-0 flex-1 basis-48">
        <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
        {children && <p className="text-[12px] text-ink-400">{children}</p>}
      </div>
      {action}
    </div>
  )
}

/** The keys a source signs in with, and the button that makes one. */
function SourceKeys({ keys, needed, onIssue }: { keys: TokenSummary[]; needed: boolean; onIssue: () => void }) {
  return (
    <Panel>
      <ShelfHead
        title={`Keys · ${keys.length}`}
        action={
          <Button kind="solid" opens="dialog" onClick={onIssue}>
            <Plus aria-hidden className="size-3.5" /> New key
          </Button>
        }
      >
        A key writes as this source on the ingest host.
      </ShelfHead>
      {keys.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-400">{needed ? 'No key yet: it cannot sign in until it has one.' : 'No key. The hub pulls it; a key only lets a pipeline ask for a pull.'}</p>
      ) : (
        <ul>
          {keys.map((t) => (
            <KeyRow key={t.id} token={t} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** The keys no source holds: access keys by the role they are bound to, then the personal keys people made for themselves. */
function AccessKeys({ tokens, onIssue }: { tokens: TokenSummary[]; onIssue: () => void }) {
  useHere('Access keys')
  const roles = useRoles().data?.roles ?? []
  const access = tokens.filter((t) => t.kind === 'access')
  const personal = tokens.filter((t) => t.kind === 'personal')
  const bound = [...new Set(access.map((t) => t.role ?? ''))].sort((a, b) => a.localeCompare(b))
  const titleOf = (role: string) => roles.find((r) => r.id === role)?.title ?? role
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="page-title">Access keys</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-300">An agent or a script calls the API as a machine with one. It may do what its role allows.</p>
        </div>
        <Button kind="solid" opens="dialog" onClick={onIssue}>
          <Plus aria-hidden className="size-3.5" /> New access key
        </Button>
      </div>
      {access.length === 0 && <Empty>No access keys yet.</Empty>}
      {bound.map((role) => {
        const keys = access.filter((t) => (t.role ?? '') === role).sort((a, b) => a.name.localeCompare(b.name))
        return (
          <Panel key={role}>
            <ShelfHead title={`${titleOf(role)} · ${keys.length}`}>
              <span className="font-mono">{role}</span>
            </ShelfHead>
            <ul>
              {keys.map((t) => (
                <KeyRow key={t.id} token={t} />
              ))}
            </ul>
          </Panel>
        )
      })}
      {personal.length > 0 && (
        <Panel>
          <ShelfHead title={`Personal keys · ${personal.length}`}>Each acts as the person who made it, from their own menu.</ShelfHead>
          <ul>
            {personal.map((t) => (
              <KeyRow key={t.id} token={t}>
                {t.owner} ·{' '}
              </KeyRow>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

/** Makes one key, and shows its secret in the same place, once. */
function IssueKey({ issuing, onClose }: { issuing: Issuing; onClose: () => void }) {
  const issue = useIssueToken()
  const roles = useRoles().data?.roles ?? []
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [issued, setIssued] = useState<TokenIssued | null>(null)
  const forSource = issuing.kind === 'source'
  const picked = roles.find((r) => r.id === role)
  return (
    <Drawer
      title={issued ? 'Copy the key' : forSource ? 'New key' : 'New access key'}
      subtitle={forSource ? `Writes as ${issuing.source.title || issuing.source.id}` : 'Calls the API as a machine, bound to a role'}
      icon={<KeyRound aria-hidden className="size-5 text-ink-300" />}
      onClose={onClose}
      unsaved={!issued && name.trim() !== ''}
    >
      {issued ? (
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-md border border-amber/50 bg-ink-850 p-3">
            <p className="text-sm text-amber">Copy it now. It is not stored and will not be shown again.</p>
            <code className="mt-2 block font-mono text-[12px] break-all text-ink-100">{issued.token}</code>
            <CopyButton text={issued.token} what={`the key ${issued.name}`} className="mt-2 -ml-1.5" />
          </div>
          <p className="text-sm text-ink-300">
            <span className="font-medium text-ink-100">{issued.name}</span> is ready. Send it as <code className="font-mono text-[12px]">Authorization: Bearer &lt;key&gt;</code>
            {forSource ? ' to the ingest host.' : ' to the API.'}
          </p>
          <Button kind="solid" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            issue.mutate(forSource ? { kind: 'source', name: name.trim(), source: issuing.source.id } : { kind: 'access', name: name.trim(), role }, { onSuccess: setIssued })
          }}
        >
          <label className="block">
            <Kicker>Name</Kicker>
            <input className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder={forSource ? 'Where it runs, such as the nightly job' : 'Who holds it, such as the deploy pipeline'} maxLength={80} required />
          </label>
          {!forSource && (
            <label className="block">
              <Kicker>Role</Kicker>
              <select className={`${input} mt-1 w-full`} value={role} onChange={(e) => setRole(e.target.value)} required>
                <option value="">Pick a role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
              {picked?.description && <span className="mt-1 block text-[12px] text-ink-400">{picked.description}</span>}
            </label>
          )}
          <ErrorNote error={issue.error} />
          <div className="flex gap-2">
            <Button type="submit" kind="solid" disabled={issue.isPending || !name.trim() || (!forSource && !role)}>
              {issue.isPending ? 'Making…' : 'Make the key'}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </Drawer>
  )
}

/** Secrets that health checks name. A value is stored encrypted and never shown. */
function Secrets() {
  useHere('Check secrets')
  const secrets = useSecrets(true)
  const set = useSetSecret()
  const remove = useDeleteSecret()
  const [f, setF] = useState({ name: '', value: '' })
  const list = secrets.data?.secrets ?? []
  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Check secrets</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-300">A health check names a secret with secretRef; the hub and runners open it when they call the URL. A secret never appears in git, in pushed data, or on the read API.</p>
      </div>
      <Panel>
        <form
          className="flex flex-wrap items-end gap-2 border-b border-ink-800 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            set.mutate(f, { onSuccess: () => setF({ name: '', value: '' }) })
          }}
        >
          <input className={`${input} w-full font-mono sm:w-56`} aria-label="Secret name" placeholder="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <input className={`${input} w-full font-mono sm:w-80`} type="password" aria-label="Secret value" placeholder="value" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required />
          <Button type="submit" kind="solid" disabled={set.isPending}>
            Store
          </Button>
          <span className="text-[12px] text-ink-400">Storing a name that exists replaces its value.</span>
        </form>
        <ErrorNote error={set.error ?? remove.error} />
        {list.length === 0 && !secrets.isLoading && <p className="px-4 py-3 text-sm text-ink-400">No secrets yet.</p>}
        <ul>
          {list.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 basis-48 font-mono text-[12px] wrap-anywhere text-ink-100">{s.name}</span>
              <span className="font-mono text-[12px] text-ink-500" title={when(s.updatedAt)}>
                updated {ago(s.updatedAt)}
              </span>
              <Button kind="danger" onClick={() => confirm(`Delete secret ${s.name}?`) && remove.mutate(s.name)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
