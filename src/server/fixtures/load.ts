import { join } from 'node:path'
import { applyCatalog, type CatalogReport } from '../catalog.ts'
import type { Hub } from '../hub.ts'

/** Applies the test catalog beside this file the way a pulled git source would be, without a repo to pull. It is test data, not a model to copy. */
export async function loadFixtureCatalog(hub: Hub): Promise<CatalogReport> {
  const source = await hub.sources.save('catalog', { title: 'Catalog', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, grace: { runs: 1, duration: '0' }, git: { url: 'https://example.org/catalog.git', branch: 'main', glob: '**/*.yaml' } })
  return applyCatalog(hub, source, join(import.meta.dirname, 'catalog'), '**/*.yaml')
}
