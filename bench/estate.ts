// The estate the benchmarks push: every count fixed, every value derived from
// its index, so each run pushes the same thing. `scale` multiplies it.

export type Push = { blueprint: string; key: string; title: string; fields: Record<string, unknown>; relations?: Record<string, string | string[]> }


const pick = <T>(list: T[], i: number): T => list[i % list.length]!
const day = 86_400_000
const at = (i: number) => new Date(Date.UTC(2026, 9, 1) - (i % 120) * day).toISOString()

export function estate(scale: number): Push[] {
  const n = (count: number) => Math.max(1, Math.round(count * scale))
  const out: Push[] = []
  const systems = Array.from({ length: n(200) }, (_, i) => `sys-${i}`)
  for (const [i, key] of systems.entries()) out.push({ blueprint: 'system', key, title: `System ${i}`, fields: { description: i % 3 ? `What system ${i} does` : null, tier: pick(['critical', 'important', 'standard', 'experimental'], i), repo: i % 2 ? `https://git.example.org/${key}` : null } })
  const envs = ['dev', 'test', 'staging', 'prod', 'dr']
  for (const e of envs) out.push({ blueprint: 'environment', key: e, title: e, fields: { type: e === 'prod' || e === 'dr' ? 'production' : e === 'staging' ? 'staging' : e === 'test' ? 'test' : 'development' } })
  const repos = Array.from({ length: n(2000) }, (_, i) => `repo-${i}`)
  for (const [i, key] of repos.entries()) out.push({ blueprint: 'repository', key, title: key, fields: { name: key, url: `https://git.example.org/${key}`, language: pick(['Go', 'TypeScript', 'C#', 'Python', 'Rust'], i), has_readme: i % 4 !== 0, has_ci: i % 5 !== 0, last_push: at(i), health: pick(['green', 'green', 'amber', 'red'], i) } })
  const services = repos.map((r) => r)
  for (const [i, key] of services.entries()) out.push({ blueprint: 'service', key, title: `Service ${i}`, fields: { description: i % 2 ? `Service ${i}` : null, tier: pick(['mission_critical', 'customer_facing', 'internal', 'other'], i), lifecycle: pick(['production', 'experimental', 'deprecated'], i) }, relations: { system: pick(systems, i) } })
  for (const [i, key] of services.entries()) out.push({ blueprint: 'workload', key, title: `${key} in ${pick(envs, i)}`, fields: {}, relations: { environment: pick(envs, i) } })
  const clusters = Array.from({ length: n(10) }, (_, i) => `c${i}`)
  for (const c of clusters) out.push({ blueprint: 'k8s_cluster', key: c, title: c, fields: { version: '1.31', api_url: `https://${c}.example.org` } })
  const nodes = Array.from({ length: n(300) }, (_, i) => `${pick(clusters, i)}/node-${i}`)
  for (const [i, key] of nodes.entries()) out.push({ blueprint: 'k8s_node', key, title: key, fields: { cpu: 16, memory_gb: 64, ready: i % 50 !== 0, health: i % 50 ? 'green' : 'red', health_reason: i % 50 ? null : 'not ready' }, relations: { cluster: key.split('/')[0]! } })
  const namespaces = Array.from({ length: n(1000) }, (_, i) => `${pick(clusters, i)}/${pick(systems, i)}-${i}`)
  for (const [i, key] of namespaces.entries()) out.push({ blueprint: 'k8s_namespace', key, title: key.split('/')[1]!, fields: { name: pick(systems, i), phase: 'Active', labels: { team: `team-${i % 30}` } }, relations: { cluster: key.split('/')[0]! } })
  const workloads = Array.from({ length: n(8000) }, (_, i) => `${pick(namespaces, i)}/${pick(services, i)}-${i}`)
  for (const [i, key] of workloads.entries()) {
    const replicas = 1 + (i % 4)
    const ready = i % 37 ? replicas : 0
    out.push({ blueprint: 'k8s_workload', key, title: pick(services, i), fields: { name: pick(services, i), kind: pick(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'], i), replicas, ready, health: ready === replicas ? 'green' : 'red', health_reason: ready === replicas ? null : 'no replica ready', images: [`registry.example.org/${pick(services, i)}:1.${i % 9}`], labels: { 'app.kubernetes.io/part-of': pick(systems, i) }, created_at: at(i) }, relations: { namespace: pick(namespaces, i), node: [pick(nodes, i), pick(nodes, i + 7)] } })
  }
  for (let i = 0; i < n(12000); i++) {
    const w = pick(workloads, i)
    out.push({ blueprint: 'k8s_pod', key: `${w}-${i}`, title: `${w.split('/').at(-1)}-${i}`, fields: { phase: 'Running', ready: i % 41 !== 0, restarts: i % 7, health: i % 41 ? 'green' : 'amber', started_at: at(i) }, relations: { workload: w, node: pick(nodes, i), namespace: w.split('/').slice(0, 2).join('/') } })
  }
  for (let i = 0; i < n(3000); i++) {
    const ns = pick(namespaces, i)
    out.push({ blueprint: 'k8s_service', key: `${ns}/svc-${i}`, title: `svc-${i}`, fields: { type: 'ClusterIP', cluster_ip: `10.0.${i % 250}.${i % 200}` }, relations: { namespace: ns, workloads: [pick(workloads, i), pick(workloads, i + 1000)] } })
  }
  const apps = Array.from({ length: n(2000) }, (_, i) => pick(services, i))
  for (const [i, key] of apps.entries()) out.push({ blueprint: 'argocd_app', key, title: key, fields: { project: 'default', repo_url: `https://git.example.org/${pick(repos, i)}`, sync_status: i % 13 ? 'Synced' : 'OutOfSync', health_status: 'Healthy', health: i % 13 ? 'green' : 'amber' }, relations: { cluster: pick(clusters, i), namespace: pick(namespaces, i) } })
  for (let i = 0; i < n(6000); i++) out.push({ blueprint: 'sw_deployment', key: `dep-${i}`, title: `deploy ${i}`, fields: { status: i % 9 ? 'succeeded' : 'failed', revision: `r${i}`, deployed_at: at(i), duration_seconds: 30 + (i % 90), automated: i % 2 === 0 }, relations: { app: pick(apps, i) } })
  return out
}

