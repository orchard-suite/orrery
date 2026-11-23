import { describe, expect, it } from 'vitest'
import { OUTPUTS_MAX, OUTPUT_IMAGE_MAX, OUTPUT_VALUE_MAX, REFRESH_VALUE_MAX, STEP_NAME_MAX, isImageOutput, outputText, readLines, readMark } from './run-marks.ts'

describe('reading one reported line', () => {
  it('starts a step from the marker and drops the marker line', () => {
    expect(readMark(null, '::step:: Stop the app')).toEqual({ kind: 'step', name: 'Stop the app', kept: false })
    expect(readMark('Stop the app', '::step::   Verify  \r')).toEqual({ kind: 'step', name: 'Verify', kept: false })
  })
  it('starts a step from a JSON line that names another step, and keeps the line', () => {
    const line = JSON.stringify({ level: 'info', msg: 'asked azure to restart', step: 'Restart' })
    expect(readMark(null, line)).toEqual({ kind: 'step', name: 'Restart', kept: true })
    expect(readMark('Restart', line)).toEqual({ kind: 'line' })
    expect(readMark(null, JSON.stringify({ msg: 'no step here' }))).toEqual({ kind: 'line' })
    expect(readMark(null, JSON.stringify({ msg: 'a step that is no name', step: 3 }))).toEqual({ kind: 'line' })
    expect(readMark(null, JSON.stringify({ msg: 'a blank step', step: '  ' }))).toEqual({ kind: 'line' })
  })
  it('sets an output from the marker', () => {
    expect(readMark(null, '::output:: url=https://example.org/a?b=c')).toEqual({ kind: 'output', name: 'url', value: 'https://example.org/a?b=c' })
    expect(readMark('Verify', '::output::  replicas = 3 ')).toEqual({ kind: 'output', name: 'replicas', value: '3' })
    expect(readMark(null, '::output:: note=')).toEqual({ kind: 'output', name: 'note', value: '' })
  })
  it('leaves a marker that breaks a rule as a plain line', () => {
    expect(readMark(null, `::step:: ${'x'.repeat(STEP_NAME_MAX + 1)}`)).toEqual({ kind: 'line' })
    expect(readMark(null, '::step::')).toEqual({ kind: 'line' })
    expect(readMark(null, '::step::Stop')).toEqual({ kind: 'line' })
    expect(readMark(null, ' ::step:: Stop')).toEqual({ kind: 'line' })
    expect(readMark(null, '::output:: no value')).toEqual({ kind: 'line' })
    expect(readMark(null, '::output:: a name=1')).toEqual({ kind: 'line' })
    expect(readMark(null, `::output:: ${'n'.repeat(65)}=1`)).toEqual({ kind: 'line' })
    expect(readMark(null, `::output:: big=${'v'.repeat(OUTPUT_VALUE_MAX + 1)}`)).toEqual({ kind: 'line' })
    expect(readMark(null, JSON.stringify({ msg: 'a long step', step: 'x'.repeat(STEP_NAME_MAX + 1) }))).toEqual({ kind: 'line' })
    expect(readMark(null, 'restarted the app')).toEqual({ kind: 'line' })
  })
})

describe('an image output', () => {
  const jpeg = (bytes: number) => `data:image/jpeg;base64,${'A'.repeat(bytes)}`
  it('takes a picture past the text limit, up to its own', () => {
    const big = jpeg(OUTPUT_VALUE_MAX * 4)
    expect(readMark(null, `::output:: screen=${big}`)).toEqual({ kind: 'output', name: 'screen', value: big })
    expect(readMark(null, `::output:: screen=${jpeg(OUTPUT_IMAGE_MAX)}`)).toEqual({ kind: 'line' })
  })
  it('is only a base64 PNG, JPEG, or WebP', () => {
    expect(isImageOutput('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isImageOutput('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isImageOutput('data:text/html;base64,PGI+')).toBe(false)
    expect(isImageOutput('data:image/png;base64,<script>')).toBe(false)
    expect(readMark(null, `::output:: page=data:text/html;base64,${'A'.repeat(OUTPUT_VALUE_MAX + 1)}`)).toEqual({ kind: 'line' })
  })
  it('reads as what it is where no picture shows', () => {
    expect(outputText(jpeg(4096))).toBe('(image/jpeg, 3 KB; shown on the run page)')
    expect(outputText('3')).toBe('3')
  })
})

describe('reading the lines of a report', () => {
  const at = '2026-01-01T00:00:00.000Z'
  it('puts each line under the step under way', () => {
    const read = readLines(['booting', '::step:: Stop', 'stopping', '::output:: was=running', '::step:: Start', 'starting'], { step: null, held: [] }, at)
    expect(read.log).toEqual([
      { at, message: 'booting' },
      { at, message: 'stopping', step: 'Stop' },
      { at, message: 'starting', step: 'Start' },
    ])
    expect(read.steps).toEqual([{ name: 'Stop', at }, { name: 'Start', at }])
    expect(read.outputs).toEqual({ was: 'running' })
    expect(read.under).toBe('Start')
  })
  it('goes on in the step a run is already in, and never starts it twice in a row', () => {
    const json = JSON.stringify({ msg: 'looking', step: 'Verify' })
    const read = readLines(['still stopping', '::step:: Stop', '::step:: Verify', json, '::step:: Verify', 'seen'], { step: 'Stop', held: [] }, at)
    expect(read.steps).toEqual([{ name: 'Verify', at }])
    expect(read.log).toEqual([
      { at, message: 'still stopping', step: 'Stop' },
      { at, message: json, step: 'Verify' },
      { at, message: 'seen', step: 'Verify' },
    ])
  })
  it('starts a step a JSON line names and keeps the line under it', () => {
    const json = JSON.stringify({ msg: 'asked', step: 'Restart' })
    const read = readLines([json], { step: null, held: [] }, at)
    expect(read.steps).toEqual([{ name: 'Restart', at }])
    expect(read.log).toEqual([{ at, message: json, step: 'Restart' }])
  })
  it('lets a later marker win and keeps an output past the cap as a line', () => {
    const held = Array.from({ length: OUTPUTS_MAX - 1 }, (_, i) => `k${i}`)
    const read = readLines(['::output:: a=1', '::output:: a=2', '::output:: k0=again', '::output:: b=3'], { step: null, held }, at)
    expect(read.outputs).toEqual({ a: '2', k0: 'again' })
    expect(read.log).toEqual([{ at, message: '::output:: b=3' }])
  })
})

describe('a final failure', () => {
  it('is read from its marker, which is not kept, and never from a line that only mentions it', () => {
    expect(readMark(null, '::final::')).toEqual({ kind: 'final' })
    expect(readMark(null, '::final::  \r')).toEqual({ kind: 'final' })
    expect(readMark(null, 'saw ::final:: in a message')).toEqual({ kind: 'line' })
    const at = '2026-01-05T15:00:00.000Z'
    const read = readLines(['the player is offline', '::final::'], { step: null, held: [] }, at)
    expect(read.final).toBe(true)
    expect(read.log).toEqual([{ at, message: 'the player is offline' }])
    expect(readLines(['fine'], { step: null, held: [] }, at).final).toBe(false)
  })
})

describe('a value handed back to write on the entity', () => {
  it('reads the value as JSON, or as the text itself', () => {
    expect(readMark(null, '::refresh:: allowed_origins=["https://a.example.org","https://b.example.org"]')).toEqual({ kind: 'refresh', field: 'allowed_origins', value: ['https://a.example.org', 'https://b.example.org'] })
    expect(readMark(null, '::refresh:: allow_credentials=true\r')).toEqual({ kind: 'refresh', field: 'allow_credentials', value: true })
    expect(readMark(null, '::refresh:: owner="platform team"')).toEqual({ kind: 'refresh', field: 'owner', value: 'platform team' })
    expect(readMark(null, '::refresh:: owner=platform team')).toEqual({ kind: 'refresh', field: 'owner', value: 'platform team' })
  })
  it('keeps a marker that breaks a rule as a line', () => {
    expect(readMark(null, '::refresh:: no equals')).toEqual({ kind: 'line' })
    expect(readMark(null, '::refresh:: bad-name=1')).toEqual({ kind: 'line' })
    expect(readMark(null, `::refresh:: big="${'x'.repeat(REFRESH_VALUE_MAX)}"`)).toEqual({ kind: 'line' })
  })
  it('drops the marker line, and the last value for a field wins', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const read = readLines(['::refresh:: n=1', 'done', '::refresh:: n=2'], { step: null, held: [] }, at)
    expect(read.refresh).toEqual({ n: 2 })
    expect(read.log).toEqual([{ at, message: 'done' }])
  })
})
