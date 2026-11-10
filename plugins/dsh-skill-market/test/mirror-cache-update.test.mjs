// M1-M6: manifest/file mirror fallback, disk cache, update detection and
// in-place overwrite. Like the rest of the suite these tests never touch the
// network: every response comes from a scripted in-memory fetch.
import assert from 'node:assert/strict'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { installSkill } from '../lib/installer.js'
import { assertAllowedUrl, parseManifest } from '../lib/manifest.js'
import { createService } from '../lib/service.js'
import {
  buildRoutes,
  listDir,
  makeManifest,
  makeReq,
  makeRes,
  makeSkill,
  rawUrl,
  removeDir,
  response,
  serviceFor,
  tempDir,
  writeSkill,
} from './helpers.mjs'

const OWNER = 'test'
const REPO = 'market'

const manifestRaw = (ref) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${ref}/market/skills.json`
const manifestMirror = (ref) => `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${ref}/market/skills.json`
const MAIN_RAW = manifestRaw('main')
const MAIN_MIRROR = manifestMirror('main')
const DEV_RAW = manifestRaw('dev')
const DEV_MIRROR = manifestMirror('dev')

function fileMirrorUrl(skill, filePath) {
  return `https://cdn.jsdelivr.net/gh/${skill.source.owner}/${skill.source.repo}@${skill.source.ref}/${skill.source.path}/${filePath}`
}

/** The raw URL a skill's file would have at an arbitrary ref. */
function fileUrlAtRef(skill, ref, filePath) {
  return `https://raw.githubusercontent.com/${skill.source.owner}/${skill.source.repo}/${ref}/${skill.source.path}/${filePath}`
}

/** Tiny scripted fetch: each key maps to a response, 'reject' or 'hang'. */
function fetchScript(handlers) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const handler = handlers[url]
    if (handler === undefined) return response('not found', 404)
    if (handler === 'reject') throw new Error('connect ECONNREFUSED')
    if (handler === 'hang') return new Promise(() => {})
    return handler
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function serviceWith(options) {
  return createService({
    owner: OWNER,
    repo: REPO,
    ref: 'main',
    bundledSkillDir: null,
    ...options,
  })
}

function manifestResponse(skills) {
  return response(JSON.stringify(makeManifest(skills)))
}

function demoFixture() {
  const bytes = {
    'SKILL.md': '---\nname: demo\ndescription: demo skill\n---\n\n# demo\n',
    'scripts/x.py': 'print("x")\n',
  }
  const skill = makeSkill('demo', bytes)
  const files = new Map(
    Object.entries(bytes).map(([path, content]) => [rawUrl(skill, path), Buffer.from(content)]),
  )
  return { bytes, skill, files }
}

async function withHome(work) {
  const home = await tempDir()
  try {
    return await work(home)
  } finally {
    await removeDir(home)
  }
}

// ---------------------------------------------------------------------------
// M1: manifest candidates

test('M1: main answers -> main is used and no stale fields appear', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const fetchImpl = fetchScript({ [MAIN_RAW]: manifestResponse([skill]) })
    const service = serviceWith({ dshHome: home, fetchImpl })
    const list = await service.list()

    assert.equal(list.skills.length, 1)
    assert.equal(list.skills[0].id, 'demo')
    assert.equal(list.skills[0].updateAvailable, false)
    assert.deepEqual(fetchImpl.calls, [MAIN_RAW])
    assert.equal(list.stale, undefined)
    assert.ok(!('savedAt' in list), 'savedAt must be absent on the normal path')
  })
})

test('M1: main 404 falls back to the dev branch', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const fetchImpl = fetchScript({
      [MAIN_RAW]: response('not found', 404),
      [MAIN_MIRROR]: response('not found', 404),
      [DEV_RAW]: manifestResponse([skill]),
    })
    const service = serviceWith({ dshHome: home, fetchImpl })
    const list = await service.list()

    assert.equal(list.skills[0].id, 'demo')
    assert.deepEqual(fetchImpl.calls, [MAIN_RAW, MAIN_MIRROR, DEV_RAW])
    assert.equal(list.stale, undefined)
  })
})

test('M1: all candidates fail with a cache -> stale result equal to the cache', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const fresh = serviceWith({
      dshHome: home,
      fetchImpl: fetchScript({ [MAIN_RAW]: manifestResponse([skill]) }),
    })
    const original = await fresh.list()

    const offlineFetch = fetchScript({
      [MAIN_RAW]: 'reject',
      [MAIN_MIRROR]: 'reject',
      [DEV_RAW]: 'reject',
      [DEV_MIRROR]: 'reject',
    })
    const offline = serviceWith({ dshHome: home, fetchImpl: offlineFetch })
    const stale = await offline.list()

    assert.equal(stale.stale, true)
    assert.equal(typeof stale.savedAt, 'number')
    assert.deepEqual(stale.skills, original.skills)
    assert.deepEqual(stale.categories, original.categories)
    assert.deepEqual(stale.rejected, original.rejected)
  })
})

test('M1: all candidates fail without a cache -> MARKET_UNAVAILABLE', async () => {
  await withHome(async (home) => {
    const offlineFetch = fetchScript({
      [MAIN_RAW]: 'reject',
      [MAIN_MIRROR]: 'reject',
      [DEV_RAW]: 'reject',
      [DEV_MIRROR]: 'reject',
    })
    const service = serviceWith({ dshHome: home, fetchImpl: offlineFetch })
    await assert.rejects(() => service.list(), (error) => error.code === 'MARKET_UNAVAILABLE')
  })
})

// ---------------------------------------------------------------------------
// M2: transport failures use the mirror; 404 does not

test('M2: the manifest falls back to jsDelivr when the primary rejects', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const fetchImpl = fetchScript({
      [MAIN_RAW]: 'reject',
      [MAIN_MIRROR]: manifestResponse([skill]),
    })
    const service = serviceWith({ dshHome: home, fetchImpl })
    const list = await service.list()

    assert.equal(list.skills[0].id, 'demo')
    assert.deepEqual(fetchImpl.calls, [MAIN_RAW, MAIN_MIRROR])
  })
})

test('M2: the manifest falls back to jsDelivr when the primary times out', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const fetchImpl = fetchScript({
      [MAIN_RAW]: 'hang',
      [MAIN_MIRROR]: manifestResponse([skill]),
    })
    const service = serviceWith({ dshHome: home, fetchImpl, manifestTimeoutMs: 100 })
    const started = Date.now()
    const list = await service.list()

    assert.equal(list.skills[0].id, 'demo')
    assert.deepEqual(fetchImpl.calls, [MAIN_RAW, MAIN_MIRROR])
    assert.ok(Date.now() - started < 2000)
  })
})

test('M2: both manifest entry points failing rejects without a partial result', async () => {
  await withHome(async (home) => {
    const fetchImpl = fetchScript({
      [MAIN_RAW]: 'reject',
      [MAIN_MIRROR]: 'reject',
      [DEV_RAW]: 'reject',
      [DEV_MIRROR]: 'reject',
    })
    const service = serviceWith({ dshHome: home, fetchImpl })
    await assert.rejects(() => service.list(), (error) => error.code === 'MARKET_UNAVAILABLE')
    assert.deepEqual(await listDir(join(home, 'skills')), [])
  })
})

test('M2: file downloads fall back to jsDelivr when the primary rejects', async () => {
  await withHome(async (home) => {
    const { bytes, skill, files } = demoFixture()
    const handlers = { [MAIN_RAW]: manifestResponse([skill]) }
    for (const [url, content] of files) handlers[url] = 'reject'
    for (const path of Object.keys(bytes)) {
      handlers[fileMirrorUrl(skill, path)] = response(files.get(rawUrl(skill, path)))
    }
    const fetchImpl = fetchScript(handlers)
    const service = serviceWith({ dshHome: home, fetchImpl })

    const result = await service.install('demo')
    assert.equal(result.status, 'installed')
    for (const [path, content] of Object.entries(bytes)) {
      const actual = await readFile(join(home, 'skills', 'demo', ...path.split('/')))
      assert.equal(actual.toString('utf8'), content)
    }
    for (const path of Object.keys(bytes)) {
      assert.ok(fetchImpl.calls.includes(fileMirrorUrl(skill, path)), `${path} mirror attempted`)
    }
  })
})

test('M2: both file entry points failing rejects and writes nothing', async () => {
  await withHome(async (home) => {
    const { bytes, skill } = demoFixture()
    const handlers = { [MAIN_RAW]: manifestResponse([skill]) }
    for (const filePath of Object.keys(bytes)) {
      handlers[rawUrl(skill, filePath)] = 'reject'
      handlers[fileMirrorUrl(skill, filePath)] = 'reject'
    }
    const fetchImpl = fetchScript(handlers)
    const service = serviceWith({ dshHome: home, fetchImpl })

    await assert.rejects(() => service.install('demo'), /download failed/i)
    const entries = await listDir(join(home, 'skills'))
    assert.ok(!entries.includes('demo'), 'destination must not exist')
    assert.ok(!entries.some((name) => name.startsWith('.staging-')), 'staging must be cleaned')
  })
})

// ---------------------------------------------------------------------------
// M3: URL whitelist and escaping sources

test('M3: non-whitelisted origins and lookalike hosts are refused', async () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://raw.githubusercontent.com/owner/repo/main/x.md'))
  assert.doesNotThrow(() => assertAllowedUrl('https://cdn.jsdelivr.net/gh/owner/repo@main/x.md'))
  for (const url of [
    'http://cdn.jsdelivr.net/gh/owner/repo@main/x.md',
    'https://cdn.jsdelivr.net.evil.test/gh/owner/repo@main/x.md',
    'https://raw.githubusercontent.com.evil.test/owner/repo/main/x.md',
    'https://evil.example/owner/repo/main/x.md',
    'https://user:' + 'secret' + '@cdn.jsdelivr.net/gh/owner/repo@main/x.md',
    'https://cdn.jsdelivr.net:8443/gh/owner/repo@main/x.md',
  ]) {
    assert.throws(() => assertAllowedUrl(url), (error) => error.code === 'URL_NOT_ALLOWED', url)
  }
  assert.throws(
    () => createService({ marketUrl: 'https://evil.example/market.json', fetchImpl: fetchScript({}) }),
    (error) => error.code === 'URL_NOT_ALLOWED',
  )
})

test('M3: a manifest source that escapes its path writes no files', async () => {
  await withHome(async (home) => {
    const files = { 'SKILL.md': '# escape\n' }
    const escaping = makeSkill('escape', files)
    const badManifest = makeManifest([
      { ...escaping, source: { ...escaping.source, path: '../outside' } },
    ])
    const parsed = parseManifest(badManifest)
    assert.equal(parsed.manifest.skills.length, 0)
    assert.match(parsed.rejected[0].reasons.join(' '), /source\.path/)

    const service = serviceWith({
      dshHome: home,
      fetchImpl: fetchScript({ [MAIN_RAW]: response(JSON.stringify(badManifest)) }),
    })
    const list = await service.list()
    assert.equal(list.skills.length, 0, 'the escaping entry is not served')
    await assert.rejects(() => service.install('escape'), (error) => error.code === 'SKILL_NOT_FOUND')
    assert.deepEqual(await listDir(join(home, 'skills')), [])
  })
})

test('M3: a handcrafted source cannot produce a non-whitelisted URL', async () => {
  await withHome(async (home) => {
    const skill = makeSkill('escape2', { 'SKILL.md': '# escape\n' })
    skill.source = { owner: 'test', repo: 'market', ref: '../evil', path: 'skills/escape2' }

    await assert.rejects(
      () => installSkill({
        userRoot: join(home, 'skills'),
        bundledRoot: undefined,
        fetchImpl: fetchScript({}),
        now: Date.now,
        perFileTimeoutMs: 1000,
        totalTimeoutMs: 5000,
        concurrency: 1,
      }, skill, false),
      (error) => error.code === 'URL_NOT_ALLOWED' || error.code === 'UNSAFE_PATH',
    )
    assert.deepEqual(await listDir(join(home, 'skills')), [])
  })
})

// ---------------------------------------------------------------------------
// M4: disk cache

test('M4: a successful fetch writes a parseable cache file', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const service = serviceWith({
      dshHome: home,
      fetchImpl: fetchScript({ [MAIN_RAW]: manifestResponse([skill]) }),
    })
    await service.list()

    const record = JSON.parse(await readFile(join(home, 'market', 'cache.json'), 'utf8'))
    assert.equal(typeof record.savedAt, 'number')
    assert.equal(record.sourceUrl, MAIN_RAW)
    assert.equal(record.manifest.skills[0].id, 'demo')
    assert.equal(record.manifest.skills[0].files.length, skill.files.length)
    assert.deepEqual(
      (await listDir(join(home, 'market'))).filter((name) => name.endsWith('.tmp')),
      [],
      'no temporary cache file is left behind',
    )
  })
})

test('M4: offline with a cache returns stale with complete entries', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const online = serviceWith({
      dshHome: home,
      fetchImpl: fetchScript({ [MAIN_RAW]: manifestResponse([skill]) }),
    })
    const fresh = await online.list()

    const offline = serviceWith({
      dshHome: home,
      fetchImpl: fetchScript({
        [MAIN_RAW]: 'reject',
        [MAIN_MIRROR]: 'reject',
        [DEV_RAW]: 'reject',
        [DEV_MIRROR]: 'reject',
      }),
    })
    const stale = await offline.list()
    assert.equal(stale.stale, true)
    assert.equal(typeof stale.savedAt, 'number')
    assert.equal(stale.skills.length, fresh.skills.length)
    assert.deepEqual(stale.skills[0].files, fresh.skills[0].files)
    assert.equal(stale.skills[0].description.zh, fresh.skills[0].description.zh)
  })
})

test('M4: a truncated or structurally invalid cache is ignored and the call fails cleanly', async () => {
  for (const cacheText of [
    '{"savedAt":1,"sourceUrl":"https://raw.githubusercontent.com/x", "manifest": {"skills": [',
    JSON.stringify({ savedAt: 'yesterday', sourceUrl: MAIN_RAW, manifest: { categories: [], skills: [] } }),
    JSON.stringify({ savedAt: 1, sourceUrl: MAIN_RAW, manifest: { skills: [] } }),
  ]) {
    await withHome(async (home) => {
      await mkdir(join(home, 'market'), { recursive: true })
      await writeFile(join(home, 'market', 'cache.json'), cacheText)
      const service = serviceWith({
        dshHome: home,
        fetchImpl: fetchScript({
          [MAIN_RAW]: 'reject',
          [MAIN_MIRROR]: 'reject',
          [DEV_RAW]: 'reject',
          [DEV_MIRROR]: 'reject',
        }),
      })
      await assert.rejects(() => service.list(), (error) => error.code === 'MARKET_UNAVAILABLE')
    })
  }
})

// ---------------------------------------------------------------------------
// M5: update detection

test('M5: an installed directory identical to the manifest is up to date', async () => {
  await withHome(async (home) => {
    const { skill, files } = demoFixture()
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
    await service.install('demo')

    const entry = (await service.installed()).find((item) => item.id === 'demo')
    assert.equal(entry.updateAvailable, false)
    const list = await service.list()
    assert.equal(list.skills[0].updateAvailable, false)
  })
})

test('M5: a changed byte, a missing file or an extra file marks an update', async () => {
  const mutations = [
    ['changed byte', async (home) => writeFile(join(home, 'skills', 'demo', 'scripts', 'x.py'), 'print("y")\n')],
    ['missing file', async (home) => unlink(join(home, 'skills', 'demo', 'scripts', 'x.py'))],
    ['extra file', async (home) => writeFile(join(home, 'skills', 'demo', 'extra.txt'), 'leftover\n')],
  ]
  for (const [label, mutate] of mutations) {
    await withHome(async (home) => {
      const { skill, files } = demoFixture()
      const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
      await service.install('demo')

      const clean = (await service.installed()).find((item) => item.id === 'demo')
      assert.equal(clean.updateAvailable, false, `${label}: clean install`)

      await mutate(home)
      const drifted = (await service.installed()).find((item) => item.id === 'demo')
      assert.equal(drifted.updateAvailable, true, label)
      const list = await service.list()
      assert.equal(list.skills[0].updateAvailable, true, `${label}: list`)
    })
  }
})

test('M5: bundled and manifest-unknown skills never report an update', async () => {
  await withHome(async (home) => {
    const bundled = await tempDir('skill-market-bundled-')
    try {
      await writeSkill(bundled, 'beta')
      await writeSkill(join(home, 'skills'), 'local')
      const beta = makeSkill('beta', { 'SKILL.md': '# deliberately different\n' })
      const service = serviceFor({
        dshHome: home,
        bundledSkillDir: bundled,
        manifest: makeManifest([beta]),
        files: new Map(),
      })

      const installed = await service.installed()
      const betaEntry = installed.find((item) => item.id === 'beta')
      assert.equal(betaEntry.source, 'bundled')
      assert.equal(betaEntry.updateAvailable, false, 'bundled is always false')
      const local = installed.find((item) => item.id === 'local')
      assert.equal(local.updateAvailable, false, 'not in the manifest')

      const list = await service.list()
      assert.equal(list.skills.find((item) => item.id === 'beta').updateAvailable, false)
    } finally {
      await removeDir(bundled)
    }
  })
})

test('M5: the installed route exposes updateAvailable on every entry', async () => {
  await withHome(async (home) => {
    const { skill, files } = demoFixture()
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
    await service.install('demo')
    const routes = buildRoutes(service, undefined)
    const route = routes.find((entry) => entry.path === '/api/skillmarket/installed')
    const res = makeRes()
    await route.handler(makeReq({ method: 'GET' }), res)

    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body[0].updateAvailable, false)
    assert.equal(typeof body[0].updateAvailable, 'boolean')
  })
})

// ---------------------------------------------------------------------------
// M6: in-place overwrite

test('M6: overwriting a drifted user skill makes it up to date', async () => {
  await withHome(async (home) => {
    const { skill, files } = demoFixture()
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
    await service.install('demo')
    await writeFile(join(home, 'skills', 'demo', 'scripts', 'x.py'), 'print("drifted")\n')

    assert.equal((await service.installed()).find((item) => item.id === 'demo').updateAvailable, true)
    const result = await service.install('demo', { overwrite: true })
    assert.equal(result.status, 'installed')
    assert.equal((await service.installed()).find((item) => item.id === 'demo').updateAvailable, false)
    assert.equal((await service.list()).skills[0].updateAvailable, false)
  })
})

test('M6: overwriting a bundled skill is rejected and leaves it untouched', async () => {
  await withHome(async (home) => {
    const bundled = await tempDir('skill-market-bundled-')
    try {
      const bundledPath = await writeSkill(bundled, 'beta')
      const before = await readFile(join(bundledPath, 'SKILL.md'), 'utf8')
      const beta = makeSkill('beta', { 'SKILL.md': '---\nname: beta\ndescription: beta\n---\n' })
      const service = serviceFor({
        dshHome: home,
        bundledSkillDir: bundled,
        manifest: makeManifest([beta]),
        files: new Map(),
      })

      await assert.rejects(
        () => service.install('beta', { overwrite: true }),
        (error) => error.code === 'BUNDLED_NOT_REMOVABLE',
      )
      assert.equal(await readFile(join(bundledPath, 'SKILL.md'), 'utf8'), before)
      assert.ok(!(await listDir(join(home, 'skills'))).includes('beta'), 'no user copy is created')

      // The HTTP layer must report the same rejection as a 400.
      const routes = buildRoutes(service, undefined)
      const route = routes.find((entry) => entry.path === '/api/skillmarket/install')
      const res = makeRes()
      await route.handler(
        makeReq({ method: 'POST', body: JSON.stringify({ id: 'beta', overwrite: true }) }),
        res,
      )
      assert.equal(res.status, 400)
      assert.equal(res.json().code, 'BUNDLED_NOT_REMOVABLE')
    } finally {
      await removeDir(bundled)
    }
  })
})

test('M6: uninstall still refuses bundled skills', async () => {
  await withHome(async (home) => {
    const bundled = await tempDir('skill-market-bundled-')
    try {
      await writeSkill(bundled, 'beta')
      const service = serviceFor({
        dshHome: home,
        bundledSkillDir: bundled,
        manifest: makeManifest([]),
        files: new Map(),
      })
      await assert.rejects(
        () => service.uninstall('beta'),
        (error) => error.code === 'BUNDLED_NOT_REMOVABLE',
      )
    } finally {
      await removeDir(bundled)
    }
  })
})

// ---------------------------------------------------------------------------
// M7: branch fallback for files of mutable `main` refs

test('M7: a main-ref file missing on main is fetched from the dev branch', async () => {
  await withHome(async (home) => {
    const { bytes, skill } = demoFixture()
    assert.equal(skill.source.ref, 'main')
    const handlers = { [MAIN_RAW]: manifestResponse([skill]) }
    // main file URLs are absent from the map, so they answer 404.
    for (const [filePath, content] of Object.entries(bytes)) {
      handlers[fileUrlAtRef(skill, 'dev', filePath)] = response(content)
    }
    const fetchImpl = fetchScript(handlers)
    const service = serviceWith({ dshHome: home, fetchImpl })

    const result = await service.install('demo')
    assert.equal(result.status, 'installed')
    for (const [filePath, content] of Object.entries(bytes)) {
      const actual = await readFile(join(home, 'skills', 'demo', ...filePath.split('/')))
      assert.equal(actual.toString('utf8'), content, `${filePath} came from dev`)
      assert.ok(fetchImpl.calls.includes(fileUrlAtRef(skill, 'dev', filePath)))
    }
    assert.ok(!fetchImpl.calls.some((url) => url.includes('cdn.jsdelivr.net')), 'a 404 does not try the mirror')
  })
})

test('M7: a commit-pinned ref never falls back and leaves no partial install', async () => {
  await withHome(async (home) => {
    const { skill } = demoFixture()
    const pinned = { ...skill, source: { ...skill.source, ref: '0123456789abcdef' } }
    // No file handler exists, so every file request answers 404.
    const fetchImpl = fetchScript({ [MAIN_RAW]: manifestResponse([pinned]) })
    const service = serviceWith({ dshHome: home, fetchImpl })

    await assert.rejects(
      () => service.install('demo'),
      (error) => error.code === 'DOWNLOAD_FAILED' && error.httpStatus === 404,
    )
    assert.ok(!fetchImpl.calls.some((url) => url.includes('/dev/')), 'a pinned ref must not try dev')
    const entries = await listDir(join(home, 'skills'))
    assert.ok(!entries.includes('demo'), 'destination must not exist')
    assert.ok(!entries.some((name) => name.startsWith('.staging-')), 'staging must be cleaned')
  })
})
