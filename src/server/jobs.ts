import type { Logger } from './log.ts'

interface Job {
  name: string
  everyMs: number
  run: () => Promise<unknown>
}

/**
 * The hub's background passes. Each runs at start and then on its timer,
 * never two of one at once. Only the leading hub runs them (`leader.ts`),
 * and `stop` waits for the passes still running, so the next leader starts
 * from what they wrote.
 */
export class Jobs {
  private readonly log: Logger
  private readonly jobs: Job[] = []
  private readonly timers: NodeJS.Timeout[] = []
  private readonly running = new Map<string, Promise<void>>()
  /** True between `start` and `stop`: the first passes still waiting their turn are skipped once it is false. */
  private started = false

  constructor(log: Logger) {
    this.log = log
  }

  add(name: string, everyMs: number, run: () => Promise<unknown>): void {
    this.jobs.push({ name, everyMs, run })
  }

  /**
   * Starts every job: the first passes run one after another, in the order
   * the jobs were added, so a hub that has just taken the lead does not do
   * all its background work at once beside the people it serves. Each job's
   * timer starts at once; a tick that lands while its first pass still waits
   * its turn runs that pass, and the turn then finds it done.
   */
  start(): void {
    if (this.timers.length) return
    this.started = true
    for (const job of this.jobs) this.timers.push(setInterval(() => void this.pass(job), job.everyMs))
    void (async () => {
      for (const job of this.jobs) {
        if (!this.started) return
        await this.pass(job)
      }
    })()
  }

  async stop(): Promise<void> {
    this.started = false
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    await Promise.all(this.running.values())
  }

  private pass(job: Job): Promise<void> {
    const running = this.running.get(job.name)
    if (running) return running
    const pass = job
      .run()
      .then(() => undefined)
      .catch((error: unknown) => this.log.error('background pass failed', { job: job.name, error }))
      .finally(() => this.running.delete(job.name))
    this.running.set(job.name, pass)
    return pass
  }
}
