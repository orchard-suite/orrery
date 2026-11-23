// The bar at the top of a phone. It shows the logo until a page puts its own
// title and buttons there, so a page's heading costs no row of its own.

import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const Slot = createContext<[HTMLElement | null, (el: HTMLElement | null) => void]>([null, () => {}])

export function PhoneBarProvider({ children }: { children: ReactNode }) {
  const slot = useState<HTMLElement | null>(null)
  return <Slot.Provider value={slot}>{children}</Slot.Provider>
}

/** Where a page's bar lands. It is marked `data-bar`, so the header can hide its logo while the slot holds something. */
export function PhoneBarSlot({ className }: { className?: string }) {
  const [, set] = useContext(Slot)
  return <div data-bar ref={set} className={className} />
}

/** What a page shows in the phone's top bar in place of the logo. */
export function PhoneBar({ children }: { children: ReactNode }) {
  const [el] = useContext(Slot)
  return el ? createPortal(children, el) : null
}
