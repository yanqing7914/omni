/**
 * Types shared by the skill-market server half.
 *
 * The manifest is deliberately plain data: categories are display metadata and
 * every skill carries its own provenance plus a byte-level file inventory. The
 * installer trusts none of it until the paths, hashes and sizes have been
 * checked.
 */

/** English/Chinese display text. `en` is always required. */
export interface Bilingual {
  en: string
  zh?: string
}

/**
 * 技能可选的能力依赖。只做这三个：无障碍、Shizuku、真实屏幕范围是壳侧能可靠判定的通道；
 * 其它能力没有稳定的本地判据，声明了也只会变成假入口。
 *
 * real-screen 与另外两个不同：它不是系统权限，而是用户在本应用里选的屏幕范围（virtual-only /
 * real-only / all）。淘宝这类「在真实屏上操作第三方 App」的技能，范围是 virtual-only 时必然用不了。
 */
export type SkillRequirement = 'a11y' | 'shizuku' | 'real-screen'

/** 解析时允许保留的能力依赖闭集；未知值丢弃而不是拒绝整条清单。 */
export const SKILL_REQUIREMENTS: readonly SkillRequirement[] = ['a11y', 'shizuku', 'real-screen']

/** 一条「条目仍可用、但有字段被降级」的解析警告。 */
export interface ManifestWarning {
  id: string
  reasons: string[]
}

/** A display category from the market manifest. */
export interface MarketCategory {
  id: string
  title: Bilingual
}

/** Upstream location of one skill directory. */
export interface SkillSource {
  owner: string
  repo: string
  ref: string
  /** Directory inside the repository, POSIX separators, no leading slash. */
  path: string
}

/** One file inside the skill directory, verified byte-for-byte. */
export interface SkillFile {
  /** File path relative to the skill directory, POSIX separators. */
  path: string
  /** Lower-case hex SHA-256 of the downloaded bytes. */
  sha256: string
  /** Exact byte length. A size mismatch is a checksum failure. */
  size: number
}

/** One valid market entry. */
export interface MarketSkill {
  id: string
  name: string
  title: Bilingual
  description: Bilingual
  category: string
  license: string
  /** 安装/使用前必须具备的本地能力；缺省为空数组。 */
  requires: SkillRequirement[]
  source: SkillSource
  files: SkillFile[]
}

/** The validated market manifest. */
export interface MarketManifest {
  schemaVersion: number
  categories: MarketCategory[]
  skills: MarketSkill[]
}

/** An entry the parser refused, with every reason it refused it. */
export interface RejectedSkill {
  id: string
  reasons: string[]
}

export interface ParsedManifest {
  manifest: MarketManifest
  rejected: RejectedSkill[]
  /** 条目未被拒绝、但有可选字段被降级的原因（如未知的 requires 值）。 */
  warnings: ManifestWarning[]
}

/** Where an installed skill came from. */
export type InstalledSource = 'user' | 'bundled'

/** One skill discovered on disk. */
export interface InstalledSkill {
  id: string
  name: string
  description: string
  source: InstalledSource
  path: string
  removable: boolean
  /** 从市场清单按 id 取到的能力依赖；清单里没有该 id 时为空数组。 */
  requires: SkillRequirement[]
  /** True when the market entry's file inventory differs from the directory on disk. */
  updateAvailable: boolean
}

/** Minimal response surface the installer needs; lets tests inject a fake. */
export interface FetchResponse {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text?(): Promise<string>
  headers?: { get(name: string): string | null }
}

/** Minimal fetch surface; tests supply a local fake and no real network is used. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>

/** Optional logger; the engine passes its cordis logger, tests may omit it. */
export interface LoggerLike {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/** Result of a successful install. */
export interface InstallResult {
  status: 'installed' | 'already-installed'
  id: string
  path: string
}

/** Error codes surfaced through the HTTP JSON body. */
export type SkillMarketErrorCode =
  | 'INVALID_ID'
  | 'INVALID_BODY'
  | 'BODY_TOO_LARGE'
  | 'INVALID_MANIFEST'
  | 'MARKET_UNAVAILABLE'
  | 'SKILL_NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'ALREADY_INSTALLED'
  | 'CHECKSUM_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'URL_NOT_ALLOWED'
  | 'UNSAFE_PATH'
  | 'INSTALL_TIMEOUT'
  | 'BUNDLED_NOT_REMOVABLE'
  | 'NOT_INSTALLED'
  | 'INTERNAL'
