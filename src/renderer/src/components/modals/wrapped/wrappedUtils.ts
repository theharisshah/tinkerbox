import type { UsageStats } from '@shared/types'

/**
 * "Year in Review" helpers: stats formatting, slide list and persona selection
 * (tests/unit/modals-b/wrapped.test.ts).
 */

// -----------------------------------------------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------------------------------------------

/** Thousands-separated count ("12,345"). */
export function formatCount(n: number): string {
  return Math.round(Number.isFinite(n) ? n : 0).toLocaleString('en-US')
}

/** Count with its noun in the right number: "1 run", "1,204 runs". */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  const rounded = Math.round(Number.isFinite(n) ? n : 0)
  return `${formatCount(rounded)} ${rounded === 1 ? singular : plural}`
}

/** Human duration for big totals: "850ms", "42.5s", "12m 05s", "3h 12m", "214h". */
export function formatLongDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60)
    return `${m}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  }
  const totalMinutes = Math.round(ms / 60_000)
  const h = Math.floor(totalMinutes / 60)
  if (h >= 100) return `${formatCount(h)}h`
  return `${h}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

/** 12-hour clock label of an hour of the day: 0 → "12 AM", 13 → "1 PM". */
export function formatHour(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  const suffix = h < 12 ? 'AM' : 'PM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${suffix}`
}

/** Compact axis label: 0 → "12a", 6 → "6a", 12 → "12p", 18 → "6p". */
export function hourTick(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}${h < 12 ? 'a' : 'p'}`
}

/** "3 PM – 4 PM" */
export function hourRange(hour: number): string {
  return `${formatHour(hour)} – ${formatHour(hour + 1)}`
}

/** Hour with the most runs (first one on ties); -1 when there are none. */
export function peakHour(hours: readonly number[]): number {
  let best = -1
  let max = 0
  hours.forEach((count, hour) => {
    if (count > max) {
      max = count
      best = hour
    }
  })
  return best
}

/** Percentage string without trailing ".0": 0.425 → "42.5%", 1 → "100%". */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const pct = ratio * 100
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10
  return `${rounded}%`
}

export interface RankedEntry {
  name: string
  count: number
  /** Share of the total (0..1). */
  share: number
}

/** Counter map sorted by count (desc, then name), with shares of the total. */
export function rankEntries(map: Record<string, number> | null | undefined, limit = Infinity): RankedEntry[] {
  const entries = Object.entries(map ?? {}).filter(([, n]) => Number.isFinite(n) && n > 0)
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  return entries
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count, share: total > 0 ? count / total : 0 }))
}

/** Last segment of a class name: "Illuminate\\Database\\QueryException" → "QueryException". */
export function shortClassName(fqcn: string): string {
  const parts = fqcn.split('\\').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : fqcn
}

export function totalExceptions(stats: UsageStats): number {
  return Object.values(stats.exceptions ?? {}).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0)
}

/** Share of runs that finished without an error (0..1). */
export function successRate(stats: UsageStats): number {
  if (stats.runs <= 0) return 0
  return Math.max(0, stats.runs - stats.failedRuns) / stats.runs
}

/** Share of runs in the given hours (0..1). */
export function hoursShare(stats: UsageStats, hours: readonly number[]): number {
  if (stats.runs <= 0) return 0
  const sum = hours.reduce((n, h) => n + (stats.hours?.[h] ?? 0), 0)
  return sum / stats.runs
}

const DRIVER_NAMES: Record<string, string> = {
  laravel: 'Laravel',
  lumen: 'Lumen',
  'laravel-zero': 'Laravel Zero',
  statamic: 'Statamic',
  october: 'October CMS',
  testbench: 'Testbench',
  symfony: 'Symfony',
  wordpress: 'WordPress',
  bedrock: 'Bedrock',
  radicle: 'Radicle',
  drupal7: 'Drupal 7',
  drupal: 'Drupal',
  craft: 'Craft CMS',
  magento2: 'Magento 2',
  shopware: 'Shopware',
  kirby: 'Kirby',
  moodle: 'Moodle',
  prestashop: 'PrestaShop',
  typo3: 'TYPO3',
  cakephp: 'CakePHP',
  codeigniter4: 'CodeIgniter 4',
  yii2: 'Yii 2',
  joomla: 'Joomla',
  composer: 'Composer',
  none: 'Plain PHP'
}

/**
 * Display name of a driver id. Built-ins have fixed names; custom drivers report their own id() (e.g.
 * "acme-shop" → "Acme Shop", "AcmeShopDriver" → "AcmeShop").
 */
export function driverName(id: string): string {
  if (DRIVER_NAMES[id]) return DRIVER_NAMES[id]
  const words = id
    .replace(/Driver$/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
  if (words.length === 0) return 'PHP'
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Average runs per active day since the first run of the year (null without a first run). */
export function runsPerDay(stats: UsageStats, now: number = Date.now()): number | null {
  if (!stats.firstRunAt || stats.runs <= 0) return null
  const endOfYear = new Date(stats.year + 1, 0, 1).getTime()
  const end = Math.min(now, endOfYear)
  const days = Math.max(1, Math.ceil((end - stats.firstRunAt) / 86_400_000))
  return stats.runs / days
}

// -----------------------------------------------------------------------------------------------------------------
// Personas (original to Tinkerbox)
// -----------------------------------------------------------------------------------------------------------------

export type PersonaId = 'query-tuner' | 'stacktrace-archaeologist' | 'midnight-compiler' | 'dawn-patroller' | 'inline-oracle' | 'codebase-nomad' | 'steady-tinkerer'

export interface Persona {
  id: PersonaId
  name: string
  tagline: string
  description: string
}

export const PERSONAS: Record<PersonaId, Persona> = {
  'query-tuner': {
    id: 'query-tuner',
    name: 'The Query Tuner',
    tagline: 'Every index has a story.',
    description: 'You lived in the SQL toggle — inspecting, tuning and interrogating queries until every N+1 confessed.'
  },
  'stacktrace-archaeologist': {
    id: 'stacktrace-archaeologist',
    name: 'The Stack Trace Archaeologist',
    tagline: 'Every exception is a dig site.',
    description: 'You poked things until they broke — on purpose (mostly) — and read the layers of the trace like ancient script.'
  },
  'midnight-compiler': {
    id: 'midnight-compiler',
    name: 'The Midnight Compiler',
    tagline: 'Your best code happens after dark.',
    description: 'While the rest of the world slept, you were in the editor running “just one more” snippet.'
  },
  'dawn-patroller': {
    id: 'dawn-patroller',
    name: 'The Dawn Patroller',
    tagline: 'Coffee, then code.',
    description: 'You checked on production data before most people checked their inbox.'
  },
  'inline-oracle': {
    id: 'inline-oracle',
    name: 'The Inline Oracle',
    tagline: 'Why print it when you can see it?',
    description: 'Magic comments were your crystal ball — values appeared right next to your code, no dump() required.'
  },
  'codebase-nomad': {
    id: 'codebase-nomad',
    name: 'The Codebase Nomad',
    tagline: 'Home is wherever composer.json is.',
    description: 'You wandered across many projects this year and felt at home in every one of them.'
  },
  'steady-tinkerer': {
    id: 'steady-tinkerer',
    name: 'The Steady Tinkerer',
    tagline: 'Balanced, curious, reliable.',
    description: 'A little SQL, a few exceptions, plenty of experiments — a well-rounded year of tinkering.'
  }
}

export const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4] as const
export const DAWN_HOURS = [5, 6, 7, 8] as const

export interface PersonaPick {
  persona: Persona
  /** Short reason, e.g. "41% of your runs happened after 10 PM". */
  evidence: string
  /** Score of the winning trait (≥ 1 for a trait persona, 0 for the balanced fallback). */
  score: number
}

interface Candidate {
  id: PersonaId
  score: number
  evidence: string
}

/**
 * Pick the persona whose trait is strongest relative to its threshold (score = metric / threshold, minimum
 * volumes required so a handful of runs does not decide). Below 1 everywhere → "The Steady Tinkerer".
 */
export function pickPersona(stats: UsageStats): PersonaPick {
  const runs = stats.runs
  const fallback: PersonaPick = {
    persona: PERSONAS['steady-tinkerer'],
    evidence: runs > 0 ? `${countOf(runs, 'run')}, nicely spread across the board` : 'Your story starts with the first run',
    score: 0
  }
  if (runs <= 0) return fallback

  const candidates: Candidate[] = []
  const queriesPerRun = stats.queries / runs
  if (stats.queries >= 50) {
    candidates.push({
      id: 'query-tuner',
      score: queriesPerRun / 3,
      evidence: `${formatCount(stats.queries)} queries inspected — about ${queriesPerRun.toFixed(1)} per run`
    })
  }
  const exceptions = totalExceptions(stats)
  if (exceptions >= 10) {
    const rate = exceptions / runs
    candidates.push({
      id: 'stacktrace-archaeologist',
      score: rate / 0.25,
      evidence: `${formatPercent(rate)} of your runs ended in an exception`
    })
  }
  if (runs >= 20) {
    const night = hoursShare(stats, NIGHT_HOURS)
    candidates.push({ id: 'midnight-compiler', score: night / 0.3, evidence: `${formatPercent(night)} of your runs happened between 10 PM and 5 AM` })
    const dawn = hoursShare(stats, DAWN_HOURS)
    candidates.push({ id: 'dawn-patroller', score: dawn / 0.3, evidence: `${formatPercent(dawn)} of your runs happened between 5 AM and 9 AM` })
  }
  if (stats.magicComments >= 25) {
    const perRun = stats.magicComments / runs
    candidates.push({
      id: 'inline-oracle',
      score: perRun / 1,
      evidence: `${formatCount(stats.magicComments)} magic comments — ${perRun.toFixed(1)} per run`
    })
  }
  const projects = rankEntries(stats.projects)
  if (projects.length >= 5 && projects[0].share < 0.5) {
    candidates.push({
      id: 'codebase-nomad',
      score: (projects.length / 5) * (0.5 / Math.max(projects[0].share, 0.05)) * 0.6,
      evidence: `${projects.length} projects, none of them took more than half of your runs`
    })
  }

  let best: Candidate | null = null
  for (const c of candidates) if (c.score >= 1 && (!best || c.score > best.score)) best = c
  if (!best) return fallback
  return { persona: PERSONAS[best.id], evidence: best.evidence, score: best.score }
}

// -----------------------------------------------------------------------------------------------------------------
// Slides
// -----------------------------------------------------------------------------------------------------------------

export type SlideId = 'intro' | 'runs' | 'time' | 'project' | 'hours' | 'exceptions' | 'queries' | 'magic' | 'longest' | 'persona'

/** Story slides for a year (empty when nothing was run → the modal shows its empty state). */
export function buildSlides(stats: UsageStats | null | undefined): SlideId[] {
  if (!stats || stats.runs <= 0) return []
  const slides: SlideId[] = ['intro', 'runs', 'time']
  if (rankEntries(stats.projects).length > 0) slides.push('project')
  if (peakHour(stats.hours ?? []) >= 0) slides.push('hours')
  slides.push('exceptions', 'queries', 'magic', 'longest', 'persona')
  return slides
}

/**
 * Background of a slide: two soft radial glows from theme tokens over the surface color, so every theme (light or
 * dark, built-in or custom) gets its own gradients.
 */
export function slideBackground(id: SlideId): string {
  const pairs: Record<SlideId, [string, string]> = {
    intro: ['--tw-accent', '--tw-code-class'],
    runs: ['--tw-code-class', '--tw-accent'],
    time: ['--tw-code-string', '--tw-accent'],
    project: ['--tw-code-number', '--tw-code-keyword'],
    hours: ['--tw-accent', '--tw-code-property'],
    exceptions: ['--tw-danger', '--tw-warning'],
    queries: ['--tw-code-class', '--tw-code-string'],
    magic: ['--tw-code-property', '--tw-accent'],
    longest: ['--tw-warning', '--tw-code-number'],
    persona: ['--tw-accent', '--tw-code-property']
  }
  const [a, b] = pairs[id]
  return [
    `radial-gradient(110% 85% at 0% 0%, color-mix(in srgb, var(${a}) 34%, transparent) 0%, transparent 62%)`,
    `radial-gradient(95% 80% at 100% 100%, color-mix(in srgb, var(${b}) 28%, transparent) 0%, transparent 60%)`,
    'var(--tw-surface)'
  ].join(', ')
}
