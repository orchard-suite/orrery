import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActionRunsResponse, ActionSchedule, SchedulesResponse, WhoAmIResponse } from '../shared/api.ts'
import type { ActionRun } from '../shared/model.ts'
import { keys } from './api.ts'
import { TabBar } from './App.tsx'

const awaiting: ActionRun = { id: 'r1', action: 'deploy', entity: null, inputs: {}, by: 'user@example.com', state: 'awaiting', label: null, link: null, summary: null, log: [], steps: [], outputs: {}, claimedBy: null, decidedBy: null, decidedAt: null, tiers: [], revises: null, note: null, attempt: 1, retryAt: null, images: [], canDecide: true, createdAt: '2026-01-05T15:00:00Z', startedAt: null, finishedAt: null }

/** A phone's tab bar for a signed-in person with `waiting` runs and `schedules` awaiting their approval. */
function render(waiting: ActionRun[], schedules: ActionSchedule[] = []): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'approver@example.com', admin: false, roles: [], permissions: ['actions.approve'] }, version: '0.0.0', telemetry: false, previews: [] } satisfies WhoAmIResponse)
  client.setQueryData(keys.actionRuns(new URLSearchParams({ state: 'awaiting', limit: '100', sets: 'apart' }).toString()), { runs: waiting, more: false } satisfies ActionRunsResponse)
  client.setQueryData(['schedules', 'awaiting'], { schedules } satisfies SchedulesResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TabBar, { route: { page: 'now' } })))
}

/** The markup of the bar's link or button whose text holds `name`. */
const control = (html: string, name: string): string => (html.match(/<(a|button)\b.*?<\/\1>/g) ?? []).find((c) => c.includes(name)) ?? ''

describe("a phone's tab bar", () => {
  it('counts the runs waiting for approval on the Self-service tab, and nowhere else', () => {
    const html = render([awaiting])
    expect(control(html, 'Self-service')).toContain('waiting for your approval')
    expect(control(html, 'More')).not.toContain('waiting for your approval')
  })

  it('counts a schedule waiting for approval beside the runs', () => {
    const html = control(render([awaiting], [{ id: 's1', state: 'awaiting' } as ActionSchedule]), 'Self-service')
    expect(html).toMatch(/>2<span class="sr-only"> waiting for your approval/)
    expect(html).toContain('title="1 run and 1 schedule wait for your approval"')
    expect(control(render([], [{ id: 's1', state: 'awaiting' } as ActionSchedule]), 'Self-service')).toContain('title="1 schedule waits for your approval"')
  })

  it('shows no count when nothing waits', () => {
    expect(render([])).not.toContain('waiting for your approval')
  })
})
