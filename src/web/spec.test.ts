import { describe, expect, it } from 'vitest'
import { changesOf, deref, exampleFor, exampleOf, preferred, readView, requestOf, shapeOf } from './spec.ts'

const pets = {
  openapi: '3.0.1',
  info: { title: 'Pets', version: '2.0', description: 'Every pet.' },
  servers: [{ url: 'https://{region}.pets.example/v2', variables: { region: { default: 'eu' } } }],
  tags: [{ name: 'pets', description: 'The animals.' }, { name: 'admin' }],
  paths: {
    '/pets/{id}': {
      parameters: [{ name: 'id', in: 'path', schema: { type: 'string', format: 'uuid' } }],
      delete: { tags: ['admin'], responses: { '204': { description: 'Gone' } } },
      get: { tags: ['pets'], summary: 'One pet', responses: { '200': { $ref: '#/components/responses/Pet' }, default: { description: 'Error' } } },
    },
    '/pets': {
      post: { tags: ['pets'], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { '201': { description: 'Made' } } },
    },
    '/health': { get: { responses: { '200': { description: 'Up' } } } },
  },
  components: {
    responses: { Pet: { description: 'The pet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
    schemas: {
      Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['cat', 'dog'] }, friends: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }, tags: { type: 'object', additionalProperties: { type: 'string' } } } },
      Loop: { $ref: '#/components/schemas/Loop' },
    },
  },
}

describe('readView', () => {
  it('groups operations by tag in the order the document lists them, the untagged last', () => {
    const view = readView(pets)
    expect(view).toMatchObject({ title: 'Pets', version: '2.0', standard: 'OpenAPI 3.0.1', description: 'Every pet.', servers: ['https://eu.pets.example/v2'] })
    expect(view.groups.map((g) => [g.tag, g.operations.map((o) => o.id)])).toEqual([
      ['pets', ['POST /pets', 'GET /pets/{id}']],
      ['admin', ['DELETE /pets/{id}']],
      ['default', ['GET /health']],
    ])
    expect(view.groups[0]!.description).toBe('The animals.')
  })

  it('reads parameters from the path, bodies, and responses through their refs', () => {
    const [post, get] = readView(pets).groups[0]!.operations
    expect(get!.parameters).toEqual([{ name: 'id', in: 'path', required: true, description: undefined, schema: { type: 'string', format: 'uuid' } }])
    expect(get!.responses.map((r) => [r.code, r.description, r.contents.map((c) => c.type)])).toEqual([
      ['200', 'The pet', ['application/json']],
      ['default', 'Error', []],
    ])
    expect(post!.body).toEqual({ required: true, description: undefined, contents: [{ type: 'application/json', schema: { $ref: '#/components/schemas/Pet' } }] })
  })

  it('reads Swagger 2.0: its server, body parameter, and response schemas', () => {
    const view = readView({
      swagger: '2.0',
      info: { title: 'Old', version: '1' },
      host: 'old.example',
      basePath: '/api',
      schemes: ['https', 'http'],
      paths: { '/things': { post: { parameters: [{ name: 'q', in: 'query', type: 'string' }, { name: 'thing', in: 'body', schema: { type: 'object' } }], responses: { '200': { description: 'OK', schema: { type: 'array', items: { type: 'string' } } } } } } },
    })
    expect(view.standard).toBe('Swagger 2.0')
    expect(view.servers).toEqual(['https://old.example/api', 'http://old.example/api'])
    const op = view.groups[0]!.operations[0]!
    expect(op.parameters.map((p) => p.name)).toEqual(['q'])
    expect(op.body?.contents).toEqual([{ type: 'application/json', schema: { type: 'object' } }])
    expect(op.responses[0]!.contents[0]!.schema).toEqual({ type: 'array', items: { type: 'string' } })
  })
})

describe('shapeOf', () => {
  it('names a referenced schema and lists its fields', () => {
    const pet = shapeOf(pets, { $ref: '#/components/schemas/Pet' })
    expect(pet.label).toBe('Pet')
    expect(pet.ref).toBe('Pet')
    expect(pet.fields.map((f) => [f.name, f.required])).toEqual([
      ['name', true],
      ['kind', false],
      ['friends', false],
      ['tags', false],
    ])
  })

  it('labels arrays, maps, formats, and enums', () => {
    const pet = shapeOf(pets, { $ref: '#/components/schemas/Pet' })
    const field = (name: string) => shapeOf(pets, pet.fields.find((f) => f.name === name)!.schema)
    expect(field('friends').label).toBe('Pet[]')
    expect(field('friends')).toMatchObject({ ref: 'Pet', fields: { length: 4 } })
    expect(field('tags').label).toBe('map of string')
    expect(field('kind').values).toEqual(['cat', 'dog'])
    expect(shapeOf(pets, { type: 'string', format: 'uuid' }).label).toBe('string · uuid')
    expect(shapeOf(pets, { type: ['string', 'null'] })).toMatchObject({ label: 'string', nullable: true })
    expect(shapeOf(pets, {}).label).toBe('any')
  })

  it('merges allOf and lists the choices of oneOf', () => {
    const merged = shapeOf(pets, { allOf: [{ $ref: '#/components/schemas/Pet' }, { properties: { age: { type: 'integer' } }, required: ['age'] }] })
    expect(merged.label).toBe('object')
    expect(merged.fields.filter((f) => f.required).map((f) => f.name)).toEqual(['name', 'age'])
    expect(shapeOf(pets, { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/Pet' }] })).toMatchObject({ label: 'string | Pet', fields: [{ name: 'One of 1' }, { name: 'One of 2' }] })
  })

  it('stops at a ref that points at itself or outside the document', () => {
    expect(deref(pets, { $ref: '#/components/schemas/Loop' }).node).toBeUndefined()
    expect(shapeOf(pets, { $ref: 'https://elsewhere.example/schema.json#/Thing' }).label).toBe('Thing')
  })
})

const guarded = {
  ...pets,
  security: [{ bearer: [] }],
  components: {
    ...pets.components,
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, key: { type: 'apiKey', in: 'query', name: 'api_key' } },
  },
  paths: {
    ...pets.paths,
    '/health': { get: { security: [], responses: { '200': { description: 'Up', content: { 'application/json': { example: { up: true } } } } } } },
    '/search': { get: { security: [{ key: [] }], parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', example: 'rex' } }], responses: { '200': { description: 'Found' } } } },
  },
}

describe('signing in', () => {
  it('reads each operation own security, the document for the rest, and an empty list as open', () => {
    const view = readView(guarded)
    const op = (id: string) => view.groups.flatMap((g) => g.operations).find((o) => o.id === id)!
    expect(op('POST /pets').auth).toEqual([[{ name: 'bearer', label: 'Bearer token (JWT)', scopes: [], carry: { in: 'header', name: 'Authorization', value: 'Bearer $TOKEN' } }]])
    expect(op('GET /health').auth).toEqual([])
    expect(op('GET /search').auth[0]![0]!.label).toBe('API key in query parameter api_key')
    expect(view.auth).toEqual({ labels: ['Bearer token (JWT)', 'API key in query parameter api_key'], guarded: 4 })
  })
})

describe('examples', () => {
  it('makes a value of a schema shape, stopping where it nests inside itself', () => {
    expect(exampleOf(pets, { $ref: '#/components/schemas/Pet' })).toEqual({ name: 'string', kind: 'cat', friends: [null], tags: { key: 'string' } })
    expect(exampleOf(pets, { type: 'string', format: 'uuid' })).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6')
    expect(exampleOf(pets, { oneOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0)
    expect(exampleOf(pets, { type: 'string', example: 'given' })).toBe('given')
  })

  it('takes the example a media type gives over one made from its schema', () => {
    const health = readView(guarded).groups.flatMap((g) => g.operations).find((o) => o.id === 'GET /health')!
    expect(exampleFor(guarded, health.responses[0]!.contents[0]!)).toEqual({ value: { up: true }, given: true })
  })
})

describe('requestOf', () => {
  const view = readView(guarded)
  const op = (id: string) => view.groups.flatMap((g) => g.operations).find((o) => o.id === id)!

  it('writes curl and PowerShell with the sign-in as a stand-in and an example body', () => {
    const { curl, powershell } = requestOf(guarded, op('POST /pets'), view.servers[0])
    expect(curl).toBe(`curl -X POST 'https://eu.pets.example/v2/pets' \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{
  "name": "string",
  "kind": "cat",
  "friends": [
    null
  ],
  "tags": {
    "key": "string"
  }
}'`)
    expect(powershell.split('\n').slice(0, 4)).toEqual(['Invoke-RestMethod -Method Post `', "  -Uri 'https://eu.pets.example/v2/pets' `", '  -Headers @{ Authorization = "Bearer $TOKEN" } `', "  -ContentType 'application/json' `"])
  })

  it('puts required query parameters and a query key in the URL, and leaves a path parameter to fill in', () => {
    expect(requestOf(guarded, op('GET /search'), view.servers[0]).curl).toBe(`curl "https://eu.pets.example/v2/search?q=rex&api_key=$API_KEY"`)
    expect(requestOf(guarded, op('GET /pets/{id}'), view.servers[0]).curl.split(' \\')[0]).toBe("curl 'https://eu.pets.example/v2/pets/{id}'")
  })
})

describe('preferred', () => {
  it('picks JSON over the order the document lists its media types in', () => {
    const of = (...types: string[]) => preferred(types.map((type) => ({ type, schema: {} })))?.type
    expect(of('text/json', 'application/json')).toBe('application/json')
    expect(of('text/plain', 'application/problem+json')).toBe('application/problem+json')
    expect(of('text/plain', 'application/xml')).toBe('text/plain')
    expect(of()).toBeUndefined()
  })
})

describe('changesOf', () => {
  it('names operations added, removed, and changed, a change to a schema they use included', () => {
    const after = {
      ...pets,
      info: { ...pets.info, version: '2.1' },
      paths: { '/pets/{id}': pets.paths['/pets/{id}'], '/pets': pets.paths['/pets'], '/owners': { get: { responses: { '200': { description: 'Owners' } } } } },
      components: { ...pets.components, schemas: { ...pets.components.schemas, Pet: { ...pets.components.schemas.Pet, required: ['name', 'kind'] } } },
    }
    expect(changesOf(pets, after)).toEqual({ added: ['GET /owners'], removed: ['GET /health'], changed: ['POST /pets', 'GET /pets/{id}'], version: { from: '2.0', to: '2.1' } })
    expect(changesOf(pets, pets)).toEqual({ added: [], removed: [], changed: [] })
  })
})
