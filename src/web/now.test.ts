import { describe, expect, it } from 'vitest'
import type { Alert, SummaryResponse } from '../shared/api.ts'
import { alertLevel, alertsOn, areasOf, bySize, elsewhereOf, firstArea, needsOf, numbered, ownKinds, ownRoles, perspectiveOf, verdictOf, yoursOf } from './now.ts'

const counts = (red = 0, amber = 0, grey = 0) => ({ red, amber, grey })
const bp = (id: string, active: number, notGreen = counts()) => ({ id, title: id, active, missing: 0, notGreen })
const alert = (alertname: string, severity: string, startsAt = '2026-11-04T10:00:00Z'): Alert => ({ fingerprint: alertname + startsAt, source: 'am', status: 'firing', labels: { alertname, severity }, annotations: { summary: `${alertname} fired` }, startsAt, endsAt: null, entity: null, updatedAt: startsAt })
const red = { entity: { blueprint: 'argocd_app', key: 'home/argocd/vantage-hub' }, title: 'vantage-hub', level: 'red' as const, reasons: ['Degraded'] }
const amber = { entity: { blueprint: 'hass_device', key: 'home/1' }, title: 'Radon sensor', level: 'amber' as const, reasons: ['8 unavailable'] }

describe('the Now page', () => {
  it('groups kinds into areas in the catalog order, worst status winning', () => {
    const summary = { blueprints: [bp('a', 3), bp('b', 2175, counts(0, 2)), bp('c', 0), bp('d', 1, counts(1))] }
    const areas = areasOf([{ id: 'a', title: 'A', group: 'Kubernetes' }, { id: 'b', title: 'B', group: 'Kubernetes' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D', group: 'Catalog' }], summary)
    expect(areas.map((a) => [a.name, a.count, a.level])).toEqual([['Kubernetes', 2178, 'amber'], ['Other', 0, 'green'], ['Catalog', 1, 'red']])
  })

  it('leads the verdict with the red thing and counts the alerts that matter', () => {
    const summary: Pick<SummaryResponse, 'notGreen' | 'blueprints'> = { notGreen: [red, amber], blueprints: [bp('argocd_app', 52, counts(1)), bp('hass_device', 208, counts(0, 1))] }
    const v = verdictOf(summary, [alert('Backup', 'critical'), alert('KubeJobFailed', 'warning'), alert('Watchdog', 'none')])
    expect(v.level).toBe('red')
    expect(v.lead?.title).toBe('vantage-hub')
    expect(v.rest).toBe(' is failing. 2\u00a0alerts are firing, 1\u00a0critical.')
  })

  it('leads with how many are red when more than one is, so the headline stays one line', () => {
    const summary: Pick<SummaryResponse, 'notGreen' | 'blueprints'> = { notGreen: [red, { ...red, title: 'other' }], blueprints: [bp('argocd_app', 52, counts(61))] }
    const v = verdictOf(summary, [alert('Backup', 'critical')], 'yours')
    expect([v.lead, v.count, v.rest]).toEqual([null, '61\u00a0things of yours', ' are failing. 1\u00a0alert is firing on your things, 1\u00a0critical.'])
  })

  it('numbers an area\'s failing kinds in the order its list shows them, biggest first', () => {
    const summary = { blueprints: [bp('small', 3, counts(1)), bp('big', 900, counts(2)), bp('fine', 5000)] }
    const [area] = areasOf([{ id: 'small', title: 'Small', group: 'G' }, { id: 'big', title: 'Big', group: 'G' }, { id: 'fine', title: 'Fine', group: 'G' }], summary)
    expect(bySize(area!).map((k) => k.id)).toEqual(['fine', 'big', 'small'])
    expect(numbered(area!).map((k) => k.id)).toEqual(['big', 'small'])
  })

  it('says all green only when nothing is off and nothing fires', () => {
    expect(verdictOf({ notGreen: [], blueprints: [bp('a', 4)] }, [alert('Watchdog', 'none')]).rest).toBe('All green. Everything answers.')
    expect(verdictOf({ notGreen: [amber], blueprints: [bp('hass_device', 2, counts(0, 1))] }, []).rest).toBe('Nothing is down. 1\u00a0thing wants a look.')
  })

  it('lists what needs a person worst first, with alike alerts counted once', () => {
    const needs = needsOf({ notGreen: [amber, red] }, [alert('KubeJobFailed', 'warning', '2026-11-04T10:00:00Z'), alert('KubeJobFailed', 'warning', '2026-11-04T08:00:00Z'), alert('Backup', 'critical'), alert('Watchdog', 'none')])
    expect(needs.map((n) => [n.title, n.level, n.count])).toEqual([['vantage-hub', 'red', 1], ['Backup', 'red', 1], ['KubeJobFailed', 'amber', 2], ['Radon sensor', 'amber', 1]])
    expect(needs[2]!.since).toBe('2026-11-04T08:00:00Z')
  })

  it('names the place an alert fires most, and how many others', () => {
    const at = (key: string, t: string) => ({ ...alert('KubeJobFailed', 'warning', t), fingerprint: key + t, entity: { blueprint: 'k8s_namespace', key } })
    const needs = needsOf({ notGreen: [] }, [at('home/vantage', '2026-11-04T01:00:00Z'), at('home/orrery', '2026-11-04T02:00:00Z'), at('home/orrery', '2026-11-04T03:00:00Z')])
    expect([needs[0]!.entity?.key, needs[0]!.elsewhere, needs[0]!.count]).toEqual(['home/orrery', 1, 3])
  })

  it('folds several amber things of one kind into one row that opens the kind', () => {
    const more = [1, 2, 3, 4].map((i) => ({ ...amber, entity: { blueprint: 'hass_device', key: `home/${i}` }, title: `Sensor ${i}` }))
    const needs = needsOf({ notGreen: more }, [])
    expect(needs.map((n) => [n.kind, n.blueprint, n.count, n.why])).toEqual([['kind', 'hass_device', 4, 'Sensor 1, Sensor 2 and 2 more']])
  })

  it('reads an alert severity as a status', () => {
    expect([alertLevel(alert('x', 'critical')), alertLevel(alert('x', 'warning')), alertLevel(alert('x', 'info'))]).toEqual(['red', 'amber', 'grey'])
  })
})

describe('whose things the page speaks for', () => {
  it('leads with the reader\'s own when the hub knows, and says why not when it does not', () => {
    // How many are theirs counts the green ones too, which the page is not sent.
    expect(perspectiveOf({ seesAll: false, state: 'known', count: 3 })).toMatchObject({ whose: 'yours', because: null })
    expect(perspectiveOf({ seesAll: false, state: 'known', count: 0 })).toMatchObject({ whose: 'shared', because: 'none' })
    expect(perspectiveOf({ seesAll: true, state: 'unset', count: 0 })).toMatchObject({ whose: 'estate', because: 'unset' })
    expect(perspectiveOf({ seesAll: false, state: 'unknown', count: 0 })).toMatchObject({ whose: 'shared', because: 'unknown' })
  })

  it('never calls what a reader sees the estate, and names their own as theirs', () => {
    const quiet = { notGreen: [], blueprints: [bp('a', 4)] }
    expect(verdictOf(quiet, [], 'shared').rest).toBe('All green. Everything you can see answers.')
    expect(verdictOf(quiet, [], 'yours').rest).toBe('Your 4\u00a0things are all green.')
    expect(verdictOf({ notGreen: [], blueprints: [bp('a', 1)] }, [], 'yours').rest).toBe('Your one thing is green.')
    const mine = yoursOf({ things: [{ ...amber, as: [] }], blueprints: { hass_device: { count: 3, notGreen: counts(0, 1) } } })
    expect(verdictOf(mine, [], 'yours').rest).toBe('Nothing of yours is down. 1 thing of yours wants a look.')
  })

  it('lists every kind of the reader\'s own, green ones too, though only what is not green is sent', () => {
    const phone = { entity: { blueprint: 'device', key: 'iphone' }, title: 'iPhone', level: 'grey' as const, reasons: [], as: ['holder'] }
    const mine = {
      things: [phone],
      blueprints: {
        team: { count: 6, notGreen: counts(0, 0), as: { member: 6 } },
        device: { count: 1, notGreen: { red: 0, amber: 0, grey: 1 }, as: { holder: 1 } },
        drive: { count: 1, notGreen: counts(0, 0), as: { holder: 1 } },
      },
    }
    expect(ownKinds(mine)).toEqual([
      { id: 'team', count: 6, level: 'green' },
      { id: 'device', count: 1, level: 'grey' },
      { id: 'drive', count: 1, level: 'green' },
    ])
    expect(ownRoles(mine)).toEqual([['member', 6], ['holder', 2]])
    expect(ownKinds(mine, 'holder')).toEqual([
      { id: 'device', count: 1, level: 'grey' },
      { id: 'drive', count: 1, level: 'green' },
    ])
    // A hub one release back counts no roles per kind: only the things it sent are counted.
    const older = { things: [phone], blueprints: { device: { count: 1, notGreen: { red: 0, amber: 0, grey: 1 } }, team: { count: 6, notGreen: counts(0, 0) } } }
    expect(ownRoles(older)).toEqual([['holder', 1]])
    expect(ownKinds(older, 'holder')).toEqual([{ id: 'device', count: 1, level: 'grey' }])
  })

  it('counts only alerts on the reader\'s own as theirs, and an alert on nothing as no one\'s', () => {
    const on = { ...alert('DiskFull', 'warning'), entity: amber.entity, yours: true }
    const theirs = { ...alert('DiskFull', 'warning'), entity: red.entity, yours: false }
    const loose = alert('HostDown', 'critical')
    expect(alertsOn([on, theirs, loose])).toEqual([on])
    expect(alertsOn([on, theirs, loose], false)).toEqual([theirs, loose])
  })

  it('lists the reader\'s amber things one by one, since a kind\'s row opens more than theirs', () => {
    const second = { ...amber, entity: { blueprint: 'hass_device', key: 'home/2' }, title: 'Door sensor' }
    expect(needsOf({ notGreen: [amber, second] }, [], false).map((n) => n.title)).toEqual(['Radon sensor', 'Door sensor'])
    expect(needsOf({ notGreen: [amber, second] }, []).map((n) => n.kind)).toEqual(['kind'])
  })

  it('says what is wrong outside the reader\'s own, worst first, and nothing when nothing is', () => {
    expect(elsewhereOf({ failing: 84, firing: 2, look: 37 }, false)).toEqual({ level: 'red', text: '84\u00a0other things you can see are failing. None of them are yours.' })
    expect(elsewhereOf({ failing: 1, firing: 0, look: 0 }, true)?.text).toBe('1\u00a0other thing in the estate is failing. None of it is yours.')
    expect(elsewhereOf({ failing: 0, firing: 3, look: 5 }, false)).toEqual({ level: 'amber', text: '3\u00a0alerts are firing on things that are not yours.' })
    expect(elsewhereOf({ failing: 0, firing: 0, look: 1 }, false)?.text).toBe('1\u00a0other thing you can see wants a look. None of it is yours.')
    expect(elsewhereOf({ failing: 0, firing: 0, look: 0 }, false)).toBeNull()
  })

  it('opens the sky on where the reader\'s own things are, else on the worst area', () => {
    const summary = { blueprints: [bp('vm', 300, counts(40)), bp('report', 900), bp('drive', 50)] }
    const areas = areasOf([{ id: 'vm', title: 'VM', group: 'Cloud' }, { id: 'report', title: 'Report', group: 'Finance' }, { id: 'drive', title: 'Drive', group: 'Office' }], summary)
    expect(firstArea(areas, { drive: { count: 1 }, report: { count: 6 } })?.name).toBe('Finance')
    expect(firstArea(areas, null)?.name).toBe('Cloud')
    expect(firstArea(areas, {})?.name).toBe('Cloud')
  })
})
