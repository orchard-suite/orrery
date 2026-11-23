import { describe, expect, it } from 'vitest'
import type { RelationEnd } from '../shared/model.ts'
import { incomingRows } from './incoming.ts'

const end = (declaredOn: string, relation: string, key: string, title: string): RelationEnd => ({
  relation,
  declaredOn,
  target: { blueprint: declaredOn, key },
  targetTitle: key,
  targetIcon: null,
  pending: false,
  dangling: false,
  title,
  display: 'link',
  layer: 'pushed',
})

describe('what points here', () => {
  it('is one row per reverse title, split by the blueprint that points, the most first', () => {
    const rows = incomingRows([
      end('sw_service', 'owner', 'checkout', 'Owns'),
      end('azure_compute', 'owner', 'vm1', 'Owns'),
      end('azure_compute', 'owner', 'vm2', 'Owns'),
      end('team', 'lead', 'platform', 'Leads'),
    ])
    expect(rows.map((r) => [r.title, r.count])).toEqual([
      ['Owns', 3],
      ['Leads', 1],
    ])
    expect(rows[0]!.kinds.map((k) => [k.blueprint, k.ends.length])).toEqual([
      ['azure_compute', 2],
      ['sw_service', 1],
    ])
  })

  it('reads a relation with no reverse title by its fallback, apart from the others', () => {
    const rows = incomingRows([end('program', 'project_manager', 'p1', 'Project manager (incoming)'), end('program', 'product_owner', 'p1', 'Product owner (incoming)')])
    expect(rows.map((r) => r.title)).toEqual(['Project manager', 'Product owner'])
  })
})
