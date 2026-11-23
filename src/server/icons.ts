// Custom icons: pictures an estate brings beyond the built-in set, stored in
// the hub and drawn wherever an icon name is drawn. Every check on what an
// icon may hold, who owns one, and what a write changes lives here.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CustomIcon } from '../shared/api.ts'
import { AZURE_ICONS, BRAND_ICONS, CUSTOM_ICON_NAME, CUSTOM_ICON_TYPES, ICON_NAMES, MAX_ICON_BYTES, type CustomIconType } from '../shared/icons.ts'
import { INKED_ICONS } from '../shared/inked-icons.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'

/** What an icon write was refused for, with the status the API answers. */
export class IconError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415 | 422
  constructor(status: IconError['status'], message: string) {
    super(message)
    this.status = status
  }
}

/** An icon's bytes as the API serves them. */
export interface IconImage {
  type: CustomIconType
  data: Uint8Array<ArrayBuffer>
  sha256: string
}

/** The owner of an icon a git source loaded. */
export const gitOwner = (source: string): string => `git:${source}`
const isGit = (owner: string) => owner.startsWith('git:')

const BUILT_IN: ReadonlySet<string> = new Set(ICON_NAMES)
const BRAND_FILES: ReadonlySet<string> = new Set([...BRAND_ICONS, ...AZURE_ICONS])
const INKED: ReadonlySet<string> = new Set(INKED_ICONS)
const EXTENSION_TYPES: Readonly<Record<string, CustomIconType>> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }

/** The type an icon file is, by its extension, or null for a file that is not an icon. */
export function iconTypeOf(file: string): CustomIconType | null {
  return EXTENSION_TYPES[extname(file).toLowerCase()] ?? null
}

/** Why a name cannot be a custom icon, or null when it can. */
export function refusedName(name: string): IconError | null {
  if (!CUSTOM_ICON_NAME.test(name)) return new IconError(400, `"${name}" is not an icon name: lowercase letters, digits, and underscores, starting with a letter or digit, at most 63`)
  if (BUILT_IN.has(name) || name.startsWith('azure_')) return new IconError(409, `"${name}" is a built-in icon: pick another name`)
  return null
}

const SVG_REFUSED: readonly (readonly [RegExp, string])[] = [
  [/<script/i, 'a script'],
  [/<foreignObject/i, 'a foreignObject'],
  [/javascript:/i, 'a javascript: address'],
  [/[\s"'/]on[a-z]+\s*=/i, 'an event handler attribute'],
  // An internal entity expands when the file is parsed, so it could carry any of the above past these checks.
  [/<!ENTITY/i, 'an entity declaration'],
]

/** Why these bytes cannot be an icon of this type, or null when they can. */
export function refusedImage(type: string, data: Uint8Array): IconError | null {
  if (!(CUSTOM_ICON_TYPES as readonly string[]).includes(type)) return new IconError(415, `An icon is ${CUSTOM_ICON_TYPES.join(', ')}, not "${type || 'nothing'}"`)
  if (data.length === 0) return new IconError(422, 'The icon is empty')
  if (data.length > MAX_ICON_BYTES) return new IconError(413, `An icon is at most ${MAX_ICON_BYTES / 1024} KiB; this one is ${Math.ceil(data.length / 1024)} KiB`)
  if (type === 'image/png' && !startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return new IconError(422, 'This is not a PNG')
  if (type === 'image/webp' && !(startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50]))) return new IconError(422, 'This is not a WebP image')
  if (type === 'image/svg+xml') {
    const text = new TextDecoder().decode(data)
    if (!/<svg[\s>]/i.test(text)) return new IconError(422, 'This is not an SVG')
    for (const [pattern, what] of SVG_REFUSED) if (pattern.test(text)) return new IconError(422, `An SVG icon may not hold ${what}`)
    for (const m of text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const target = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (!target.startsWith('#') && !target.startsWith('data:image/')) return new IconError(422, `An SVG icon links only within itself or to a data:image/ address, not "${target.slice(0, 60)}"`)
    }
  }
  return null
}

function startsWith(data: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => data[i] === b)
}

interface Row {
  name: string
  type: CustomIconType
  data: Buffer
  sha256: string
  owner: string
  updated_at: Date
}

interface Kept extends IconImage {
  name: string
  owner: string
  updatedAt: string
}

export class Icons {
  private readonly db: Db
  private readonly events: Events
  private readonly log: Logger
  /** Where the built-in brand files are, with their light theme copies under `light/`. */
  private readonly brandDir: string | null
  private readonly kept = new Map<string, Kept>()
  private readonly brands = new Map<string, Promise<IconImage | null>>()

  constructor(db: Db, events: Events, log: Logger, brandDir: string | null) {
    this.db = db
    this.events = events
    this.log = log
    this.brandDir = brandDir
  }

  async load(): Promise<void> {
    const rows = await this.db.query<Row>('SELECT name, type, data, sha256, owner, updated_at FROM icons')
    this.kept.clear()
    for (const r of rows.rows) this.kept.set(r.name, { name: r.name, type: r.type, data: new Uint8Array(r.data), sha256: r.sha256, owner: r.owner, updatedAt: r.updated_at.toISOString() })
  }

  /** True for a custom icon the hub holds. */
  has(name: string): boolean {
    return this.kept.has(name)
  }

  /** The names of every custom icon the hub holds. */
  names(): string[] {
    return [...this.kept.keys()]
  }

  list(): CustomIcon[] {
    return [...this.kept.values()].sort((a, b) => a.name.localeCompare(b.name)).map((icon) => this.summary(icon))
  }

  /**
   * Stores an icon. The same bytes from the same owner change nothing and
   * write no row. Git wins: nobody but a git source replaces an icon a git
   * source owns, and a git source replaces anyone's.
   */
  async put(name: string, type: string, data: Uint8Array, owner: string): Promise<{ icon: CustomIcon; changed: boolean }> {
    const refused = refusedName(name) ?? refusedImage(type, data)
    if (refused) {
      this.log.warn('icon refused', { name, type, size: data.length, owner, reason: refused.message })
      throw refused
    }
    const was = this.kept.get(name)
    if (was && isGit(was.owner) && !isGit(owner)) {
      this.log.warn('icon refused: set in git', { name, owner, holder: was.owner })
      throw new IconError(409, `The icon "${name}" is set in git by ${was.owner.slice(4)}: change it there`)
    }
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (was && was.sha256 === sha256 && was.type === type && was.owner === owner) {
      this.log.debug('icon unchanged', { name, owner })
      return { icon: this.summary(was), changed: false }
    }
    if (was && was.owner !== owner) this.log.warn('icon taken over', { name, from: was.owner, to: owner })
    const at = new Date()
    await this.db.query(
      `INSERT INTO icons (name, type, data, sha256, owner, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, owner = EXCLUDED.owner, updated_at = EXCLUDED.updated_at`,
      [name, type, Buffer.from(data), sha256, owner, at],
    )
    const kept: Kept = { name, type: type as CustomIconType, data: new Uint8Array(data), sha256, owner, updatedAt: at.toISOString() }
    this.kept.set(name, kept)
    await record(this.db, 'icon.changed', null, isGit(owner) ? owner.slice(4) : null, null, { icon: name, type, size: data.length, sha256, owner, ...(was ? { was: { sha256: was.sha256, owner: was.owner } } : {}) }, at)
    this.log.info(was ? 'icon replaced' : 'icon added', { name, type, size: data.length, owner })
    this.events.emit({ type: 'icons' })
    return { icon: this.summary(kept), changed: true }
  }

  async remove(name: string): Promise<void> {
    const was = this.kept.get(name)
    if (!was) throw new IconError(404, `No custom icon is called "${name}"`)
    await this.db.query('DELETE FROM icons WHERE name = $1', [name])
    this.kept.delete(name)
    await record(this.db, 'icon.removed', null, isGit(was.owner) ? was.owner.slice(4) : null, null, { icon: name, owner: was.owner, sha256: was.sha256 })
    this.log.info('icon removed', { name, owner: was.owner })
    this.events.emit({ type: 'icons' })
  }

  /** The image an icon name is served as: the custom icon, else the built-in brand file. Null for a concept or an unknown name. */
  async image(name: string, theme: 'dark' | 'light'): Promise<IconImage | null> {
    const custom = this.kept.get(name)
    if (custom) return custom
    if (!BRAND_FILES.has(name) || !this.brandDir) return null
    const file = theme === 'light' && INKED.has(name) ? `light/${name}` : name
    let image = this.brands.get(file)
    if (!image) {
      image = readFile(join(this.brandDir, `${file}.svg`)).then(
        (data) => ({ type: 'image/svg+xml' as const, data: new Uint8Array(data), sha256: createHash('sha256').update(data).digest('hex') }),
        () => null,
      )
      this.brands.set(file, image)
    }
    return image
  }

  /**
   * Loads a git source's icons: every `icons/<name>.svg|png|webp` beside its
   * catalog files, owned by the source. An icon the source owns that is no
   * longer in the repository is removed. Answers what could not be loaded.
   */
  async syncGit(source: string, root: string, catalogDirs: readonly string[]): Promise<{ file: string; reason: string }[]> {
    const owner = gitOwner(source)
    const errors: { file: string; reason: string }[] = []
    const seen = new Set<string>()
    for (const dir of [...new Set(catalogDirs)].sort()) {
      const iconsDir = join(root, dir, 'icons')
      if (!existsSync(iconsDir)) continue
      for (const entry of (await readdir(iconsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const type = entry.isFile() ? iconTypeOf(entry.name) : null
        if (!type) continue
        const file = join(dir, 'icons', entry.name)
        const name = entry.name.slice(0, -extname(entry.name).length)
        if (seen.has(name)) {
          errors.push({ file, reason: `icon ${name}: another file in this repository already names it` })
          continue
        }
        // A file that is there but cannot be taken keeps the last good picture: it is reported, not removed.
        seen.add(name)
        try {
          await this.put(name, type, new Uint8Array(await readFile(join(root, file))), owner)
        } catch (error) {
          errors.push({ file, reason: `icon ${name}: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
    for (const icon of [...this.kept.values()]) {
      if (icon.owner !== owner || seen.has(icon.name)) continue
      this.log.info('icon removed from git', { name: icon.name, source })
      await this.remove(icon.name)
    }
    return errors
  }

  private summary(icon: Kept): CustomIcon {
    return { name: icon.name, type: icon.type, sha256: icon.sha256, size: icon.data.length, owner: icon.owner, updatedAt: icon.updatedAt }
  }
}
