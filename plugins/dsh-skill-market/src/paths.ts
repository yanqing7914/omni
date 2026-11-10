import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SkillMarketError } from './errors.js'

/** The install API and the manifest use the same kebab-case identity shape. */
export const KEBAB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Validate a market / install id. */
export function assertKebabId(value: unknown): string {
  if (typeof value !== 'string' || !KEBAB_ID.test(value)) {
    throw new SkillMarketError('INVALID_ID', 'id must match ^[a-z0-9][a-z0-9-]{0,63}$')
  }
  return value
}

/** True when `value` is a safe relative POSIX path with no escape segment. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false
  if (value.includes('\0') || value.includes('\\')) return false
  if (value.includes('?') || value.includes('#')) return false
  // A colon is a Windows drive/ADS separator and never valid in a skill path.
  if (value.includes(':')) return false
  if (isAbsolute(value) || value.startsWith('/')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Validate a relative path coming from the (untrusted) manifest. */
export function assertSafeRelativePath(value: unknown, label: string): string {
  if (!isSafeRelativePath(value)) {
    throw new SkillMarketError('UNSAFE_PATH', `${label} must be a safe relative path`)
  }
  return value
}

/** Validate a repository directory path; same rules as a file path. */
export function assertSafeSourcePath(value: unknown): string {
  return assertSafeRelativePath(value, 'source.path')
}

/** Convert a validated POSIX relative path to a platform path below `root`. */
export function resolveBelow(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split('/'))
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new SkillMarketError('UNSAFE_PATH', 'resolved path escapes the skill root')
  }
  return target
}

/** Lexical containment check used before touching the filesystem. */
export function isLexicallyInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(rootWithSep)
}

/**
 * Resolve `candidate` and prove that its real path is inside `rootReal`.
 *
 * `candidate` may not exist yet (staging files); in that case its parent must
 * exist. Any symbolic link in the chain is resolved by `realpath`, and a link
 * that leaves `rootReal` is rejected rather than followed.
 */
export async function assertRealpathInside(rootReal: string, candidate: string): Promise<string> {
  let real: string
  try {
    real = await realpath(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
    const parent = await realpath(dirname(candidate))
    if (!isLexicallyInside(rootReal, parent)) {
      throw new SkillMarketError('UNSAFE_PATH', 'path escapes the skill root')
    }
    return join(parent, basename(candidate))
  }
  if (!isLexicallyInside(rootReal, real)) {
    throw new SkillMarketError('UNSAFE_PATH', 'path escapes the skill root')
  }
  return real
}

/**
 * Refuse to operate on a symbolic link. Install and uninstall both use this:
 * a link is never treated as the directory it points at.
 */
export async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Create a directory and return its real path. */
export async function ensureRealDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return realpath(path)
}

/** Random suffix for staging/trash names; never derived from user input. */
export function randomToken(): string {
  return randomBytes(8).toString('hex')
}
