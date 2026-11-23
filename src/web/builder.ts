// What the action builder does to an action's sections: every move a button
// or a pick makes, worked out here from the sections as the definition holds
// them, so the builder only writes the answer back.

/** One section as the definition holds it: whatever it was written with, and the inputs it names. */
export type SectionDraft = Record<string, unknown> & { inputs: string[] }

/** The sections a definition holds. One written badly is read with what it has, so the builder can show it and what is wrong with it. */
export function draftSections(raw: unknown): SectionDraft[] {
  if (!Array.isArray(raw)) return []
  return raw.map((s: unknown) => {
    const section = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
    return { ...section, inputs: Array.isArray(section.inputs) ? section.inputs.map(String) : [] }
  })
}

/** The section that names an input: the first, when more than one does. Null when none does. */
export function sectionOfInput(sections: readonly SectionDraft[], name: string): number | null {
  const at = sections.findIndex((s) => s.inputs.includes(name))
  return at < 0 ? null : at
}

/** The sections without an input. */
export function without(sections: readonly SectionDraft[], name: string): SectionDraft[] {
  return sections.map((s) => ({ ...s, inputs: s.inputs.filter((n) => n !== name) }))
}

/** The sections with an input moved to the end of one of them, or out of them all for `null`. */
export function placed(sections: readonly SectionDraft[], name: string, to: number | null): SectionDraft[] {
  return without(sections, name).map((s, i) => (i === to ? { ...s, inputs: [...s.inputs, name] } : s))
}

/** The sections with an input moved one place inside its section. Null when it is already at that end, or not there. */
export function shifted(sections: readonly SectionDraft[], section: number, name: string, by: -1 | 1): SectionDraft[] | null {
  const inputs = sections[section]?.inputs ?? []
  const i = inputs.indexOf(name)
  const j = i + by
  if (i < 0 || j < 0 || j >= inputs.length) return null
  const next = [...inputs]
  next[i] = inputs[j]!
  next[j] = name
  return sections.map((s, at) => (at === section ? { ...s, inputs: next } : s))
}

/** The sections with one moved a place. Null when it is already at that end. */
export function sectionShifted(sections: readonly SectionDraft[], section: number, by: -1 | 1): SectionDraft[] | null {
  const j = section + by
  if (section < 0 || section >= sections.length || j < 0 || j >= sections.length) return null
  const next = [...sections]
  next[section] = sections[j]!
  next[j] = sections[section]!
  return next
}

/** The sections with an input under its new name, where it was. */
export function renamedIn(sections: readonly SectionDraft[], from: string, to: string): SectionDraft[] {
  return sections.map((s) => ({ ...s, inputs: s.inputs.map((n) => (n === from ? to : n)) }))
}
