// The modelling guide, served to people and agents so both estates read the same conventions from the hub they use.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const GUIDE_PATH = resolve(import.meta.dirname, '../../docs/modelling.md')

let cached: Promise<string> | undefined

export function modellingGuide(): Promise<string> {
  cached ??= readFile(GUIDE_PATH, 'utf8')
  return cached
}
