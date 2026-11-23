// The stars a person keeps for themselves: a pin that puts an action at the
// top of their self-service page or a blueprint at the top of the catalog's
// list, and a star that makes an entity one of their favorites, first in
// every catalog grid they read. Each is theirs alone and the hub keeps it, so
// it is the same in every browser. While an admin views as someone, nothing
// here is drawn: that view changes nothing.

import { ArrowDown, ArrowUp, Star } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Entity, Pin } from '../../shared/model.ts'
import { movedPin } from '../actions.ts'
import { useOrderPins, usePins, useSetPinned, useSetStarred, useViewingAs } from '../api.ts'

/** What a pin does, said on its button: where it keeps the thing. */
const PIN_WORDS: Record<Pin['kind'], { on: string; off: string }> = {
  action: { on: 'Unpin: take it off the top of your page', off: 'Pin: keep it at the top of your page' },
  blueprint: { on: 'Unstar: take it off the top of your catalog', off: 'Star: keep it at the top of your catalog' },
}

const BUTTON = 'flex shrink-0 items-center justify-center rounded-md hover:bg-ink-800'

/** The one control that pins a thing or lets it go. No hub that keeps pins, no star. */
export function PinStar({ pin, name, className = '' }: { pin: Pin; name: string; className?: string }) {
  const pins = usePins().data
  const viewing = useViewingAs()
  const set = useSetPinned()
  if (viewing || !pins) return null
  const on = pins.some((p) => p.kind === pin.kind && p.id === pin.id)
  const verb = pin.kind === 'action' ? (on ? 'Unpin' : 'Pin') : on ? 'Unstar' : 'Star'
  return (
    <button type="button" aria-pressed={on} aria-label={`${verb} ${name}`} title={PIN_WORDS[pin.kind][on ? 'on' : 'off']} onClick={() => set.mutate({ pin, on: !on })} className={`relative z-10 size-7 ${BUTTON} ${on ? 'text-amber' : 'text-ink-400 hover:text-ink-100'} ${className}`}>
      <Star aria-hidden className={`size-4 ${on ? 'fill-current' : ''}`} />
    </button>
  )
}

/**
 * The star on an entity: filled while it is one of the person's favorites,
 * which every catalog grid they read puts first. `quiet` draws an unstarred
 * one only while its row is pointed at or holds the focus, as a grid row's
 * other buttons are.
 */
export function EntityStar({ e, quiet = false, words = false, className = '' }: { e: Pick<Entity, 'blueprint' | 'key' | 'title' | 'starred'>; quiet?: boolean; /** Says Star or Starred beside it, as a button among a page's others. */ words?: boolean; className?: string }) {
  const viewing = useViewingAs()
  const set = useSetStarred()
  if (viewing) return null
  const on = !!e.starred
  const flip = () => set.mutate({ ref: { blueprint: e.blueprint, key: e.key }, on: !on })
  if (words)
    return (
      <button type="button" aria-pressed={on} onClick={flip} title={on ? 'Take it out of your favorites' : 'Make it one of your favorites, first in every list of its kind'} className={`flex items-center gap-1.5 btn btn-ghost ${className}`}>
        <Star aria-hidden className={`size-3.5 ${on ? 'fill-current text-amber' : ''}`} />
        {on ? 'Starred' : 'Star'}
      </button>
    )
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${on ? 'Unstar' : 'Star'} ${e.title}`}
      title={on ? 'Unstar: take it out of your favorites' : 'Star: one of your favorites, first in every list of its kind'}
      onClick={flip}
      className={`${BUTTON} ${on ? 'text-amber' : `text-ink-500 hover:text-ink-100 ${quiet ? 'invisible group-hover:visible group-focus-within:visible' : ''}`} ${className}`}
    >
      <Star aria-hidden className={`size-3.5 ${on ? 'fill-current' : ''}`} />
    </button>
  )
}

/**
 * Moving what a person pinned of one kind a place earlier or later, kept by
 * the hub as their own order. `shown` is that kind's pins as the page lists
 * them. A moved row is put back in the page, which drops the focus it held,
 * so the control the move was made with takes it again; `said` is the move
 * in words, for a screen reader. Nothing moves while viewing as someone.
 */
export function usePinMoves(shown: Pin[]) {
  const viewing = useViewingAs()
  const order = useOrderPins()
  const base = useId()
  const [said, setSaid] = useState('')
  const held = useRef<string | null>(null)
  const places = shown.map((p) => p.id).join('\n')
  useEffect(() => {
    if (!held.current) return
    document.getElementById(held.current)?.focus()
    held.current = null
  }, [places])
  const control = (pin: Pin, by: -1 | 1) => `${base}-${pin.id}-${by < 0 ? 'earlier' : 'later'}`
  const move = (pin: Pin, name: string, by: -1 | 1) => {
    const next = movedPin(shown, pin, by)
    if (!next) return
    held.current = control(pin, by)
    setSaid(`${name} is now ${next.findIndex((p) => p.id === pin.id) + 1} of ${next.length}`)
    order.mutate(next)
  }
  return { movable: !viewing && shown.length > 1, move, control, said }
}

/** A pin's two moves. An end's control stays in the tab order and says it is off, so the keyboard never loses its place there. */
export function PinMoves({ moves, pin, name, at, of, look }: { moves: ReturnType<typeof usePinMoves>; pin: Pin; name: string; at: number; of: number; /** The look of a button, given whether it is off. */ look: (off: boolean) => string }) {
  if (!moves.movable) return null
  const icon = pin.kind === 'action' ? 'size-4' : 'size-3'
  return (
    <>
      <button type="button" id={moves.control(pin, -1)} aria-disabled={at === 0 || undefined} aria-label={`Move ${name} earlier`} title="Move earlier, for you" onClick={() => moves.move(pin, name, -1)} className={look(at === 0)}>
        <ArrowUp aria-hidden className={icon} />
      </button>
      <button type="button" id={moves.control(pin, 1)} aria-disabled={at === of - 1 || undefined} aria-label={`Move ${name} later`} title="Move later, for you" onClick={() => moves.move(pin, name, 1)} className={look(at === of - 1)}>
        <ArrowDown aria-hidden className={icon} />
      </button>
    </>
  )
}
