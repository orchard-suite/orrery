import { describe, expect, it } from 'vitest'
import { ansi, groups, logText, plain, readLine, searched, since, stepTimes } from './runlog.ts'

describe('a run log line', () => {
  it('reads a JSON line as its message and what else it says, without the plumbing', () => {
    const line = '{"time":"2026-11-05T17:33:58Z","level":"INFO","msg":"Signing in to tenant t","component":"azure-restart","version":"1.9.2","subscription":"s"}'
    expect(readLine(line)).toEqual({ text: 'Signing in to tenant t · subscription: s', level: 'info' })
  })

  it('keeps how serious a line is, and leaves any other line as it came', () => {
    expect(readLine('{"level":"ERROR","msg":"The restart failed","summary":"x"}')).toEqual({ text: 'The restart failed', level: 'error' })
    expect(readLine('{"level":"WARN","msg":"Answered 403"}').level).toBe('warn')
    expect(readLine('claimed by runner azure-restart')).toEqual({ text: 'claimed by runner azure-restart', level: 'info' })
    expect(readLine('{"not":"a log line"}').text).toBe('{"not":"a log line"}')
    expect(readLine('{broken').text).toBe('{broken')
  })

  it('leaves out the step a line names, which its heading already says', () => {
    expect(readLine('{"level":"INFO","msg":"Asking Azure to restart","step":"Restart","app":"billing"}').text).toBe('Asking Azure to restart · app: billing')
  })
})

const ESC = '\u001b'

describe('the colours of a log line', () => {
  it('reads the eight colours, their bright ones, bold, and a reset', () => {
    expect(ansi(`${ESC}[32mok${ESC}[0m then ${ESC}[1;91mFAILED${ESC}[22m still red${ESC}[39m plain`)).toEqual([
      { text: 'ok', color: 'green' },
      { text: ' then ' },
      { text: 'FAILED', color: 'red', bright: true, bold: true },
      { text: ' still red', color: 'red', bright: true },
      { text: ' plain' },
    ])
    expect(ansi(`${ESC}[30ma${ESC}[33mb${ESC}[34mc${ESC}[35md${ESC}[36me${ESC}[37mf${ESC}[97mg${ESC}[m`).map((s) => `${s.bright ? 'bright ' : ''}${s.color}`)).toEqual(['black', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bright white'])
  })

  it('is one plain span for a line with no escape', () => {
    expect(ansi('restarted the app')).toEqual([{ text: 'restarted the app' }])
    expect(ansi('')).toEqual([])
  })

  it('strips every other escape, and reads no colour out of one it does not draw', () => {
    // A 256-colour and a true colour foreground, a background, a cursor move, a window title, and a line cleared.
    expect(ansi(`${ESC}[38;5;196ma${ESC}[38;2;255;0;0mb${ESC}[41mc${ESC}[2K${ESC}[1Ad${ESC}]0;title\u0007e${ESC}(Bf\r`)).toEqual([{ text: 'abcdef' }])
    // What follows a colour the page does not draw is still read.
    expect(ansi(`${ESC}[38;5;196;1mbold`)).toEqual([{ text: 'bold', bold: true }])
  })

  it('reads as plain text with every escape gone', () => {
    expect(plain(`${ESC}[1;31mError:${ESC}[0m no such app${ESC}[K`)).toBe('Error: no such app')
    expect(plain('nothing to strip')).toBe('nothing to strip')
  })
})

describe("a run's log under its steps", () => {
  const at = (s: number) => `2026-01-05T15:00:${String(s).padStart(2, '0')}.000Z`
  const steps = [{ name: 'Stop', at: at(2) }, { name: 'Start', at: at(5) }, { name: 'Stop', at: at(8) }]
  const log = [
    { at: at(0), message: 'claimed by runner east' },
    { at: at(2), message: 'stopping', step: 'Stop' },
    { at: at(3), message: 'stopped', step: 'Stop' },
    { at: at(5), message: 'starting', step: 'Start' },
    { at: at(6), message: 'a line of the hub' },
    { at: at(7), message: 'started', step: 'Start' },
    { at: at(8), message: 'stopping again', step: 'Stop' },
    { at: at(9), message: 'failed: exit 1' },
  ]

  it('puts lines before the first step under no heading, and each step under its own', () => {
    const read = groups(log, steps)
    expect(read.map((g) => [g.step, g.name, g.continued, g.lines.map((l) => l.n)])).toEqual([
      [null, null, false, [0]],
      [0, 'Stop', false, [1, 2]],
      [1, 'Start', false, [3]],
      [null, null, false, [4]],
      [1, 'Start', true, [5]],
      [2, 'Stop', false, [6]],
      [null, null, false, [7]],
    ])
    expect(read[1]!.lines[0]).toEqual({ n: 1, at: at(2), text: 'stopping', level: 'info', raw: 'stopping' })
  })

  it('is one group under no heading from a hub that names no steps', () => {
    const old = log.map(({ at, message }) => ({ at, message }))
    expect(groups(old, []).map((g) => [g.step, g.lines.length])).toEqual([[null, 8]])
    expect(groups([], [])).toEqual([])
  })

  it('keeps a line whose step the run does not list under that name', () => {
    expect(groups([{ at: at(1), message: 'x', step: 'Lost' }], []).map((g) => [g.step, g.name])).toEqual([[null, 'Lost']])
  })

  it('times each step to the next, to the finish, or to now', () => {
    expect(stepTimes({ steps, state: 'failed', finishedAt: at(9) }, 0)).toEqual([
      { name: 'Stop', at: at(2), ms: 3000, status: 'done' },
      { name: 'Start', at: at(5), ms: 3000, status: 'done' },
      { name: 'Stop', at: at(8), ms: 1000, status: 'failed' },
    ])
    expect(stepTimes({ steps: steps.slice(0, 2), state: 'running', finishedAt: null }, Date.parse(at(45))).map((s) => [s.ms, s.status])).toEqual([[3000, 'done'], [40000, 'now']])
    expect(stepTimes({ steps: steps.slice(0, 1), state: 'succeeded', finishedAt: at(4) }, 0).map((s) => s.status)).toEqual(['done'])
    expect(stepTimes({ state: 'succeeded', finishedAt: at(4) }, 0)).toEqual([])
  })

  it('says how long after the start a line came', () => {
    expect(since(at(0), at(42))).toBe('+0:42')
    expect(since(at(0), '2026-01-05T15:03:07.400Z')).toBe('+3:07')
    expect(since(at(0), '2026-01-05T16:03:07Z')).toBe('+1:03:07')
    expect(since(at(5), at(0))).toBe('+0:00')
  })

  it('finds the lines that hold what is searched for, whatever its case, and drops the groups with none', () => {
    const all = groups([...log, { at: at(9), message: `{"level":"ERROR","msg":"${ESC}[31mStopping${ESC}[0m failed","step":"Stop"}`, step: 'Stop' }], steps)
    const found = searched(all, 'STOPPING')
    expect(found.groups.map((g) => [g.name, g.lines.map((l) => l.n)])).toEqual([['Stop', [1]], ['Stop', [6]], ['Stop', [8]]])
    expect([found.found, found.of]).toEqual([3, 9])
    // Nothing searched for is everything.
    expect(searched(all, '  ')).toEqual({ groups: all, found: 9, of: 9 })
    expect(searched(all, 'no such words').groups).toEqual([])
  })

  it('is plain text to copy or keep, a line each, with no escape left in it', () => {
    expect(logText([{ at: at(0), message: 'claimed' }, { at: at(1), message: `${ESC}[32mok${ESC}[0m`, step: 'Stop' }])).toBe(`${at(0)} claimed\n${at(1)} ok\n`)
    expect(logText([])).toBe('')
  })
})
