// The icon set a blueprint's `icon` names, and the logo a link wears for the
// site it points into. This is the one place the hub names products: an
// icon is a picture, not a model. Concepts are drawn by
// the web app; brand marks are colour logos vendored by
// `scripts/brand-icons.mjs`, which also vendors Microsoft's Azure service
// icons and writes their names to `azure-icons.ts`.

import { AZURE_ICONS } from './azure-icons.ts'

export { AZURE_ICONS }

export const CONCEPT_ICONS = [
  // Shapes and software
  'box', 'cube', 'package', 'layers', 'stack', 'hexagon', 'circle', 'component', 'blocks', 'puzzle', 'app', 'service', 'api', 'webhook', 'code', 'terminal', 'bot', 'brain', 'sparkles',
  // Source and delivery
  'git', 'repository', 'branch', 'commit', 'pull_request', 'fork', 'merge', 'pipeline', 'rocket', 'release', 'environment', 'flask', 'container',
  // Compute, data, network
  'server', 'server_cog', 'vm', 'cpu', 'chip', 'memory', 'circuit', 'database', 'backup', 'disk', 'storage', 'archive', 'table', 'queue', 'cloud', 'cloud_cog', 'cluster', 'namespace', 'network', 'router', 'wifi', 'cable', 'globe', 'dns', 'gateway', 'load_balancer', 'firewall', 'vpn', 'plug', 'link', 'antenna',
  // People and structure
  'organization', 'department', 'team', 'person', 'role', 'contact', 'id', 'briefcase', 'handshake', 'building', 'factory', 'warehouse', 'store', 'location', 'home', 'map',
  // Security
  'shield', 'shield_check', 'vulnerability', 'lock', 'key', 'vault', 'fingerprint', 'certificate', 'secret', 'scan',
  // Operations
  'activity', 'health', 'chart', 'gauge', 'dashboard', 'radar', 'alert', 'bell', 'siren', 'incident', 'bug', 'warning', 'support', 'history', 'clock', 'timer', 'calendar', 'schedule',
  // Work and documents
  'folder', 'file', 'document', 'book', 'contract', 'checklist', 'clipboard', 'ticket', 'milestone', 'target', 'flag', 'tag', 'star', 'award', 'trophy', 'scale', 'megaphone', 'message', 'mail', 'search', 'eye',
  // Money
  'cost', 'wallet', 'receipt', 'bank', 'cart', 'truck',
  // Devices and the physical world
  'laptop', 'monitor', 'phone', 'printer', 'camera', 'tv', 'speaker', 'lightbulb', 'thermometer', 'sensor', 'switch', 'fan', 'door', 'power', 'battery', 'zap', 'sun', 'water', 'bluetooth', 'satellite', 'car',
  // Tools
  'settings', 'wrench', 'tool', 'upload', 'download', 'share',
] as const

export const BRAND_ICONS = [
  // Clouds and platforms
  'azure', 'aws', 'gcp', 'cloudflare', 'cloudflare_workers', 'digitalocean', 'heroku', 'vercel', 'netlify', 'fly', 'railway', 'linode', 'vultr', 'scaleway', 'openstack', 'openshift', 'oracle', 'ibm', 'sap', 'salesforce', 'akamai', 'fastly', 'microsoft', 'windows', 'apple', 'macos', 'ios', 'android', 'linux', 'ubuntu', 'debian', 'redhat', 'centos', 'fedora', 'rocky_linux', 'alma_linux', 'alpine', 'archlinux', 'nixos', 'suse', 'freebsd', 'raspberry_pi', 'vmware', 'vsphere', 'hyperv', 'proxmox',
  // Azure and Microsoft services
  'azure_devops', 'azure_pipelines', 'azure_artifacts', 'azure_functions', 'azure_sql', 'azure_cosmos_db', 'azure_data_factory', 'azure_data_explorer', 'power_bi', 'power_apps', 'power_automate', 'dynamics_365', 'powershell', 'dotnet', 'csharp', 'fsharp', 'blazor', 'visual_studio', 'vscode', 'sql_server', 'teams', 'sharepoint', 'outlook', 'exchange', 'office', 'word', 'excel', 'powerpoint', 'onenote', 'onedrive', 'edge', 'bing', 'skype', 'xbox', 'linkedin',
  // AWS services
  'aws_lambda', 'aws_s3', 'aws_ec2', 'aws_ecs', 'aws_eks', 'aws_fargate', 'aws_rds', 'aws_aurora', 'aws_dynamodb', 'aws_elasticache', 'aws_redshift', 'aws_sqs', 'aws_sns', 'aws_kinesis', 'aws_eventbridge', 'aws_step_functions', 'aws_api_gateway', 'aws_cloudfront', 'aws_route53', 'aws_vpc', 'aws_elb', 'aws_iam', 'aws_cognito', 'aws_kms', 'aws_secrets_manager', 'aws_cloudwatch', 'aws_cloudformation', 'aws_glue', 'aws_athena', 'aws_amplify',
  // Google
  'google', 'google_cloud_functions', 'google_cloud_run', 'firebase', 'gmail', 'google_drive', 'google_calendar', 'google_meet', 'google_analytics', 'google_maps', 'chrome',
  // Kubernetes and delivery
  'kubernetes', 'k3s', 'rancher', 'talos', 'helm', 'argocd', 'argo', 'flux', 'docker', 'podman', 'containerd', 'harbor', 'portainer', 'istio', 'linkerd', 'envoy', 'cilium', 'kong', 'longhorn', 'ceph', 'etcd', 'crossplane', 'terraform', 'pulumi', 'ansible', 'chef', 'puppet', 'saltstack', 'vault_hashicorp', 'hashicorp', 'consul', 'nomad', 'packer', 'vagrant', 'jenkins', 'octopus_deploy', 'circleci', 'travis_ci', 'teamcity', 'bamboo', 'buildkite', 'drone', 'spinnaker', 'harness', 'gocd', 'backstage', 'launchdarkly', 'jfrog', 'quay',
  // Forges and packages
  'github', 'github_actions', 'github_copilot', 'dependabot', 'renovate', 'gitlab', 'bitbucket', 'gitea', 'forgejo', 'codeberg', 'sourcegraph', 'npm', 'yarn', 'pnpm', 'bun', 'nuget', 'pypi', 'maven', 'gradle', 'rubygems', 'cargo', 'homebrew',
  // Languages and frameworks
  'go', 'python', 'nodejs', 'deno', 'typescript', 'javascript', 'java', 'kotlin', 'swift', 'rust', 'ruby', 'php', 'c', 'cpp', 'scala', 'elixir', 'erlang', 'haskell', 'lua', 'perl', 'r', 'dart', 'zig', 'bash', 'webassembly', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'astro', 'remix', 'solidjs', 'flutter', 'electron', 'tauri', 'tailwindcss', 'vite', 'webpack', 'html', 'css', 'sass', 'django', 'fastapi', 'rails', 'laravel', 'spring', 'express', 'nestjs', 'unity', 'wordpress', 'drupal', 'jupyter', 'numpy', 'pandas', 'pytorch', 'tensorflow',
  // APIs and tools
  'openapi', 'swagger', 'graphql', 'postman', 'insomnia', 'json', 'yaml', 'markdown', 'jetbrains', 'intellij', 'rider', 'neovim', 'vim', 'playwright', 'cypress', 'selenium', 'jest', 'vitest', 'storybook', 'eslint', 'prettier',
  // Data and messaging
  'postgresql', 'mysql', 'mariadb', 'sqlite', 'redis', 'valkey', 'memcached', 'mongodb', 'cassandra', 'couchdb', 'couchbase', 'neo4j', 'clickhouse', 'duckdb', 'cockroachdb', 'supabase', 'planetscale', 'neon', 'elasticsearch', 'opensearch', 'kibana', 'logstash', 'solr', 'meilisearch', 'algolia', 'influxdb', 'timescale', 'kafka', 'rabbitmq', 'nats', 'pulsar', 'mqtt', 'minio', 'databricks', 'snowflake', 'hadoop', 'spark', 'flink', 'airflow', 'dbt', 'tableau', 'looker', 'metabase', 'superset', 'prisma', 'hasura', 'qdrant', 'pinecone', 'milvus',
  // Observability and security
  'grafana', 'prometheus', 'loki', 'jaeger', 'victoriametrics', 'opentelemetry', 'datadog', 'new_relic', 'dynatrace', 'sentry', 'splunk', 'appdynamics', 'graylog', 'fluentd', 'zabbix', 'icinga', 'rollbar', 'bugsnag', 'pagerduty', 'opsgenie', 'statuspage', 'uptime_kuma', 'snyk', 'sonarqube', 'sonarcloud', 'trivy', 'falco', 'sigstore', 'hackerone', 'okta', 'auth0', 'keycloak', 'authentik', 'teleport', 'onepassword', 'bitwarden', 'vaultwarden', 'lets_encrypt',
  // Work
  'jira', 'confluence', 'atlassian', 'trello', 'linear', 'asana', 'monday', 'clickup', 'youtrack', 'lucid', 'notion', 'obsidian', 'airtable', 'slack', 'discord', 'zoom', 'telegram', 'whatsapp', 'signal', 'mattermost', 'rocket_chat', 'zulip', 'dropbox', 'figma', 'miro', 'loom', 'zendesk', 'intercom', 'hubspot', 'twilio', 'sendgrid', 'mailchimp', 'mailgun', 'stripe', 'paypal', 'shopify', 'zapier', 'n8n', 'ifttt', 'youtube', 'x', 'facebook', 'instagram', 'reddit', 'twitch', 'spotify', 'medium', 'stackoverflow',
  // AI
  'anthropic', 'claude', 'claude_code', 'openai', 'gemini', 'mistral', 'perplexity', 'deepseek', 'grok', 'meta', 'hugging_face', 'ollama', 'langchain', 'cursor', 'mcp', 'elevenlabs', 'midjourney', 'replit', 'nvidia',
  // Network, hardware, and home
  'nginx', 'apache', 'haproxy', 'traefik', 'caddy', 'ngrok', 'tailscale', 'wireguard', 'openvpn', 'pihole', 'adguard', 'opnsense', 'pfsense', 'ubiquiti', 'cisco', 'fortinet', 'palo_alto', 'mikrotik', 'synology', 'qnap', 'truenas', 'veeam', 'intel', 'amd', 'arm', 'dell', 'hp', 'lenovo', 'arduino', 'home_assistant', 'esphome', 'zigbee', 'zwave', 'node_red', 'plex', 'jellyfin', 'nextcloud',
] as const

export type ConceptIcon = (typeof CONCEPT_ICONS)[number]
export type BrandIcon = (typeof BRAND_ICONS)[number]
export type AzureIcon = (typeof AZURE_ICONS)[number]
export type IconName = ConceptIcon | BrandIcon | AzureIcon

export const ICON_NAMES: readonly IconName[] = [...CONCEPT_ICONS, ...BRAND_ICONS, ...AZURE_ICONS]

const NAMES: ReadonlySet<string> = new Set(ICON_NAMES)

/**
 * A custom icon is a picture an estate stores in the hub beside the set. Its
 * name is never one of the set's, nor starts `azure_`.
 */
export const CUSTOM_ICON_NAME = /^[a-z0-9][a-z0-9_]{0,62}$/
export const CUSTOM_ICON_TYPES = ['image/svg+xml', 'image/png', 'image/webp'] as const
export type CustomIconType = (typeof CUSTOM_ICON_TYPES)[number]
export const MAX_ICON_BYTES = 256 * 1024

/**
 * A person's photo is no icon of the set and no custom icon: the hub keeps it
 * by the person's sign-in address and names it by its bytes, `photo:<sha256>`,
 * so a new photo is a new name and an old one is cached for good. No picker
 * offers one: only the person's own entity shows it, and only they may pick it.
 * Each is kept in two sizes, one square JPEG each: `small` for every place a
 * person is drawn beside other things, `large` for their own page.
 */
export const PHOTO_PREFIX = 'photo:'
export const PHOTO_SIZES = { small: { px: 64, maxBytes: 16 * 1024 }, large: { px: 256, maxBytes: 64 * 1024 } } as const
export type PhotoSize = keyof typeof PHOTO_SIZES

export const photoName = (sha256: string): string => `${PHOTO_PREFIX}${sha256}`
export const isPhoto = (name: string | null | undefined): name is string => !!name && name.startsWith(PHOTO_PREFIX) && /^[0-9a-f]{64}$/.test(name.slice(PHOTO_PREFIX.length))

/**
 * Sites a link may point into, and the logo it wears there, as a host and
 * an optional path a link's must start with. A host matches itself and
 * every host under it; the first match wins, so a narrower entry comes
 * first. These are the consoles and tools people link to, not the hosts an
 * app is served from: a link to an app shows its address.
 */
const SITES: readonly (readonly [string, BrandIcon])[] = [
  ['dev.azure.com', 'azure_devops'],
  ['visualstudio.com', 'azure_devops'],
  ['portal.azure.com', 'azure'],
  ['azure.com', 'azure'],
  ['azure.microsoft.com', 'azure'],
  ['teams.microsoft.com', 'teams'],
  ['teams.cloud.microsoft', 'teams'],
  ['sharepoint.com', 'sharepoint'],
  ['app.powerbi.com', 'power_bi'],
  ['make.powerapps.com', 'power_apps'],
  ['make.powerautomate.com', 'power_automate'],
  ['outlook.office.com', 'outlook'],
  ['onedrive.live.com', 'onedrive'],
  ['office.com', 'office'],
  ['microsoft.com', 'microsoft'],
  ['console.aws.amazon.com', 'aws'],
  ['aws.amazon.com', 'aws'],
  ['console.cloud.google.com', 'gcp'],
  ['cloud.google.com', 'gcp'],
  ['docs.google.com', 'google_drive'],
  ['drive.google.com', 'google_drive'],
  ['calendar.google.com', 'google_calendar'],
  ['meet.google.com', 'google_meet'],
  ['mail.google.com', 'gmail'],
  ['github.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
  ['codeberg.org', 'codeberg'],
  ['atlassian.net/wiki', 'confluence'],
  ['atlassian.net', 'jira'],
  ['trello.com', 'trello'],
  ['linear.app', 'linear'],
  ['asana.com', 'asana'],
  ['monday.com', 'monday'],
  ['clickup.com', 'clickup'],
  ['youtrack.cloud', 'youtrack'],
  ['lucid.app', 'lucid'],
  ['lucidchart.com', 'lucid'],
  ['notion.so', 'notion'],
  ['notion.site', 'notion'],
  ['airtable.com', 'airtable'],
  ['figma.com', 'figma'],
  ['miro.com', 'miro'],
  ['loom.com', 'loom'],
  ['slack.com', 'slack'],
  ['discord.com', 'discord'],
  ['discord.gg', 'discord'],
  ['zoom.us', 'zoom'],
  ['dropbox.com', 'dropbox'],
  ['zendesk.com', 'zendesk'],
  ['hubspot.com', 'hubspot'],
  ['salesforce.com', 'salesforce'],
  ['dash.cloudflare.com', 'cloudflare'],
  ['vercel.com', 'vercel'],
  ['app.netlify.com', 'netlify'],
  ['dashboard.heroku.com', 'heroku'],
  ['cloud.digitalocean.com', 'digitalocean'],
  ['app.terraform.io', 'terraform'],
  ['hub.docker.com', 'docker'],
  ['npmjs.com', 'npm'],
  ['pypi.org', 'pypi'],
  ['nuget.org', 'nuget'],
  ['grafana.net', 'grafana'],
  ['datadoghq.com', 'datadog'],
  ['datadoghq.eu', 'datadog'],
  ['newrelic.com', 'new_relic'],
  ['sentry.io', 'sentry'],
  ['pagerduty.com', 'pagerduty'],
  ['opsgenie.com', 'opsgenie'],
  ['statuspage.io', 'statuspage'],
  ['snyk.io', 'snyk'],
  ['sonarcloud.io', 'sonarcloud'],
  ['okta.com', 'okta'],
  ['auth0.com', 'auth0'],
  ['stripe.com', 'stripe'],
  ['stackoverflow.com', 'stackoverflow'],
  ['youtube.com', 'youtube'],
  ['linkedin.com', 'linkedin'],
  ['claude.ai', 'claude'],
  ['chatgpt.com', 'openai'],
]

/** Tools an estate hosts under its own domain, by the host label they usually carry. */
const SELF_HOSTED: Readonly<Record<string, BrandIcon>> = Object.fromEntries(
  (
    [
      ['gitlab', 'gitlab'], ['github', 'github'], ['gitea', 'gitea'], ['forgejo', 'forgejo'], ['bitbucket', 'bitbucket'],
      ['grafana', 'grafana'], ['prometheus', 'prometheus'], ['loki', 'loki'], ['jaeger', 'jaeger'], ['kibana', 'kibana'],
      ['argocd', 'argocd'], ['argo', 'argocd'], ['jenkins', 'jenkins'], ['teamcity', 'teamcity'], ['sonarqube', 'sonarqube'], ['sonar', 'sonarqube'],
      ['harbor', 'harbor'], ['rancher', 'rancher'], ['portainer', 'portainer'], ['youtrack', 'youtrack'], ['jira', 'jira'], ['confluence', 'confluence'],
      ['sentry', 'sentry'], ['keycloak', 'keycloak'], ['authentik', 'authentik'], ['minio', 'minio'], ['zabbix', 'zabbix'], ['graylog', 'graylog'],
      ['backstage', 'backstage'], ['n8n', 'n8n'], ['mattermost', 'mattermost'], ['proxmox', 'proxmox'], ['traefik', 'traefik'],
    ] as const
  ).filter(([, icon]) => (BRAND_ICONS as readonly string[]).includes(icon)),
)

/** The logo of the site a link points into, or null when it is not one the hub knows. */
export function siteIcon(url: string): BrandIcon | null {
  let at: URL
  try {
    at = new URL(url)
  } catch {
    return null
  }
  const host = at.hostname.toLowerCase()
  for (const [site, icon] of SITES) {
    const slash = site.indexOf('/')
    const [domain, path] = slash < 0 ? [site, ''] : [site.slice(0, slash), site.slice(slash)]
    if ((host === domain || host.endsWith(`.${domain}`)) && at.pathname.startsWith(path)) return icon
  }
  // A tool people host themselves is found by the name its host carries: gitlab.example.org, grafana.example.org.
  for (const label of host.split('.')) {
    const icon = SELF_HOSTED[label]
    if (icon) return icon
  }
  return null
}

/** The mark a link is drawn as where there is no room for its address: its icon, or a plain link. Null only when the field turned icons off. */
export function linkMark(def: { icon?: string | false } | undefined, url: string): IconName | null {
  return def?.icon === false ? null : (linkIcon(def, url) ?? 'link')
}

/** The icon a name stands for in the set, or null for a name the set lacks. */
export function iconNamed(name: string | false | undefined): IconName | null {
  return name && NAMES.has(name) ? (name as IconName) : null
}

/** The links a url field's value holds: one, or a list. Anything that is not a link is left out. */
export function linksOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== '')
}

/**
 * What a link is called where it stands alone, beside no column that names
 * it: the name of the field that holds it. A field that holds several adds
 * each one's host, so they read apart; an address that is not a web address
 * is said as it is.
 */
export function linkLabel(name: string, url: string, many: boolean): string {
  if (!many) return name
  try {
    return `${name} · ${new URL(url).host}`
  } catch {
    return `${name} · ${url}`
  }
}

/**
 * The icon a link is drawn as, or null to show its address. A field that
 * names an icon from the set wears it, `false` turns icons off, and
 * otherwise a link wears its site's logo.
 */
export function linkIcon(def: { icon?: string | false } | undefined, url: string): IconName | null {
  if (def?.icon === false) return null
  const named = iconNamed(def?.icon)
  if (named) return named
  return siteIcon(url)
}
