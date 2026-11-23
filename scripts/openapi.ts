// Writes openapi.json, the definition of the hub's API kept with its code,
// which orrery.yaml names and Trellis judges. A test fails while it is stale.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFINITION_PATH, definition } from '../src/server/openapi.ts'

writeFileSync(DEFINITION_PATH, definition())
console.log('wrote', resolve(DEFINITION_PATH))
