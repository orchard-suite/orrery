import { resolve } from 'node:path'
import { MOST_PINS, PIN_KINDS } from '../shared/model.ts'
import { MOST_STEPS } from '../shared/map.ts'
import { ENTITY_LINKS } from '../shared/api.ts'

/**
 * The read and write surface, published so agents and SDKs can discover it.
 * The description is written for an agent that has only this document and a
 * token: it says where to send the token and where to start. `serverUrl` is
 * the host the caller should send requests to.
 */
export function openapi(serverUrl: string, version: string): Record<string, unknown> {
  const entityRef = { type: 'object', properties: { blueprint: { type: 'string' }, key: { type: 'string' } }, required: ['blueprint', 'key'] }
  const writeInput = {
    type: 'object',
    properties: {
      blueprint: { type: 'string' },
      key: { type: 'string' },
      title: { type: 'string' },
      icon: { type: 'string', description: 'A name from the icon set or a custom icon (/v1/icons), for this entity alone; without one it shows its blueprint\'s icon' },
      fields: { type: 'object', additionalProperties: true },
      relations: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] }, description: 'Target ids (blueprint:key) or bare keys of the target blueprint' },
      digest: {
        type: 'string',
        description:
          'In a run: the sender\'s own stable fingerprint of what it sends of the entity. Beside a full write it is kept; alone with blueprint and key, the item is a sighting, taken as that full write sent again while the entity has not changed and its blueprint was not saved since, and answered in wanted otherwise',
      },
    },
    required: ['blueprint', 'key'],
  }
  const lastAt = { type: 'string', format: 'date-time' }
  const source = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      class: { type: 'string' },
      blueprints: { type: 'array', items: { type: 'string' } },
      deleteGrant: { type: 'array', items: { type: 'string' } },
      cadence: { type: ['string', 'null'] },
      actsFor: { type: ['string', 'null'], description: 'The entity this source speaks for, <blueprint>:<key>, such as the service whose token it is. Set by an admin' },
      actions: { type: 'boolean', description: 'The source may put self-service actions with its token. Set by an admin' },
      scorecards: { type: 'boolean', description: 'The source may put and remove its own scorecards with its token, as a judge publishes its rules. Set by an admin' },
      serves: {
        type: ['object', 'null'],
        description: 'A runner only: the tools it runs with its key. tiers are the tiers a tool on it may have; sources are the sources that may put a tool on it with their own token (none: only an admin and git); on is a filter over the entity a tool on it is declared from. Null: it runs no tool. Set by an admin',
        properties: { tiers: { type: 'array', items: { type: 'string', enum: ['read', 'data', 'act'] } }, sources: { type: 'array', items: { type: 'string' } }, on: { type: 'object', properties: { blueprint: { type: 'string' }, where: { type: 'object', additionalProperties: true } } } },
      },
      writes: {
        type: 'object',
        description: 'What the hub accepted from this source, per target, with the last time',
        properties: {
          entities: { type: 'array', items: { type: 'object', properties: { blueprint: { type: 'string' }, count: { type: 'integer' }, lastAt } } },
          blueprints: { type: 'array', description: 'Blueprints offered through PUT /v1/ingest/blueprints', items: { type: 'object', properties: { id: { type: 'string' }, lastAt } } },
          actions: { type: 'array', description: 'Actions put through PUT /v1/actions/{id}', items: { type: 'object', properties: { id: { type: 'string' }, lastAt } } },
          scorecards: { type: 'array', description: 'Scorecards put through PUT /v1/scorecards/{id}', items: { type: 'object', properties: { id: { type: 'string' }, lastAt } } },
        },
      },
      status: { type: 'string' },
      lastSeenAt: { type: ['string', 'null'] },
      lastRunAt: { type: ['string', 'null'] },
    },
  }
  const bearer = [{ bearerAuth: [] }]
  const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
  const modelBody = { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }
  const pin = { type: 'object', properties: { kind: { type: 'string', enum: [...PIN_KINDS] }, id: { type: 'string' } }, required: ['kind', 'id'] }
  const pinParams = [
    { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: [...PIN_KINDS] } },
    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'The id of the action, or of the blueprint' },
  ]
  const starParams = [
    { name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
  ]
  return {
    openapi: '3.1.0',
    info: { title: 'Orrery', version, description: AGENT_GUIDE },
    servers: [{ url: serverUrl }],
    security: bearer,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Send the token you were given in the Authorization header: `Authorization: Bearer orr_acc_...`. No other header or query parameter is read. A personal token (orr_usr_) is the person it was made for, with their roles: it reads what they read and changes what they may change, the model included where they hold model.edit. An access token (orr_acc_) reads; a source token (orr_src_) writes through /v1/ingest, puts custom icons at PUT /v1/icons/{name}, and, when an admin gave its source the actions grant, puts and removes its own actions at /v1/actions/{id}, and, with the scorecards grant, its own scorecards at /v1/scorecards/{id}. Where the hub names a scope for people, an access token its sign-in issuer gave an app for that scope acts as the person it names, with their roles.',
        },
      },
      schemas: {
        EntityRef: entityRef,
        WriteInput: writeInput,
        Source: source,
        Error: {
          type: 'object',
          description: 'Every refusal and failure: why, in one line, and for a refused write or model change the entries or values that caused it',
          properties: { error: { type: 'string' }, errors: { type: 'array', items: { type: 'object', additionalProperties: true } }, offenders: { type: 'array', items: { type: 'object', additionalProperties: true } } },
          required: ['error'],
        },
      },
      responses: {
        Error: { description: 'Refused or failed: a bad request (400), no or the wrong token (401), not allowed (403), not found (404), a refused write (422), or a fault (5xx)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
    paths: finish({
      '/v1/blueprints': { get: { summary: 'The model: every blueprint with fields, relations, and descriptions', security: bearer } },
      '/v1/blueprints/{id}': {
        get: { summary: 'One blueprint', security: bearer, parameters: idParam },
        put: { summary: `Create or change a blueprint, sent whole as the model page sends it: {title, description?, icon?, group?, wall?, standalone?, fields, relations, lifecycle?, status?, ground?, map?, access?, adminEdit?}. What the body leaves out is gone. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        patch: { summary: `Change part of a blueprint, or create one: the body is laid over its definition as JSON Merge Patch, where an object merges into what it names, null removes what it names, and anything else, a list included, replaces it whole. {fields: {cost: {calculation: "a + b"}}} changes one field; {fields: {old: null}} removes one; {relations: {team: {target: "team"}}} adds a relation. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        delete: { summary: 'Remove a blueprint. Refused while another blueprint\'s relation targets it, and to anyone but an admin when it decides who sees or changes something (needs model.edit)', security: bearer, parameters: idParam },
      },
      '/v1/blueprints/{id}/rename': { post: { summary: 'Rename a blueprint and everything that names it; body {to} (needs model.edit)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/blueprints/{id}/hand-over': {
        post: {
          summary: "Hand fields, and the status field, to a source: each is marked as the source's with the fingerprint of its definition now, so the source's next offer keeps it current. Body {source, fields?, status?}; answers the blueprint. Admin only; 400 a blueprint git or the hub defines, an unknown source, or a field the blueprint lacks",
          security: bearer,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', description: 'The source the definitions go to' },
                    fields: { type: 'array', items: { type: 'string' }, description: 'Fields of the blueprint to hand over' },
                    status: { type: 'boolean', description: 'Hand over the status field too' },
                  },
                  required: ['source'],
                },
              },
            },
          },
        },
      },
      '/v1/blueprints/{id}/formerly/{name}': { delete: { summary: 'Forget a name the blueprint was known by, so another blueprint may take it (needs model.edit)', security: bearer } },
      '/v1/model/templates': { get: { summary: 'The models the hub offers for import (needs model.edit)', security: bearer } },
      '/v1/model/export': {
        get: {
          summary: 'The model as the caller sees it, in the YAML /v1/model/import takes: {blueprints, relationRules, scorecards, alertRules}, each as its definition, the hub\'s own blueprints left out. Access rules are an admin\'s to read. Keep a copy, or compare two',
          security: bearer,
          parameters: [
            { name: 'blueprint', in: 'query', schema: { type: 'string' }, description: 'Only this blueprint, and the rules, scorecards, and alert rules on it' },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['yaml', 'json'] }, description: 'json answers the same as JSON; YAML when left out' },
          ],
        },
      },
      '/v1/model/layout': { get: { summary: 'Where each card stands on the model page, and which are hidden, as everyone is shown them', security: bearer }, put: { summary: 'Move, hide, or show cards on the model page for everyone: body {positions?: {id: {x, y} | null}, hidden?: [id], rearrange?} (needs model.edit)', security: bearer } },
      '/v1/model/layout/place': { post: { summary: 'Where the caller\'s own view of the model page would place its cards, worked out and never saved: body {hidden, positions?, rearrange?}', security: bearer } },
      '/v1/rules': { get: { summary: 'Every relation rule: {rules: [{id, blueprint, relation, match: {target, where}, optional, origin}]}', security: bearer } },
      '/v1/rules/{id}': {
        put: { summary: `Create or change a relation rule, sent whole: {blueprint, relation, match: {target, where: "source.<path> == target.<path>"}, optional?}. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        patch: { summary: `Change part of a relation rule, or create one, as JSON Merge Patch over its definition. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        delete: { summary: 'Remove a relation rule and the links it made (needs model.edit)', security: bearer, parameters: idParam },
      },
      '/v1/alert-rules/{id}': {
        put: { summary: `Create or change an alert rule, sent whole: {blueprint, where: "alert.<path> == target.<path>"}. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        patch: { summary: `Change part of an alert rule, or create one, as JSON Merge Patch over its definition. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        delete: { summary: 'Remove an alert rule (needs model.edit)', security: bearer, parameters: idParam },
      },
      '/v1/access/hub-blueprints/{id}': { put: { summary: "Who sees one of the hub's own blueprints (orrery_): body {access: rule | null}; null keeps it to admins (admins only)", security: bearer, parameters: idParam } },
      '/v1/model/import': { post: { summary: 'Import a model: body {template} or {yaml}. Creates what is missing, adds to what exists, changes nothing (needs model.edit)', security: bearer } },
      '/v1/entities': {
        get: {
          summary: 'Search entities',
          security: bearer,
          parameters: [
            { name: 'blueprint', in: 'query', schema: { type: 'string' } },
            { name: 'filter', in: 'query', schema: { type: 'string' }, description: 'JSON filter: {field,op,value} with op eq|neq|gt|gte|lt|lte|in|contains|prefix|exists|within|older | {relation,target?} where <-relation asks who points here | {relation,where,every?} the entities it reaches meet where, a filter on their own fields: any of them, or every:true at least one and all (none: {not:{relation,where}}) | {scorecard,op,value} the level reached, in the scorecard order (op eq|neq|gt|gte|lt|lte|in|exists; out of scope matches none) | {relatedTo} | {state} | {search} | {and|or:[...]} | {not}' },
            { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated field names to return under fields; empty returns none. Every entity keeps its shape and what the hub keeps about it' },
            { name: 'relations', in: 'query', schema: { type: 'string' }, description: 'Comma-separated relation names to return under relations; empty returns none' },
            { name: 'state', in: 'query', schema: { type: 'string' }, description: 'active,missing,deleted' },
            { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'field or -field. For a person, what they starred comes first in any order, inside each group; each such row says starred: true' },
            { name: 'starred', in: 'query', schema: { type: 'boolean' }, description: 'Only what the caller starred, a person\'s favorites; nothing for a machine' },
            { name: 'layers', in: 'query', schema: { type: 'boolean' }, description: 'Add the layer that won for each field and relation' },
            { name: 'incoming', in: 'query', schema: { type: 'string' }, description: 'true adds everyone pointing at each entity as incomingRefs, keyed blueprint.relation; a number adds that many under each key and the full count of each as incomingCount' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 2000 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Rows to skip; each one is still read, so a deep page costs more. Not with after' },
            { name: 'after', in: 'query', schema: { type: 'string' }, description: 'The next a page answered with: the page right after it, reading none of the rows before. It fits only the same blueprint, filter, state, sort, and group' },
          ],
        },
        post: { summary: 'Create an entity from the UI (needs entities.edit)', security: bearer, requestBody: { content: { 'application/json': { schema: writeInput } } } },
      },
      '/v1/entities/{blueprint}/{key}': {
        get: { summary: `One entity; ?provenance=true adds per-field sources. Of each kind of thing that points at it, the first ${ENTITY_LINKS} by title, and incomingCount says how many there are`, security: bearer },
        patch: { summary: 'Edit fields (title and icon among them) and relations as a person: soft overrides for pushed values, null clears what a person set (needs entities.edit, or an edit rule that opens every value named to the caller on this entity; an owner let in by a rule writes only where no source says a value)', security: bearer },
        delete: { summary: 'Delete a UI-owned entity (needs entities.edit)', security: bearer },
      },
      '/v1/entities/bulk': { post: { summary: 'Make one edit to many entities: fields, relations, or hidden. Answers with the count changed and each refusal (needs entities.edit, or, for fields and relations, an edit rule that opens them to the caller: an entity no rule opens is named among the refusals)', security: bearer } },
      '/v1/entities/{blueprint}/{key}/hidden': { put: { summary: 'Hide an entity from views, or show it again (needs entities.edit)', security: bearer } },
      '/v1/entities/{blueprint}/{key}/related': { get: { summary: 'Graph traversal', security: bearer, parameters: [{ name: 'direction', in: 'query', schema: { type: 'string', enum: ['in', 'out', 'both'] } }, { name: 'depth', in: 'query', schema: { type: 'integer', maximum: 4 } }, { name: 'blueprints', in: 'query', schema: { type: 'string' } }] } },
      '/v1/wall': { get: { summary: 'The all-green view: one colour per entity of every blueprint shown on the wall, and per source', security: bearer } },
      '/v1/summary': { get: { summary: 'Compact estate overview', security: bearer } },
      '/v1/mine': { get: { summary: "What the caller owns, by what the person setting's paths reach, how each thing is theirs, how many there are, and whether they see everything", security: bearer, parameters: [{ name: 'green', in: 'query', description: 'false leaves the green things out of things; the count and the counts per blueprint still hold them', schema: { type: 'boolean' } }, { name: 'blueprint', in: 'query', description: 'Only the things of this blueprint, green ones too, the worst 200 read whole', schema: { type: 'string' } }] } },
      '/v1/findings': { get: { summary: 'Hygiene problems, each marked yours when it touches something the caller owns', security: bearer } },
      '/v1/load': { get: { summary: 'What costs the hub over the last hours: deriving and grid shapes by blueprint, what people\'s stars cost each blueprint\'s grids beside how many stars and people it holds (stars), writes by source, API calls by caller and by caller and route, each with the most time first, beside the derive queue and the entities of each blueprint now (needs audit.view)', security: bearer, parameters: [{ name: 'hours', in: 'query', description: 'How many hours back, 24 when not given', schema: { type: 'integer' } }] } },
      '/v1/budgets': {
        get: { summary: 'The budgets the hub holds its sources, callers, and blueprints to: `changes` (entities a source changes in an hour), `calls` (API calls a caller makes in an hour), `entities` (entities a blueprint holds), `reads` (entities one row of a blueprint reads), each by name, `*` for every name with none of its own (needs audit.view)', security: bearer },
        put: { summary: 'Set every budget at once; one left out is no longer held. Each is `{ warn, limit }`: past `warn` the hub raises an over_budget finding, past `limit` it refuses what would add to it with 429 and Retry-After, or refuses the new entity (needs budgets.set)', security: bearer },
      },
      '/v1/changes': { get: { summary: 'The activity log: who changed what, newest first (needs audit.view). fold=batches shows a batch as the row that asked it (action.batched) and names each in batches, by id; batch=<id> reads one batch\'s rows', security: bearer, parameters: [{ name: 'fold', in: 'query', description: 'batches: a batch is one row', schema: { type: 'string' } }, { name: 'batch', in: 'query', description: 'Only the rows of this batch', schema: { type: 'string' } }, { name: 'actorKind', in: 'query', description: 'Comma separated: user, token, source, hub', schema: { type: 'string' } }, { name: 'category', in: 'query', description: 'Comma separated: estate, runs, model, layout, sources, secrets, access', schema: { type: 'string' } }, { name: 'outcome', in: 'query', description: 'Comma separated: ok, refused, failed', schema: { type: 'string' } }, { name: 'actor', in: 'query', schema: { type: 'string' } }, { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'before', in: 'query', description: 'Rows older than this id', schema: { type: 'integer' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'blueprint', in: 'query', schema: { type: 'string' } }, { name: 'key', in: 'query', schema: { type: 'string' } }, { name: 'kind', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }] } },
      '/v1/sources': { get: { summary: 'Every source with its freshness, what it acts for (actsFor, <blueprint>:<key> or null), whether it may define actions, and what it has written (writes)', security: bearer, responses: { '200': { description: 'The sources', content: { 'application/json': { schema: { type: 'object', properties: { sources: { type: 'array', items: { $ref: '#/components/schemas/Source' } } } } } } } } } },
      '/v1/sources/{id}': {
        get: { summary: 'One source and its recent runs: {source, runs}', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
        put: { summary: 'Register or change a source (needs sources.manage). actsFor, actions, and serves are set by an admin alone; a body that leaves one out keeps what the source had, and serves: null clears it. Only a runner has serves', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
        delete: { summary: 'Remove a source, its tokens, and what it has written (needs sources.manage)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
      },
      '/v1/sources/{id}/hand-over': { post: { summary: 'Hand every entity a pusher owns to another pusher, optionally into a new scope, or only the entities of the blueprints named (body: to, scope?, blueprints?)', security: bearer } },
      '/v1/sources/{id}/adopt': { post: { summary: 'Give a pusher entities a person made, named one by one, optionally into its scope', security: bearer } },
      '/v1/guide': { get: { summary: 'The modelling guide as markdown: what belongs in the catalog, the shared names, and the field contracts', security: bearer } },
      '/v1/whoami': { get: { summary: 'Who the caller is, the roles they hold, the permissions those give, the previews open to them, web: the address people open the hub\'s pages on (one thing is web/entities/{blueprint}/{key}), and, where the hub names a notification desk for people, notifications: the page where they choose how they are told', security: bearer } },
      '/v1/access/previews': {
        get: { summary: 'Who each preview is open to: {previews: {garden: {open, people}}}, where open is nobody, people, or everyone, and people are the addresses named. A preview is a view held back until an admin opens it; `garden` is the ground view (admins only)', security: bearer },
        put: { summary: 'Set who each preview is open to: body {garden: {open, people}, welcome: {open, people}}. A person is in a preview when named, an admin too; an access token of a person is the person; any other token is in only once it is open to everyone. Writes a preview.changed activity row when something changed (admins only)', security: bearer },
      },
      '/v1/ground': { get: { summary: 'Every blueprint that names a ground and the caller sees, with how many of its entities hold a budgeted number and how many are inside every budget: {grounds: {<blueprint>: {items, measured, inside, share}}}. A preview: 404 to a caller it is not open to', security: bearer } },
      '/v1/ground/{blueprint}': { get: { summary: "One blueprint's ground, from what the caller may see: fields (the numbers read), items worst first (each with its measures, how many are over their budget, and why it is worth a visit), cover, rounds (where to go first), templates (what entities were started from, and how many are on an older version), plant (the action that starts a new one, when the caller may run it), forecast (numbers heading out of their budget, dates falling due, and the budgeted numbers whose past is not kept), and seasons (the share inside budget, week by week). A preview: 404 to a caller it is not open to", security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/ground/{blueprint}/{key}': { get: { summary: 'One entity of a ground: its measures, what it is built on (foundations), the limits it holds (guards), what it copied from and who else did (taught), the past kept of each number (pasts), and its dates ahead. A preview: 404 to a caller it is not open to', security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/map': { get: { summary: 'Every entity a map can be drawn of: each one of a blueprint that names a map and no part of another, with how many plots and members name it or one of its parts, how their checks stand, whether the caller owns it, whether it is primary (the boolean field the map names as `primary` is true on it), and its sector (the value of the field the map names as `sector`, or the title of the entity that relation names). A preview: 404 to a caller it is not open to', security: bearer } },
      '/v1/map/{blueprint}/{key}': { get: { summary: 'One entity\'s map: its parts, the places its things are in, its plots with where each is and how it is doing there, and its members in their places, in a plot or open. Every thing carries its checks in one shape (scorecard rules, budgets, guards) as pass, fail, or unknown, each with ladder (a scorecard\'s id, or budget:<field> and guard:<field>) and rung (its level, from 0); ladders lists every ladder the checks climb, {id, title, rungs}. A preview: 404 to a caller it is not open to', security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/mine/walk/{blueprint}/{key}': {
        get: { summary: 'The caller\'s walk through one map: {steps: [{id, place, ladder, from, scope, things, addedAt}]}, oldest first. A stop is a climb on one place (null: tied to no place): the things standing on rung from of ladder, taken to its top, kept to scope (plot:<key>, kind:<blueprint>, or null for the whole place); things names each as blueprint:key. A person or a personal token; a machine keeps none (403). In the garden preview', security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }] },
        post: { summary: `Put a stop on the caller\'s walk: body {place, ladder, from, scope, things}. The same climb again keeps its stop and takes the things named now. ${MOST_STEPS} at most on one map (409 past it). Answers the walk. Writes no activity row`, security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }] },
      },
      '/v1/mine/walk/{blueprint}/{key}/{id}': { delete: { summary: 'Take one stop off the caller\'s walk. Answers the walk', security: bearer, parameters: [{ name: 'blueprint', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/roles': { get: { summary: 'Every role with the permissions it bundles', security: bearer } },
      '/v1/roles/{id}': { put: { summary: 'Create or change a role: body {title, description, permissions} (needs users.manage)', security: bearer }, delete: { summary: 'Remove a role (needs users.manage)', security: bearer } },
      '/v1/users': { get: { summary: 'Everyone sign-in has let in, with their roles (needs users.manage)', security: bearer } },
      '/v1/posture': { get: { summary: 'The security posture: every blueprint, field, and action with who may see, change, or run it, the people and tokens it is judged for, the findings, the audiences and field classes with whom they let in and what they cover, the review queue, and how every field\'s reach was decided. An action also carries its icon and home as the caller sees them, whether its home\'s people or everyone may run it, when it last ran, and how many runs the last 90 days saw (posture.read)', security: bearer } },
      '/v1/posture/policy': {
        get: { summary: 'The audiences and field classes, and the git source that declares them, if one does (posture.read)', security: bearer },
        post: { summary: 'A new set of audiences, field classes, and edit rules, previewed (who gains and who loses sight of what) and saved when body.save is true: body {policy: {audiences, classes, edits}, save}; edits left out keeps the saved ones. Refused while a git source declares them (admins only)', security: bearer },
      },
      '/v1/posture/review': { post: { summary: 'Marks blueprints reviewed as they stand, so their fields leave the review queue: body {blueprints: [id]} (admins only)', security: bearer } },
      '/v1/posture/reach': { get: { summary: 'What one person or token may see, change, and run: ?kind=person|token&name= (posture.read)', security: bearer } },
      '/v1/posture/edits': { get: { summary: 'Who changes what by hand: every blueprint\'s fields and relations with the one authority over each (an edit rule, the holders of entities.edit, admins, sources, or derived) and why, and the hand values standing over what a source says, oldest first. With ?person=<address>, what the edit rules open to that person, on every entity or on how many of their own (posture.read)', security: bearer } },
      '/v1/posture/who': { get: { summary: 'Everyone who may see, change, or run one target, and through which audience or grant, or for a field by its summary mark alone: ?target=blueprint:<id>|field:<blueprint>.<field>|action:<id> (posture.read)', security: bearer } },
      '/v1/posture/change': { post: { summary: 'One change to many targets\' access or admin-only mark, previewed (who gains, who loses) and saved when body.save is true: body {change: {targets, access?: {op, grants?, audiences?, everyone?}, adminEdit?}, save}. A field in a class is refused: change the class (admins only)', security: bearer } },
      '/v1/users/{email}/roles': { put: { summary: 'Set the roles a person holds: body {roles} (needs users.manage)', security: bearer } },
      '/v1/grid/{blueprint}': { get: { summary: "A catalog grid's shared layout: the filter and sort it opens with, and its columns. With arranged: standard, columns holds only what a person changed on top of the column standard, each {id, width?, hidden?, after?} where after names the column it was placed after (null for first)", security: bearer }, put: { summary: 'Change any part of a grid\'s shared layout: body {columns?, arranged?, filter?, sort?}; what it leaves out stays (needs views.arrange)', security: bearer } },
      '/v1/conventions': { get: { summary: 'The relation conventions: {conventions: [{id, title?, description?, groups: [group], relations: [relation]}], source?}. Each blueprint of a named group that lacks one of the relations is an unmet_convention finding', security: bearer }, put: { summary: 'Set the relation conventions, for everyone: body {conventions: [{id, title?, description?, groups, relations}]}. Refused while a git source declares them under config.conventions (409) (needs model.edit)', security: bearer } },
      '/v1/grid-standard': { get: { summary: 'The column standard every catalog grid opens with: ranks of column patterns, first to last, and the patterns hidden until someone shows them', security: bearer }, put: { summary: 'Set the column standard, for everyone: body {ranks: [{id, title?, description?, columns: [pattern]}], hidden?: [pattern], widths?: {pattern: pixels}}. Refused while a git source declares it under config.columns (needs views.arrange)', security: bearer } },
      '/v1/catalog/layout': { put: { summary: 'Set any part of how the list of blueprints is laid out, for everyone: the order of the group headings, which of them start closed, the order of the blueprints inside the groups it names, and which blueprints are hidden from the list: body {order, closed, blueprints: {group: [ids]}, hidden} (needs catalog.organize)', security: bearer } },
      '/v1/export': { get: { summary: 'Entities people made or changed by hand as catalog YAML (scope=all adds what sources pushed); the model itself is /v1/model/export', security: bearer, parameters: [{ name: 'blueprint', in: 'query', schema: { type: 'string' } }, { name: 'key', in: 'query', schema: { type: 'string' } }, { name: 'scope', in: 'query', schema: { type: 'string', enum: ['ui', 'all'] } }] } },
      '/v1/scorecards': { get: { summary: 'Every scorecard with its levels and rules', security: bearer } },
      '/v1/scorecards/{id}': {
        put: {
          summary:
            'Define or change a scorecard (needs model.edit, or a source token whose source has the scorecards grant: then its origin is {kind: source, source}, it is that source alone to change or remove, and it may not put over one git or another source defined). A rule holds where (a filter the hub judges) or judged ({field, check?}: another judge decided it, and its state is the entry under check, the rule id when left out, in an object field a checks aggregation fills: pass, fail, or unknown when the judge had no data; a rule with no entry does not apply to the entity)',
          security: bearer,
        },
        patch: { summary: `Change part of a scorecard, or create one, as JSON Merge Patch over its definition: a list, such as levels, is sent whole. ${MODEL_SAVE}`, security: bearer, parameters: idParam, requestBody: modelBody },
        delete: { summary: 'Remove a scorecard (needs model.edit; a source token removes only a scorecard its source put)', security: bearer },
      },
      '/v1/scorecards/{id}/results': { get: { summary: 'Entities × rules with the level each reached. A row holds each rule that applies to it: true, false, or null when its judge had no data, which holds it below that level', security: bearer } },
      '/v1/scorecards/{id}/trend': { get: { summary: 'Entities per level per day', security: bearer } },
      '/v1/alerts': { get: { summary: 'Firing alerts and the entities they attach to, each marked yours when it fires on something the caller owns', security: bearer } },
      '/v1/checks': { get: { summary: 'Every health check with its latest result per runner', security: bearer } },
      '/v1/icons': { get: { summary: 'The custom icons the hub holds: {icons: [{name, type, sha256, size, owner, updatedAt}]}. owner is the source that put one, git:<source> for a git source, or ui', security: bearer } },
      '/v1/icons/{name}': {
        get: {
          summary: 'An icon file: the custom icon of that name, else the built-in brand file; 404 for a concept icon (drawn by the web app) or an unknown name. Sends ETag; If-None-Match answers 304',
          security: bearer,
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'theme', in: 'query', schema: { type: 'string', enum: ['dark', 'light'] }, description: 'light gives the light-theme copy of a brand mark drawn in ink, where there is one' },
          ],
        },
        put: {
          summary: 'Create or replace a custom icon: the body is the image, its type in Content-Type (image/svg+xml, image/png, image/webp; at most 256 KiB). A source token may call it, as a forge reader does for a repository logo; anyone else needs entities.edit. Answers {name, type, sha256, size}. 400 a name outside ^[a-z0-9][a-z0-9_]{0,62}$, 409 a built-in name or an icon set in git, 413 too big, 415 another type, 422 an unsafe SVG or bytes that are not the type',
          security: bearer,
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_]{0,62}$' } }],
          requestBody: { required: true, content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/webp': { schema: { type: 'string', format: 'binary' } } } },
        },
        delete: { summary: 'Remove a custom icon (admins only)', security: bearer, parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }] },
      },
      '/v1/ingest/blueprints': { put: { summary: 'Offer the blueprints a pusher writes; missing ones are created, existing ones gain the fields and relations they lack (source token)', security: bearer } },
      '/v1/ingest/runner/checks': { get: { summary: 'Checks assigned to this runner, with secrets opened (runner token)', security: bearer } },
      '/v1/ingest/runner/results': { post: { summary: 'Check results from a runner', security: bearer } },
      '/v1/mine/preferences': { get: { summary: 'The caller\'s preferences, kept on the person for every device: {preferences: {welcomed, release}}. A name never set reads as its fallback. A person\'s alone: a machine token keeps none (403)', security: bearer } },
      '/v1/mine/preferences/{name}': { put: { summary: 'Set one of the caller\'s preferences: body {value}. 404 for a name the hub does not keep, 400 for a value it does not take. Writes no activity row, and is refused while viewing as someone', security: bearer } },
      '/v1/welcome': { get: { summary: 'The welcome tour as the caller is shown it: {version, steps: [{id, to, spot, title, text}]}, with nothing in it the caller may not see. 404 outside the welcome preview', security: bearer } },
      '/v1/access/welcome': { get: { summary: 'What the estate sets of the welcome tour: {welcome: {version, blueprint?, example?, actions?, steps?, source?}} (admins only, inside the welcome preview)', security: bearer }, put: { summary: 'Set the welcome tour: body {version, blueprint?, example?, actions?: [<action id>, best first], steps?: {<step>: {shown?, title?, text?, empty?}}}; empty is a step\'s words for a reader who may run no action, on a step that has them. Refused while a git source declares it under config.welcome (409). Writes a welcome.changed activity row when something changed (admins only, inside the welcome preview)', security: bearer } },
      '/v1/mine/approvals': { get: { summary: 'How many records of the estate\'s approvals blueprint wait for the caller: pending, and naming them among the approvers, read through what they may see: {blueprint, waiting}. blueprint is null when the hub names none or the caller may not see it', security: bearer } },
      '/v1/mine/fill': { get: { summary: 'What the caller could fill in: for each field an edit rule opens to them as an owner, how many of their own entities of a blueprint hold no value of it', security: bearer } },
      '/v1/mine/pins': {
        get: { summary: 'What the caller pinned, in the order they keep them: {pins: [{kind, id}]}. An action pin keeps it at the top of their own Self-service page, and shows while they may run or change it; a blueprint pin keeps it at the top of their catalog list, and shows while they see some of it. A person or a personal token; a machine keeps none (403)', security: bearer },
        put: { summary: 'Put the caller\'s pins in order: body {order: [{kind, id}]}. The named pins come first, in that order, and the rest keep theirs after them. Answers the pins', security: bearer, requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['order'], properties: { order: { type: 'array', maxItems: MOST_PINS, items: pin } } } } } } },
      },
      '/v1/mine/pins/{kind}/{id}': {
        put: { summary: `Pin an action the caller may run or change, or a blueprint they see some of, after their other pins; pinning one again changes nothing. ${MOST_PINS} of a kind at most a person (409 past it). Answers the pins. Writes no activity row`, security: bearer, parameters: pinParams },
        delete: { summary: 'Let a pin go. Answers the pins', security: bearer, parameters: pinParams },
      },
      '/v1/mine/stars': { get: { summary: 'What the caller starred, their favorites, newest first: {stars: [{blueprint, key}]}, only what they may see today; the rest are kept and show again when they may. What a person starred comes first in every catalog grid they read; a query, an export, and a report never read it. A person or a personal token; a machine keeps none (403)', security: bearer } },
      '/v1/mine/stars/table': { get: { summary: 'Everything the caller starred and may see, as one query answer: each blueprint a source, its fields and relations columns, one column where blueprints share a field, every state. The favorites page draws it', security: bearer } },
      '/v1/mine/stars/{blueprint}/{key}': {
        put: { summary: 'Star an entity the caller may see: one of their favorites, first in every catalog grid they read. Starring one again changes nothing; 404 for what they may not see. Answers {starred}. Writes no activity row, and is refused while viewing as someone', security: bearer, parameters: starParams },
        delete: { summary: 'Let a star go. Answers {starred}', security: bearer, parameters: starParams },
      },
      '/v1/actions': { get: { summary: 'The self-service actions the caller may run, each with canRun, pinned (the caller keeps it at the top of their own page; absent for a machine), iconShown (the icon to draw: its own, else its home\'s, else its one blueprint\'s, else rocket), homeShown ({id, entity, title, icon, yours}: its home as the caller sees it, yours when they own it; null when it has none, the home is gone, or they may not see it), and stats ({usualSeconds, failedInARow}: how long a run usually takes, null until three have succeeded, and how many of its newest runs failed in a row); a holder of actions.manage also gets the rest, marked canRun false. Beside them, reads: the blueprints what the caller owns is read from when an action asks who owns what, so a page reads the list again when one moves; empty for a machine. And person: the blueprint the estate says a person is, which a person input picks from, null when it says none. With ?for=<email> and actions.list, the actions that person may run, each with home ({id, title}) when they may see it', security: bearer } },
      '/v1/actions/layout': { get: { summary: 'How the Self-service page lays its sections out: the order and which start closed. A section is a home, named by its entity id, or a group, named by its name; a home the caller may not see is left out', security: bearer }, put: { summary: 'Set the self-service section order and which start closed: body {order, closed}, the empty name in closed being the section of what has no home and no group; a home the caller may not see keeps its place (needs catalog.organize)', security: bearer } },
      '/v1/actions/{id}': { get: { summary: 'One action, as the list answers it', security: bearer }, put: { summary: 'Define or change an action (needs actions.manage, or a source token whose source has the actions grant: then its origin is {kind: source, source}, it keeps the access and the home an admin set, and it may not put over an action another source or git defined; only an admin sets access or home, and a home is an entity id of a blueprint the caller sees). An input may carry when (a filter over the inputs above it: asked only while it matches), value (an expression over the inputs above it: worked out, never asked), unique ({blueprint, field}: refused when an active entity holds the value), and show (fields under each option of an entity or person input); the action may carry sections ([{title, description?, inputs}]) and walk (one section at a time). A job backend\'s template is a fixed name, or names what the job runs as from the entity the run is on, as infra-apply-{{ entity.fields.infra_principal }}: it reads only fields of that entity, each a stored string or enum that is locked (overridable: false), on every blueprint the action runs on, and the save is refused for anything else, for a field the action\'s own refreshes names, and while another action writes the field', security: bearer }, delete: { summary: 'Remove an action (needs actions.manage; a source token removes only an action its source put)', security: bearer } },
      '/v1/actions/{id}/targets': { get: { summary: 'What the caller may run an action on: {entities, approval}, the entities its rules let them run it on and those whose runs wait for approval. ?narrow={input: value} keeps only targets that hold the values of the inputs that narrow it. ?for=<address>, from a machine access token that holds actions.list, answers for that person instead, judged by the rules alone. ?q=<text>, ?of=<blueprint:key>, or ?limit=<n> (at most 50) answers one page in title order, with total, the count of every match', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'narrow', in: 'query', required: false, schema: { type: 'string' } }, { name: 'for', in: 'query', required: false, schema: { type: 'string' } }, { name: 'q', in: 'query', required: false, schema: { type: 'string' } }, { name: 'of', in: 'query', required: false, schema: { type: 'string' } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } }] } },
      '/v1/access/lets-in': { post: { summary: 'Whether grants let one person in, judged now on their own person entity as a rule\'s are: body {address, grants: [{path?, field?, values}]}, answered {letsIn}. For a product that names people by grants, such as a run\'s approvers or who holds one of its lanes, to check one person before it acts; a machine access token with actions.ask', security: bearer } },
      '/v1/actions/{id}/run': { post: { summary: 'Run an action: body {entity?: {blueprint, key}, inputs}. for: <the sign-in address of a person> asks in the name of that person (a machine access token with actions.ask), and then approvers: [{path?, field?, values}] names who alone decides the run if it waits, never that person: the hub judges it as theirs, never with the override of an admin, and a person it has not met is added with no role. requestedFor: <the sign-in address of a person> asks as the caller itself (a machine access token with actions.ask) for that person, who is kept on the run as requestedFor and needs no access: the caller\'s own access lets it run the action, the person never decides the run, and the hub tells them nothing of it; with approvers it always waits for one of them. Name for or requestedFor, never both. tiers: [read|data|act] asks for tool tiers beyond those the action carries; such a run always waits, and only someone who holds each tier on that entity approves it. revises: <run id> names a run of the same action on the same entity, by the same person, that was sent back or still waits for its decision: the new run is its next round, and one that still waits ends cancelled, superseded by it. Answers the run; the action itself names who may run it. Each input is checked as its kind and by its rules; a refusal over one input answers {error, input}, input being its name. An input whose when does not match is not asked: what is sent for it is dropped. An input with a value is worked out by the hub, never taken from the body. A unique input is refused when an active entity already holds the value. A many input with current changes a list the entity holds: the hub renders current as the run is asked for and keeps it on the run as current, by input name, and refuses a run that leaves every such list as it is, as a set, over the first of them. A list a person types holds each value once', security: bearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { entity: entityRef, inputs: { type: 'object', additionalProperties: true }, for: { type: 'string' }, requestedFor: { type: 'string' }, approvers: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, field: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['values'] } }, tiers: { type: 'array', items: { type: 'string', enum: ['read', 'data', 'act'] } }, revises: { type: 'string' } } } } } } } },
      '/v1/actions/{id}/batch/preview': { post: { summary: 'What a batch of the action would run on, before anything is asked: body {entities: [{blueprint, key}]} or {query: {blueprint, filter?, states?, hidden?, except?}}, and {inputs}. Answers {total, max, entities: [{blueprint, key, title}], refused: [{blueprint, key, title, reason}], approval, estimate: {seconds, basis} | null, ahead}. Only for an action with batch', security: bearer } },
      '/v1/actions/{id}/batch': { post: { summary: 'Run the action on many entities at once, the same body as the preview: each entity gets its own run, judged as one asked alone, naming the batch. Answers the batch {id, asked, refused, counts, done}. A runner is handed every run asked alone before any run of a batch', security: bearer } },
      '/v1/access/approvals': { get: { summary: 'The blueprint the hub writes its own approvals into, {approvals: {blueprint} | null}', security: bearer }, put: { summary: 'Names the approvals blueprint, or null for none; an admin\'s. The blueprint needs a decision field', security: bearer } },
      '/v1/schedules': { get: { summary: 'Schedules: the caller\'s own, or every one for someone who decides approvals, {schedules}', security: bearer }, post: { summary: 'Asks for a schedule as the caller\'s: body {action, title, target: {entity?} | {entities?: [{blueprint, key}]} | {matching?: {blueprint, filter?, states?, hidden?, except?}} | {query?: savedQueryId}, inputs, cadence: {every: once, on: ISO moment, tz} | {every: hour, minute, tz} | {every: hours, hours: 2|3|4|6|8|12, at, tz} | {every: day, at, tz} | {every: week, days, at, tz}, deliver?, tell?: failed | anyFailed | every}. tell says which results its owner and the people in deliver hear of, only failures when left out. One on repeat waits for approval; once is a run put off, fires at its moment, and is then done. It says the load it adds', security: bearer } },
      '/v1/schedules/awaiting': { get: { summary: 'The schedules waiting for the caller to decide them', security: bearer } },
      '/v1/reports': { get: { summary: 'The reports the caller may see, the newest published first: {reports: [{key, title, owner, home, yours, status, statusReason, editions, latest: {number, publishedAt, summary, stats}, schedules: [{id, title, when, state, nextAt, owner}]}], total}. home keeps it to the reports of one entity', security: bearer, parameters: [{ name: 'home', in: 'query', schema: { type: 'string' }, description: 'blueprint:key' }] } },
      '/v1/datasets': { get: { summary: 'The published datasets the caller may read in a query, as the source $data:<id>: {datasets: [{id, title, description, icon, columns: [{id, title, type}], fresh, entity, fetchedAt}]}', security: bearer } },
      '/v1/datasets/{id}/refresh': { post: { summary: 'Reads a dataset from its tool again, whatever answer is kept, as a run of the caller: {fetchedAt, rows}', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/reports/check': { post: { summary: 'Reads a report layout and names every problem with its line, as an edit would refuse it, the saved queries and tools it names judged as the caller: {issues: [{line, message}]}. Empty issues means it reads. Body {layout}', security: bearer } },
      '/v1/reports/{key}': { get: { summary: 'A report as the caller may see it: {report, canChange, versions: [{version, note, by, at, restoredFrom}], editions: [{number, publishedAt, summary, headline}], stats: [{name, title, unit, decimals, better}], schedules: [{id, title, when, state, nextAt, owner}]}, newest first. A report is changed only by running an action with the report backend', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/reports/{key}/versions/{version}': { get: { summary: 'One version of a report layout: {layout}', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'integer' } }] } },
      '/v1/reports/{key}/editions/{number}': { get: { summary: 'One edition whole: {content: {title, number, publishedAt, blocks}, data: {<data set>: {columns, rows, total, truncated, error}}}', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'number', in: 'path', required: true, schema: { type: 'integer' } }] } },
      '/v1/reports/{key}/editions/{number}/body': { get: { summary: 'One edition drawn as HTML: profile=email (the default) is a whole page with every style inline, to read or forward; profile=web is the fragment the hub page draws', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'number', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'profile', in: 'query', schema: { type: 'string', enum: ['email', 'web'] } }] } },
      '/v1/reports/{key}/editions/{number}/data': { get: { summary: 'The data sets one edition read, as kept, as a JSON download', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'number', in: 'path', required: true, schema: { type: 'integer' } }] } },
      '/v1/reports/{key}/previews/{run}': { get: { summary: 'The preview a report preview run drew, kept with the run: the same shape as an edition', security: bearer, parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'run', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/v1/schedules/history': { get: { summary: 'Every firing over the last days (default 7, at most 90) of the schedules the caller may see, or of the one named, oldest first, {since, days, firings: [{schedule, at, run, batch, runs, succeeded, failed, open, stopped, seconds, startedAt, endedAt, error}]}', security: bearer, parameters: [{ name: 'days', in: 'query', schema: { type: 'integer' } }, { name: 'schedule', in: 'query', schema: { type: 'string' } }] } },
      '/v1/schedules/{id}': { get: { summary: 'One schedule', security: bearer }, put: { summary: 'Changes a schedule; one on repeat that fires differently waits for approval again, and a new title, deliver, or tell keeps it as it stands', security: bearer }, delete: { summary: 'Removes a schedule', security: bearer } },
      '/v1/schedules/{id}/approve': { post: { summary: 'Approves a schedule that waits; needs actions.approve or admin', security: bearer } },
      '/v1/schedules/{id}/decline': { post: { summary: 'Declines a schedule that waits, body {reason?}', security: bearer } },
      '/v1/schedules/{id}/pause': { post: { summary: 'Pauses a schedule', security: bearer } },
      '/v1/schedules/{id}/resume': { post: { summary: 'Starts an approved, paused schedule firing again', security: bearer } },
      '/v1/schedules/{id}/run': { post: { summary: 'Fires an approved schedule now', security: bearer } },
      '/v1/action-insights': { get: { summary: 'What self-service was used for over days (default 30): per action, per person, batches, and each runner by hour of the day; needs audit.view', security: bearer, parameters: [{ name: 'days', in: 'query', schema: { type: 'integer' } }] } },
      '/v1/query': { post: { summary: 'Runs a query: every row each of its blueprints matches, read through the caller\'s view, up to 50,000. Body {sources: [{blueprint, clauses: [{field, op, value, not?, where?, match?}], search?, states?, hidden?}] where a clause on a relation (field r:<name>, op exists) may hold where, conditions on the entities it reaches, and match any|all|none of them meeting them, columns: [id or {id, title, from}], view?}; a column is a field, a relation as r:<name>, or $type, title, key, $status, state, $owner, lastSeenAt, updatedAt, or read through relations: r:<path> the titles at the end of a relation path (team.department, <-blueprint:relation for a hop in) and r:<path>@<field> a field there, each a list. view {where: [{field: <column id>, op, value, not?}], sort: [{column, desc?}], group: [column], totals: {column: count|filled|distinct|sum|avg|min|max}, widths} is how the answer is shown; this route answers the rows as read, and an export, a batch, or a schedule takes the rows it keeps. Answers {columns, rows: [{blueprint, key, values}], counts, truncated, ms}', security: bearer } },
      '/v1/query/export': { post: { summary: 'The same query as an Excel workbook: body {spec, title?}. One sheet of the rows its view keeps, in its order, and a sheet for each blueprint when it reads more than one', security: bearer } },
      '/v1/queries': { get: { summary: 'Saved queries: the caller\'s own, and every one shared with them: with everyone, with an audience they are in, or with the people of a home they own, {queries}; each names its home as the caller sees it. ?home=<blueprint:key> lists only the queries that belong to that entity', security: bearer }, post: { summary: 'Saves a query as the caller\'s: body {title, description?, shared?, audience?, home?, homeShared?, spec}; an audience must be one the caller is in. home is the entity it belongs to (blueprint:key), one the caller sees; null takes it off, and left out it keeps the one it has. homeShared opens it to the people who own its home, set only by one of them or an admin', security: bearer } },
      '/v1/queries/audiences': { get: { summary: 'The audiences the caller is in, which a query may be shared with, {audiences}', security: bearer } },
      '/v1/queries/{id}': { get: { summary: 'One saved query', security: bearer }, put: { summary: 'Changes a saved query; only whoever saved it, or an admin', security: bearer }, delete: { summary: 'Removes a saved query; only whoever saved it, or an admin', security: bearer } },
      '/v1/queries/{id}/run': { get: { summary: 'Runs a saved query as the caller sees the catalog', security: bearer } },
      '/v1/queries/{id}/export': { get: { summary: 'A saved query as an Excel workbook', security: bearer } },
      '/v1/action-batches': { get: { summary: 'The newest batches the caller may see: {batches}. action names one action', security: bearer, parameters: [{ name: 'action', in: 'query', schema: { type: 'string' } }] } },
      '/v1/action-batches/{id}': { get: { summary: 'One batch with every entity it ran on, and canDecide, whether the caller decides its runs that wait: items [{blueprint, key, title, run, state, summary, outputs, images, runs, attempt, retryAt}], the newest run on each, and left: {seconds, basis: history | pace} | null, how long it still has; images names the outputs that are pictures, read at /v1/action-runs/{run}/outputs/{name}', security: bearer } },
      '/v1/action-batches/{id}/approve': { post: { summary: 'Approve every run of a batch that waits for approval, as one decision: each is approved as it would be alone, and one the caller may not decide stays waiting. A run called as a person (onBehalf) runs as the approver, from this request\'s own sign-in, and keeps that right until it starts, however long it waits its turn. Body {note?}. Answers {approved, voted, refused: [{reason, runs}]}', security: bearer } },
      '/v1/action-batches/{id}/stop': { post: { summary: 'Stop a batch: every run of it not started yet is cancelled; what runs finishes. Whoever asked for it, or an admin', security: bearer } },
      '/v1/action-batches/{id}/again': { post: { summary: 'Run again, in the same batch, on some of its entities whose newest run has ended: body {entities: [{blueprint, key}]} or {states: [failed, ...]}. Whoever asked for it, or an admin. Answers {asked, refused}', security: bearer } },
      '/v1/change-sets': {
        get: { summary: 'The newest change sets the caller may see: {sets}, each {id, title, note, by, through, retries, createdAt, decision: pending | approved | rejected | withdrawn, decidedBy, decidedAt, decisionNote, size, actions: [{id, title, runs}], counts, done, endedAt, url}. by names who asked; waiting=true keeps the sets that wait for the caller\'s own decision', security: bearer, parameters: [{ name: 'by', in: 'query', schema: { type: 'string' } }, { name: 'waiting', in: 'query', schema: { type: 'boolean' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }] },
        post: { summary: 'Asks for many runs as one change set, for one decision: body {title, note?, items: [{action, entity?: {blueprint, key}, inputs}], for?}. Each item is judged as a run of it alone would be; when any is refused nothing is asked, and the answer is 400 {error, items: [{index, action, entity, error, input?}]}. Every run waits for the set\'s decision. Answers the set, 201', security: bearer },
      },
      '/v1/change-sets/{id}': { get: { summary: 'One change set with every run in its place: items [{index, run, action, actionTitle, entity, entityTitle, inputs, inputTitles?, state, summary, approvalsNeeded, approvedBy, attempt, startedAt, finishedAt}], and canDecide, canWithdraw, canRetry for the caller', security: bearer } },
      '/v1/change-sets/{id}/approve': { post: { summary: 'Approves every run of a change set that waits, in its order, as one decision: each as it would be approved alone, and nothing unless the caller may decide every one. A run called as a person (onBehalf) runs as the approver, from this request\'s own sign-in, and keeps that right until it starts, however long it waits its turn. Body {note?}. Answers {approved, voted, set}', security: bearer } },
      '/v1/change-sets/{id}/reject': { post: { summary: 'Rejects a change set: every run of it that waits is declined. Body {reason?}. Answers the set', security: bearer } },
      '/v1/change-sets/{id}/withdraw': { post: { summary: 'Withdraws a change set that waits: every run of it is cancelled. Whoever asked for it, or an admin. Body {reason?}. Answers the set', security: bearer } },
      '/v1/change-sets/{id}/retry': { post: { summary: 'Asks again for every change of an ended set that failed, as a new change set for approval that names this one as retries. Whoever asked for it, or an admin. Answers the new set, 201', security: bearer } },
      '/v1/action-runs/{id}/outputs/{name}': { get: { summary: 'An image a run reported, as the image itself (image/png, image/jpeg, or image/webp). 404 when the output is not an image', security: bearer } },
      '/v1/action-runs': { get: { summary: 'Runs, newest first: {runs, more}, where more says older runs match too. group=batch lists only the runs asked alone, and the batches asked over the same span in batches, each one line with counts, cover, and endedAt. group=origin also leaves out what a schedule fired, and lists it in schedules: one line a schedule a day in the tz named (IANA, UTC by default), with its title, cadence in words, firings, counts, missed firings, and why the newest failure failed. group=origin with schedule, from, and to lists the firings of that schedule over that span instead: its runs asked alone and its batches. A run on an entity carries entityTitle, the title of what it ran on, null once that is gone, and inputTitles, the title of each entity it was given as an input, by its id, those the caller may see. An input the run was not asked for is null. The run of a tool is left out unless tools=true or action names it. limit is at most 500, 50 by default', security: bearer, parameters: [{ name: 'action', in: 'query', schema: { type: 'string' } }, { name: 'state', in: 'query', schema: { type: 'string' }, description: 'Comma separated: awaiting, queued, running, succeeded, failed, unknown, declined, returned, cancelled' }, { name: 'tools', in: 'query', schema: { type: 'boolean' }, description: 'Include the runs of tools' }, { name: 'scheduled', in: 'query', schema: { type: 'boolean' }, description: 'false leaves out the runs a schedule fired, so only what people asked by hand is listed' }, { name: 'by', in: 'query', schema: { type: 'string' }, description: 'Only the runs this person or token asked for' }, { name: 'entity', in: 'query', schema: { type: 'string' }, description: 'blueprint:key' }, { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'group', in: 'query', schema: { type: 'string', enum: ['batch', 'origin'] } }, { name: 'tz', in: 'query', schema: { type: 'string' }, description: 'With group=origin: the time zone the days of schedules are read in' }, { name: 'schedule', in: 'query', schema: { type: 'string' }, description: 'With a group: only what this schedule fired' }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }] } },
      '/v1/action-runs/{id}': { get: { summary: 'One run with its state, its log (each line {at, message, step?}), the steps its backend named ({name, at}), the outputs it ended with, its link, heardAt (when the hub last heard from it while it ran), canStop (on a job\'s run under way, whether the caller may stop it), wroteBack: [{field, was, now}], what it wrote back on its entity once it succeeded, only fields the caller may see, and statementDigest, the digest of the change statement a run of an action with a change input carries. A run is read at any time, by whoever may see it: nothing has to stay connected for it to go on. A job\'s own container reads its run here with the credential made for that run (orr_run_), which opens no other read', security: bearer } },
      '/v1/action-runs/{id}/approve': { post: { summary: 'Approve a run that waits for it, with an optional {note}: a holder of actions.approve, or someone a rule lets run the action there without approval. A run that names approvers is approved only by someone they let in, never its asker. The person a product asked a run for never decides it. A run held for its asker\'s own approval (heldFor: self) is approved by its asker alone. A run that asks for tool tiers is approved only by someone who holds each of them on its entity. A run called as a person (onBehalf) is approved only by someone who may run it there themselves, and the approval that starts it must be their own signed-in request: it runs as them', security: bearer } },
      '/v1/action-runs/{id}/decline': { post: { summary: 'Decline a run that waits for approval: body {reason?}, kept on the run as its note. Whoever may approve it', security: bearer } },
      '/v1/action-runs/{id}/return': { post: { summary: 'Send back a run that waits for approval: body {note}, what to change. Whoever may approve it. It ends returned, and the person who asked may ask again with revises', security: bearer } },
      '/v1/tools': { get: { summary: 'The tools the caller may call on an entity, or the tools of no entity: {tools: [{id, title, description?, tier, inputs}]}. A tool is listed when the caller holds its tier there and its runner serves it. With for and action (a machine access token with tools.lend), the tools a call lent to that person\'s request reaches', security: bearer, parameters: [{ name: 'entity', in: 'query', schema: { type: 'string' }, description: 'blueprint:key' }, { name: 'for', in: 'query', schema: { type: 'string' }, description: 'The person whose request it is' }, { name: 'action', in: 'query', schema: { type: 'string' }, description: 'The action that person asked in' }, { name: 'run', in: 'query', schema: { type: 'string' }, description: 'A run of that action whose granted tiers are lent too' }] } },
      '/v1/tools/{id}/call': { post: { summary: 'Call a tool and wait for what it printed: body {entity?: {blueprint, key}, inputs?, as?: {person, action, entity, run?}}. Answers 201 {run, state, summary, text, truncated, outputs}; text is at most 64 KB. The caller needs the tool\'s tier on the entity. as calls in a person\'s name (a machine access token with tools.lend), with the tiers of the action they asked in and of the live run named, on the entity their request is on; with the act tier, id may also be a plain action, asked for as that person. A tool no runner took while the call waited is cancelled', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { entity: entityRef, inputs: { type: 'object', additionalProperties: true }, as: { type: 'object', properties: { person: { type: 'string' }, action: { type: 'string' }, entity: entityRef, run: { type: 'string' } }, required: ['person', 'action', 'entity'] } } } } } } } },
      '/v1/action-runs/{id}/withdraw': { post: { summary: 'Withdraw a run not started yet, or stop a job\'s run under way (canStop on the run): body {reason?}. The person who asked, or an admin. It ends cancelled, and the starter of a job\'s run stops its job', security: bearer } },
      '/v1/action-runs/{id}/report': { post: { summary: 'What a backend says about a run: body {state?: running|succeeded|failed, label?, link?, summary?, log?: [lines], step?, outputs?: {name: text|number|boolean|null}} (needs actions.report, or, from a job\'s own container, the credential made for its run, orr_run_, which reports on that run alone and never carries a state). Every report says the run is alive, an empty body too: a run under way that is not heard from for the hub\'s time (ACTION_TIMEOUT_MINUTES) ends unknown. running starts a queued run; on a serial action it answers 409 while another run of its line is running. step starts a named step, as does a line "::step:: <name>" or a JSON line with a step; outputs sets named values (null takes one away), as does a line "::output:: <name>=<value>"; a run holds at most 50, and whoever may see the run sees them, so never a secret. A line "::refresh:: <field>=<json>" hands back a value of the run\'s entity, held until the run ends and written on it as its owning source once it succeeds, only for a field the action refreshes; anything else is dropped with a log line', security: bearer } },
      '/v1/sign-in': { get: { summary: 'How an app signs a person in to call this surface as them: {issuer, scope}. No token needed; 404 when the hub takes none' } },
      '/v1/ingest/runner/jobs': { get: { summary: 'Claim the queued action runs that name this runner, rendered as jobs (runner token). wait holds the call open, up to 30 seconds, until a job is queued; max is how many to claim, 1 to 50', security: bearer, parameters: [{ name: 'wait', in: 'query', schema: { type: 'integer' } }, { name: 'max', in: 'query', schema: { type: 'integer' } }] } },
      '/v1/ingest/runner/jobs/{id}/report': { post: { summary: 'Report on a job this runner claimed, same body as /v1/action-runs/{id}/report. A starter reports here on the job runs it claimed, and may say state: unknown when a run\'s job is gone and nobody saw how it ended', security: bearer } },
      '/v1/ingest/starter/jobs': { get: { summary: 'Claim the queued job runs that name this starter (runner token): {starter, jobs: [{run, action, try, template, image, command, args, env, token, ceilingMs}]}. Each run is marked running under the starter, which starts one container for it from its own template. template is the name the hub worked out for the run: the action\'s fixed one, or the one the run\'s entity names, read as the job is claimed. token is the credential made for that run alone, given here once: the job reports with it at /v1/action-runs/{run}/report and reads its run at /v1/action-runs/{run}. wait holds the call open, up to 30 seconds; max is how many to claim, 1 to 50', security: bearer, parameters: [{ name: 'wait', in: 'query', schema: { type: 'integer' } }, { name: 'max', in: 'query', schema: { type: 'integer' } }] } },
      '/v1/ingest/starter/runs': { post: { summary: 'How the runs this starter claimed stand (runner token): body {seen?: [run ids]}, the runs whose jobs it still finds on its platform, 1,000 at most. Answers {starter, runs: [{run, try, state, startedAt, ceilingMs, summary}]}: every run it holds that is still running, and each seen run it once claimed. A starter keeps no state: it says a running run is alive while its job is, reports how the job ended, and stops the job of a run that is cancelled', security: bearer } },
      '/mcp': { post: { summary: 'MCP server (streamable HTTP), same tools as the read API', security: bearer } },
      '/v1/ingest/runs': { post: { summary: 'Open a run (source token); the answer says sightings: true when this hub takes an entity named by its digest alone', security: bearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['snapshot', 'incremental'] }, scope: { type: 'string' }, write: { type: 'string', enum: ['upsert', 'enrich'] } }, required: ['mode', 'scope'] } } } } } },
      '/v1/ingest/runs/{id}/entities': { put: { summary: 'Write a batch into a run; updates apply at once, and a sighting the hub cannot take comes back in wanted, to be sent in full', security: bearer, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { entities: { type: 'array', items: writeInput }, observedAt: { type: 'string', format: 'date-time' } }, required: ['entities'] } } } } } },
      '/v1/ingest/runs/{id}/commit': { post: { summary: 'Commit: a snapshot marks unseen entities in its scope missing', security: bearer } },
      '/v1/ingest/runs/{id}/fail': { post: { summary: 'Mark a run failed; it deletes nothing', security: bearer } },
      '/v1/ingest/entities/{blueprint}/{key}': {
        put: { summary: 'Create or replace one entity', security: bearer },
        patch: { summary: 'Merge fields into one entity', security: bearer },
        delete: { summary: 'Explicit delete (needs a delete grant); blocks re-creation for 1h', security: bearer },
      },
      '/v1/ingest/heartbeat': { post: { summary: 'Mark the source alive without a run', security: bearer } },
      '/v1/ingest/alerts/alertmanager': {
        post: {
          summary: "Alertmanager's webhook: firing and resolved alerts, kept on what they fire on (an event source's token)",
          security: bearer,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    alerts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          status: { type: 'string', enum: ['firing', 'resolved'] },
                          labels: { type: 'object', additionalProperties: { type: 'string' } },
                          annotations: { type: 'object', additionalProperties: { type: 'string' } },
                          startsAt: { type: 'string' },
                          endsAt: { type: 'string' },
                          fingerprint: { type: 'string' },
                        },
                        required: ['status', 'fingerprint'],
                      },
                    },
                  },
                  required: ['alerts'],
                },
              },
            },
          },
        },
      },
      '/v1/ingest/sources/{id}/refresh': { post: { summary: 'Pull a git source now (webhook target)', security: bearer } },
    }),
  }
}

type Operation = { operationId?: string; responses?: Record<string, unknown> } & Record<string, unknown>

/**
 * Publishes every route, all under version 1, and leaves out the MCP
 * server, which is an API of its own. Names every operation and gives it the one error shape: an operationId
 * from its method and path (GET /v1/entities/{blueprint}/{key} is
 * getEntitiesByBlueprintKey), the name a generated client or tool calls it
 * by, and a default response of the shared Error.
 */
export function finish(written: Record<string, Record<string, Operation>>): Record<string, Record<string, Operation>> {
  const paths: Record<string, Record<string, Operation>> = {}
  for (const [path, item] of Object.entries(written)) {
    if (path !== '/mcp') paths[path] = item
  }
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      op.operationId ??= operationId(method, path)
      op.responses = { ...(op.responses ?? {}), default: { $ref: '#/components/responses/Error' } }
    }
  }
  return paths
}

function operationId(method: string, path: string): string {
  const words: string[] = []
  const params: string[] = []
  for (const part of path.split('/').filter((p) => p && p !== 'v1')) {
    const param = /^\{(.+)\}$/.exec(part)
    if (param) params.push(param[1]!)
    else words.push(...part.split(/[-_.]/))
  }
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  return method + words.map(cap).join('') + (params.length ? 'By' + params.map(cap).join('') : '')
}

/** What every save of the model is checked and recorded by, the same as the model page's own. */
const MODEL_SAVE = 'Runs the checks the model page runs and answers the saved definition; a definition the hub refuses (a calculation that does not compile, a type the stored values do not fit, a part git defines) changes nothing and answers why. Recorded in the activity log under the caller (needs model.edit; access rules, adminEdit, and summary are an admin\'s)'

const AGENT_GUIDE = `One graph of the estate: services, infrastructure, people, teams, and their health, as entities of blueprints joined by relations.

How to use it:
1. Send your token on every request as \`Authorization: Bearer <token>\` to the server listed in this document.
2. GET /v1/whoami to confirm the token and see what it may do.
3. GET /v1/guide for the conventions the model follows, then GET /v1/blueprints to learn the model. Every blueprint and field carries a description; read them before searching.
4. GET /v1/summary for an overview of the estate and what is not healthy.
5. GET /v1/entities?blueprint=<id> to search, /v1/entities/{blueprint}/{key} for one entity, and /v1/entities/{blueprint}/{key}/related to follow relations. One entity carries the first ${ENTITY_LINKS} of each kind of thing that points at it and, in incomingCount, how many there are; read the rest with /v1/entities?blueprint=<that kind>&filter={"relation":"<relation>","target":"<blueprint>:<key>"}, a page at a time.

An MCP server at /mcp (streamable HTTP, same token) offers the same reads as tools, each answer small and saying how to read more: modelling_guide, describe_model, estate_summary, search_entities, run_query, get_entity, traverse, get_status, list_findings, get_changes. It changes the model too, as the person the token is: get_model_definition, edit_model, delete_from_model, rename_blueprint.

The model is changed where it lives, on the hub: GET /v1/model/export reads it whole, and PUT or PATCH /v1/blueprints/{id}, /v1/rules/{id}, /v1/scorecards/{id}, and /v1/alert-rules/{id} change it, with the checks the model page runs (needs model.edit).

Asking again costs little. GET /v1/entities, /v1/summary, /v1/mine, /v1/wall, and /v1/findings answer with an ETag. Send it back as If-None-Match, and while nothing the answer reads has moved, the hub answers 304 with no body; a list is told so before any row is read. A list pages with after: pass the next a page answered with, and the page after it reads none of the rows before.

The /ingest routes are for pushers and runners with a source token, not for reading.`

/** Where the definition kept with the code lives: openapi.json at the repository root. */
export const DEFINITION_PATH = resolve(import.meta.dirname, '../../openapi.json')

/** The definition kept with the code, for any host and no release: what `npm run openapi` writes. */
export function definition(): string {
  return `${JSON.stringify(openapi('/', '0.0.0'), null, 2)}\n`
}
