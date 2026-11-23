// The web code keeps a tab's state in sessionStorage. Node has it built in only from version 25, and the checks run on 24, so a test gets a tab's storage in memory where Node has none.
if (typeof globalThis.sessionStorage === 'undefined') {
  const kept = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return kept.size
    },
    key: (i) => [...kept.keys()][i] ?? null,
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => void kept.set(k, String(v)),
    removeItem: (k) => void kept.delete(k),
    clear: () => kept.clear(),
  }
  globalThis.sessionStorage = storage
}
