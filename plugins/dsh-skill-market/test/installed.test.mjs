import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  makeManifest,
  removeDir,
  serviceFor,
  tempDir,
  writeFlatSkill,
  writeSkill,
} from './helpers.mjs'

test('S10: user and bundled roots are both listed with the right source and removability', async () => {
  const home = await tempDir()
  const bundled = await tempDir('skill-market-bundled-')
  try {
    await writeSkill(join(home, 'skills'), 'alpha', { description: 'alpha from user' })
    await writeFlatSkill(join(home, 'skills'), 'gamma', { description: 'gamma flat skill' })
    await writeSkill(bundled, 'beta', { description: 'beta from the engine' })

    const service = serviceFor({
      dshHome: home,
      bundledSkillDir: bundled,
      manifest: makeManifest([]),
      files: new Map(),
    })

    const installed = await service.installed()
    assert.equal(installed.length, 3)

    const alpha = installed.find((entry) => entry.id === 'alpha')
    assert.ok(alpha)
    assert.equal(alpha.source, 'user')
    assert.equal(alpha.removable, true)
    assert.equal(alpha.description, 'alpha from user')
    assert.equal(alpha.path, join(home, 'skills', 'alpha'))

    const beta = installed.find((entry) => entry.id === 'beta')
    assert.ok(beta)
    assert.equal(beta.source, 'bundled')
    assert.equal(beta.removable, false)
    assert.equal(beta.description, 'beta from the engine')
    assert.equal(beta.path, join(bundled, 'beta'))

    const gamma = installed.find((entry) => entry.id === 'gamma')
    assert.ok(gamma)
    assert.equal(gamma.source, 'user')
    assert.equal(gamma.removable, true)
    assert.equal(gamma.path, join(home, 'skills', 'gamma.md'))
  } finally {
    await removeDir(home)
    await removeDir(bundled)
  }
})
