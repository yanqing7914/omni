import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { listDir, makeManifest, removeDir, serviceFor, tempDir, writeSkill } from './helpers.mjs'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('S6: a user skill is removed; a bundled skill is refused; unknown ids are explicit', async () => {
  const home = await tempDir()
  const bundled = await tempDir('skill-market-bundled-')
  try {
    await writeSkill(join(home, 'skills'), 'alpha')
    await writeSkill(bundled, 'beta')
    const service = serviceFor({
      dshHome: home,
      bundledSkillDir: bundled,
      manifest: makeManifest([]),
      files: new Map(),
    })

    await service.uninstall('alpha')
    assert.equal(await exists(join(home, 'skills', 'alpha')), false, 'user skill removed')

    await assert.rejects(
      () => service.uninstall('beta'),
      (error) => error.code === 'BUNDLED_NOT_REMOVABLE',
    )
    assert.equal(await exists(join(bundled, 'beta', 'SKILL.md')), true, 'bundled skill remains')

    await assert.rejects(
      () => service.uninstall('missing'),
      (error) => error.code === 'NOT_INSTALLED',
    )
    assert.deepEqual(await listDir(join(home, 'skills')), [])
  } finally {
    await removeDir(home)
    await removeDir(bundled)
  }
})
