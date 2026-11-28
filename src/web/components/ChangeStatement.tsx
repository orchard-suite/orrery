// The change a run states, for whoever approves it: what runs where, each
// effect on each live thing, and each part the writer could not name an
// effect for. It reads the statement the hub checked and kept on the run,
// and the route the run was given: who judged it, why it is asked, by when,
// from when, and what packs not counting yet would have answered.

import { actorText, applierText, reasonText, refText, routeText, type ChangeEffect, type ChangeReason, type ChangeRouting, type ChangeStatement } from '../../shared/change.ts'
import { when } from '../format.ts'
import { Badge, CopyButton, Kicker, Panel } from './ui.tsx'

const UNDO: Record<ChangeEffect['undo'], string> = { yes: 'Yes', no: 'No', partial: 'In part' }
const CLAIM: Record<ChangeEffect['claim']['from'], string> = { writer: 'The writer', estate: 'The estate', model: 'A model' }

export function ChangeStatementView({ statement: s, digest, waiting }: { statement: ChangeStatement; digest?: string; waiting: boolean }) {
  const effects = s.effects ?? []
  const unknown = s.unknown ?? []
  const things = s.things ?? []
  return (
    <Panel className={waiting ? 'border-amber/40' : undefined}>
      <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2">
        <Kicker>{waiting ? 'What you are asked to approve' : 'The change it states'}</Kicker>
        <span className="break-all font-mono text-[12px] text-ink-300">{s.key}</span>
      </h2>
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-ink-300">Runs on</dt>
        <dd className="text-ink-100">{applierText(s.applier)}</dd>
        <dt className="text-ink-300">Asked by</dt>
        <dd className="break-words text-ink-100">{actorText(s.actor)}</dd>
        <dt className="text-ink-300">Written by</dt>
        <dd className="text-ink-100">
          {s.writer.name} {s.writer.version}
        </dd>
        <dt className="text-ink-300">From the {s.artifact.kind}</dt>
        <dd className="break-all font-mono text-[12px] text-ink-200">{s.artifact.digest}</dd>
        {things.length > 0 && (
          <>
            <dt className="text-ink-300">It touches</dt>
            <dd className="break-words text-ink-100">{things.map(refText).join(', ')}</dd>
          </>
        )}
        {digest && (
          <>
            <dt className="text-ink-300">Statement</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 break-all font-mono text-[12px] text-ink-200">{digest}</span>
              <CopyButton text={digest} what="the statement's digest" />
            </dd>
          </>
        )}
      </dl>
      <section aria-label="Effects" className="border-t border-ink-800">
        <h3 className="px-4 pt-3 text-sm text-ink-300">{effects.length ? `What it does (${effects.length})` : 'It states no effect.'}</h3>
        {effects.length > 0 && (
          <div className="overflow-x-auto px-4 pb-3">
            <table className="mt-2 w-full min-w-[36rem] text-left text-sm">
              <thead className="text-[12px] text-ink-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">Effect</th>
                  <th className="py-1 pr-3 font-normal">On</th>
                  <th className="py-1 pr-3 font-normal">Path</th>
                  <th className="py-1 pr-3 font-normal">Size</th>
                  <th className="py-1 pr-3 font-normal">Undo</th>
                  <th className="py-1 font-normal">Claimed by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {effects.map((e, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-1.5 pr-3 font-medium text-ink-50">{e.kind}</td>
                    <td className="py-1.5 pr-3 break-words text-ink-100">{refText(e.subject)}</td>
                    <td className="py-1.5 pr-3 text-ink-200">{e.path}</td>
                    <td className="py-1.5 pr-3 text-ink-200">{e.size ?? ''}</td>
                    <td className={`py-1.5 pr-3 ${e.undo === 'no' ? 'text-amber' : 'text-ink-200'}`}>{UNDO[e.undo]}</td>
                    <td className="py-1.5 text-ink-200">
                      {CLAIM[e.claim.from]}
                      {(e.claim.rule || e.claim.version) && <span className="block text-[12px] text-ink-400">{[e.claim.rule, e.claim.version].filter(Boolean).join(', ')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {unknown.length > 0 && (
        <section aria-label="Parts with no effect named" className="border-t border-ink-800 px-4 py-3">
          <h3 className="text-sm text-amber">Parts with no effect named ({unknown.length})</h3>
          <ul className="mt-1.5 space-y-1 text-sm">
            {unknown.map((u, i) => (
              <li key={i} className="break-words text-ink-100">
                {u.thing && <span className="text-ink-300">{refText(u.thing)}: </span>}
                <span className="font-mono text-[12px]">{u.part}</span>
                <span className="text-ink-400">, {u.why === 'unread' ? 'which the writer could not read' : 'which the writer read and has no effect for'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Panel>
  )
}

/** Why a route came, one reason to a line: the effect or the part it is about, with the proof, the fence, and the rule. */
function Reasons({ reasons, statement }: { reasons: ChangeReason[]; statement: ChangeStatement }) {
  if (!reasons.length) return <p className="text-sm text-ink-300">It gives no reason.</p>
  return (
    <ul className="space-y-1 text-sm">
      {reasons.map((r, i) => (
        <li key={i} className={`break-words ${r.fence ? 'text-amber' : 'text-ink-100'}`}>
          {reasonText(r, statement)}
        </li>
      ))}
    </ul>
  )
}

/** The route a run of a stated change was given, as its change.routed event says it. A draft is shown as one, and never as who is asked. */
export function RouteView({ routing, statement }: { routing: ChangeRouting; statement: ChangeStatement }) {
  const route = routing.route
  const drafts = routing.drafts ?? []
  return (
    <Panel>
      <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-2">
        <Kicker>Why it is asked</Kicker>
        <span className="text-[12px] text-ink-300">{routing.judge ? `judged by ${routing.judge.name} ${routing.judge.version}, pack ${routing.judge.pack}` : 'the judge did not answer'}</span>
      </h2>
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-ink-300">Route</dt>
        <dd className="break-words text-ink-100">{routeText(route)}</dd>
        {route.to === 'people' && route.by && (
          <>
            <dt className="text-ink-300">Decide by</dt>
            <dd className="text-ink-100">{when(route.by)}</dd>
          </>
        )}
        {route.to === 'people' && route.start && (
          <>
            <dt className="text-ink-300">Starts no earlier than</dt>
            <dd className="text-ink-100">{when(route.start)}</dd>
          </>
        )}
      </dl>
      <section aria-label="Reasons" className="border-t border-ink-800 px-4 py-3">
        <h3 className="mb-1.5 text-sm text-ink-300">Reasons</h3>
        <Reasons reasons={routing.reasons ?? []} statement={statement} />
      </section>
      {drafts.map((d, i) => (
        <section key={i} aria-label={`Draft ${d.pack}`} className="border-t border-ink-800 px-4 py-3">
          <h3 className="mb-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-300">
            <Badge className="border-ink-600 text-ink-300">draft</Badge>
            <span>
              Pack {d.pack}, not counting yet, would route to {routeText(d.route)}. It changes nobody who is asked.
            </span>
          </h3>
          <Reasons reasons={d.reasons ?? []} statement={statement} />
        </section>
      ))}
    </Panel>
  )
}
