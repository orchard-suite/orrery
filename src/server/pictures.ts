// People's pictures: the photo a source puts for a person (an identity
// provider's profile photo), kept by the address they sign in with, and the
// icon a person picks for themselves in its place. The person entity that
// answers to the address shows the pick, else the photo, else its own icon.
// Who may set what, and what each write moves, lives here.

import { createHash } from 'node:crypto'
import { CUSTOM_ICON_NAME, ICON_NAMES, PHOTO_SIZES, photoName, type PhotoSize } from '../shared/icons.ts'
import { addressKey, type Entity, type EntityRef, type PersonSetting } from '../shared/model.ts'
import { fieldOf } from '../shared/filter.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'

/** What a picture write was refused for, with the status the API answers. */
export class PictureError extends Error {
  readonly status: 400 | 404 | 413 | 422
  constructor(status: PictureError['status'], message: string) {
    super(message)
    this.status = status
  }
}

/** What a person entity shows in place of its own icon, and why. */
export interface Face {
  icon: string
  picture: 'photo' | 'picked'
}

interface Kept {
  sha256: string | null
  source: string | null
  pick: string | null
}

const SET: ReadonlySet<string> = new Set(ICON_NAMES)

/** The width and height a JPEG says it is, from its first frame header, or null for bytes that are no JPEG. */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return null
  let at = 2
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return null
    const marker = data[at + 1]!
    // Fill bytes between markers.
    if (marker === 0xff) {
      at++
      continue
    }
    const length = (data[at + 2]! << 8) | data[at + 3]!
    // A start of frame: every SOFn but the huffman, arithmetic, and their kin.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: (data[at + 5]! << 8) | data[at + 6]!, width: (data[at + 7]! << 8) | data[at + 8]! }
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

/** Why these bytes cannot be a photo of this size, or null when they can. */
export function refusedPhoto(size: PhotoSize, data: Uint8Array): PictureError | null {
  const want = PHOTO_SIZES[size]
  if (data.length === 0) return new PictureError(422, `The ${size} photo is empty`)
  if (data.length > want.maxBytes) return new PictureError(413, `The ${size} photo is at most ${want.maxBytes / 1024} KiB; this one is ${Math.ceil(data.length / 1024)} KiB`)
  const got = jpegSize(data)
  if (!got) return new PictureError(422, `The ${size} photo is not a JPEG`)
  if (got.width !== want.px || got.height !== want.px) return new PictureError(422, `The ${size} photo is ${want.px}x${want.px}, not ${got.width}x${got.height}`)
  return null
}

/** The hash a photo is named by: of the small bytes, then the large. */
export function photoSha(small: Uint8Array, large: Uint8Array): string {
  return createHash('sha256').update(small).update(large).digest('hex')
}

export class Pictures {
  private readonly db: Db
  private readonly log: Logger
  private readonly kept = new Map<string, Kept>()
  /** The person setting: which blueprint holds people, and which field their address. The hub wires it. */
  person: () => PersonSetting | null = () => null
  /** The person entities that answer to an address. The hub wires it. */
  peopleOf: (address: string) => Promise<EntityRef[]> = async () => []
  /** Whether a name is a custom icon the hub holds. The hub wires it. */
  custom: (name: string) => boolean = () => false
  /** The deriver's queue: a picture moves what its person entity shows. The hub wires it. */
  queue: Queue = NO_QUEUE

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async load(): Promise<void> {
    const rows = await this.db.query<{ address: string; sha256: string | null; source: string | null; pick: string | null }>('SELECT address, sha256, source, pick FROM pictures')
    this.kept.clear()
    for (const r of rows.rows) this.kept.set(r.address, { sha256: r.sha256, source: r.source, pick: r.pick })
  }

  /** What an entity shows in place of its own icon: only a person entity, by the address it answers to, and only when its person has a pick or a photo. */
  of(e: Pick<Entity, 'blueprint' | 'key' | 'fields'>): Face | null {
    if (!this.kept.size) return null
    const p = this.person()
    if (!p || e.blueprint !== p.blueprint) return null
    const values = p.field ? fieldOf(e as Entity, p.field) : e.key
    for (const v of Array.isArray(values) ? values : [values]) {
      if (typeof v !== 'string') continue
      const k = this.kept.get(addressKey(v))
      if (k?.pick) return { icon: k.pick, picture: 'picked' }
      if (k?.sha256) return { icon: photoName(k.sha256), picture: 'photo' }
    }
    return null
  }

  /** Lays what a person entity shows over the entity: its icon and why. */
  lay(e: Entity): void {
    const face = this.of(e)
    if (!face) return
    e.icon = face.icon
    e.picture = face.picture
  }

  /** Which entities show a picture moved with the person setting: every entity of the blueprint before and after is derived again. */
  async personMoved(before: PersonSetting | null, after: PersonSetting | null): Promise<void> {
    if (!this.kept.size || (before?.blueprint === after?.blueprint && before?.field === after?.field)) return
    await this.queue.enqueueBlueprints(this.db, [before?.blueprint, after?.blueprint].filter((b): b is string => !!b))
  }

  /** A person's photo by their address, and their pick, as kept. */
  ofAddress(address: string): { photo: string | null; pick: string | null } {
    const k = this.kept.get(addressKey(address))
    return { photo: k?.sha256 ? photoName(k.sha256) : null, pick: k?.pick ?? null }
  }

  /** The photos a source put, by address. */
  photosOf(source: string): { address: string; sha256: string }[] {
    return [...this.kept].flatMap(([address, k]) => (k.source === source && k.sha256 ? [{ address, sha256: k.sha256 }] : [])).sort((a, b) => a.address.localeCompare(b.address))
  }

  /** The bytes of one size of a photo, by its hash, or null for none the hub holds. */
  async image(sha256: string, size: PhotoSize): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null
    const row = await this.db.query<{ data: Buffer }>(`SELECT ${size === 'large' ? 'large' : 'small'} AS data FROM pictures WHERE sha256 = $1 LIMIT 1`, [sha256])
    return row.rows[0] ? new Uint8Array(row.rows[0].data) : null
  }

  /**
   * Puts a person's photo, from a source. The same bytes from the same source
   * change nothing and write no row. Another source's photo of the same
   * person is replaced, with a warning, as a value another source wrote is.
   */
  async put(address: string, small: Uint8Array, large: Uint8Array, source: string): Promise<{ address: string; sha256: string; changed: boolean }> {
    const key = addressKey(address)
    if (!key) throw new PictureError(400, 'A photo names the address its person signs in with')
    const refused = refusedPhoto('small', small) ?? refusedPhoto('large', large)
    if (refused) {
      this.log.warn('photo refused', { address: key, source, small: small.length, large: large.length, reason: refused.message })
      throw refused
    }
    const sha256 = photoSha(small, large)
    const was = this.kept.get(key)
    if (was?.sha256 === sha256 && was.source === source) {
      this.log.debug('photo unchanged', { address: key, source })
      return { address: key, sha256, changed: false }
    }
    if (was?.source && was.source !== source) this.log.warn('photo taken over', { address: key, from: was.source, to: source })
    const people = await this.peopleOf(key)
    const at = new Date()
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO pictures (address, sha256, small, large, source, photo_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (address) DO UPDATE SET sha256 = EXCLUDED.sha256, small = EXCLUDED.small, large = EXCLUDED.large, source = EXCLUDED.source, photo_at = EXCLUDED.photo_at`,
        [key, sha256, Buffer.from(small), Buffer.from(large), source, at],
      )
      await this.queue.enqueue(client, people)
      await record(client, 'picture.changed', people[0] ?? null, source, null, { address: key, sha256, small: small.length, large: large.length, ...(was?.sha256 ? { was: { sha256: was.sha256, source: was.source } } : {}) }, at)
    })
    this.kept.set(key, { sha256, source, pick: was?.pick ?? null })
    this.log.info(was?.sha256 ? 'photo replaced' : 'photo added', { address: key, source, people: people.length })
    return { address: key, sha256, changed: true }
  }

  /** Removes the photo a source put for a person. A pick they made stays. */
  async remove(address: string, source: string): Promise<void> {
    const key = addressKey(address)
    const was = this.kept.get(key)
    if (!was?.sha256 || was.source !== source) throw new PictureError(404, `This source holds no photo of "${key}"`)
    const people = await this.peopleOf(key)
    await this.db.tx(async (client) => {
      if (was.pick) await client.query('UPDATE pictures SET sha256 = NULL, small = NULL, large = NULL, source = NULL, photo_at = NULL WHERE address = $1', [key])
      else await client.query('DELETE FROM pictures WHERE address = $1', [key])
      await this.queue.enqueue(client, people)
      await record(client, 'picture.removed', people[0] ?? null, source, null, { address: key, sha256: was.sha256 })
    })
    if (was.pick) this.kept.set(key, { sha256: null, source: null, pick: was.pick })
    else this.kept.delete(key)
    this.log.info('photo removed', { address: key, source, people: people.length })
  }

  /**
   * Sets the icon a person shows in place of their photo, or null to show
   * their photo again. Only an icon of the set or a custom icon may be
   * picked: never a photo, theirs or anyone's. Answers whether it changed.
   */
  async pick(address: string, icon: string | null): Promise<boolean> {
    const key = addressKey(address)
    if (icon !== null && !(SET.has(icon) || (CUSTOM_ICON_NAME.test(icon) && this.custom(icon)))) throw new PictureError(422, `"${icon}" is no icon the hub holds`)
    const was = this.kept.get(key)
    if ((was?.pick ?? null) === icon) return false
    const people = await this.peopleOf(key)
    const at = new Date()
    await this.db.tx(async (client) => {
      if (icon === null && !was?.sha256) await client.query('DELETE FROM pictures WHERE address = $1', [key])
      else await client.query(`INSERT INTO pictures (address, pick, picked_at) VALUES ($1, $2, $3) ON CONFLICT (address) DO UPDATE SET pick = EXCLUDED.pick, picked_at = EXCLUDED.picked_at`, [key, icon, at])
      await this.queue.enqueue(client, people)
      await record(client, 'picture.picked', people[0] ?? null, null, null, { icon, ...(was?.pick ? { was: was.pick } : {}) }, at)
    })
    if (icon === null && !was?.sha256) this.kept.delete(key)
    else this.kept.set(key, { sha256: was?.sha256 ?? null, source: was?.source ?? null, pick: icon })
    this.log.info(icon === null ? 'picture back to the photo' : 'picture picked', { address: key, icon, people: people.length })
    // What the person sees of themselves moves before the answer, as a hand edit does.
    await this.queue.inline(people)
    return true
  }
}
