// What self-service is used for, and what it costs the platform: who runs
// what, which actions go unused, how often people batch and how big and long
// their batches are, what the schedules add, and how busy and how far behind
// each runner is in each hour of the day. All of it is read from the runs the
// hub keeps; nothing is collected for it.

import type { ActionInsights } from '../shared/api.ts'
import type { Actions } from './actions.ts'
import type { Db } from './db.ts'

/** The most people an answer names. */
const PEOPLE_MAX = 25

export async function actionInsights(db: Db, actions: Actions, days: number): Promise<ActionInsights> {
  const since = new Date(Date.now() - days * 86_400_000)
  const all = actions.list()
  const runnerOf = new Map(all.flatMap((a) => (a.backend.type === 'runner' ? [[a.id, a.backend.runner] as const] : [])))

  const perAction = await db.query<{ action: string; runs: number; people: number; failed: number; retried: number; batched: number; scheduled: number; mean: number | null; p95: number | null; last: Date | null }>(
    `SELECT action, count(*)::int AS runs, count(DISTINCT actor)::int AS people,
            (count(*) FILTER (WHERE state = 'failed'))::int AS failed,
            (count(*) FILTER (WHERE attempt > 1))::int AS retried,
            (count(*) FILTER (WHERE batch IS NOT NULL))::int AS batched,
            (count(*) FILTER (WHERE schedule IS NOT NULL))::int AS scheduled,
            (avg(extract(epoch FROM finished_at - started_at)) FILTER (WHERE started_at IS NOT NULL AND finished_at IS NOT NULL))::float8 AS mean,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)) FILTER (WHERE started_at IS NOT NULL AND finished_at IS NOT NULL))::float8 AS p95,
            max(created_at) AS last
     FROM action_runs WHERE created_at >= $1 GROUP BY action`,
    [since],
  )
  const ran = new Map(perAction.rows.map((r) => [r.action, r]))
  const lastEver = await db.query<{ action: string; last: Date }>('SELECT action, max(created_at) AS last FROM action_runs GROUP BY action')
  const everOf = new Map(lastEver.rows.map((r) => [r.action, r.last]))

  const people = await db.query<{ actor: string; runs: number; actions: number; batches: number }>(
    `SELECT actor, count(*)::int AS runs, count(DISTINCT action)::int AS actions, count(DISTINCT batch)::int AS batches
     FROM action_runs WHERE created_at >= $1 GROUP BY actor ORDER BY count(*) DESC LIMIT ${PEOPLE_MAX}`,
    [since],
  )

  const batches = await db.query<{ action: string; batches: number; mean: number | null; largest: number | null; seconds: number | null; scheduled: number }>(
    `SELECT b.action, count(*)::int AS batches, avg(b.asked)::float8 AS mean, max(b.asked)::int AS largest,
            avg(extract(epoch FROM r.ended - b.created_at))::float8 AS seconds, (count(*) FILTER (WHERE b.schedule IS NOT NULL))::int AS scheduled
     FROM action_batches b LEFT JOIN LATERAL (SELECT max(finished_at) AS ended FROM action_runs WHERE batch = b.id) r ON true
     WHERE b.created_at >= $1 GROUP BY b.action`,
    [since],
  )

  // Each runner's busy time and wait, by hour of the day in UTC, averaged over the days of the window.
  const hourly = await db.query<{ action: string; hour: number; busy: number; runs: number; wait: number | null }>(
    `SELECT action, extract(hour FROM started_at AT TIME ZONE 'UTC')::int AS hour,
            sum(extract(epoch FROM coalesce(finished_at, now()) - started_at))::float8 AS busy, count(*)::int AS runs,
            avg(extract(epoch FROM started_at - coalesce(decided_at, created_at)))::float8 AS wait
     FROM action_runs WHERE started_at >= $1 AND action = ANY($2) GROUP BY action, hour`,
    [since, [...runnerOf.keys()]],
  )
  const runners = new Map<string, { busy: number[]; runs: number[]; waitSum: number[]; waitN: number[] }>()
  const span = Math.max(1, days)
  for (const r of hourly.rows) {
    const runner = runnerOf.get(r.action)!
    const at = runners.get(runner) ?? { busy: Array(24).fill(0), runs: Array(24).fill(0), waitSum: Array(24).fill(0), waitN: Array(24).fill(0) }
    at.busy[r.hour] += r.busy / span
    at.runs[r.hour] += r.runs / span
    if (r.wait !== null) {
      at.waitSum[r.hour] += r.wait * r.runs
      at.waitN[r.hour] += r.runs
    }
    runners.set(runner, at)
  }
  // What approved schedules add to each runner in each hour, from the load each one keeps.
  const planned = await db.query<{ hours: number[] | null; runner: string | null }>(`SELECT load->'hours' AS hours, load->>'runner' AS runner FROM action_schedules WHERE state = 'active'`)
  const scheduled = new Map<string, number[]>()
  for (const p of planned.rows) {
    if (!p.runner || !p.hours) continue
    const at = scheduled.get(p.runner) ?? Array(24).fill(0)
    p.hours.forEach((s, h) => (at[h] += s))
    scheduled.set(p.runner, at)
  }
  const runnerIds = [...new Set([...runners.keys(), ...scheduled.keys(), ...runnerOf.values()])].sort()
  const widths = actions.runnerWidths()

  return {
    days,
    since: since.toISOString(),
    actions: all
      .filter((a) => !a.tool)
      .map((a) => {
        const r = ran.get(a.id)
        return {
          action: a.id,
          title: a.title,
          runs: r?.runs ?? 0,
          people: r?.people ?? 0,
          failed: r?.failed ?? 0,
          retried: r?.retried ?? 0,
          batched: r?.batched ?? 0,
          scheduled: r?.scheduled ?? 0,
          meanSeconds: r?.mean ?? null,
          p95Seconds: r?.p95 ?? null,
          lastRunAt: everOf.get(a.id)?.toISOString() ?? null,
        }
      })
      .sort((x, y) => y.runs - x.runs || x.title.localeCompare(y.title)),
    people: people.rows.map((p) => ({ person: p.actor, runs: p.runs, actions: p.actions, batches: p.batches })),
    batches: batches.rows.map((b) => ({ action: b.action, batches: b.batches, meanSize: b.mean ?? 0, largest: b.largest ?? 0, meanSeconds: b.seconds, scheduled: b.scheduled })).sort((x, y) => y.batches - x.batches),
    runners: runnerIds.map((id) => {
      const r = runners.get(id)
      return {
        runner: id,
        width: widths.get(id) ?? null,
        busySeconds: r ? r.busy.map((x) => Math.round(x)) : Array(24).fill(0),
        runs: r ? r.runs.map((x) => Math.round(x * 10) / 10) : Array(24).fill(0),
        waitSeconds: r ? r.waitSum.map((s, h) => (r.waitN[h] ? Math.round(s / r.waitN[h]) : null)) : Array(24).fill(null),
        scheduledSeconds: scheduled.get(id) ?? Array(24).fill(0),
      }
    }),
  }
}
