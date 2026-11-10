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
