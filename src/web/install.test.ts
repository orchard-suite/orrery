import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A Home Screen or a desktop install reads the icon and the manifest the page names. A name that misses a file
// gives the device nothing to draw, and it draws a letter instead.
const web = new URL('./', import.meta.url)
const page = readFileSync(new URL('index.html', web), 'utf8')

/** A PNG's width and height, from its header. */
function size(path: string): string {
  const png = readFileSync(new URL(`public${path}`, web))
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

function linked(rel: string): string {
  const match = page.match(new RegExp(`<link rel="${rel}" href="([^"]+)"`))
  const href = match?.[1]
  if (!href) throw new Error(`index.html links no ${rel}`)
  return href
}

describe('installing the hub as an app', () => {
  it('names a 180 by 180 PNG for the iOS Home Screen', () => {
    expect(size(linked('apple-touch-icon'))).toBe('180x180')
  })

  it('names a manifest that opens standalone with icons of the sizes it says', () => {
    const manifest = JSON.parse(readFileSync(new URL(`public${linked('manifest')}`, web), 'utf8')) as {
      display: string
      start_url: string
      icons: { src: string; sizes: string }[]
    }
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
    for (const icon of manifest.icons) expect(size(icon.src)).toBe(icon.sizes)
  })
})
