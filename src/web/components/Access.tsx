import { useMutation } from '@tanstack/react-query'
import { Eye, Plus } from 'lucide-react'
import { useState } from 'react'
import { ADMIN_ROLE, PERMISSIONS, PERMISSION_FAMILIES, can, ownsPaths, type OwnsPath, type Permission, type PersonSetting, type PersonShown, type RoleDef, type User, type ValueColor } from '../../shared/model.ts'
import { PREVIEWS, type PreviewName, type PreviewSetting } from '../../shared/api.ts'
import { useAccessSettings, startViewingAs, useAddUser, useBlueprintName, useBlueprints, useCan, useDeleteRole, useIsAdmin, usePreview, usePreviews, useRemoveUser, useRoles, useSavePreviews, useSaveRole, useSetPerson, useSetUserRoles, useTokens, useUsers, useViewingAs, useWhoAmI } from '../api.ts'
import { ago, when } from '../format.ts'
import { Drawer } from './Drawer.tsx'
import { Icon } from '../icons.tsx'
import { isPhoto } from '../../shared/icons.ts'
import { WelcomeSettings } from './WelcomeSettings.tsx'
import { Badge, Button, Empty, ErrorNote, Fold, input, Kicker, Panel, swatch } from './ui.tsx'
import { useVisit } from '../trail.ts'

/**
 * Who has come in, and what each may do. People sit in lanes by what they
 * hold, each a card with its own "View as"; one grid shows what every role
 * allows. A person or a role opens in a drawer to be changed. The settings
 * changed once in a while fold away below.
 */
export function Access() {
  const allowed = useCan('users.manage')
  const admin = useIsAdmin()
  const roles = useRoles()
  // The tour's settings are part of its preview.
  const welcome = usePreview('welcome')
  // Everything here changes who may do what, and nothing is changed as someone else.
  if (useViewingAs()) return <Empty>Access is where people and roles are changed, and nothing is changed while viewing as someone else. Exit to manage it.</Empty>
  if (!allowed && !admin) return <Empty>People and roles need the "users.manage" permission.</Empty>
  const list = roles.data?.roles ?? []
  return (
    <div className="space-y-8 py-6">
      {allowed ? <People roles={list} /> : <Heading />}
      {allowed && <RoleGrid roles={list} />}
      {admin && (
        <div className="space-y-2">
          <PersonEntity />
          <PreviewsPanel />
          {welcome && <WelcomeSettings />}
        </div>
      )}
    </div>
  )
}

function Heading() {
  return (
    <div className="min-w-[min(100%,20rem)] flex-1">
      <h1 className="page-title">Access</h1>
      <p className="max-w-3xl text-sm text-ink-400">Who is in, and what each may do. Sign-in decides who gets in and who is an admin; a role adds what its permissions allow. Every change takes effect at once.</p>
    </div>
  )
}

/** The colour each family of permissions is drawn in, wherever a permission is shown. */
const FAMILY_COLOR: Record<string, ValueColor> = { catalog: 'blue', model: 'purple', sources: 'turquoise', access: 'red', actions: 'green', behalf: 'pink' }
const familyColor = (id: string) => swatch(FAMILY_COLOR[id] ?? 'grey')
/** A family's colour as text: pulled toward the brightest ink, as a chip's is, so it reads in either theme. */
const familyInk = (id: string) => `color-mix(in oklab, ${familyColor(id)} var(--chip-ink), var(--color-ink-50))`
const EVERY = PERMISSION_FAMILIES.flatMap((f) => f.permissions.map((p) => p.id))

/** How recently a person was here, as the ring round their initial says. */
type Fresh = 'today' | 'week' | 'quiet' | 'never'
const DAY = 86_400_000
function freshness(u: User, now: number): Fresh {
  if (!u.firstSeenAt) return 'never'
  const since = u.lastSeenAt ? now - Date.parse(u.lastSeenAt) : Infinity
  return since < DAY ? 'today' : since < 7 * DAY ? 'week' : 'quiet'
}
const RING: Record<Fresh, string> = { today: 'var(--color-green)', week: 'var(--color-orbit)', quiet: 'var(--color-ink-700)', never: 'transparent' }

/** One lane of people: the admins, the holders of one role, those who only read, and those not signed in yet. */
interface Lane {
  id: string
  title: string
  about: string
  /** A CSS background: the lane's swatch and its part of the bar. */
  color: string
  people: User[]
}

/**
 * The lanes in their order, leaving out the empty ones. A person stands in
 * each role lane they hold; an admin only among the admins, since sign-in
 * gives them everything.
 */
function lanesOf(users: User[], roles: RoleDef[]): Lane[] {
  const known = new Set(roles.map((r) => r.id))
  const lanes: Lane[] = [{ id: ADMIN_ROLE, title: 'Admin', about: 'from sign-in · everything', color: 'var(--color-amber)', people: users.filter((u) => u.admin) }]
  for (const r of roles.filter((r) => !r.locked)) {
    lanes.push({ id: r.id, title: r.title, about: `${r.permissions.length} of ${EVERY.length}`, color: 'var(--color-orbit)', people: users.filter((u) => !u.admin && u.roles.includes(r.id)) })
  }
  // A role id no role answers to grants nothing, so its holder reads only.
  const bare = users.filter((u) => !u.admin && !u.roles.some((id) => known.has(id)))
  lanes.push({ id: 'reads', title: 'Reads only', about: 'what the access rules show them', color: 'var(--color-ink-300)', people: bare.filter((u) => u.firstSeenAt) })
  lanes.push({ id: 'waiting', title: 'Not signed in yet', about: 'added ahead of sign-in', color: 'repeating-linear-gradient(135deg, var(--color-ink-300) 0 2px, transparent 2px 4px)', people: bare.filter((u) => !u.firstSeenAt) })
  return lanes.filter((l) => l.people.length > 0)
}

/** The domain most people sign in from: a card leaves it off, and names any other address in full. */
function commonDomain(users: User[]): string {
  const counts = new Map<string, number>()
  for (const u of users) {
    const d = u.email.slice(u.email.indexOf('@'))
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function People({ roles }: { roles: RoleDef[] }) {
  const users = useUsers()
  const add = useAddUser()
  const view = useMutation({ mutationFn: startViewingAs })
  const [adding, setAdding] = useState<{ email: string; roles: string[] } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [find, setFind] = useVisit('access.find', '')
  const admin = useIsAdmin()
  const me = useWhoAmI().data?.identity.name
  const everyone = users.data?.users ?? []
  // Found by address or by the name the estate holds for them.
  const needle = find.trim().toLowerCase()
  const list = everyone.filter((u) => u.email.includes(needle) || !!users.data?.people?.[u.email.toLowerCase()]?.title.toLowerCase().includes(needle))
  const lanes = lanesOf(list, roles)
  const domain = commonDomain(everyone)
  const giveable = roles.filter((r) => !r.locked)
  const person = open ? everyone.find((u) => u.email === open) : undefined
  const now = Date.now()
  // Only an admin sees as someone else, and never as themselves.
  const viewAs = (email: string) => (admin && email !== me ? () => void view.mutateAsync(email) : undefined)
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Heading />
        <input className={`${input} w-full sm:w-64`} type="search" placeholder="Find a person" aria-label="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />
        <Button title="Add someone before they first sign in, with the roles they will have when they do. Sign-in still decides whether they get in" onClick={() => setAdding(adding ? null : { email: '', roles: [] })}>
          {adding ? 'Close' : 'Add person'}
        </Button>
      </div>
      {adding && (
        <form
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-ink-700 bg-ink-900/70 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate(adding, { onSuccess: () => setAdding(null) })
          }}
        >
          <input className={`${input} w-full sm:w-72`} type="email" aria-label="Email" placeholder="name@example.org" value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} autoFocus required />
          {giveable.map((r) => (
            <label key={r.id} className="flex min-h-6 cursor-pointer items-center gap-1.5 text-sm" title={r.description}>
              <input type="checkbox" checked={adding.roles.includes(r.id)} onChange={() => setAdding({ ...adding, roles: toggled(adding.roles, r.id) })} />
              {r.title}
            </label>
          ))}
          <Button type="submit" kind="solid" disabled={add.isPending}>
            Add
          </Button>
        </form>
      )}
      <ErrorNote error={users.error ?? add.error ?? view.error} />
      {everyone.length > 0 && <Mix lanes={lanesOf(everyone, roles)} total={everyone.length} />}
      <div className="flex flex-wrap gap-x-8 gap-y-6">
        {lanes.map((lane) => (
          <div key={lane.id} className="min-w-[min(100%,18rem)]" style={{ flex: `${lane.people.length >= 4 ? 1 : 0} 1 ${Math.min(lane.people.length, 4) * 18.5}rem` }}>
            <h2 className="mb-2 flex flex-wrap items-center gap-x-2 text-sm font-semibold text-ink-100">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: lane.color }} aria-hidden />
              {lane.title}
              <span className="text-[12px] font-normal text-ink-400">
                {lane.people.length} · {lane.about}
              </span>
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2">
              {lane.people.map((u) => (
                <li key={u.email}>
                  <Card user={u} shown={users.data?.people?.[u.email.toLowerCase()]} domain={domain} fresh={freshness(u, now)} me={u.email === me} picked={u.email === open} onOpen={() => setOpen(u.email)} onViewAs={viewAs(u.email)} viewing={view.isPending} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {users.data && everyone.length > 0 && list.length === 0 && <p className="text-sm text-ink-400">Nobody here matches "{find}".</p>}
      {users.data && everyone.length === 0 && <p className="text-sm text-ink-400">Nobody is here yet. A person appears the first time sign-in lets them in, or when you add them ahead of time.</p>}
      {person && <PersonDrawer user={person} shown={users.data?.people?.[person.email.toLowerCase()]} roles={roles} me={person.email === me} onViewAs={viewAs(person.email)} viewing={view.isPending} onClose={() => setOpen(null)} />}
    </section>
  )
}

/** How the people split across the lanes, as one bar and its key. */
function Mix({ lanes, total }: { lanes: Lane[]; total: number }) {
  return (
    <div className="space-y-2">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {lanes.map((l) => (
          <span key={l.id} style={{ flex: l.people.length, background: l.color }} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-ink-300">
        <span className="text-ink-100">{total === 1 ? '1 person' : `${total} people`}</span>
        {lanes.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden />
            {l.title} {l.people.length}
          </span>
        ))}
        <span className="inline-flex items-center gap-4 sm:ml-auto">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border-2" style={{ borderColor: RING.today }} aria-hidden />
            seen today
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border-2" style={{ borderColor: RING.week }} aria-hidden />
            this week
          </span>
        </span>
      </div>
    </div>
  )
}

/** A person: who, how lately, and "View as" right beside them. The card opens their drawer. */
function Card({ user, shown, domain, fresh, me, picked, onOpen, onViewAs, viewing }: { user: User; shown: PersonShown | undefined; domain: string; fresh: Fresh; me: boolean; picked: boolean; onOpen: () => void; onViewAs?: () => void; viewing: boolean }) {
  // A person the estate holds is called by their entity's name; anyone else by their address.
  const name = shown?.title ?? (domain && user.email.endsWith(domain) ? user.email.slice(0, -domain.length) : user.email)
  const seen = !user.firstSeenAt ? 'not signed in yet' : `seen ${user.lastSeenAt ? ago(user.lastSeenAt) : 'never'}`
  return (
    <div className={`flex items-center gap-2 rounded-lg border p-1.5 pr-2 ${picked ? 'border-orbit bg-orbit/10' : user.firstSeenAt ? 'border-ink-700 bg-ink-900/70 hover:border-ink-600' : 'border-dashed border-ink-600 hover:border-ink-500'}`}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 text-left" title={`${user.email}: their roles and what they may do`} onClick={onOpen}>
        <Initial email={user.email} icon={shown?.icon} ring={RING[fresh]} />
        <span className="min-w-0">
          <span className="block font-medium wrap-anywhere text-ink-100">{name}</span>
          <span className="block text-[12px] text-ink-400">
            {seen}
            {me && ' · you'}
          </span>
        </span>
      </button>
      {onViewAs && (
        <Button className="shrink-0" title={`See the whole hub as ${user.email} sees it, read-only, to check what your access rules show them`} onClick={onViewAs} disabled={viewing}>
          <Eye className="size-3.5" aria-hidden />
          View as
        </Button>
      )}
    </div>
  )
}

/** A person's mark: their picture where the estate holds them, else their address's first letter. */
function Initial({ email, icon, ring }: { email: string; icon?: string | null; ring: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-ink-800 text-[13px] font-semibold text-ink-200" style={{ boxShadow: `0 0 0 2px var(--color-ink-950), 0 0 0 4px ${ring}` }} aria-hidden>
      {icon ? <Icon name={icon} className={isPhoto(icon) ? 'size-8' : 'size-4'} /> : email.charAt(0).toUpperCase()}
    </span>
  )
}

/** A role's permissions as a strip of cells, one a permission, coloured by family where it holds it. */
function Strip({ permissions }: { permissions: readonly Permission[] }) {
  return (
    <span className="mt-1.5 flex gap-0.5" aria-hidden>
      {PERMISSION_FAMILIES.flatMap((f) => f.permissions.map((p) => <span key={p.id} className="h-1.5 flex-1 rounded-[2px] bg-ink-700" style={permissions.includes(p.id) ? { background: familyColor(f.id) } : undefined} />))}
    </span>
  )
}

/** One person: see as them, the roles they hold, and everything that adds up to. */
function PersonDrawer({ user, shown, roles, me, onViewAs, viewing, onClose }: { user: User; shown: PersonShown | undefined; roles: RoleDef[]; me: boolean; onViewAs?: () => void; viewing: boolean; onClose: () => void }) {
  const setRoles = useSetUserRoles()
  const remove = useRemoveUser()
  const giveable = roles.filter((r) => !r.locked)
  const name = user.email.slice(0, user.email.indexOf('@'))
  const held = new Set<Permission>(user.admin ? EVERY : roles.filter((r) => user.roles.includes(r.id)).flatMap((r) => r.permissions))
  const orphans = user.roles.filter((id) => !roles.some((r) => r.id === id))
  const subtitle = user.firstSeenAt ? `Enrolled ${when(user.firstSeenAt)} · seen ${user.lastSeenAt ? ago(user.lastSeenAt) : 'never'}` : 'Added here ahead of sign-in. Their roles take effect the first time sign-in lets them in.'
  return (
    <Drawer title={shown?.title ?? user.email} subtitle={shown ? `${user.email} · ${subtitle}` : subtitle} icon={<Initial email={user.email} icon={shown?.icon} ring="transparent" />} onClose={onClose} width={460}>
      <div className="space-y-6 p-4">
        <div className="flex gap-2">
          {onViewAs && (
            <Button kind="solid" className="flex-1 justify-center" onClick={onViewAs} disabled={viewing} title="See the whole hub as this person sees it, read-only, to check what your access rules show them">
              <Eye className="size-4" aria-hidden />
              View as {name}
            </Button>
          )}
          <Button kind="danger" title="Forget this person and the roles given to them. Sign-in still decides whether they get in: one who does is enrolled again with no roles" onClick={() => confirm(`Remove ${user.email} and their roles?`) && remove.mutate(user.email, { onSuccess: onClose })}>
            Remove
          </Button>
        </div>
        <ErrorNote error={setRoles.error ?? remove.error} />
        <div>
          <Kicker>Roles</Kicker>
          {user.admin && <p className="mt-1 text-sm text-ink-300">Sign-in makes {me ? 'you' : 'them'} an admin, which holds everything. That is changed where sign-in is managed, not here.</p>}
          <div className="mt-2 space-y-1.5">
            {giveable.map((r) => {
              const on = user.roles.includes(r.id)
              return (
                <label key={r.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${on ? 'border-orbit bg-orbit/10' : 'border-ink-700 hover:border-ink-600'}`}>
                  <input type="checkbox" className="mt-1 accent-orbit" checked={on} disabled={setRoles.isPending} onChange={() => setRoles.mutate({ email: user.email, roles: toggled(user.roles, r.id) })} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink-100">{r.title}</span>
                    {r.description && <span className="block text-[12px] text-ink-400">{r.description}</span>}
                    <Strip permissions={r.permissions} />
                  </span>
                </label>
              )
            })}
            {giveable.length === 0 && <p className="text-sm text-ink-400">No roles yet. Add one under "What each role allows".</p>}
            {orphans.map((id) => (
              <label key={id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-ink-600 px-3 py-2 text-sm text-ink-300" title="This role no longer exists and grants nothing">
                <input type="checkbox" checked disabled={setRoles.isPending} onChange={() => setRoles.mutate({ email: user.email, roles: toggled(user.roles, id) })} />
                <span>
                  <span className="font-mono text-[12px]">{id}</span> no longer exists
                </span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <Kicker>
            What {me ? 'you' : name} may do · {held.size} of {EVERY.length}
          </Kicker>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
            {PERMISSION_FAMILIES.map((f) => (
              <div key={f.id}>
                <div className="text-[12px] font-semibold" style={{ color: familyInk(f.id) }}>
                  {f.title}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {f.permissions.map((p) => {
                    const on = held.has(p.id)
                    return (
                      <li key={p.id} className={`flex items-center gap-2 text-[13px] ${on ? 'text-ink-100' : 'text-ink-500'}`} title={PERMISSIONS[p.id]}>
                        <span className={on ? 'size-2.5 shrink-0 rounded-[3px]' : 'mx-0.5 size-1.5 shrink-0 rounded-full bg-ink-600'} style={on ? { background: familyColor(f.id) } : undefined} aria-hidden />
                        <span className="sr-only">{on ? 'May' : 'May not'}:</span>
                        {p.short}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-400">Beside these, {me ? 'you read' : 'they read'} what the access rules let {me ? 'you' : 'them'} see.</p>
        </div>
      </div>
    </Drawer>
  )
}

/**
 * What every role allows, as one grid: a row a role, a column a permission,
 * the columns by family. A square changes at once. Where the grid has no
 * room, each role is its strip of cells, and opens to be changed.
 */
function RoleGrid({ roles }: { roles: RoleDef[] }) {
  const save = useSaveRole()
  const users = useUsers().data?.users ?? []
  const tokens = useTokens(useCan('tokens.manage')).data?.tokens
  const me = useWhoAmI().data?.identity
  const [open, setOpen] = useState<string | null>(null)
  const [f, setF] = useState({ id: '', title: '' })
  const who = (r: RoleDef) => {
    const n = users.filter((u) => (r.locked ? u.admin : u.roles.includes(r.id))).length
    const t = tokens?.filter((k) => k.role === r.id).length
    return `${n === 1 ? '1 person' : `${n} people`}${t === undefined ? '' : ` · ${t === 1 ? '1 token' : `${t} tokens`}`}`
  }
  const why = (r: RoleDef, p: Permission) => (r.locked ? 'The admin role is the hub\'s own: it holds every permission, and sign-in gives it' : !can(me, p) ? 'You do not hold this permission, so you cannot give or take it' : '')
  const flip = (r: RoleDef, p: Permission) => save.mutate({ id: r.id, title: r.title, description: r.description, permissions: r.permissions.includes(p) ? r.permissions.filter((x) => x !== p) : [...r.permissions, p] })
  const role = open ? roles.find((r) => r.id === open) : undefined
  return (
    <section className="@container space-y-3">
      <div>
        <h2 className="text-base font-semibold text-ink-100">What each role allows</h2>
        <p className="text-sm text-ink-400">
          <span className="@[60rem]:hidden">Open a role to change it.</span>
          <span className="hidden @[60rem]:inline">Click a square to give or take a permission; hover a column for what it means. Open a role to rename it or remove it.</span>
        </p>
      </div>
      <ErrorNote error={save.error} />
      <ul className="space-y-1.5 @[60rem]:hidden">
        {roles.map((r) => (
          <li key={r.id}>
            <button type="button" className="w-full rounded-lg border border-ink-700 bg-ink-900/70 px-3 py-2 text-left hover:border-ink-600" onClick={() => setOpen(r.id)}>
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-semibold text-ink-100">{r.title}</span>
                <span className="text-[12px] text-ink-400">
                  {r.permissions.length} of {EVERY.length} · {who(r)}
                </span>
              </span>
              <Strip permissions={r.permissions} />
            </button>
          </li>
        ))}
      </ul>
      <Panel className="hidden w-fit max-w-full overflow-x-auto px-4 pt-2 pb-3 @[60rem]:block">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th />
              {PERMISSION_FAMILIES.map((fam) => [
                <th key={`${fam.id}-gap`} className="w-2.5" />,
                <th key={fam.id} colSpan={fam.permissions.length} className="border-b-2 px-1 pt-2 pb-1 text-left text-[12px] font-semibold whitespace-nowrap" style={{ borderColor: familyColor(fam.id), color: familyInk(fam.id) }}>
                  {fam.title}
                </th>,
              ])}
              <th />
            </tr>
            <tr>
              <th />
              {PERMISSION_FAMILIES.map((fam) => [
                <th key={`${fam.id}-gap`} />,
                ...fam.permissions.map((p) => (
                  <th key={p.id} scope="col" title={`${PERMISSIONS[p.id]} (${p.id})`} className="h-32 py-1.5 text-left align-bottom text-[12px] font-normal whitespace-nowrap text-ink-300" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                    {p.short}
                  </th>
                )),
              ])}
              <th />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="group">
                <th scope="row" className="pr-4 text-left group-hover:bg-ink-850">
                  <button type="button" className="rounded-sm px-1 py-1 font-semibold whitespace-nowrap text-ink-100 hover:underline" title={r.description ?? 'Open to rename, describe, or remove it'} onClick={() => setOpen(r.id)}>
                    {r.title}
                  </button>
                </th>
                {PERMISSION_FAMILIES.map((fam) => [
                  <td key={`${fam.id}-gap`} className="group-hover:bg-ink-850" />,
                  ...fam.permissions.map((p) => {
                    const on = r.permissions.includes(p.id)
                    const off = why(r, p.id)
                    return (
                      <td key={p.id} className="size-8 p-0 text-center group-hover:bg-ink-850">
                        <button type="button" aria-pressed={on} aria-label={`${r.title}: ${p.short}`} title={off || PERMISSIONS[p.id]} disabled={!!off || save.isPending} onClick={() => flip(r, p.id)} className={`size-6 rounded-[5px] border align-middle ${off ? 'cursor-default' : 'cursor-pointer hover:border-ink-300'}`} style={on ? { background: familyColor(fam.id), borderColor: familyColor(fam.id) } : { borderColor: 'var(--color-edge)' }} />
                      </td>
                    )
                  }),
                ])}
                <td className="pl-4 text-[12px] whitespace-nowrap text-ink-400 group-hover:bg-ink-850">{who(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ id: f.id.trim(), title: f.title.trim(), permissions: [] }, { onSuccess: () => setF({ id: '', title: '' }) })
        }}
      >
        <input className={`${input} w-full font-mono sm:w-64`} aria-label="Role id" placeholder="id, like catalog-moderator" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} pattern="[a-z0-9][a-z0-9_-]*" required />
        <input className={`${input} w-full sm:w-64`} aria-label="Role title" placeholder="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
        <Button type="submit" disabled={save.isPending || f.id === ADMIN_ROLE}>
          <Plus className="size-3.5" aria-hidden />
          Add role
        </Button>
      </form>
      {role && <RoleDrawer role={role} who={who(role)} why={(p) => why(role, p)} onFlip={(p) => flip(role, p)} pending={save.isPending} onClose={() => setOpen(null)} />}
    </section>
  )
}

/** One role, changed where it is shown: a tick saves at once, a name saves when the field is left. */
function RoleDrawer({ role, who, why, onFlip, pending, onClose }: { role: RoleDef; who: string; why: (p: Permission) => string; onFlip: (p: Permission) => void; pending: boolean; onClose: () => void }) {
  const save = useSaveRole()
  const remove = useDeleteRole()
  const spec = { id: role.id, title: role.title, description: role.description, permissions: role.permissions }
  const locked = role.locked ? 'The admin role is the hub\'s own: it holds every permission, and sign-in gives it' : ''
  return (
    <Drawer title={role.title} subtitle={<span className="font-mono">{role.id}</span>} onClose={onClose} width={480}>
      <div className="space-y-5 p-4">
        <div className="space-y-2">
          <label className="block">
            <Kicker>Name</Kicker>
            <input key={`t:${role.title}`} className={`${input} mt-1 w-full font-semibold`} defaultValue={role.title} disabled={!!locked} title={locked || 'Click to rename'} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== role.title && save.mutate({ ...spec, title: e.target.value.trim() })} />
          </label>
          <label className="block">
            <Kicker>What it is for</Kicker>
            <textarea key={`d:${role.description ?? ''}`} rows={1} className={`${input} mt-1 block w-full field-sizing-content resize-none`} defaultValue={role.description ?? ''} placeholder="What this role is for" disabled={!!locked} title={locked || undefined} onBlur={(e) => e.target.value.trim() !== (role.description ?? '') && save.mutate({ ...spec, description: e.target.value.trim() || undefined })} />
          </label>
          <p className="text-[13px] text-ink-400">Held by {who}.</p>
        </div>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="space-y-4">
          {PERMISSION_FAMILIES.map((f) => (
            <fieldset key={f.id}>
              <legend className="text-[12px] font-semibold" style={{ color: familyInk(f.id) }}>
                {f.title}
              </legend>
              <div className="mt-1 space-y-1">
                {f.permissions.map((p) => {
                  const off = why(p.id)
                  return (
                    <label key={p.id} className={`flex items-start gap-2 text-sm ${off ? 'text-ink-500' : 'cursor-pointer text-ink-200'}`} title={off || undefined}>
                      <input type="checkbox" className="mt-1" style={{ accentColor: familyColor(f.id) }} checked={role.permissions.includes(p.id)} disabled={!!off || pending} onChange={() => onFlip(p.id)} />
                      <span>
                        {PERMISSIONS[p.id]}
                        <span className="ml-2 font-mono text-[12px] text-ink-500">{p.id}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>
        {!role.locked && (
          <Button kind="danger" onClick={() => confirm(`Remove role ${role.title}? People who hold it lose what it gives.`) && remove.mutate(role.id, { onSuccess: onClose })}>
            Remove role
          </Button>
        )}
      </div>
    </Drawer>
  )
}

function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((r) => r !== id) : [...list, id]
}

/** What each preview is called, and what opening it shows a person. */
const PREVIEW_TEXT: Record<PreviewName, { title: string; about: string }> = {
  garden: { title: 'Garden view', about: 'The ground under each kind in the sky: one bed for each entity, with its numbers against their budgets, where to go first, and what is coming. It adds the Ground page, the landing from the sky, and the ground settings of a blueprint.' },
  welcome: { title: 'Welcome tour', about: 'A tour of the hub on a person\'s first visit, which they can take again from their account menu, and the notes on each new release the first time they open it. It adds the tour\'s settings below.' },
}
const OPEN_TEXT: Record<PreviewSetting['open'], string> = { nobody: 'Nobody', people: 'The people named', everyone: 'Everyone' }

/** Whom a preview is open to, in a few words, for the folded line. */
function reach(setting: PreviewSetting): string {
  if (setting.open !== 'people') return setting.open
  return setting.people.length === 1 ? '1 person' : `${setting.people.length} people`
}

/**
 * Views that are built and not yet released. An admin opens each one to
 * nobody, to the people they name, or to everyone. Outside a preview nothing
 * of it is drawn, linked, or answered. Saved as it is changed.
 */
function PreviewsPanel() {
  const previews = usePreviews(true)
  const save = useSavePreviews()
  const users = useUsers()
  const me = useWhoAmI().data?.identity.name
  const [adding, setAdding] = useState<Partial<Record<PreviewName, string>>>({})
  const held = previews.data?.previews
  const set = (name: PreviewName, setting: PreviewSetting) => held && save.mutate({ ...held, [name]: setting })
  return (
    <Fold title="Previews" summary={held && PREVIEWS.map((name) => `${PREVIEW_TEXT[name].title}: ${reach(held[name])}`).join(' · ')}>
      <div className="space-y-4 px-4 py-3">
        <p className="max-w-3xl text-sm text-ink-400">A preview is a view that is built and not yet released. Open it to the people who should try it first. Everyone else sees the hub as it was: no page, no link, and no answer from the API. An admin is in a preview only when named, like anyone else.</p>
        <ErrorNote error={previews.error ?? save.error} />
        {held &&
          PREVIEWS.map((name) => {
            const setting = held[name]
            const text = PREVIEW_TEXT[name]
            const typed = (adding[name] ?? '').trim().toLowerCase()
            const known = (users.data?.users ?? []).map((u) => u.email).filter((email) => !setting.people.includes(email))
            const add = (email: string) => {
              if (!email || setting.people.includes(email)) return
              set(name, { open: 'people', people: [...setting.people, email] })
              setAdding({ ...adding, [name]: '' })
            }
            return (
              <fieldset key={name} className="max-w-3xl space-y-2">
                <legend className="text-sm font-semibold text-ink-100">{text.title}</legend>
                <p className="text-sm text-ink-400">{text.about}</p>
                <div role="radiogroup" aria-label={`${text.title} is open to`} className="flex flex-wrap gap-x-5 gap-y-1">
                  {(['nobody', 'people', 'everyone'] as const).map((open) => (
                    <label key={open} className="flex min-h-6 cursor-pointer items-center gap-1.5 text-sm text-ink-200">
                      <input type="radio" name={`preview-${name}`} checked={setting.open === open} disabled={save.isPending} onChange={() => set(name, { ...setting, open })} />
                      {OPEN_TEXT[open]}
                    </label>
                  ))}
                </div>
                {setting.open === 'everyone' && <p className="text-[13px] text-ink-300">Open to every person, every access token, and every source. This is the release.</p>}
                {setting.open !== 'everyone' && (
                  <>
                    <ul aria-label={`People ${text.title} is open to`} className="flex flex-wrap gap-1.5">
                      {setting.people.map((email) => (
                        <li key={email}>
                          <Badge className="border-ink-600 text-ink-200">
                            {email}
                            {email === me && <span className="text-ink-400">(you)</span>}
                            <button type="button" className="-mr-1.5 grid size-6 place-items-center rounded-full text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label={`Remove ${email}`} disabled={save.isPending} onClick={() => set(name, { ...setting, people: setting.people.filter((p) => p !== email) })}>
                              ×
                            </button>
                          </Badge>
                        </li>
                      ))}
                      {setting.people.length === 0 && <li className="text-[13px] text-ink-400">Nobody is named yet.</li>}
                    </ul>
                    {setting.open === 'nobody' && setting.people.length > 0 && <p className="text-[13px] text-ink-300">The names are kept. Pick "{OPEN_TEXT.people}" to open it to them.</p>}
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        add(typed)
                      }}
                    >
                      <input className={`${input} w-full sm:w-72`} type="email" list={`preview-${name}-known`} aria-label={`Add a person to ${text.title} by the address they sign in with`} placeholder="name@example.org" value={adding[name] ?? ''} onChange={(e) => setAdding({ ...adding, [name]: e.target.value })} required />
                      <datalist id={`preview-${name}-known`}>
                        {known.map((email) => (
                          <option key={email} value={email} />
                        ))}
                      </datalist>
                      <Button type="submit" disabled={save.isPending || !typed}>
                        Add person
                      </Button>
                      {me && !setting.people.includes(me) && (
                        <Button disabled={save.isPending} onClick={() => add(me)}>
                          Add me
                        </Button>
                      )}
                    </form>
                  </>
                )}
              </fieldset>
            )
          })}
      </div>
    </Fold>
  )
}

/**
 * Which entity a signed-in person is. Every access rule starts there and
 * follows relations to their teams, department, and anything else. The
 * blueprints it reads become an admin's alone, so nobody can grant
 * themselves access by editing them.
 */
function PersonEntity() {
  const settings = useAccessSettings()
  const blueprints = useBlueprints()
  const name = useBlueprintName()
  const save = useSetPerson()
  const person = settings.data?.person ?? null
  const list = blueprints.data?.blueprints ?? []
  const bp = list.find((b) => b.id === person?.blueprint)
  const emailFields = Object.entries(bp?.fields ?? {}).filter(([, f]) => f.type === 'email' || f.type === 'string' || f.type === 'array')
  const adminOnly = (settings.data?.adminOnly ?? []).map((id) => name(id))
  const paths = person ? ownsPaths(person.owns).length : 0
  const matched = person?.field ? `${bp?.fields[person.field]?.title ?? person.field} holds the sign-in address` : 'its key is the sign-in address'
  const summary = !settings.data ? undefined : !person ? 'Rules name people by address only' : [`${name(person.blueprint)}, ${matched}`, paths === 1 ? '1 ownership path' : `${paths} ownership paths`, adminOnly.length === 1 ? '1 blueprint only an admin changes' : `${adminOnly.length} blueprints only an admin changes`].join(' · ')
  return (
    <Fold title="Who a signed-in person is" summary={summary}>
      <div className="space-y-3 px-4 py-3">
        <p className="max-w-3xl text-sm text-ink-400">Access rules start from the person's own entity and follow relations from it, so a rule can name teams, a department, or people. Pick the blueprint that holds people, and how the hub finds the one that is the person signing in.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <Kicker>Blueprint</Kicker>
            <select className={`${input} mt-1 max-w-full`} value={person?.blueprint ?? ''} onChange={(e) => save.mutate(e.target.value ? { blueprint: e.target.value } : null)}>
              <option value="">none: rules name people by address only</option>
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  {name(b)}
                </option>
              ))}
            </select>
          </label>
          {person && (
            <label className="block">
              <Kicker>Matched by</Kicker>
              <select className={`${input} mt-1 max-w-full`} value={person.field ?? ''} onChange={(e) => save.mutate({ blueprint: person.blueprint, ...(e.target.value ? { field: e.target.value } : {}), ...(person.owns ? { owns: person.owns } : {}) })}>
                <option value="">its key is the sign-in address</option>
                {emailFields.map(([k, f]) => (
                  <option key={k} value={k}>
                    {f.title ?? k} holds the sign-in address
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {person && <Owns person={person} onSave={(owns) => save.mutate({ blueprint: person.blueprint, ...(person.field ? { field: person.field } : {}), ...(owns.length ? { owns } : {}) })} />}
        <ErrorNote error={settings.error ?? save.error} />
        {adminOnly.length > 0 && (
          <div>
            <Kicker>Only an admin changes these, because access is decided from them</Kicker>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {adminOnly.map((n) => (
                <li key={n}>
                  <Badge className="border-ink-600 text-ink-200">{n}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Fold>
  )
}

/** One line of what a person owns: `qa = <-qa_owner`, or a bare path. A path never holds `=`. */
const ownsLine = (o: OwnsPath): string => (o.as ? `${o.as} = ${o.path}` : o.path)

function parseOwns(text: string): (string | OwnsPath)[] {
  return text
    .split(/[,\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=')
      if (at < 0) return line
      const as = line.slice(0, at).trim()
      const path = line.slice(at + 1).trim()
      return as ? { as, path } : path
    })
}

/**
 * What a person owns: relation paths from their entity, each with how what it
 * reaches is theirs. Every page speaks to a person about what is theirs first,
 * so a dev or someone in finance lands on their own few things, not on
 * everything they may see. Saved when the field is left.
 */
function Owns({ person, onSave }: { person: PersonSetting; onSave: (owns: (string | OwnsPath)[]) => void }) {
  const held = ownsPaths(person.owns).map(ownsLine).join('\n')
  const [text, setText] = useState(held)
  const [was, setWas] = useState(held)
  if (held !== was) {
    setWas(held)
    setText(held)
  }
  const commit = () => {
    const owns = parseOwns(text)
    if (ownsPaths(owns).map(ownsLine).join('\n') !== held) onSave(owns)
  }
  return (
    <label className="block max-w-3xl">
      <Kicker>What a person owns</Kicker>
      <textarea className={`${input} mt-1 min-h-28 w-full font-mono`} value={text} placeholder={'owner = <-owner\nteam = <-lead.<-team\nteams.<-team'} onChange={(e) => setText(e.target.value)} onBlur={commit} spellCheck={false} />
      <span className="mt-1 block text-[12px] text-ink-400">
        One relation path from the person per line. Each reaches things that are theirs: <span className="font-mono">teams.&lt;-team</span> reaches everything their teams are named on. Put a word and <span className="font-mono">=</span> before a path to say how what it reaches is theirs, such as <span className="font-mono">qa = &lt;-qa_owner</span>; Now groups their things by it. Now and the command bar lead with what is theirs. Left empty, the hub says it does not know what is anyone's.
      </span>
    </label>
  )
}
