import { EventEmitter } from 'node:events'
import type { ServerEvent } from '../shared/api.ts'

/**
 * Fan-out of changes: to every open browser stream, and to the parts of the
 * hub that follow what moved. What this hub emits is sent on to the other
 * hubs on its database, and what they emit is told here (`bridge.ts`).
 */
export class Events {
  private readonly emitter = new EventEmitter()
  /** Sends an event this hub emitted on to the other hubs; set by the bridge. */
  forward: ((event: ServerEvent) => void) | null = null

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  /** Tells this hub's listeners and every other hub, stamped with when it was emitted. */
  emit(event: ServerEvent): void {
    const stamped = { ...event, at: event.at ?? Date.now() }
    this.emitter.emit('event', stamped)
    this.forward?.(stamped)
  }

  /** Tells this hub's listeners alone, for what moved only in this hub's own memory. */
  local(event: ServerEvent): void {
    this.emitter.emit('event', { ...event, at: event.at ?? Date.now() })
  }

  /** Tells this hub's listeners an event another hub emitted. It is not sent on. */
  deliver(event: ServerEvent): void {
    this.emitter.emit('event', event)
    this.emitter.emit('heard', event)
  }

  /** Calls `listener` for each event another hub emitted. */
  onHeard(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('heard', listener)
    return () => this.emitter.off('heard', listener)
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  /** Ends every open browser stream, as the hub stops: each browser reconnects to the hub that serves next. */
  end(): void {
    this.emitter.emit('end')
  }

  onEnd(listener: () => void): () => void {
    this.emitter.on('end', listener)
    return () => this.emitter.off('end', listener)
  }
}
