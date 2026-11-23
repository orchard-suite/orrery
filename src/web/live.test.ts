import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { markStale } from './api.ts'

/** A client with one page watching `['summary']`, and how often the hub was asked for it. */
async function watched() {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 10_000 } } })
  client.mount()
  let asked = 0
  const observer = new QueryObserver(client, { queryKey: ['summary'], queryFn: async () => ++asked })
  const stop = observer.subscribe(() => {})
  await observer.refetch()
  return { client, asked: () => asked, stop: () => { stop(); client.unmount() } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => focusManager.setFocused(undefined))

describe('a change the hub tells of', () => {
  it('is read again at once on a page in view', async () => {
    const page = await watched()
    await markStale(page.client, { queryKey: ['summary'] })
    expect(page.asked()).toBe(2)
    page.stop()
  })

  it('is read once, when a hidden page comes back into view', async () => {
    const page = await watched()
    focusManager.setFocused(false)
    await markStale(page.client, { queryKey: ['summary'] })
    await markStale(page.client, { queryKey: ['summary'] })
    expect(page.asked()).toBe(1)
    focusManager.setFocused(true)
    await settle()
    expect(page.asked()).toBe(2)
    page.stop()
  })
})
