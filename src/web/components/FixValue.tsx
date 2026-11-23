// A failing mark that one value would mend, as a button: it opens that
// value's editor where the reader may change it, and says where it is
// changed where they may not.

import { CircleX } from 'lucide-react'
import { useState } from 'react'
import type { Blueprint, EntityRef } from '../../shared/model.ts'
import { useAccessGuard, useCanEdit, useEditEntity, useEntity, useIsAdmin } from '../api.ts'
import { opened } from '../editable.ts'
import { whyNotYours } from '../fix.ts'
import { words } from '../format.ts'
import { fieldLock, ValueEditor } from './editors.tsx'
import { Popover } from './Popover.tsx'
import { ErrorNote, Link } from './ui.tsx'

/** The failing mark of a rule that reads one field: press it to mend that field on this entity. */
export function FixMark({ entity, title, bp, field }: { entity: EntityRef; title: string; bp: Blueprint; field: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const name = words(bp.fields[field]?.title ?? field)
  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={!!anchor} aria-label={`Fails. Set ${name} of ${title}`} title={`Set ${name}`} onClick={(event) => setAnchor(event.currentTarget)} className="grid size-6 place-items-center rounded-sm hover:bg-ink-700">
        <CircleX className="size-4 text-red" aria-hidden />
      </button>
      {anchor && <Fixer anchor={anchor} entity={entity} title={title} bp={bp} field={field} name={name} onClose={() => setAnchor(null)} />}
    </>
  )
}

function Fixer({ anchor, entity, title, bp, field, name, onClose }: { anchor: HTMLElement; entity: EntityRef; title: string; bp: Blueprint; field: string; name: string; onClose: () => void }) {
  const page = useEntity(entity)
  const canEdit = useCanEdit(bp.id)
  const admin = useIsAdmin()
  const guard = useAccessGuard(bp)
  const edit = useEditEntity()
  const e = page.data
  const def = bp.fields[field]
  if (!e) {
    return (
      <Popover anchor={anchor} onClose={onClose} label={`${name} of ${title}`} className="px-3 py-2 text-[13px] text-ink-400">
        {page.error ? <ErrorNote error={page.error} /> : 'Reading…'}
      </Popover>
    )
  }
  const from = e.provenance[field]
  const held = canEdit ? (fieldLock(def, from?.layer, admin) ?? guard(field)) : ''
  if (held === null || opened(e, 'field', field)) {
    return <ValueEditor anchor={anchor} place="below" def={def ? { ...def, title: name } : undefined} value={e.fields[field]} onCommit={(value) => (edit.mutate({ ref: entity, patch: { fields: { [field]: value } } }), onClose())} onClose={onClose} />
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} label={`${name} of ${title}`} className="space-y-1.5 px-3 py-2 text-[13px]">
      <p className="text-ink-200">{whyNotYours(held, from, e.fields[field])}.</p>
      <Link to={{ page: 'entity', ...entity }} className="text-orbit hover:underline">
        Open {title}
      </Link>
    </Popover>
  )
}
