#!/usr/bin/env node
/**
 * Build market/skills.json from a short source list.
 *
 * For each entry the script obtains the directory tree (GitHub tree API, with a
 * sparse git clone as the rate-limit fallback), downloads every file, hashes the
 * bytes and writes a deterministic manifest. Input order does not affect the
 * output: categories, skills and files are all sorted, so running the script
 * twice over the same sources produces byte-identical JSON.
 *
 * Usage:
 *   node scripts/market/build-skill-manifest.mjs
 *   node scripts/market/build-skill-manifest.mjs --check
 *   node scripts/market/build-skill-manifest.mjs --sources <file> --out <file>
 *
 * Optional: GITHUB_TOKEN raises the GitHub API rate limit. `--cache <dir>` sets
 * the fallback clone cache; the default is under the OS temp directory.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DEFAULT_SOURCES = join(REPO_ROOT, 'scripts', 'market', 'skill-sources.json')
const DEFAULT_OUTPUT = join(REPO_ROOT, 'market', 'skills.json')
const KEBAB = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/
/** 技能允许声明的能力依赖；与 plugins/dsh-skill-market/src/types.ts 的闭集一致。 */
const KNOWN_REQUIREMENTS = new Set(['a11y', 'shizuku', 'real-screen'])
const DOWNLOAD_CONCURRENCY = 8
const DOWNLOAD_TIMEOUT_MS = 30_000

/** Code-unit ordering: stable across locales, unlike localeCompare. */
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function fail(message) {
  throw new Error(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKebab(value, label) {
  if (typeof value !== 'string' || !KEBAB.test(value)) fail(label + ' must be kebab-case')
  return value
}

function readBilingual(value, label) {
  if (!isRecord(value) || typeof value.en !== 'string' || value.en.trim() === '') {
    fail(label + '.en is required')
  }
  const out = { en: value.en.trim() }
  if (typeof value.zh === 'string' && value.zh.trim() !== '') out.zh = value.zh.trim()
  return out
}

function safeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || isAbsolute(value)
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(label + ' must be a safe relative path')
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 读取可选的 `requires`。
 *
 * 与运行时的解析口径一致：未知值/非数组只告警并丢弃，不让整条技能构建失败。
 * 生成脚本仍要出声，否则源清单里的拼写错误会静默消失。
 */
function readRequires(value, id) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    console.warn(`skill ${id}: requires must be an array; declaration dropped`)
    return []
  }
  const requires = []
  for (const item of value) {
    if (typeof item !== 'string' || !KNOWN_REQUIREMENTS.has(item)) {
      console.warn(`skill ${id}: unknown requires value ${JSON.stringify(item)}; dropped`)
      continue
    }
    if (!requires.includes(item)) requires.push(item)
  }
  return requires
}

/** Extract owner/repo from the repository's origin remote. */
function remoteSlug(repoRoot) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
    if (match !== null) return { owner: match[1], repo: match[2] }
  } catch {
    /* fall through */
  }
  return null
}

function walkLocal(root, prefix = '') {
  const files = new Map()
  for (const name of readdirSync(root).sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const absolute = join(root, name)
    const info = lstatSync(absolute)
    const rel = prefix === '' ? name : prefix + '/' + name
    if (info.isSymbolicLink()) fail('local skill contains a symbolic link: ' + rel)
    if (info.isDirectory()) {
      for (const [path, bytes] of walkLocal(absolute, rel)) files.set(path, bytes)
      continue
    }
    if (!info.isFile()) fail('local skill contains a non-regular file: ' + rel)
    files.set(rel, readFileSync(absolute))
  }
  return files
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Sparse clone fallback: the working tree only materializes the needed paths. */
function gitInventory(source, cacheRoot) {
  const key = sha256(Buffer.from(`${source.owner}/${source.repo}@${source.ref}`)).slice(0, 24)
  const checkout = join(cacheRoot, key)
  if (!existsSync(join(checkout, '.git'))) {
    mkdirSync(checkout, { recursive: true })
    git(['init', '-q'], checkout)
    git(['remote', 'add', 'origin', `https://github.com/${source.owner}/${source.repo}.git`], checkout)
    git(['sparse-checkout', 'init', '--cone'], checkout)
    git(['sparse-checkout', 'set', source.path], checkout)
  }
  // Refresh the cone on every run: one repository can host several skill paths.
  git(['sparse-checkout', 'set', source.path], checkout)
  git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', source.ref], checkout)
  git(['checkout', '-q', '--detach', 'FETCH_HEAD'], checkout)

  const listed = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', source.path], checkout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const prefix = source.path.replace(/\/+$/, '') + '/'
  const files = new Map()
  for (const full of listed.sort()) {
    if (!full.startsWith(prefix)) continue
    const rel = full.slice(prefix.length)
    safeRelativePath(rel, 'file path')
    const absolute = join(checkout, ...full.split('/'))
    if (lstatSync(absolute).isSymbolicLink()) fail('skill contains a symbolic link: ' + full)
    files.set(rel, readFileSync(absolute))
  }
  return files
}

async function githubTree(source, fetchImpl) {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-skill-market-manifest' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const response = await fetchImpl(url, { headers })
    if (!response.ok) return null
    const json = JSON.parse(await response.text())
    if (json.truncated === true || !Array.isArray(json.tree)) return null
    const prefix = source.path.replace(/\/+$/, '') + '/'
    const paths = []
    for (const item of json.tree) {
      if (item.type !== 'blob' || typeof item.path !== 'string') continue
      if (!item.path.startsWith(prefix)) continue
      if (item.mode === '120000') fail('skill contains a symbolic link: ' + item.path)
      const rel = item.path.slice(prefix.length)
      safeRelativePath(rel, 'file path')
      paths.push(rel)
    }
    return paths.sort()
  } catch {
    return null
  }
}

async function downloadRaw(source, relPath, fetchImpl) {
  const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${source.path}/${relPath}`
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) fail(`download failed for ${url} (HTTP ${response.status})`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  let failure
  const worker = async () => {
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

async function remoteInventory(source, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('no fetch implementation available')
  const listed = await githubTree(source, fetchImpl)
  if (listed !== null) {
    try {
      const pairs = await mapLimit(listed, DOWNLOAD_CONCURRENCY, async (rel) => [rel, await downloadRaw(source, rel, fetchImpl)])
      return new Map(pairs)
    } catch (error) {
      // A flaky raw host must not make the manifest unbuildable; git carries
      // the same bytes over its own transport.
      console.error(`raw downloads failed for ${source.owner}/${source.repo}; falling back to git (${error?.message ?? error})`)
    }
  }
  // GitHub API is rate-limited, truncated, or raw downloads failed.
  return gitInventory(source, options.cacheRoot)
}

function sourceObject(raw, isLocal, localSlug, options) {
  const path = safeRelativePath(raw.path, 'source.path')
  const ref = typeof raw.ref === 'string' && raw.ref.trim() !== '' ? raw.ref.trim() : (options.ref ?? 'main')
  if (ref.includes('..') || ref.startsWith('/') || ref.includes('\\')) fail('source.ref is unsafe')
  if (isLocal) {
    const owner = options.owner ?? localSlug?.owner
    const repo = options.repo ?? localSlug?.repo
    if (owner === undefined || repo === undefined) {
      fail('cannot determine owner/repo for a local skill; pass --owner/--repo')
    }
    return { owner, repo, ref, path }
  }
  const owner = typeof raw.owner === 'string' ? raw.owner : ''
  const repo = typeof raw.repo === 'string' ? raw.repo : ''
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    fail('remote source.owner/source.repo must be plain GitHub names')
  }
  return { owner, repo, ref, path }
}

async function inventoryFor(source, entry, options) {
  if (entry.local === true) {
    const absolute = resolve(options.repoRoot, ...source.path.split('/'))
    const root = resolve(options.repoRoot)
    if (absolute !== root && !absolute.startsWith(root + sep)) fail('local source.path escapes the repository')
    return walkLocal(absolute)
  }
  return remoteInventory(source, options)
}

/**
 * Build the manifest object.
 * @param {object} options - `{ sources, repoRoot, owner?, repo?, ref?, fetchImpl?, cacheRoot? }`.
 * @returns {Promise<{manifest: object, bytes: string}>} validated manifest and its JSON text.
 */
export async function buildManifest(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT)
  const sources = options.sources ?? JSON.parse(readFileSync(options.sourcesPath ?? DEFAULT_SOURCES, 'utf8'))
  if (!isRecord(sources) || !Array.isArray(sources.categories) || !Array.isArray(sources.skills)) {
    fail('source list must carry categories and skills arrays')
  }
  const localSlug = remoteSlug(repoRoot)
  const cacheRoot = options.cacheRoot ?? join(tmpdir(), 'dsh-skill-market-cache')
  mkdirSync(cacheRoot, { recursive: true })

  const categories = []
  for (const raw of sources.categories) {
    if (!isRecord(raw)) fail('category entries must be objects')
    const id = assertKebab(raw.id, 'category.id')
    categories.push({ id, title: readBilingual(raw.title ?? raw.name, `category ${id}.title`) })
  }
  categories.sort((a, b) => compareText(a.id, b.id))

  const seen = new Set()
  const skills = []
  for (const raw of sources.skills) {
    if (!isRecord(raw)) fail('skill entries must be objects')
    const id = assertKebab(raw.id, 'skill.id')
    const name = assertKebab(raw.name, `skill ${id}.name`)
    if (seen.has(id)) fail('duplicate skill id: ' + id)
    seen.add(id)
    const source = sourceObject(raw.source ?? {}, raw.local === true, localSlug, { ...options, repoRoot })
    const filesByName = await inventoryFor(source, raw, { ...options, repoRoot, cacheRoot })
    const files = [...filesByName.entries()]
      .map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length }))
      .sort((a, b) => compareText(a.path, b.path))
    if (files.length === 0) fail(`skill ${id} has no files`)
    for (const file of files) {
      if (!SHA256.test(file.sha256)) fail(`skill ${id} produced an invalid sha256`)
    }
    const requires = readRequires(raw.requires, id)
    skills.push({
      id,
      name,
      title: readBilingual(raw.title ?? { en: name }, `skill ${id}.title`),
      description: readBilingual(raw.description, `skill ${id}.description`),
      category: (() => {
        const category = typeof raw.category === 'string' ? raw.category : ''
        if (!categories.some((entry) => entry.id === category)) fail(`skill ${id}.category is unknown`)
        return category
      })(),
      license: typeof raw.license === 'string' && raw.license.trim() !== '' ? raw.license.trim() : fail(`skill ${id}.license is required`),
      // 空声明不写字段，保持清单与旧生成结果逐字节一致。
      ...(requires.length === 0 ? {} : { requires }),
      source,
      files,
    })
  }
  skills.sort((a, b) => compareText(a.id, b.id))

  const manifest = { schemaVersion: 1, categories, skills }
  return { manifest, bytes: JSON.stringify(manifest, null, 2) + '\n' }
}

/** Serialize and write (or compare) the manifest. */
export async function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => {
    const index = argv.indexOf('--' + name)
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
  }
  const sourcesPath = resolve(arg('sources', DEFAULT_SOURCES))
  const outputPath = resolve(arg('out', DEFAULT_OUTPUT))
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'))
  const { bytes } = await buildManifest({
    sources,
    repoRoot: REPO_ROOT,
    owner: arg('owner', undefined),
    repo: arg('repo', undefined),
    ref: arg('ref', undefined),
    cacheRoot: arg('cache', join(tmpdir(), 'dsh-skill-market-cache')),
  })

  if (argv.includes('--check')) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
    if (current !== bytes) {
      console.error(`manifest drift: ${relative(REPO_ROOT, outputPath)} is not the generated output`)
      process.exitCode = 1
      return 1
    }
    console.log(`manifest up to date: ${relative(REPO_ROOT, outputPath)}`)
    return 0
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, bytes)
  console.log(`wrote ${relative(REPO_ROOT, outputPath)} (${bytes.length} bytes)`)
  return 0
}

const invoked = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error('build-skill-manifest: ' + (error?.message ?? error))
    process.exitCode = 1
  })
}

export { DEFAULT_OUTPUT, DEFAULT_SOURCES, REPO_ROOT }
export const __internal = { remoteSlug, walkLocal, gitInventory, buildManifest }
