import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertAllowedUrl } from '../lib/manifest.js'
import { createService } from '../lib/service.js'
import {
  fakeFetch,
  listDir,
  makeManifest,
  makeSkill,
  rawUrl,
  removeDir,
  serviceFor,
  sha256,
  tempDir,
} from './helpers.mjs'

test('S2: install writes the whole directory and verifies every hash', async () => {
  const home = await tempDir()
  try {
    const bytes = {
      'SKILL.md': '---\nname: demo\ndescription: demo skill\n---\n\n# demo\n',
      'scripts/x.py': 'print("x")\n',
      'references/a.md': '# reference\n',
    }
    const skill = makeSkill('demo', bytes)
    const fetched = new Map([...Object.entries(bytes)].map(([path, content]) => [rawUrl(skill, path), Buffer.from(content)]))
    const service = serviceFor({
      dshHome: home,
      manifest: makeManifest([skill]),
      files: fetched,
    })

    const result = await service.install('demo')
    assert.equal(result.status, 'installed')
    assert.equal(result.id, 'demo')

    for (const [path, content] of Object.entries(bytes)) {
      const actual = await readFile(join(home, 'skills', 'demo', ...path.split('/')))
      assert.equal(actual.toString('utf8'), content)
      assert.equal(sha256(actual), sha256(Buffer.from(content)), `${path} hash`)
    }
    const entries = await listDir(join(home, 'skills'))
    assert.ok(entries.includes('demo'))
    assert.ok(!entries.some((name) => name.startsWith('.staging-')), 'staging must be gone')
  } finally {
    await removeDir(home)
  }
})

test('S3: a checksum failure leaves no destination and no staging directory', async () => {
  const home = await tempDir()
  try {
    const bytes = {
      'SKILL.md': '---\nname: broken\ndescription: broken skill\n---\n',
      'scripts/x.py': 'print("expected")\n',
    }
    const skill = makeSkill('broken', bytes)
    const fetched = new Map([...Object.entries(bytes)].map(([path, content]) => [rawUrl(skill, path), Buffer.from(content)]))
    fetched.set(rawUrl(skill, 'scripts/x.py'), Buffer.from('print("tampered")\n'))

    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files: fetched })
    await assert.rejects(() => service.install('broken'), /checksum mismatch|CHECKSUM_MISMATCH/)

    const entries = await listDir(join(home, 'skills'))
    assert.ok(!entries.includes('broken'), 'destination must not exist')
    assert.ok(!entries.some((name) => name.startsWith('.staging-')), 'staging must be cleaned')
  } finally {
    await removeDir(home)
  }
})

test('S5: same content is already-installed; different content needs overwrite', async () => {
  const home = await tempDir()
  try {
    const bytes = {
      'SKILL.md': '---\nname: stable\ndescription: stable skill\n---\n',
      'scripts/x.py': 'print("one")\n',
    }
    const skill = makeSkill('stable', bytes)
    const fetched = new Map([...Object.entries(bytes)].map(([path, content]) => [rawUrl(skill, path), Buffer.from(content)]))
    let downloads = 0
    const fetchImpl = fakeFetch({
      manifest: makeManifest([skill]),
      files: fetched,
      onRequest(url) {
        if (url !== 'https://raw.githubusercontent.com/test/market/main/market/skills.json') downloads += 1
      },
    })
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files: fetched, fetchImpl })

    const first = await service.install('stable')
    assert.equal(first.status, 'installed')
    const before = await stat(join(home, 'skills', 'stable', 'SKILL.md'))
    const downloadsAfterFirst = downloads
    assert.ok(downloadsAfterFirst >= 2, 'both files were downloaded')

    const second = await service.install('stable')
    assert.equal(second.status, 'already-installed')
    const after = await stat(join(home, 'skills', 'stable', 'SKILL.md'))
    assert.equal(after.mtimeMs, before.mtimeMs, 'already-installed must not rewrite')
    assert.equal(downloads, downloadsAfterFirst, 'already-installed must not download')

    // Simulate local drift: an extra file makes the existing tree different.
    await writeFile(join(home, 'skills', 'stable', 'extra.txt'), 'leftover\n')
    await assert.rejects(() => service.install('stable'), /overwrite|ALREADY_EXISTS/)

    const replaced = await service.install('stable', { overwrite: true })
    assert.equal(replaced.status, 'installed')
    const entries = await listDir(join(home, 'skills', 'stable'))
    assert.ok(!entries.includes('extra.txt'), 'old content must not survive overwrite')
    assert.ok(!(await listDir(join(home, 'skills'))).some((name) => name.startsWith('.trash-')), 'trash must be removed')
  } finally {
    await removeDir(home)
  }
})

test('S7: only raw.githubusercontent.com is accepted', async () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://raw.githubusercontent.com/owner/repo/main/x.md'))
  const credentialedUrl = 'https://user:' + 'secret' + '@raw.githubusercontent.com/owner/repo/main/x.md'
  for (const url of [
    'http://raw.githubusercontent.com/owner/repo/main/x.md',
    'https://example.com/x.md',
    'https://raw.githubusercontent.com.evil.test/owner/repo/main/x.md',
    'https://raw.githubusercontent.com:8443/owner/repo/main/x.md',
    credentialedUrl,
  ]) {
    assert.throws(() => assertAllowedUrl(url), /restricted|URL_NOT_ALLOWED/, url)
  }
  assert.throws(
    () => createService({ marketUrl: 'https://example.com/market.json', fetchImpl: fakeFetch({ manifest: makeManifest([]) }) }),
    /restricted|URL_NOT_ALLOWED/,
  )
})

test('S7: a hanging fetch fails inside the budget and cleans staging', async () => {
  const home = await tempDir()
  try {
    const bytes = { 'SKILL.md': '---\nname: slow\ndescription: slow skill\n---\n' }
    const skill = makeSkill('slow', bytes)
    const fetched = new Map([[rawUrl(skill, 'SKILL.md'), Buffer.from(bytes['SKILL.md'])]])
    const target = rawUrl(skill, 'SKILL.md')
    const fetchImpl = fakeFetch({
      manifest: makeManifest([skill]),
      files: fetched,
      hangUrls: new Set([target]),
    })
    const service = serviceFor({
      dshHome: home,
      manifest: makeManifest([skill]),
      files: fetched,
      fetchImpl,
      perFileTimeoutMs: 100,
      totalTimeoutMs: 1000,
      concurrency: 1,
    })

    const started = Date.now()
    // 主地址超时后按设计回落到镜像；假 fetch 没有镜像文件，于是镜像 404 成为最终失败。
    await assert.rejects(() => service.install('slow'), /time budget|INSTALL_TIMEOUT|download failed/i)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `failed in ${elapsed}ms`)
    const entries = await listDir(join(home, 'skills'))
    assert.ok(!entries.includes('slow'))
    assert.ok(!entries.some((name) => name.startsWith('.staging-')), 'staging must be cleaned')
  } finally {
    await removeDir(home)
  }
})

test('S7: the total install budget also bounds a hanging fetch', async () => {
  const home = await tempDir()
  try {
    const bytes = { 'SKILL.md': '---\nname: slow2\ndescription: slow skill\n---\n' }
    const skill = makeSkill('slow2', bytes)
    const fetched = new Map([[rawUrl(skill, 'SKILL.md'), Buffer.from(bytes['SKILL.md'])]])
    const fetchImpl = fakeFetch({
      manifest: makeManifest([skill]),
      files: fetched,
      hangUrls: new Set([rawUrl(skill, 'SKILL.md')]),
    })
    const service = serviceFor({
      dshHome: home,
      manifest: makeManifest([skill]),
      files: fetched,
      fetchImpl,
      perFileTimeoutMs: 5000,
      totalTimeoutMs: 100,
      concurrency: 1,
    })
    const started = Date.now()
    await assert.rejects(() => service.install('slow2'), /time budget|INSTALL_TIMEOUT/)
    assert.ok(Date.now() - started < 2000)
    assert.ok(!(await listDir(join(home, 'skills'))).includes('slow2'))
  } finally {
    await removeDir(home)
  }
})
