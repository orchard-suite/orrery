import { z } from 'zod'
import { parseDelegates } from './behalf.ts'

const schema = z.object({
  /** Session surface: browsers arrive here through the login proxy, which sets the identity headers. */
  PORT: z.coerce.number().int().positive().default(8080),
  /** Machine surface: pushers, runners, and agents arrive here with a bearer token. Identity headers are never trusted. */
  INGEST_PORT: z.coerce.number().int().positive().default(8081),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().default('postgres://orrery:orrery@localhost:5433/orrery'),
  /**
   * How the hub signs in to the database. `password` uses the one in `DATABASE_URL`. `azure` signs in as the pod's
   * workload identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`), with an Entra token for
   * Azure Database for PostgreSQL as the password; the URL then names the role and carries `sslmode=require`.
   */
  DATABASE_AUTH: z.enum(['password', 'azure']).default('password'),
  /** How many Postgres connections the hub holds at most. Size it to the pod: two hubs serve during a rollout, and each takes this many. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Seconds one statement may run before Postgres ends it, so one slow query never holds every request behind it. Migrations are not bound by it. */
  DATABASE_STATEMENT_SECONDS: z.coerce.number().positive().default(60),
  /**
   * What this hub does. `all` serves and runs the background work, as one hub alone does. `api` only serves: it never
   * takes the lead, so nothing it answers waits behind a background pass. `worker` runs the background work; give it
   * no traffic. An `api` hub needs a `worker` or an `all` hub on the same database.
   */
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** Seconds between the leader's passes over the derive queue: what a write marked is derived and stored within this. */
  DERIVE_EVERY_SECONDS: z.coerce.number().positive().default(2),
  /** Seconds between re-derivations of the blueprints whose values read the clock: ages, windows, trends. */
  DERIVE_CLOCK_SECONDS: z.coerce.number().positive().default(60),
  /** A write of at most this many entities is derived on the request before it answers, so a hand edit shows at once. */
  DERIVE_INLINE_MAX: z.coerce.number().int().min(0).default(50),
  /** How many queued entities one pass takes at a time. */
  DERIVE_BATCH: z.coerce.number().int().positive().default(2000),
  /** Milliseconds one drain pass may spend before it yields to the next tick. */
  DERIVE_BUDGET_MS: z.coerce.number().positive().default(1500),
  /**
   * `proxy` takes the person on the session port from the login proxy, and enrolls each person it lets in. With
   * `AUTH_ISSUER` set it reads them from the signed ID token the proxy passes in `Authorization`, so a caller that
   * reaches the port around the proxy is refused; without it, from X-Forwarded-Email and X-Forwarded-Groups.
   * `none` treats every session request as an admin, for local runs.
   */
  AUTH_MODE: z.enum(['proxy', 'none']).default('none'),
  /** The OIDC issuer whose ID tokens the login proxy passes on, e.g. `https://login.microsoftonline.com/<tenant>/v2.0`. */
  AUTH_ISSUER: z.string().url().optional(),
  /** The audience those ID tokens carry: the login proxy's client id. Required with `AUTH_ISSUER`. */
  AUTH_AUDIENCE: z.string().optional(),
  /**
   * A scope the issuer's apps ask for to call the hub as a person, such as `access_as_user`. With it set, the machine
   * port also takes the issuer's access tokens for `AUTH_AUDIENCE` that carry this scope, as the person they name, with
   * the roles the token gives them. Another app, such as a chat bot, then acts as the person who used it, never as itself.
   */
  AUTH_API_SCOPE: z.string().optional(),
  /**
   * The APIs the hub may call as the person who asked, as JSON by name:
   * `{"ops":{"scope":"api://ops/.default","urls":["https://ops.example.org/"]}}`. A webhook action names one as
   * `onBehalf`; the hub trades the person's own access token for one with that scope (the on-behalf-of grant, as the
   * pod's workload identity) and sends it only to a URL the delegate lists. Needs `AUTH_API_SCOPE`; on the session
   * port the login proxy must pass the person's access token for the hub in `X-Forwarded-Access-Token`.
   */
  AUTH_DELEGATES: z.string().optional(),
  /**
   * `true` keeps the session port on X-Forwarded-Email and X-Forwarded-Groups with `AUTH_ISSUER` set, for a front door
   * that passes no ID token: the issuer then serves only `AUTH_API_SCOPE` on the machine port. Only the front door may
   * reach the session port then, since it trusts those headers.
   */
  AUTH_SESSION_HEADERS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /**
   * Where the login proxy starts a fresh sign-in, on the hub's own host; the web app sends a person there, with `rd`
   * naming the page to come back to, when what they do needs their own token for the hub and the one their session
   * passed has lapsed. oauth2-proxy's is `/oauth2/start`.
   */
  AUTH_SIGN_IN_PATH: z.string().regex(/^\/[^/]/, 'a path on the hub\'s own host').default('/oauth2/start'),
  /** Groups claim values, comma separated, that let a person in. An admin holds every permission; a user holds what the roles given in the hub grant. A person with neither is refused. */
  ROLE_GROUP_ADMIN: z.string().default('Admin'),
  ROLE_GROUP_USER: z.string().default('User'),
  /**
   * Mail domains that are aliases of the sign-in domain, as `alias=domain` pairs separated by commas,
   * e.g. `example.com=corp.example.com`. The login proxy may give a person's mail address on an alias;
   * the hub knows them by the sign-in domain, so an address on an alias is rewritten before it is used.
   */
  EMAIL_DOMAIN_ALIASES: z.string().default(''),
  /** Base64 32-byte key that encrypts git credentials at rest. Generated into DATA_DIR when unset. */
  SECRET_KEY: z.string().optional(),
  /** Seconds a stopping hub keeps serving after it stops asking for traffic, while the load balancer moves away from it. */
  DRAIN_SECONDS: z.coerce.number().min(0).default(5),
  /** Seconds a stopping hub waits for the requests it holds to finish before it cuts them. */
  STOP_SECONDS: z.coerce.number().min(0).default(20),
  GIT_POLL_MINUTES: z.coerce.number().positive().default(15),
  LIFECYCLE_MINUTES: z.coerce.number().positive().default(5),
  /** Minutes between passes that re-link every rule and inherited relation, whether or not anything they read moved. */
  RELINK_MINUTES: z.coerce.number().positive().default(60),
  /** How often the built-in runner executes the checks assigned to it. */
  CHECK_MINUTES: z.coerce.number().positive().default(2),
  /** Days a deleted entity's tombstone is kept. */
  TOMBSTONE_DAYS: z.coerce.number().positive().default(90),
  /** How long an ended action run is kept, with its log and outputs. */
  RUN_KEEP_DAYS: z.coerce.number().positive().default(365),
  /** How long the pictures a run reported are kept: most of what runs weigh, and seldom looked at after the first days. */
  RUN_IMAGE_DAYS: z.coerce.number().positive().default(30),
  /** Days a report's edition is kept, counted from when it was published: its record, its body, and its data. */
  REPORT_KEEP_DAYS: z.coerce.number().int().positive().default(730),
  /** Days a finished run's row is kept, for the source's history and the findings that read it. */
  RUN_DAYS: z.coerce.number().positive().default(30),
  /** Days the activity log is kept. */
  ACTIVITY_DAYS: z.coerce.number().positive().default(90),
  /** Days the load ledger is kept: what deriving, grids, writes, and API calls cost by the hour. */
  LOAD_DAYS: z.coerce.number().positive().default(14),
  /**
   * Minutes an action run under way may go unheard from before the hub gives up on it: counted from its last report,
   * one that carries nothing included, or from its start. A run that keeps reporting is never given up for it.
   */
  ACTION_TIMEOUT_MINUTES: z.coerce.number().positive().default(60),
  /** Seconds between looks at the GitHub workflow runs the hub started, so one that ends without reporting is finished with GitHub's answer. */
  ACTION_WATCH_SECONDS: z.coerce.number().positive().default(30),
  /** The GitHub REST API a `github_workflow` backend calls. */
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  /** Annals' API port. With ANNALS_TOKEN, every person's and token's activity, and every change to the model, sources, secrets, access, and actions, is forwarded to it. */
  ANNALS_URL: z.string().url().optional(),
  /** A token Annals issued for the source `orrery`. */
  ANNALS_TOKEN: z.string().optional(),
  /** Seconds between forwarding passes. */
  ANNALS_EVERY_SECONDS: z.coerce.number().positive().default(30),
  /** A dispatch desk's API port. With DISPATCH_TOKEN, every self-service run asked for, waiting for approval, approved, declined, or finished is sent there as an event, for its subscriptions to deliver. */
  DISPATCH_URL: z.string().url().optional(),
  /** A token the dispatch desk issued; its name is the producer the desk's subscriptions match. */
  DISPATCH_TOKEN: z.string().optional(),
  /** Seconds between passes that send runs to dispatch. */
  DISPATCH_EVERY_SECONDS: z.coerce.number().positive().default(5),
  /** A group on the dispatch desk, by slug, told of a run that waits for approval when no rule names a decider. Unset, such a run reaches only what a subscription sends it to. */
  DISPATCH_APPROVERS_GROUP: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/).optional(),
  /** Hours a run may wait for approval before its deciders are told once more. 0 never tells them again. */
  DISPATCH_REMIND_HOURS: z.coerce.number().min(0).default(24),
  /**
   * The estate's judge (Trellis), by its address on the cluster network: an action with `judge: true` sends each run's
   * change statement to `POST <JUDGE_URL>/v1/judge` before the run is queued, with no credential. Unset, or with no
   * answer within three seconds, such a run goes to people.
   */
  JUDGE_URL: z.string().url().optional(),
  /** The dispatch desk's address for people. Set, the web app's profile menu links to the page where a person says how they are told. */
  DISPATCH_PUBLIC_URL: z.string().url().optional(),
  /**
   * The one header the hub takes a caller's address from: the proxy in front of it must write it over whatever the caller
   * sent. `none` trusts no header, and no request has an address. Read for telemetry and for an action's `by.address`.
   */
  CLIENT_ADDRESS_HEADER: z.string().regex(/^(none|[A-Za-z0-9-]+)$/, 'a header name, or none').default('x-real-ip'),
  /** How many proxies in front of the hub add an entry to that header: the hub reads the entry that many from its end. */
  CLIENT_ADDRESS_HOPS: z.coerce.number().int().positive().max(10).default(1),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  if (parsed.data.AUTH_ISSUER && !parsed.data.AUTH_AUDIENCE) throw new Error('Invalid configuration: AUTH_AUDIENCE is required with AUTH_ISSUER')
  if (parsed.data.AUTH_API_SCOPE && !parsed.data.AUTH_ISSUER) throw new Error('Invalid configuration: AUTH_API_SCOPE needs AUTH_ISSUER')
  if (parsed.data.AUTH_DELEGATES?.trim() && !parsed.data.AUTH_API_SCOPE) throw new Error('Invalid configuration: AUTH_DELEGATES needs AUTH_API_SCOPE')
  try {
    parseDelegates(parsed.data.AUTH_DELEGATES)
  } catch (error) {
    throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parsed.data
}
