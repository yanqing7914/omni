import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { rawFileUrl, parseManifest } from '../lib/manifest.js'
import { installSkill } from '../lib/installer.js'
import { assertSafeRelativePath } from '../lib/paths.js'
import {
  fakeFetch,
  fileEntry,
  listDir,
  makeManifest,
  makeSkill,
  rawUrl,
  removeDir,
  serviceFor,
  sha256,
  tempDir,
} from './helpers.mjs'

test('S4: unsafe ids are rejected before any filesystem work', async () => {
  const home = await tempDir()
  try {
    const skill = makeSkill('safe', { 'SKILL.md': '# safe\n' })
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files: new Map() })
    for (const id of ['../evil', '/absolute', 'Bad_Name', '', 'a'.repeat(65)]) {
      await assert.rejects(
        () => service.install(id),
        (error) => error.code === 'INVALID_ID',
        String(id),
      )
    }
    assert.deepEqual(await listDir(join(home, 'skills')), [])
  } finally {
    await removeDir(home)
  }
})

test('S4: manifest paths with .. or absolute paths are rejected entry-wide', async () => {
  const good = makeSkill('escape', { 'SKILL.md': '# escape\n' })
  for (const path of ['../evil', 'a/../../evil', '/etc/passwd', 'C:evil', 'a\\..\\evil', 'a?b']) {
    const parsed = parseManifest(makeManifest([{ ...good, files: [{ path, sha256: sha256(Buffer.from('x')), size: 1 }] }]))
    assert.equal(parsed.manifest.skills.length, 0, path)
    assert.equal(parsed.rejected.length, 1, path)
    assert.match(parsed.rejected[0].reasons.join(' '), /unsafe path/, path)
  }
  assert.throws(() => assertSafeRelativePath('../evil', 'file path'), /UNSAFE_PATH|safe relative/)
  assert.throws(() => rawFileUrl(good.source, '../evil'), /UNSAFE_PATH|safe relative/)
})

test('S4: a symlinked destination or file entry cannot escape the skill root', async () => {
  const home = await tempDir()
  const outside = await tempDir('skill-market-outside-')
  try {
    await writeFile(join(outside, 'keep.txt'), 'unchanged\n')
    await mkdir(join(home, 'skills'), { recursive: true })
    await symlink(outside, join(home, 'skills', 'evil'))

    const bytes = { 'SKILL.md': '---\nname: evil\ndescription: evil skill\n---\n' }
    const skill = makeSkill('evil', bytes)
    const fetched = new Map([[rawUrl(skill, 'SKILL.md'), Buffer.from(bytes['SKILL.md'])]])
    const service = serviceFor({
      dshHome: home,
      manifest: makeManifest([skill]),
      files: fetched,
    })

    await assert.rejects(() => service.install('evil'), /symbolic link|UNSAFE_PATH/)
    await assert.rejects(() => service.uninstall('evil'), /symbolic link|UNSAFE_PATH/)

    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'unchanged\n')
    assert.deepEqual((await listDir(outside)).sort(), ['keep.txt'])
    assert.ok((await listDir(join(home, 'skills'))).includes('evil'), 'the symlink itself must remain')
    assert.ok(!(await listDir(join(home, 'skills'))).some((name) => name.startsWith('.staging-')))
  } finally {
    await removeDir(home)
    await removeDir(outside)
  }
})

test('S4: a manifest file path cannot produce a file outside the user root', async () => {
  const home = await tempDir()
  const outside = await tempDir('skill-market-outside-')
  try {
    const skill = makeSkill('escape2', {
      'SKILL.md': '# safe\n',
    })
    skill.files = [
      { path: '../outside.txt', sha256: sha256(Buffer.from('should never land\n')), size: 18 },
      fileEntry('SKILL.md', '# safe\n'),
    ]

    // The manifest parser refuses the entry, and the installer refuses the same
    // handcrafted object even if a caller bypasses the parser.
    const parsed = parseManifest(makeManifest([skill]))
    assert.equal(parsed.manifest.skills.length, 0)
    assert.equal(parsed.rejected.length, 1)

    await assert.rejects(
      () => installSkill({
        userRoot: join(home, 'skills'),
        bundledRoot: undefined,
        fetchImpl: fakeFetch({ manifest: makeManifest([]) }),
        now: Date.now,
        perFileTimeoutMs: 1000,
        totalTimeoutMs: 5000,
        concurrency: 1,
      }, skill, false),
      /UNSAFE_PATH|safe relative|URL_NOT_ALLOWED/,
    )

    assert.deepEqual((await listDir(outside)).sort(), [])
    assert.ok(!(await listDir(join(home, 'skills'))).includes('escape2'))
    assert.ok(!(await listDir(join(home, 'skills'))).includes('outside.txt'))
  } finally {
    await removeDir(home)
    await removeDir(outside)
  }
})
