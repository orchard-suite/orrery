import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { AZURE_ICONS, BRAND_ICONS, linkIcon, linkLabel, linkMark, linksOf, siteIcon } from './icons.ts'

describe('a link', () => {
  it("wears the logo of the console it points into, and not of a host an app is served from", () => {
    expect(siteIcon('https://portal.azure.com/#@example.org/resource/subscriptions/x/overview')).toBe('azure')
    expect(siteIcon('https://dev.azure.com/example/project')).toBe('azure_devops')
    expect(siteIcon('https://example.atlassian.net/wiki/spaces/OPS')).toBe('confluence')
    expect(siteIcon('https://example.atlassian.net/browse/OPS-1')).toBe('jira')
    expect(siteIcon('https://example.sharepoint.com/sites/ops')).toBe('sharepoint')
    expect(siteIcon('https://lucid.app/lucidchart/abc/edit')).toBe('lucid')
    expect(siteIcon('https://app.example.azurewebsites.net')).toBeNull()
    expect(siteIcon('https://notazure.com')).toBeNull()
    expect(siteIcon('not a url')).toBeNull()
  })

  it('wears the icon its field names, or none when the field turns icons off', () => {
    const url = 'https://portal.azure.com/#resource'
    expect(linkIcon(undefined, url)).toBe('azure')
    expect(linkIcon({ icon: 'dashboard' }, url)).toBe('dashboard')
    expect(linkIcon({ icon: 'dashboard' }, 'https://example.org')).toBe('dashboard')
    expect(linkIcon({ icon: 'no_such_icon' }, url)).toBe('azure')
    expect(linkIcon({ icon: false }, url)).toBeNull()
  })
})

describe('a link where there is no room for its address', () => {
  it('wears the logo of a tool hosted under the estate\'s own domain', () => {
    expect(siteIcon('https://gitlab.example.org/cloud/orrery')).toBe('gitlab')
    expect(siteIcon('https://grafana.ops.example.org/d/abc')).toBe('grafana')
    expect(siteIcon('https://argo.example.org/applications')).toBe('argocd')
    expect(siteIcon('https://notgitlab.example.org')).toBeNull()
  })

  it('is a plain link when the hub does not know the site, and its address only when the field turned icons off', () => {
    expect(linkMark(undefined, 'https://wiki.example.org/runbook')).toBe('link')
    expect(linkMark(undefined, 'https://grafana.example.org/d/abc')).toBe('grafana')
    expect(linkMark({ icon: false }, 'https://grafana.example.org/d/abc')).toBeNull()
  })

  it('reads one link or a list of them', () => {
    expect(linksOf('https://example.org')).toEqual(['https://example.org'])
    expect(linksOf(['https://a.example.org', '', null, 'https://b.example.org'])).toEqual(['https://a.example.org', 'https://b.example.org'])
    expect(linksOf(null)).toEqual([])
  })
})

describe('a link standing alone', () => {
  it('is called by its field, not by its host', () => {
    expect(linkLabel('Logs', 'https://grafana.example.org/d/app?viewPanel=12', false)).toBe('Logs')
    expect(linkLabel('Grafana', 'https://grafana.example.org/d/app', false)).toBe('Grafana')
  })

  it('adds its host when its field holds several', () => {
    expect(linkLabel('Dashboards', 'https://grafana.example.org/d/app', true)).toBe('Dashboards · grafana.example.org')
    expect(linkLabel('Dashboards', 'not a link', true)).toBe('Dashboards · not a link')
  })
})

describe('the vendored icons', () => {
  it('holds a picture for every brand and Azure service named', () => {
    const missing = [...BRAND_ICONS, ...AZURE_ICONS].filter((name) => !existsSync(new URL(`../web/public/icons/${name}.svg`, import.meta.url)))
    expect(missing).toEqual([])
    expect(AZURE_ICONS).toEqual(expect.arrayContaining(['azure_app_services', 'azure_virtual_machine', 'azure_storage_accounts', 'azure_api_management_services', 'azure_front_door_and_cdn_profiles', 'azure_service_bus', 'azure_event_grid_topics']))
  })
})
