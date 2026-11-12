import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { SkillMarketError, asSkillMarketError } from './errors.js'
import { mirrorFileUrl, rawFileUrl } from './manifest.js'
import {
  assertKebabId,
  assertRealpathInside,
  ensureRealDirectory,
  isLexicallyInside,
  lstatOrUndefined,
  randomToken,
  resolveBelow,
} from './paths.js'
import { scanInstalledRoots } from './installed.js'
import type { FetchLike, InstallResult, MarketSkill, SkillFile, SkillSource } from './types.js'

export interface InstallerOptions {
  userRoot: string
  bundledRoot?: string
  fetchImpl: FetchLike
  now: () => number
  perFileTimeoutMs: number
  totalTimeoutMs: number
  concurrency: number
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function withTimeout<T>(work: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      // 单次尝试超时可以换镜像重试；总预算耗尽由调用方在发起下一次之前直接拒绝。
      reject(new SkillMarketError('INSTALL_TIMEOUT', 'the skill download exceeded its time budget', { retryable: true }))
    }, Math.max(1, ms))
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Run at most `limit` workers; stop handing out work after the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failure: unknown
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) return
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = await work(items[index])
      } catch (error) {
        failure = error
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failure !== undefined) throw failure
  return results
}

/** Hash every regular file below `root`; any symlink makes the inventory unusable. */
async function inventory(root: string, prefix = ''): Promise<Map<string, { sha256: string; size: number }> | null> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const files = new Map<string, { sha256: string; size: number }>()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return null
    const absolute = join(root, entry.name)
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      const nested = await inventory(absolute, rel)
      if (nested === null) return null
      for (const [path, value] of nested) files.set(path, value)
      continue
    }
    if (!entry.isFile()) return null
    const bytes = await readFile(absolute)
    files.set(rel.split(sep).join('/'), { sha256: sha256(bytes), size: bytes.length })
  }
  return files
}

function inventoriesMatch(
  expected: SkillFile[],
  actual: Map<string, { sha256: string; size: number }>,
): boolean {
  if (actual.size !== expected.length) return false
  for (const file of expected) {
    const found = actual.get(file.path)
    if (found === undefined || found.sha256 !== file.sha256 || found.size !== file.size) return false
  }
  return true
}

/** One HTTP attempt; `retryable` is true only for transport failures and 5xx. */
async function downloadOnce(
  options: InstallerOptions,
  url: string,
  filePath: string,
  budget: number,
): Promise<Buffer> {
  const controller = new AbortController()
  try {
    return await withTimeout(
      (async () => {
        let response
        try {
          response = await options.fetchImpl(url, { signal: controller.signal })
        } catch {
          throw new SkillMarketError('DOWNLOAD_FAILED', `download failed for ${filePath}`, { retryable: true })
        }
        if (!response.ok) {
          throw new SkillMarketError(
            'DOWNLOAD_FAILED',
            `download failed for ${filePath} (HTTP ${response.status})`,
            { retryable: response.status >= 500, httpStatus: response.status },
          )
        }
        try {
          return Buffer.from(await response.arrayBuffer())
        } catch {
          throw new SkillMarketError('DOWNLOAD_FAILED', `download body failed for ${filePath}`, { retryable: true })
        }
      })(),
      budget,
      controller,
    )
  } catch (error) {
    throw asSkillMarketError(error)
  }
}

/**
 * Resolve one file across its entry points and, for the mutable `main` ref,
 * across branches.
 *
 * Local skills declare `ref: "main"` while the market manifest may still live
 * on `dev` during development, so a 404 on main means "not published there
 * yet" and the same file is retried on dev. A concrete commit is pinned on
 * purpose and never moves to another branch. Within one ref the mirror is only
 * another entry point: a 404 means this ref does not have the file (do not try
 * the mirror), while connection failures, timeouts and 5xx do move to it, and a
 * second transport failure is final instead of crossing branches.
 */
async function downloadCandidate(
  options: InstallerOptions,
  source: SkillSource,
  filePath: string,
  deadline: number,
): Promise<Buffer> {
  const refs = source.ref === 'main' ? ['main', 'dev'] : [source.ref]
  let lastError: SkillMarketError | undefined

  for (const ref of refs) {
    const refSource = ref === source.ref ? source : { ...source, ref }
    const candidates = [rawFileUrl(refSource, filePath), mirrorFileUrl(refSource, filePath)]
    for (let index = 0; index < candidates.length; index += 1) {
      const remaining = deadline - options.now()
      if (remaining <= 0) {
        throw new SkillMarketError('INSTALL_TIMEOUT', 'the skill download exceeded its time budget')
      }
      const budget = Math.min(options.perFileTimeoutMs, remaining)
      try {
        return await downloadOnce(options, candidates[index], filePath, budget)
      } catch (error) {
        const failure = asSkillMarketError(error)
        lastError = failure
        if (failure.httpStatus === 404) break
        // 若这次超时已经把总预算耗尽，换镜像也没有时间可用；直接按总预算失败。
        const exhaustedTotal = failure.code === 'INSTALL_TIMEOUT' && budget >= remaining
        if (failure.retryable !== true || exhaustedTotal || index === candidates.length - 1) throw failure
      }
    }
  }
  throw lastError ?? new SkillMarketError('DOWNLOAD_FAILED', `download failed for ${filePath}`)
}

/** Download and verify one file, then write it into the staging directory. */
async function downloadFile(
  options: InstallerOptions,
  skill: MarketSkill,
  file: SkillFile,
  staging: string,
  stagingReal: string,
  deadline: number,
): Promise<void> {
  const bytes = await downloadCandidate(options, skill.source, file.path, deadline)

  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
    throw new SkillMarketError('CHECKSUM_MISMATCH', `checksum mismatch for ${file.path}`)
  }

  const target = resolveBelow(staging, file.path)
  await mkdir(dirname(target), { recursive: true })
  await assertRealpathInside(stagingReal, dirname(target))
  const existing = await lstatOrUndefined(target)
  if (existing !== undefined) {
    throw new SkillMarketError('UNSAFE_PATH', `duplicate or pre-existing staging path: ${file.path}`)
  }
  await writeFile(target, bytes, { flag: 'wx', mode: 0o644 })
}

/** Remove a tree without letting cleanup mask the original failure. */
async function discard(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {})
}

/**
 * Install one manifest entry into `<userRoot>/<id>`.
 *
 * Order matters: download and verify every file into `.staging-*`, compare the
 * existing directory before doing any network work, and only then swap the
 * staging tree in with a same-filesystem rename. A failure at any point removes
 * staging and leaves the previous directory in place.
 */
export async function installSkill(
  options: InstallerOptions,
  skill: MarketSkill,
  requestedOverwrite: boolean,
): Promise<InstallResult> {
  const id = assertKebabId(skill.id)
  // Bundled skills ship with the engine and are read-only; an "update" of one
  // must never be translated into writing a user copy over it.
  if (requestedOverwrite && options.bundledRoot !== undefined) {
    const bundledDirectory = await lstatOrUndefined(join(options.bundledRoot, id))
    const bundledFlat = await lstatOrUndefined(join(options.bundledRoot, `${id}.md`))
    if (bundledDirectory !== undefined || bundledFlat !== undefined) {
      throw new SkillMarketError(
        'BUNDLED_NOT_REMOVABLE',
        'bundled skills are read-only and cannot be overwritten',
      )
    }
  }

  const userRootReal = await ensureRealDirectory(options.userRoot)
  const destination = join(userRootReal, id)
  if (!isLexicallyInside(userRootReal, destination)) {
    throw new SkillMarketError('UNSAFE_PATH', 'destination escapes the skill root')
  }

  const existing = await lstatOrUndefined(destination)
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      throw new SkillMarketError('UNSAFE_PATH', 'destination is a symbolic link')
    }
    if (existing.isDirectory()) {
      const real = await realpath(destination)
      if (real !== destination) {
        throw new SkillMarketError('UNSAFE_PATH', 'destination resolves outside the skill root')
      }
      const current = await inventory(destination)
      if (current !== null && inventoriesMatch(skill.files, current)) {
        return { status: 'already-installed', id, path: destination }
      }
    }
    if (!requestedOverwrite) {
      throw new SkillMarketError(
        'ALREADY_EXISTS',
        'a different skill with this id is already installed; resend with overwrite:true to replace it',
      )
    }
  }

  const staging = join(userRootReal, `.staging-${id}-${randomToken()}`)
  await mkdir(staging, { recursive: false, mode: 0o700 })
  const stagingReal = await realpath(staging)
  const deadline = options.now() + options.totalTimeoutMs

  try {
    await mapLimit(skill.files, options.concurrency, (file) =>
      downloadFile(options, skill, file, staging, stagingReal, deadline),
    )

    let trash: string | undefined
    if (existing !== undefined) {
      trash = join(userRootReal, `.trash-${id}-${randomToken()}`)
      await rename(destination, trash)
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (trash !== undefined) await rename(trash, destination).catch(() => {})
      throw error
    }
    if (trash !== undefined) await discard(trash)
    return { status: 'installed', id, path: destination }
  } catch (error) {
    await discard(staging)
    throw asSkillMarketError(error)
  }
}

/** Resolve a directory if it exists; return undefined for ENOENT. */
async function realIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Remove a user-installed skill.
 *
 * Bundled skills are read-only and answer `BUNDLED_NOT_REMOVABLE`. A user path
 * is removed only after `lstat` rejects a symlink and `realpath` proves it is
 * still inside the user root.
 */
export async function uninstallSkill(options: InstallerOptions, id: string): Promise<void> {
  const safeId = assertKebabId(id)
  const userRootReal = await realIfExists(options.userRoot)

  if (userRootReal !== undefined) {
    const directory = join(userRootReal, safeId)
    const info = await lstatOrUndefined(directory)
    if (info !== undefined) {
      if (info.isSymbolicLink()) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill path is a symbolic link')
      }
      if (!info.isDirectory()) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill path is not a plain directory')
      }
      const real = await realpath(directory)
      if (real !== directory || !isLexicallyInside(userRootReal, real)) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill resolves outside the skill root')
      }
      await rm(directory, { recursive: true, force: true })
      return
    }

    const flat = join(userRootReal, `${safeId}.md`)
    const flatInfo = await lstatOrUndefined(flat)
    if (flatInfo !== undefined) {
      if (flatInfo.isSymbolicLink()) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill file is a symbolic link')
      }
      if (!flatInfo.isFile()) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill file is not a plain file')
      }
      const real = await realpath(flat)
      if (!isLexicallyInside(userRootReal, real)) {
        throw new SkillMarketError('UNSAFE_PATH', 'installed skill file resolves outside the skill root')
      }
      await unlink(flat)
      return
    }
  }

  if (options.bundledRoot !== undefined) {
    const installed = await scanInstalledRoots(options.userRoot, options.bundledRoot)
    if (installed.some((entry) => entry.id === safeId && entry.source === 'bundled')) {
      throw new SkillMarketError('BUNDLED_NOT_REMOVABLE', 'bundled skills ship with the engine and cannot be removed')
    }
  }

  throw new SkillMarketError('NOT_INSTALLED', 'no user-installed skill has this id')
}

// Re-export the helpers the service and tests share.
export { inventory, inventoriesMatch, mapLimit, withTimeout }
