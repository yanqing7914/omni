// Shared fakes for the skill-market tests. No test touches the real network:
// every manifest and file response is served by an in-memory fetch function.
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createService } from '../lib/service.js'
import { registerSkillMarketRoutes } from '../lib/index.js'

export const MARKET_URL = 'https://raw.githubusercontent.com/test/market/main/market/skills.json'
export const SOURCE = { owner: 'test', repo: 'market', ref: 'main', path: 'skills' }

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function bytesOf(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

export function fileEntry(path, value) {
  const bytes = bytesOf(value)
  return { path, sha256: sha256(bytes), size: bytes.length }
}

export function sourceFor(id, overrides = {}) {
  return { owner: SOURCE.owner, repo: SOURCE.repo, ref: SOURCE.ref, path: `${SOURCE.path}/${id}`, ...overrides }
}

export function makeSkill(id, files, overrides = {}) {
  const fileMap = files instanceof Map ? files : new Map(Object.entries(files))
  return {
    id,
    name: id,
    title: { en: id, zh: id },
    description: { en: `${id} description`, zh: `${id} 简介` },
    category: 'test',
    license: 'MIT',
    source: sourceFor(id),
    files: [...fileMap.entries()].map(([path, bytes]) => fileEntry(path, bytes)),
    ...overrides,
  }
}

export function makeManifest(skills, categories = [{ id: 'test', title: { en: 'Test', zh: '测试' } }]) {
  return { schemaVersion: 1, categories, skills }
}

export function rawUrl(skill, filePath) {
  return `https://raw.githubusercontent.com/${skill.source.owner}/${skill.source.repo}/${skill.source.ref}/${skill.source.path}/${filePath}`
}

export function response(bytes, status = 200) {
  const buffer = bytesOf(bytes)
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
    async text() {
      return buffer.toString('utf8')
    },
  }
}

/**
 * Build a fake fetch from a manifest plus a file map.
 * `files` keys are raw URLs (use rawUrl(skill, path)); values are file bytes.
 * `hangUrls` returns a promise that never settles and ignores the abort signal.
 */
export function fakeFetch({ manifest, files = new Map(), hangUrls = new Set(), onRequest }) {
  return async (url, init) => {
    if (typeof onRequest === 'function') onRequest(url, init)
    if (url === MARKET_URL) {
      if (hangUrls.has(url)) return new Promise(() => {})
      return response(JSON.stringify(manifest))
    }
    if (hangUrls.has(url)) return new Promise(() => {})
    if (files.has(url)) return response(files.get(url))
    return response('not found', 404)
  }
}

export async function tempDir(prefix = 'skill-market-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true })
}

export function serviceFor({ manifest, files, dshHome, bundledSkillDir = null, fetchImpl, now, ...options }) {
  return createService({
    dshHome,
    bundledSkillDir,
    marketUrl: MARKET_URL,
    fetchImpl: fetchImpl ?? fakeFetch({ manifest, files }),
    ...(now === undefined ? {} : { now }),
    ...options,
  })
}

export async function writeSkill(root, id, { name = id, description = `${id} description`, body = '# ' + id } = {}) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
  return dir
}

export async function writeFlatSkill(root, id, { name = id, description = `${id} description` } = {}) {
  await mkdir(root, { recursive: true })
  const file = join(root, `${id}.md`)
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${id}\n`)
  return file
}

export function fakeCtx(rejection) {
  const routes = []
  const ctx = {
    get(name) {
      if (name !== 'connection') return undefined
      return { requestRejection: () => rejection }
    },
    webServer: {
      register(route) {
        routes.push(route)
      },
    },
  }
  return { ctx, routes }
}

export function buildRoutes(service, rejection) {
  const { ctx, routes } = fakeCtx(rejection)
  registerSkillMarketRoutes(ctx, service)
  return routes
}

export function makeReq({ method = 'POST', body } = {}) {
  const chunks = body === undefined ? [] : [bytesOf(body)]
  return {
    method,
    url: '/',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

export function makeRes() {
  let status
  let headers
  let body = ''
  return {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      headers = nextHeaders
    },
    end(value) {
      body = value === undefined ? '' : String(value)
    },
    get status() {
      return status
    },
    get headers() {
      return headers ?? {}
    },
    get body() {
      return body
    },
    json() {
      return JSON.parse(body)
    },
  }
}

export async function listDir(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

export function parentOf(path) {
  return dirname(path)
}
