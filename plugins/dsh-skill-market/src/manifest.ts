import { SkillMarketError } from './errors.js'
import { assertSafeRelativePath, assertSafeSourcePath, KEBAB_ID } from './paths.js'
import type {
  Bilingual,
  MarketCategory,
  MarketManifest,
  MarketSkill,
  ParsedManifest,
  RejectedSkill,
  SkillFile,
  SkillSource,
} from './types.js'

const REPO_PART = /^[A-Za-z0-9_.-]+$/
const SHA256 = /^[a-f0-9]{64}$/

/** The only origins downloads may use: GitHub raw plus its jsDelivr mirror. */
export const ALLOWED_DOWNLOAD_ORIGINS = [
  'https://raw.githubusercontent.com/',
  'https://cdn.jsdelivr.net/',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string/object bilingual field; `en` is mandatory for a usable entry. */
function readBilingual(value: unknown): Bilingual | null {
  if (typeof value === 'string') {
    const en = value.trim()
    return en === '' ? null : { en }
  }
  if (!isRecord(value)) return null
  const en = typeof value.en === 'string' ? value.en.trim() : ''
  if (en === '') return null
  const zh = typeof value.zh === 'string' ? value.zh.trim() : undefined
  return zh === undefined || zh === '' ? { en } : { en, zh }
}

function readSource(value: unknown, reasons: string[]): SkillSource | null {
  if (!isRecord(value)) {
    reasons.push('source is required')
    return null
  }
  const owner = typeof value.owner === 'string' ? value.owner.trim() : ''
  const repo = typeof value.repo === 'string' ? value.repo.trim() : ''
  const ref = typeof value.ref === 'string' ? value.ref.trim() : ''
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo)) {
    reasons.push('source.owner/source.repo must be plain GitHub names')
  }
  if (ref === '' || ref.includes('..') || ref.includes('\\') || ref.startsWith('/')) {
    reasons.push('source.ref must be a non-empty git ref without path escapes')
  }
  let path = ''
  try {
    path = assertSafeSourcePath(value.path)
  } catch {
    reasons.push('source.path must be a safe relative path')
  }
  if (reasons.length > 0) return null
  return { owner, repo, ref, path }
}

function readFiles(value: unknown, reasons: string[]): SkillFile[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push('files must be a non-empty array')
    return null
  }
  const files: SkillFile[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const id = isRecord(raw) && typeof raw.path === 'string' ? raw.path : '<unknown file>'
    if (!isRecord(raw)) {
      reasons.push(`file ${id} must be an object`)
      continue
    }
    let path = ''
    try {
      path = assertSafeRelativePath(raw.path, 'file path')
    } catch {
      reasons.push(`file ${id} has an unsafe path`)
      continue
    }
    if (seen.has(path)) {
      reasons.push(`file ${path} is listed more than once`)
      continue
    }
    seen.add(path)
    if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
      reasons.push(`file ${path} is missing a valid sha256`)
      continue
    }
    if (typeof raw.size !== 'number' || !Number.isInteger(raw.size) || raw.size < 0) {
      reasons.push(`file ${path} is missing a valid size`)
      continue
    }
    files.push({ path, sha256: raw.sha256.toLowerCase(), size: raw.size })
  }
  if (reasons.length > 0) return null
  return files
}

/**
 * Validate a market manifest.
 *
 * The contract is fail-soft for individual entries: a bad name, description,
 * category or checksum rejects that entry with a reason and leaves the rest of
 * the catalogue usable. Only a structurally impossible document (not an object,
 * missing category/skill arrays) throws.
 */
export function parseManifest(value: unknown): ParsedManifest {
  if (!isRecord(value)) throw new SkillMarketError('INVALID_MANIFEST', 'manifest must be a JSON object')
  if (!Array.isArray(value.categories) || !Array.isArray(value.skills)) {
    throw new SkillMarketError('INVALID_MANIFEST', 'manifest must carry categories and skills arrays')
  }

  const categories: MarketCategory[] = []
  for (const raw of value.categories) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id : ''
    const title = readBilingual(raw.title ?? raw.name)
    if (!KEBAB_ID.test(id) || title === null) continue
    categories.push({ id, title })
  }
  const categoryIds = new Set(categories.map((category) => category.id))

  const skills: MarketSkill[] = []
  const rejected: RejectedSkill[] = []
  const acceptedIds = new Set<string>()

  for (const raw of value.skills) {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '<missing>'
    const reasons: string[] = []
    if (!isRecord(raw)) {
      rejected.push({ id, reasons: ['entry must be an object'] })
      continue
    }
    if (!KEBAB_ID.test(id)) reasons.push('id is not kebab-case')
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (!KEBAB_ID.test(name)) reasons.push('name is not kebab-case')
    const description = readBilingual(raw.description)
    if (description === null) reasons.push('description is required')
    const title = readBilingual(raw.title) ?? (KEBAB_ID.test(name) ? { en: name } : null)
    const category = typeof raw.category === 'string' ? raw.category : ''
    if (!categoryIds.has(category)) reasons.push('category is missing or unknown')
    const license = typeof raw.license === 'string' ? raw.license.trim() : ''
    if (license === '') reasons.push('license is required')

    const sourceReasons: string[] = []
    const source = readSource(raw.source, sourceReasons)
    reasons.push(...sourceReasons)
    const files = readFiles(raw.files, reasons)

    if (KEBAB_ID.test(id) && acceptedIds.has(id)) reasons.push('id is duplicated')

    if (reasons.length > 0) {
      rejected.push({ id, reasons: [...new Set(reasons)] })
      continue
    }
    acceptedIds.add(id)
    skills.push({
      id,
      name,
      title: title as Bilingual,
      description: description as Bilingual,
      category,
      license,
      source: source as SkillSource,
      files: files as SkillFile[],
    })
  }

  const manifest: MarketManifest = {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    categories: categories.sort((a, b) => a.id.localeCompare(b.id)),
    skills: skills.sort((a, b) => a.id.localeCompare(b.id)),
  }
  return { manifest, rejected }
}

/** Validate the pieces of a source reference that end up in a download path. */
function assertSourceReference(source: SkillSource, filePath: string): void {
  assertSafeRelativePath(filePath, 'file path')
  assertSafeSourcePath(source.path)
  if (
    !REPO_PART.test(source.owner)
    || !REPO_PART.test(source.repo)
    || source.ref === ''
    || source.ref.includes('..')
    || source.ref.includes('\\')
    || source.ref.startsWith('/')
  ) {
    throw new SkillMarketError('URL_NOT_ALLOWED', 'source location is not a plain GitHub reference')
  }
}

/** Absolute raw.githubusercontent URL for one file of one market entry. */
export function rawFileUrl(source: SkillSource, filePath: string): string {
  assertSourceReference(source, filePath)
  const url = new URL(
    `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${source.path}/${filePath}`,
  )
  assertAllowedUrl(url.href)
  return url.href
}

/**
 * jsDelivr mirror of the same file.
 *
 * jsDelivr serves GitHub content through `gh/<owner>/<repo>@<ref>/<path>`, so it
 * is a second entry point to identical bytes rather than a different source.
 */
export function mirrorFileUrl(source: SkillSource, filePath: string): string {
  assertSourceReference(source, filePath)
  const url = new URL(
    `https://cdn.jsdelivr.net/gh/${source.owner}/${source.repo}@${source.ref}/${source.path}/${filePath}`,
  )
  assertAllowedUrl(url.href)
  return url.href
}

/** Primary and mirror URLs, in the order they should be attempted. */
export function fileUrls(source: SkillSource, filePath: string): string[] {
  return [rawFileUrl(source, filePath), mirrorFileUrl(source, filePath)]
}

/**
 * Mirror URL for an already-built raw.githubusercontent URL.
 *
 * The first three path segments of a raw URL are owner/repo/ref. A ref that
 * itself contains slashes is ambiguous in this scheme; market refs are branch
 * names (`main` / `dev`), and an ambiguous URL simply yields a mirror that
 * points at the wrong path, which then fails as a normal 404.
 */
export function mirrorUrlFor(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.hostname !== 'raw.githubusercontent.com') return undefined
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length < 4) return undefined
  const [owner, repo, ref, ...rest] = segments
  const mirror = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest.join('/')}`
  try {
    assertAllowedUrl(mirror)
  } catch {
    return undefined
  }
  return mirror
}

/**
 * Hard download whitelist: HTTPS, no credentials, no non-default port, and one
 * of the two exact origins above. Subdomains and lookalike hosts (`raw.githubusercontent.com.evil.test`)
 * are refused because the hostname comparison is exact.
 */
export function assertAllowedUrl(href: string): void {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    throw new SkillMarketError('URL_NOT_ALLOWED', 'download URL is not a valid URL')
  }
  const allowedOrigin = ALLOWED_DOWNLOAD_ORIGINS.find((origin) => href.startsWith(origin))
  if (
    url.protocol !== 'https:'
    || allowedOrigin === undefined
    || url.origin + '/' !== allowedOrigin
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new SkillMarketError(
      'URL_NOT_ALLOWED',
      'downloads are restricted to https://raw.githubusercontent.com/ and https://cdn.jsdelivr.net/',
    )
  }
}
