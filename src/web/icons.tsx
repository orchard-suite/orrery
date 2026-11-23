import { Activity, Antenna, AppWindow, Archive, Award, BadgeCheck, Battery, Bell, Blocks, Bluetooth, BookOpen, Bot, Box, Boxes, Braces, Brain, BrickWall, Briefcase, Bug, Building, Building2, Cable, Calendar, CalendarClock, Camera, Car, ChartLine, Circle, CircleAlert, CircleDollarSign, CircuitBoard, ClipboardList, Clock, Cloud, CloudCog, Code, Cog, Component, Contact, Container, Cpu, Database, DatabaseBackup, Disc, DoorClosed, DoorOpen, Download, Droplets, Eye, Factory, Fan, FileCode, FileKey, FileText, Fingerprint, Flag, Flame, FlaskConical, Folder, FolderGit2, Gauge, GitBranch, GitCommitHorizontal, GitFork, GitMerge, GitPullRequest, Globe, Group, Hammer, Handshake, HardDrive, HeartPulse, Hexagon, History, House, IdCard, Inbox, KeyRound, Landmark, Laptop, Layers, Layers2, LayoutDashboard, LifeBuoy, Lightbulb, Link, ListChecks, Lock, Mail, Map, MapPin, Megaphone, MemoryStick, MessageSquare, Microchip, Milestone, Monitor, Network, Package, PackageCheck, PcCase, PiggyBank, Plug, Power, Printer, Puzzle, Radar, Radio, Receipt, Rocket, Router, SatelliteDish, Scale, ScanSearch, ScrollText, Search, Server, ServerCog, Settings, Share2, Shield, ShieldAlert, ShieldCheck, ShoppingCart, Signpost, Siren, Smartphone, Sparkles, Speaker, Split, SquareStack, Star, Store, Sun, Table, Tag, Target, Terminal, Thermometer, Ticket, Timer, ToggleLeft, TriangleAlert, Trophy, Truck, Tv, Upload, User, UserCog, Users, Vault, Wallet, Warehouse, Waypoints, Webhook, Wifi, Workflow, Wrench, Zap, type LucideIcon } from 'lucide-react'
import { AZURE_ICONS, BRAND_ICONS, isPhoto, PHOTO_PREFIX, type ConceptIcon } from '../shared/icons.ts'
import { INKED_ICONS } from '../shared/inked-icons.ts'
import type { Blueprint } from '../shared/model.ts'
import { useCustomIcons } from './api.ts'
import { useTheme } from './theme.ts'

/** How each concept in the icon set is drawn. */
const CONCEPTS: Record<ConceptIcon, LucideIcon> = { box: Box, cube: Boxes, package: Package, layers: Layers, stack: SquareStack, hexagon: Hexagon, circle: Circle, component: Component, blocks: Blocks, puzzle: Puzzle, app: AppWindow, service: Cog, api: Braces, webhook: Webhook, code: Code, terminal: Terminal, bot: Bot, brain: Brain, sparkles: Sparkles, git: GitBranch, repository: FolderGit2, branch: GitBranch, commit: GitCommitHorizontal, pull_request: GitPullRequest, fork: GitFork, merge: GitMerge, pipeline: Workflow, rocket: Rocket, release: PackageCheck, environment: Layers2, flask: FlaskConical, container: Container, server: Server, server_cog: ServerCog, vm: PcCase, cpu: Cpu, chip: Microchip, memory: MemoryStick, circuit: CircuitBoard, database: Database, backup: DatabaseBackup, disk: Disc, storage: HardDrive, archive: Archive, table: Table, queue: Inbox, cloud: Cloud, cloud_cog: CloudCog, cluster: Waypoints, namespace: Group, network: Network, router: Router, wifi: Wifi, cable: Cable, globe: Globe, dns: Signpost, gateway: DoorOpen, load_balancer: Split, firewall: BrickWall, vpn: Share2, plug: Plug, link: Link, antenna: Antenna, organization: Landmark, department: Building2, team: Users, person: User, role: UserCog, contact: Contact, id: IdCard, briefcase: Briefcase, handshake: Handshake, building: Building, factory: Factory, warehouse: Warehouse, store: Store, location: MapPin, home: House, map: Map, shield: Shield, shield_check: ShieldCheck, vulnerability: ShieldAlert, lock: Lock, key: KeyRound, vault: Vault, fingerprint: Fingerprint, certificate: BadgeCheck, secret: FileKey, scan: ScanSearch, activity: Activity, health: HeartPulse, chart: ChartLine, gauge: Gauge, dashboard: LayoutDashboard, radar: Radar, alert: CircleAlert, bell: Bell, siren: Siren, incident: Flame, bug: Bug, warning: TriangleAlert, support: LifeBuoy, history: History, clock: Clock, timer: Timer, calendar: Calendar, schedule: CalendarClock, folder: Folder, file: FileCode, document: FileText, book: BookOpen, contract: ScrollText, checklist: ListChecks, clipboard: ClipboardList, ticket: Ticket, milestone: Milestone, target: Target, flag: Flag, tag: Tag, star: Star, award: Award, trophy: Trophy, scale: Scale, megaphone: Megaphone, message: MessageSquare, mail: Mail, search: Search, eye: Eye, cost: CircleDollarSign, wallet: Wallet, receipt: Receipt, bank: PiggyBank, cart: ShoppingCart, truck: Truck, laptop: Laptop, monitor: Monitor, phone: Smartphone, printer: Printer, camera: Camera, tv: Tv, speaker: Speaker, lightbulb: Lightbulb, thermometer: Thermometer, sensor: Radio, switch: ToggleLeft, fan: Fan, door: DoorClosed, power: Power, battery: Battery, zap: Zap, sun: Sun, water: Droplets, bluetooth: Bluetooth, satellite: SatelliteDish, car: Car, settings: Settings, wrench: Wrench, tool: Hammer, upload: Upload, download: Download, share: Share2 }

const BRANDS: ReadonlySet<string> = new Set([...BRAND_ICONS, ...AZURE_ICONS])
const INKED: ReadonlySet<string> = new Set(INKED_ICONS)

/**
 * A name from the icon set: a brand or an Azure service as its colour logo, a
 * concept as a glyph in the current text colour, a custom icon as the hub
 * serves it, a person's photo round; anything unknown is a box. A logo drawn
 * in ink takes the theme's.
 */
export function Icon({ name, className = 'size-3.5', large = false }: { name: string | null | undefined; className?: string; large?: boolean }) {
  const theme = useTheme()
  const custom = useCustomIcons().data
  // A photo's name is its bytes' hash, so its address never changes what it serves. The small one is for every place
  // a person is drawn beside other things; only a picture drawn large, such as on their own page, reads the large one.
  if (isPhoto(name)) return <img src={`/v1/photos/${name.slice(PHOTO_PREFIX.length)}/${large ? 'large' : 'small'}`} alt="" loading="lazy" decoding="async" className={`${className} rounded-full object-cover`} />
  if (name && BRANDS.has(name)) return <img src={`/icons/${theme === 'light' && INKED.has(name) ? 'light/' : ''}${name}.svg`} alt="" loading="lazy" className={`${className} object-contain`} />
  // The hash in the address makes new bytes a new picture at once, while the same bytes stay cached.
  const sha = name ? custom?.get(name) : undefined
  if (name && sha) return <img src={`/v1/icons/${encodeURIComponent(name)}?v=${sha.slice(0, 16)}`} alt="" loading="lazy" className={`${className} object-contain`} />
  const Concept = (name && CONCEPTS[name as ConceptIcon]) || Box
  return <Concept className={className} strokeWidth={1.75} aria-hidden />
}

export function BlueprintIcon({ bp, className }: { bp: Pick<Blueprint, 'icon'> | undefined; className?: string }) {
  return <Icon name={bp?.icon} className={className} />
}

/** Blueprints in sidebar order, marking each one that starts a group. `group` null is the blueprints with no group. */
export function grouped<T extends { group?: string }>(list: T[]): { starts: boolean; group: string | null; item: T }[] {
  let last: string | undefined | null = null
  return list.map((item) => {
    const starts = item.group !== last
    last = item.group
    return { starts, group: item.group ?? null, item }
  })
}
