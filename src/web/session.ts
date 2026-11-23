// What the web app does when a person's sign-in has ended, or lapsed for one thing they do, while a page was open.

const KEY = 'orrery.signin'
const AGAIN_AFTER_MS = 60_000

export const SIGNED_OUT = 'Your sign-in has ended. Reload the page to sign in again.'

/**
 * Whether an answer means the person is no longer signed in: a 401, or a
 * redirect, which is the login proxy sending them to sign in. A request must
 * be made with `redirect: 'manual'` for the redirect to be seen at all.
 */
export const signedOut = (response: { type: string; status: number }): boolean => response.type === 'opaqueredirect' || response.status === 401

export interface Page {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  reload: () => void
  /** Leaves for another address on this host. */
  assign: (url: string) => void
  /** Where the person is, path and query, to come back to. */
  here: string
  now: number
}

/**
 * Sends the person through the sign-in and back to where they were: to
 * `start`, the login proxy's fresh sign-in, when the hub named one (their
 * session holds a sign-in that lapsed for what they did, and a reload keeps
 * it), else by reloading the page. False when this was done a moment ago and
 * did not help: the caller says so instead of going round for ever.
 */
export function signInAgain(page: Page, start?: string): boolean {
  const last = Number(page.storage.getItem(KEY))
  if (last && page.now - last < AGAIN_AFTER_MS) return false
  page.storage.setItem(KEY, String(page.now))
  const fresh = start ? freshSignIn(start, page.here) : null
  if (fresh) page.assign(fresh)
  else page.reload()
  return true
}

/** The login proxy's fresh sign-in that comes back to `here`, or null when `start` is no path on this host. */
export function freshSignIn(start: string, here: string): string | null {
  if (!/^\/[^/\\]/.test(start)) return null
  return `${start}${start.includes('?') ? '&' : '?'}rd=${encodeURIComponent(here)}`
}
