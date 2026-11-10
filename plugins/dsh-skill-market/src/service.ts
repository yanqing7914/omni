import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SkillMarketError } from './errors.js'
import { assertKebabId } from './paths.js'
import { assertAllowedUrl, parseManifest } from './manifest.js'
import { scanInstalledRoots } from './installed.js'
import { installSkill, uninstallSkill } from './installer.js'
import type { InstallerOptions } from './installer.js'
import type {
  FetchLike,
  InstallResult,
  InstalledSkill,
  LoggerLike,
  MarketCategory,
  ParsedManifest,
  RejectedSkill,
} from './types.js'

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MANIFEST_TIMEOUT_MS = 20 * 1000
const DEFAULT_PER_FILE_TIMEOUT_MS = 20 * 1000
const DEFAULT_TOTAL_TIMEOUT_MS = 120 * 1000
const DEFAULT_CONCURRENCY = 4

export interface ServiceOptions {
  /** Override `$DSH_HOME` (tests pass a temp directory). */
  dshHome?: string
  /** Read-only bundled skill root; `null` disables bundled discovery explicitly. */
  bundledSkillDir?: string | null
  /** Override the manifest URL (still required to pass the raw.githubusercontent whitelist). */
  marketUrl?: string
  owner?: string
  repo?: string
  ref?: string
  fetchImpl?: FetchLike
  now?: () => number
  perFileTimeoutMs?: number
  totalTimeoutMs?: number
  concurrency?: number
  cacheTtlMs?: number
  manifestTimeoutMs?: number
  logger?: LoggerLike
}

export interface MarketListResult {
  ok: true
  cached: boolean
  categories: MarketCategory[]
  skills: Array<{
    id: string
    name: string
    title: { en: string; zh?: string }
    description: { en: string; zh?: string }
    category: string
    license: string
    installed: boolean
    installedSource?: 'user' | 'bundled'
    removable?: boolean
  }>
  rejected: RejectedSkill[]
}

export interface SkillMarketService {
  list(): Promise<MarketListResult>
  installed(): Promise<InstalledSkill[]>
  install(id: string, options?: { overwrite?: boolean }): Promise<InstallResult>
  uninstall(id: string): Promise<void>
}

interface MarketConfig {
  owner: string
  repo: string
  ref: string
}

/** `$DSH_HOME` when present, otherwise `~/.dsh`. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/**
 * Locate the bundled skill directory shipped with `@deepseek-ai/dsh-agent-preset`.
 *
 * The engine may run from a private snapshot with either a nested or a hoisted
 * node_modules layout, so both shapes are probed while walking up from the
 * engine entry point and the current working directory.
 */
export function detectBundledSkillDir(): string | undefined {
  const explicit = process.env.DSH_BUNDLED_SKILL_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())

  const shapes = [
    join('node_modules', '@deepseek-ai', 'dsh-agent-preset', 'skills'),
    join('@deepseek-ai', 'dsh-agent-preset', 'skills'),
  ]
  const starts: string[] = []
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') {
    starts.push(resolve(entry))
    try {
      // `/usr/bin/dsh` is a symlink into the package; the real path exposes the
      // nested node_modules layout the engine actually runs from.
      starts.push(realpathSync(entry))
    } catch {
      /* keep the unresolved path */
    }
  }
  starts.push(resolve(process.cwd()))

  for (const start of starts) {
    let dir = dirname(start)
    for (let depth = 0; depth < 12; depth += 1) {
      for (const shape of shapes) {
        const candidate = join(dir, shape)
        try {
          if (statSync(candidate).isDirectory()) return candidate
        } catch {
          /* keep walking */
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function readPackageMarketConfig(): MarketConfig {
  try {
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as { dsh?: { skillMarket?: Partial<MarketConfig> } }
    const configured = parsed.dsh?.skillMarket
    if (configured !== undefined) {
      return {
        owner: typeof configured.owner === 'string' ? configured.owner : '',
        repo: typeof configured.repo === 'string' ? configured.repo : 'omni',
        ref: typeof configured.ref === 'string' ? configured.ref : 'main',
      }
    }
  } catch {
    /* fall through to the defaults below */
  }
  return { owner: '', repo: 'omni', ref: 'main' }
}

/** Resolve the market manifest URL, allowing env/config overrides for deployment. */
/**
 * 清单地址候选（按顺序尝试）。
 *
 * 主分支可能还没有清单（开发期先合到 dev），而发布版读的是 main；所以 main 读不到时回落到 dev，
 * 免得开发期的包市场永远是空的。显式配置的 URL 只有一个候选，不做回落（配置就是真源）。
 */
export function resolveMarketUrls(options: Pick<ServiceOptions, 'marketUrl' | 'owner' | 'repo' | 'ref'>): string[] {
  const primary = resolveMarketUrl(options)
  if (typeof options.marketUrl === 'string' && options.marketUrl !== '') return [primary]
  if (process.env.DSH_SKILL_MARKET_URL !== undefined && process.env.DSH_SKILL_MARKET_URL.trim() !== '') return [primary]
  const ref = options.ref ?? process.env.DSH_SKILL_MARKET_REF ?? readPackageMarketConfig().ref
  if (ref !== 'main') return [primary]
  const fallback = primary.replace('/main/market/skills.json', '/dev/market/skills.json')
  return fallback === primary ? [primary] : [primary, fallback]
}

export function resolveMarketUrl(options: Pick<ServiceOptions, 'marketUrl' | 'owner' | 'repo' | 'ref'>): string {
  if (typeof options.marketUrl === 'string' && options.marketUrl !== '') {
    assertAllowedUrl(options.marketUrl)
    return options.marketUrl
  }
  const envOwner = process.env.DSH_SKILL_MARKET_OWNER
  const envRepo = process.env.DSH_SKILL_MARKET_REPO
  const envRef = process.env.DSH_SKILL_MARKET_REF
  const envUrl = process.env.DSH_SKILL_MARKET_URL
  if (typeof envUrl === 'string' && envUrl.trim() !== '') {
    assertAllowedUrl(envUrl.trim())
    return envUrl.trim()
  }
  const config = readPackageMarketConfig()
  const owner = options.owner ?? (typeof envOwner === 'string' && envOwner !== '' ? envOwner : config.owner)
  const repo = options.repo ?? (typeof envRepo === 'string' && envRepo !== '' ? envRepo : config.repo)
  const ref = options.ref ?? (typeof envRef === 'string' && envRef !== '' ? envRef : config.ref)
  if (owner === '') {
    throw new SkillMarketError('MARKET_UNAVAILABLE', 'skill market owner is not configured')
  }
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/market/skills.json`
  assertAllowedUrl(url)
  return url
}

function withDeadline<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest request timed out'))
    }, Math.max(1, ms))
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function fetchManifest(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<ParsedManifest> {
  const controller = new AbortController()
  const work = (async (): Promise<ParsedManifest> => {
    let response
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    } catch {
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is unreachable')
    }
    if (!response.ok) {
      throw new SkillMarketError('MARKET_UNAVAILABLE', `market manifest responded HTTP ${response.status}`)
    }
    let text: string
    try {
      text = typeof response.text === 'function'
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString('utf8')
    } catch {
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest body is unreadable')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is not valid JSON')
    }
    return parseManifest(parsed)
  })()
  return withDeadline(work, timeoutMs, controller)
}

/**
 * Build the skill-market service.
 *
 * The manifest cache lives for five minutes and is shared by list/install; a
 * failed refresh never discards the fact that a previous copy existed, so the
 * caller can report `cached: true` without serving stale data as current.
 */
export function createService(options: ServiceOptions = {}): SkillMarketService {
  const dshHome = options.dshHome ?? resolveDshHome()
  const userRoot = join(dshHome, 'skills')
  const bundledRoot = options.bundledSkillDir === null
    ? undefined
    : (options.bundledSkillDir ?? detectBundledSkillDir())
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  if (typeof fetchImpl !== 'function') {
    throw new SkillMarketError('MARKET_UNAVAILABLE', 'no fetch implementation is available')
  }
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const manifestTimeoutMs = options.manifestTimeoutMs ?? DEFAULT_MANIFEST_TIMEOUT_MS
  const marketUrls = resolveMarketUrls(options)

  const installerOptions: InstallerOptions = {
    userRoot,
    bundledRoot,
    fetchImpl,
    now,
    perFileTimeoutMs: options.perFileTimeoutMs ?? DEFAULT_PER_FILE_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
  }

  let cached: { at: number; parsed: ParsedManifest } | undefined
  let inflight: Promise<ParsedManifest> | undefined

  const loadManifest = async (): Promise<{ parsed: ParsedManifest; cached: boolean }> => {
    const at = now()
    if (cached !== undefined && at - cached.at < cacheTtlMs) {
      return { parsed: cached.parsed, cached: true }
    }
    if (inflight === undefined) {
      inflight = (async () => {
        let lastError: unknown
        for (const url of marketUrls) {
          try {
            return await fetchManifest(url, fetchImpl, manifestTimeoutMs)
          } catch (error) {
            lastError = error
            // 只有「这一份清单不存在」才换下一个候选；网络不可达/超时说明整条链路都不通，继续试没有意义。
            const notFound = error instanceof SkillMarketError && /HTTP 404/.test(error.message)
            if (!notFound) break
          }
        }
        throw lastError
      })()
        .then((parsed) => {
          cached = { at: now(), parsed }
          return parsed
        })
        .finally(() => {
          inflight = undefined
        })
    }
    try {
      const parsed = await inflight
      return { parsed, cached: false }
    } catch (error) {
      const known = error instanceof SkillMarketError
        ? error
        : new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is unavailable')
      throw new SkillMarketError(known.code, known.message, {
        status: known.status,
        cached: cached !== undefined,
      })
    }
  }

  const list = async (): Promise<MarketListResult> => {
    const { parsed, cached: fromCache } = await loadManifest()
    const installed = await scanInstalledRoots(userRoot, bundledRoot)
    const installedById = new Map<string, InstalledSkill>()
    for (const entry of installed) {
      // A user copy shadows the bundled copy of the same id.
      if (!installedById.has(entry.id) || entry.source === 'user') installedById.set(entry.id, entry)
    }
    const skills = parsed.manifest.skills.map((skill) => {
      const hit = installedById.get(skill.id)
      return {
        ...skill,
        installed: hit !== undefined,
        ...(hit === undefined ? {} : { installedSource: hit.source, removable: hit.removable }),
      }
    })
    return {
      ok: true,
      cached: fromCache,
      categories: parsed.manifest.categories,
      skills,
      rejected: parsed.rejected,
    }
  }

  const installed = async (): Promise<InstalledSkill[]> => scanInstalledRoots(userRoot, bundledRoot)

  const install = async (id: string, installOptions: { overwrite?: boolean } = {}): Promise<InstallResult> => {
    const safeId = assertKebabId(id)
    const { parsed } = await loadManifest()
    const skill = parsed.manifest.skills.find((entry) => entry.id === safeId)
    if (skill === undefined) {
      throw new SkillMarketError('SKILL_NOT_FOUND', 'the market has no skill with this id')
    }
    return installSkill(installerOptions, skill, installOptions.overwrite === true)
  }

  const uninstall = async (id: string): Promise<void> => uninstallSkill(installerOptions, assertKebabId(id))

  return { list, installed, install, uninstall }
}
