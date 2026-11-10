import { readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SkillMarketError } from './errors.js'
import { assertKebabId, randomToken } from './paths.js'
import { assertAllowedUrl, mirrorUrlFor, parseManifest } from './manifest.js'
import { scanInstalledRoots } from './installed.js'
import { installSkill, inventoriesMatch, inventory, uninstallSkill } from './installer.js'
import type { InstallerOptions } from './installer.js'
import type {
  FetchLike,
  InstallResult,
  InstalledSkill,
  LoggerLike,
  MarketCategory,
  MarketSkill,
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
    updateAvailable: boolean
  }>
  rejected: RejectedSkill[]
  /** Present only when the network failed and a previously saved manifest was served. */
  stale?: boolean
  /** Epoch milliseconds of the disk manifest that produced a stale result. */
  savedAt?: number
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
 * 免得开发期的包市场永远是空的。每个地址都有 jsDelivr 镜像，主入口连接失败/超时/5xx 时换镜像。
 * 显式配置的 URL 只有它自己（加可推导出的镜像），不做 dev 回落（配置就是真源）。
 */
export function resolveMarketUrls(options: Pick<ServiceOptions, 'marketUrl' | 'owner' | 'repo' | 'ref'>): string[] {
  const primary = resolveMarketUrl(options)
  const appendWithMirror = (urls: string[], url: string): void => {
    urls.push(url)
    const mirror = mirrorUrlFor(url)
    if (mirror !== undefined) urls.push(mirror)
  }

  if (typeof options.marketUrl === 'string' && options.marketUrl !== '') {
    const urls: string[] = []
    appendWithMirror(urls, primary)
    return dedupeUrls(urls)
  }
  if (process.env.DSH_SKILL_MARKET_URL !== undefined && process.env.DSH_SKILL_MARKET_URL.trim() !== '') {
    const urls: string[] = []
    appendWithMirror(urls, primary)
    return dedupeUrls(urls)
  }
  const ref = options.ref ?? process.env.DSH_SKILL_MARKET_REF ?? readPackageMarketConfig().ref
  const urls: string[] = []
  appendWithMirror(urls, primary)
  if (ref === 'main') {
    const fallback = primary.replace('/main/market/skills.json', '/dev/market/skills.json')
    if (fallback !== primary) appendWithMirror(urls, fallback)
  }
  return dedupeUrls(urls)
}

/** Keep the first occurrence of each URL so candidate order stays meaningful. */
function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    unique.push(url)
  }
  return unique
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
      reject(new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest request timed out', { retryable: true }))
    }, Math.max(1, ms))
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

interface FetchedManifest {
  parsed: ParsedManifest
  /** The untouched JSON document, so the disk cache round-trips the same catalogue. */
  raw: unknown
  sourceUrl: string
}

async function fetchManifest(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<FetchedManifest> {
  const controller = new AbortController()
  const work = (async (): Promise<FetchedManifest> => {
    let response
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    } catch {
      // 连接失败/超时属于传输层问题，换镜像或 dev 分支还有机会；4xx 是权威答复，不再换。
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is unreachable', { retryable: true })
    }
    if (!response.ok) {
      const retryable = response.status === 404 || response.status >= 500
      throw new SkillMarketError('MARKET_UNAVAILABLE', `market manifest responded HTTP ${response.status}`, { retryable })
    }
    let text: string
    try {
      text = typeof response.text === 'function'
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString('utf8')
    } catch {
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest body is unreadable', { retryable: true })
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is not valid JSON')
    }
    return { parsed: parseManifest(raw), raw, sourceUrl: url }
  })()
  return withDeadline(work, timeoutMs, controller)
}

interface DiskManifestCache {
  savedAt: number
  sourceUrl: string
  manifest: unknown
}

interface LoadedManifest {
  parsed: ParsedManifest
  cached: boolean
  stale?: boolean
  savedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and validate the on-disk manifest; any structural problem means "no cache". */
async function readDiskManifest(path: string): Promise<{ parsed: ParsedManifest; savedAt: number } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const savedAt = value.savedAt
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null
  if (typeof value.sourceUrl !== 'string') return null
  try {
    return { parsed: parseManifest(value.manifest), savedAt }
  } catch {
    return null
  }
}

/** Atomically replace the cache; a write failure never fails the caller. */
async function writeDiskManifest(path: string, record: DiskManifestCache, logger?: LoggerLike): Promise<void> {
  const temp = `${path}.${randomToken()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`skill market cache write failed: ${message}`)
  }
}

/**
 * Compare one installed copy against its market entry.
 *
 * A bundled copy never reports an update: the engine ships it and the user
 * cannot replace it. Any inspection failure degrades to `false` so one broken
 * directory cannot fail the whole route.
 */
async function computeUpdateAvailable(
  entry: InstalledSkill,
  marketSkill: MarketSkill | undefined,
  logger?: LoggerLike,
): Promise<boolean> {
  if (entry.source === 'bundled') return false
  if (marketSkill === undefined) return false
  try {
    const actual = await inventory(entry.path)
    if (actual === null) {
      logger?.warn?.(`skill market: cannot inventory ${entry.id}; treating it as up to date`)
      return false
    }
    return !inventoriesMatch(marketSkill.files, actual)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`skill market: update check failed for ${entry.id}: ${message}`)
    return false
  }
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

  const logger = options.logger
  const cachePath = join(dshHome, 'market', 'cache.json')

  let cached: (LoadedManifest & { at: number }) | undefined
  let inflight: Promise<LoadedManifest> | undefined

  const loadManifest = async (): Promise<LoadedManifest> => {
    const at = now()
    if (cached !== undefined && at - cached.at < cacheTtlMs) {
      return {
        parsed: cached.parsed,
        cached: true,
        ...(cached.stale === true ? { stale: true, savedAt: cached.savedAt } : {}),
      }
    }
    if (inflight === undefined) {
      inflight = (async (): Promise<LoadedManifest> => {
        let lastError: unknown
        for (const url of marketUrls) {
          try {
            const fetched = await fetchManifest(url, fetchImpl, manifestTimeoutMs)
            await writeDiskManifest(
              cachePath,
              { savedAt: now(), sourceUrl: fetched.sourceUrl, manifest: fetched.raw },
              logger,
            )
            return { parsed: fetched.parsed, cached: false }
          } catch (error) {
            lastError = error
            // 只有传输层失败（连接/超时/5xx）和 404 才换下一个候选；清单内容损坏换地址也不会变好。
            if (!(error instanceof SkillMarketError) || error.retryable !== true) break
          }
        }
        const disk = await readDiskManifest(cachePath)
        if (disk !== null) {
          logger?.warn?.('skill market manifest is unavailable; serving the last cached copy')
          return { parsed: disk.parsed, cached: true, stale: true, savedAt: disk.savedAt }
        }
        throw lastError ?? new SkillMarketError('MARKET_UNAVAILABLE', 'market manifest is unavailable')
      })()
        .then((result) => {
          cached = { at: now(), ...result }
          return result
        })
        .finally(() => {
          inflight = undefined
        })
    }
    try {
      return await inflight
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
    const loaded = await loadManifest()
    const installed = await scanInstalledRoots(userRoot, bundledRoot)
    const installedById = new Map<string, InstalledSkill>()
    for (const entry of installed) {
      // A user copy shadows the bundled copy of the same id.
      if (!installedById.has(entry.id) || entry.source === 'user') installedById.set(entry.id, entry)
    }
    const skills = await Promise.all(loaded.parsed.manifest.skills.map(async (skill) => {
      const hit = installedById.get(skill.id)
      const updateAvailable = hit === undefined ? false : await computeUpdateAvailable(hit, skill, logger)
      return {
        ...skill,
        installed: hit !== undefined,
        ...(hit === undefined ? {} : { installedSource: hit.source, removable: hit.removable }),
        updateAvailable,
      }
    }))
    return {
      ok: true,
      cached: loaded.cached,
      ...(loaded.stale === true ? { stale: true, savedAt: loaded.savedAt } : {}),
      categories: loaded.parsed.manifest.categories,
      skills,
      rejected: loaded.parsed.rejected,
    }
  }

  const installed = async (): Promise<InstalledSkill[]> => {
    const entries = await scanInstalledRoots(userRoot, bundledRoot)
    let manifest: ParsedManifest | undefined
    try {
      manifest = (await loadManifest()).parsed
    } catch (error) {
      // 更新判定是附加信息，清单不可达不应让「已安装列表」整条失败。
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`skill market: manifest unavailable for update checks: ${message}`)
    }
    const byId = new Map(manifest?.manifest.skills.map((skill) => [skill.id, skill]) ?? [])
    return Promise.all(entries.map(async (entry) => ({
      ...entry,
      updateAvailable: await computeUpdateAvailable(entry, byId.get(entry.id), logger),
    })))
  }

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
