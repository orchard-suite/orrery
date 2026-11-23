// Vendors the brand marks named in src/shared/icons.ts into
// src/web/public/icons, one colour SVG each, so the app carries only what it
// shows and a mark dropped upstream stays in ours. Run `npm run icons` after
// adding a name to BRAND_ICONS.
//
// It also vendors Microsoft's whole Azure service icon pack, one `azure_`
// name per service, and writes those names to src/shared/azure-icons.ts.
//
// A mark drawn in black is repainted in the dark theme's ink. Each one also
// gets a copy in the light theme's ink under icons/light, and its name goes in
// src/shared/inked-icons.ts so the app knows to swap it.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as simple from 'simple-icons'
import * as simple11 from 'simple-icons-11'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Colour sets, each with its licence: SVG Logos (CC0), Devicon (MIT), VSCode Icons (MIT). */
const SETS = {
  logos: require('@iconify-json/logos/icons.json'),
  devicon: require('@iconify-json/devicon/icons.json'),
  vscode: require('@iconify-json/vscode-icons/icons.json'),
}
const mdi = require('@iconify-json/mdi/icons.json').icons
/**
 * One-path sets: simple-icons (CC0), filled with the brand's own colour, and
 * Material Design Icons (Apache 2.0). `si11` is an older simple-icons that
 * carries Microsoft's marks.
 */
const SIMPLE = {
  si: new Map(Object.values(simple).map((icon) => [icon.slug, icon])),
  si11: new Map(Object.values(simple11).map((icon) => [icon.slug, icon])),
  mdi: new Map(Object.entries(mdi).flatMap(([id, icon]) => {
    const path = /^<path [^>]*d="([^"]+)"\/>$/.exec(icon.body)?.[1]
    return path ? [[id, { path, hex: '000000' }]] : []
  })),
}

/**
 * Microsoft's Azure service icons, under Microsoft's terms of use for them.
 * The pack is not on npm, so it is fetched once into node_modules/.cache and
 * checked against this hash. To take a newer pack, change both.
 */
const AZURE_PACK = {
  url: 'https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V24.zip',
  sha256: '921594ccd1bf3d9c0a1bd7b6d924e050551a59342f2b353bb74bdcf761c35141',
}

/** Every icon in the pack by its service, as `app_services` for `10035-icon-service-App-Services.svg`. A service drawn twice keeps the higher-numbered, newer drawing. */
async function azurePack() {
  const dir = resolve(root, 'node_modules/.cache/azure-icons', AZURE_PACK.sha256)
  if (!existsSync(dir)) {
    const res = await fetch(AZURE_PACK.url)
    if (!res.ok) throw new Error(`azure icons: ${AZURE_PACK.url} answered ${res.status}`)
    const zip = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(zip).digest('hex')
    if (sha !== AZURE_PACK.sha256) throw new Error(`azure icons: the pack's sha256 is ${sha}, not the pinned one`)
    mkdirSync(dirname(dir), { recursive: true })
    writeFileSync(`${dir}.zip`, zip)
    execFileSync('unzip', ['-qo', `${dir}.zip`, '-d', `${dir}.tmp`])
    execFileSync('mv', [`${dir}.tmp`, dir])
    rmSync(`${dir}.zip`)
  }
  const found = new Map()
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const m = /(?:^|\/)(\d+)\s*-icon-service-([^/]+)\.svg$/.exec(file)
    if (!m) continue
    const id = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^azure_/, '')
    const number = Number(m[1])
    if (found.has(id) && found.get(id).number > number) continue
    const svg = readFileSync(resolve(dir, file), 'utf8').replace(/<title>[^<]*<\/title>/g, '').replace(/>\s+</g, '><').trim()
    found.set(id, { number, svg })
  }
  if (!found.size) throw new Error('azure icons: the pack holds no service icons')
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, { svg }]) => [id, svg]))
}
const azure = await azurePack()

/**
 * Where a brand comes from, as `<set>:<id>`. The `azure` set is the Azure
 * pack, by service. A name not listed here is
 * `logos:<name with dashes>`. In `logos` the `-icon` variant is taken when
 * there is one, since a wordmark is unreadable at icon size. A one-path
 * source may end in `#rrggbb` to set the fill.
 */
const SOURCES = {
  azure: 'logos:microsoft-azure',
  gcp: 'logos:google-cloud',
  digitalocean: 'logos:digital-ocean',
  scaleway: 'devicon:scaleway',
  windows: 'logos:microsoft-windows',
  linux: 'logos:linux-tux',
  rocky_linux: 'logos:rocky-linux',
  alma_linux: 'devicon:almalinux',
  alpine: 'si:alpinelinux',
  nixos: 'devicon:nixos',
  vsphere: 'devicon:vsphere',
  hyperv: 'devicon:hyperv',
  proxmox: 'devicon:proxmox',
  azure_devops: 'azure:devops',
  azure_pipelines: 'vscode:file-type-azurepipelines',
  lucid: 'si:lucid',
  azure_artifacts: 'si11:azureartifacts',
  azure_functions: 'azure:function_apps',
  azure_sql: 'azure:sql',
  azure_cosmos_db: 'azure:cosmos_db',
  azure_data_factory: 'azure:data_factories',
  azure_data_explorer: 'azure:data_explorer_clusters',
  power_bi: 'logos:microsoft-power-bi',
  power_apps: 'si11:powerapps#c153b5',
  power_automate: 'si11:powerautomate',
  powershell: 'devicon:powershell',
  csharp: 'logos:c-sharp',
  blazor: 'devicon:blazor',
  visual_studio: 'logos:visual-studio',
  vscode: 'logos:visual-studio-code',
  sql_server: 'devicon:microsoftsqlserver',
  teams: 'logos:microsoft-teams',
  sharepoint: 'si11:microsoftsharepoint#03a5a8',
  outlook: 'vscode:file-type-outlook',
  exchange: 'si11:microsoftexchange',
  office: 'mdi:microsoft-office#eb3c00',
  dynamics_365: 'si11:dynamics365#0b53ce',
  word: 'vscode:file-type-word',
  excel: 'vscode:file-type-excel',
  powerpoint: 'vscode:file-type-powerpoint',
  onenote: 'si11:microsoftonenote#b452d8',
  onedrive: 'logos:microsoft-onedrive',
  edge: 'logos:microsoft-edge',
  xbox: 'si11:xbox',
  aws_elasticache: 'logos:aws-elasticache',
  gmail: 'logos:google-gmail',
  cargo: 'vscode:file-type-cargo',
  k3s: 'devicon:k3s',
  talos: 'devicon:talos',
  argocd: 'devicon:argocd',
  flux: 'si:flux',
  podman: 'devicon:podman',
  containerd: 'si:containerd',
  harbor: 'devicon:harbor',
  portainer: 'devicon:portainer',
  istio: 'devicon:istio',
  cilium: 'si:cilium',
  longhorn: 'si:longhorn',
  ceph: 'devicon:ceph',
  vault_hashicorp: 'logos:vault',
  travis_ci: 'logos:travis-ci',
  backstage: 'si:backstage',
  renovate: 'logos:renovatebot',
  gitea: 'devicon:gitea',
  forgejo: 'devicon:forgejo',
  codeberg: 'devicon:codeberg',
  nuget: 'devicon:nuget',
  cpp: 'logos:c-plusplus',
  elixir: 'devicon:elixir',
  r: 'logos:r-lang',
  html: 'logos:html-5',
  css: 'logos:css-3',
  intellij: 'logos:intellij-idea',
  clickhouse: 'devicon:clickhouse',
  duckdb: 'devicon:duckdb',
  cockroachdb: 'si:cockroachlabs',
  timescale: 'si:timescale',
  pulsar: 'devicon:pulsar',
  mqtt: 'si:mqtt',
  minio: 'si:minio',
  flink: 'logos:apache-flink',
  loki: 'devicon:grafanaloki',
  jaeger: 'devicon:jaegertracing',
  victoriametrics: 'si:victoriametrics',
  fluentd: 'si:fluentd',
  icinga: 'devicon:icinga',
  uptime_kuma: 'si:uptimekuma',
  trivy: 'si:trivy',
  falco: 'si:falco',
  hackerone: 'logos:hacker-one',
  keycloak: 'si:keycloak',
  authentik: 'si:authentik',
  teleport: 'devicon:teleport',
  onepassword: 'si:1password',
  bitwarden: 'si:bitwarden',
  vaultwarden: 'si:vaultwarden',
  gemini: 'logos:google-gemini',
  mistral: 'logos:mistral-ai',
  grok: 'logos:x-ai',
  ollama: 'devicon:ollama',
  mcp: 'logos:model-context-protocol',
  apache: 'devicon:apache',
  haproxy: 'devicon:haproxy',
  traefik: 'devicon:traefikproxy',
  caddy: 'si:caddy',
  tailscale: 'si:tailscale',
  wireguard: 'devicon:wireguard',
  openvpn: 'si:openvpn',
  pihole: 'si:pihole',
  adguard: 'si:adguard',
  opnsense: 'devicon:opnsense',
  pfsense: 'devicon:pfsense',
  ubiquiti: 'si:ubiquiti',
  cisco: 'si:cisco',
  fortinet: 'si:fortinet',
  palo_alto: 'si:paloaltonetworks',
  mikrotik: 'si:mikrotik',
  synology: 'si:synology',
  qnap: 'si:qnap',
  truenas: 'si:truenas',
  veeam: 'si:veeam',
  dell: 'si:dell',
  hp: 'si:hp',
  lenovo: 'si:lenovo',
  home_assistant: 'si:homeassistant',
  esphome: 'si:esphome',
  node_red: 'devicon:nodered',
  plex: 'si:plex',
  jellyfin: 'si:jellyfin',
  nextcloud: 'si:nextcloud',
  akamai: 'si:akamai',
  algolia: 'si:algolia',
  envoy: 'si:envoyproxy',
  express: 'si:express',
  hubspot: 'si:hubspot',
  nvidia: 'si:nvidia',
  neovim: 'si:neovim',
  neo4j: 'si:neo4j',
  sonarqube: 'si:sonarqubeserver',
  lets_encrypt: 'si:letsencrypt',
  suse: 'si:suse#30ba78',
  solr: 'si:apachesolr',
  superset: 'si:apachesuperset',
  spark: 'si:apachespark',
  maven: 'si:apachemaven',
  stripe: 'si:stripe',
  ngrok: 'si:ngrok',
  macos: 'si:macos',
  fastly: 'si:fastly',
  mysql: 'si:mysql',
  yaml: 'si:yaml',
  amd: 'si:amd',
  sqlite: 'devicon:sqlite',
}

/** Marks drawn partly in black for a white page, whose dark parts are repainted in each theme's ink. */
const LIGHTEN = new Set(['aws'])

/** The ink a black mark takes on each theme: the brightest text of the dark one, the darkest of the light one. */
const INK = { dark: '#eaecf1', light: '#151a2a' }
const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi

function luminance(hex) {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const dark = (hex) => luminance(hex) < 0.05

function svgOf(name, ink) {
  const source = SOURCES[name] ?? `logos:${name.replaceAll('_', '-')}`
  const [, set, id, tint] = /^([a-z0-9]+):([^#]+)(#[0-9a-f]{6})?$/.exec(source)
  if (set === 'azure') {
    if (!azure.has(id)) throw new Error(`${name}: azure has no "${id}"`)
    return azure.get(id)
  }
  if (SIMPLE[set]) {
    const icon = SIMPLE[set].get(id)
    if (!icon) throw new Error(`${name}: ${set} has no "${id}"`)
    const fill = tint ?? `#${icon.hex.toLowerCase()}`
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${dark(fill) ? ink : fill}"><path d="${icon.path}"/></svg>`
  }
  const json = SETS[set]
  const icon = (set === 'logos' && json.icons[`${id}-icon`]) || json.icons[id]
  if (!icon) throw new Error(`${name}: ${set} has no "${id}"`)
  const colours = icon.body.match(HEX) ?? []
  // A mark with no colour but black is invisible on the dark theme, so it takes the ink.
  const repaint = LIGHTEN.has(name) || colours.every(dark)
  const body = (repaint ? icon.body.replace(HEX, (c) => (dark(c) ? ink : c)) : icon.body).replaceAll('currentColor', ink)
  const box = `${icon.left ?? 0} ${icon.top ?? 0} ${icon.width ?? json.width} ${icon.height ?? json.height}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"${repaint ? ` fill="${ink}"` : ''}>${body}</svg>`
}

const text = readFileSync(resolve(root, 'src/shared/icons.ts'), 'utf8')
const namesIn = (list) => [...new RegExp(`export const ${list} = \\[([\\s\\S]*?)\\] as const`).exec(text)[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
const names = namesIn('BRAND_ICONS')
const concepts = new Set(namesIn('CONCEPT_ICONS'))

const problems = [
  ...Object.keys(SOURCES).filter((n) => !names.includes(n)).map((n) => `${n}: a source without a name in BRAND_ICONS`),
  ...[...LIGHTEN].filter((n) => !names.includes(n)).map((n) => `${n}: lightened without a name in BRAND_ICONS`),
  ...names.filter((n, i) => names.indexOf(n) !== i).map((n) => `${n}: named twice in BRAND_ICONS`),
  ...names.filter((n) => concepts.has(n)).map((n) => `${n}: already a concept icon`),
]
const svgs = names.map((name) => {
  try {
    return { dark: svgOf(name, INK.dark), light: svgOf(name, INK.light) }
  } catch (err) {
    problems.push(err.message)
    return { dark: '', light: '' }
  }
})
const inked = names.filter((_, i) => svgs[i].dark !== svgs[i].light)
if (problems.length) throw new Error(problems.join('\n'))

// A service a brand name already stands for keeps that name alone.
const taken = new Set(names)
const azureIcons = [...azure].map(([id, svg]) => [`azure_${id}`, svg]).filter(([name]) => !taken.has(name))

const out = resolve(root, 'src/web/public/icons')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(resolve(out, 'light'))
names.forEach((name, i) => writeFileSync(resolve(out, `${name}.svg`), `${svgs[i].dark}\n`))
for (const name of inked) writeFileSync(resolve(out, 'light', `${name}.svg`), `${svgs[names.indexOf(name)].light}\n`)
for (const [name, svg] of azureIcons) writeFileSync(resolve(out, `${name}.svg`), `${svg}\n`)
writeFileSync(
  resolve(root, 'src/shared/azure-icons.ts'),
  `// Generated by scripts/brand-icons.mjs from Microsoft's Azure service icon pack. Do not edit: run \`npm run icons\`.\n\nexport const AZURE_ICONS = [\n${azureIcons.map(([name]) => `  '${name}',\n`).join('')}] as const\n`,
)
writeFileSync(
  resolve(root, 'src/shared/inked-icons.ts'),
  `// Generated by scripts/brand-icons.mjs. Do not edit: run \`npm run icons\`.\n\n/** Brand marks drawn in the theme's ink, each with a light theme copy under icons/light. */\nexport const INKED_ICONS = [\n${inked.map((name) => `  '${name}',\n`).join('')}] as const\n`,
)
const kB = (list) => Math.round(list.reduce((sum, svg) => sum + svg.length, 0) / 1024)
console.log(`wrote ${names.length} brand icons, ${kB(svgs.map((svg) => svg.dark))} kB, ${inked.length} of them inked, and ${azureIcons.length} azure icons, ${kB(azureIcons.map(([, svg]) => svg))} kB`)
