// R1/R2: 能力依赖声明 `requires` 的服务端口径。
//
// 解析是「降级不拒绝」：只有未知项被丢弃并记 warning，条目本身仍可用；
// `/list` 与 `/installed` 每条都必须带 requires（缺省 []），已安装项按 id 从清单取。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseManifest } from '../lib/manifest.js'
import {
  buildRoutes,
  makeManifest,
  makeReq,
  makeRes,
  makeSkill,
  rawUrl,
  removeDir,
  serviceFor,
  tempDir,
  writeSkill,
} from './helpers.mjs'

const SKILL_MD = '---\nname: demo\ndescription: demo skill\n---\n'

function routeByPath(routes, path) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route, `route ${path} registered`)
  return route
}

test('R1: valid requires survive; bad shapes drop only the invalid parts with a reason', () => {
  const valid = makeSkill('valid', { 'SKILL.md': SKILL_MD }, { requires: ['a11y', 'shizuku'] })
  const mixed = makeSkill('mixed', { 'SKILL.md': SKILL_MD }, { requires: ['a11y', 'sms', 'a11y'] })
  const notArray = makeSkill('not-array', { 'SKILL.md': SKILL_MD }, { requires: 'a11y' })
  const absent = makeSkill('absent', { 'SKILL.md': SKILL_MD })

  const parsed = parseManifest(makeManifest([valid, mixed, notArray, absent]))

  assert.equal(parsed.rejected.length, 0, 'bad requires never rejects the entry')
  assert.equal(parsed.manifest.skills.length, 4)
  const byId = new Map(parsed.manifest.skills.map((skill) => [skill.id, skill]))

  assert.deepEqual(byId.get('valid').requires, ['a11y', 'shizuku'], 'known values kept in order')
  assert.deepEqual(byId.get('mixed').requires, ['a11y'], 'unknown values and duplicates dropped')
  assert.deepEqual(byId.get('not-array').requires, [], 'non-array degrades to empty')
  assert.deepEqual(byId.get('absent').requires, [], 'missing field defaults to empty')

  const warningById = new Map(parsed.warnings.map((warning) => [warning.id, warning.reasons.join(' | ')]))
  assert.match(warningById.get('mixed'), /unknown capability/)
  assert.match(warningById.get('mixed'), /sms/)
  assert.match(warningById.get('not-array'), /must be an array/)
  assert.equal(warningById.has('valid'), false)
  assert.equal(warningById.has('absent'), false, 'an absent optional field is not a warning')
})

test('R2: /list and /installed every entry carries requires; installed reads the manifest by id', async () => {
  const home = await tempDir()
  const bundled = await tempDir('skill-market-requires-bundled-')
  try {
    const demo = makeSkill('demo', { 'SKILL.md': SKILL_MD }, { requires: ['a11y'] })
    const plain = makeSkill('plain', { 'SKILL.md': SKILL_MD })
    const files = new Map([[rawUrl(demo, 'SKILL.md'), Buffer.from(SKILL_MD)]])
    const service = serviceFor({
      dshHome: home,
      bundledSkillDir: bundled,
      manifest: makeManifest([demo, plain]),
      files,
    })

    await writeSkill(join(home, 'skills'), 'demo')
    await writeSkill(join(home, 'skills'), 'plain')
    await writeSkill(join(home, 'skills'), 'orphan')

    const routes = buildRoutes(service, undefined)
    const listRes = makeRes()
    await routeByPath(routes, '/api/skillmarket/list').handler(makeReq({ method: 'GET' }), listRes)
    assert.equal(listRes.status, 200)
    const list = listRes.json()
    const listById = new Map(list.skills.map((skill) => [skill.id, skill]))
    assert.deepEqual(listById.get('demo').requires, ['a11y'])
    assert.deepEqual(listById.get('plain').requires, [])
    for (const skill of list.skills) {
      assert.ok(Array.isArray(skill.requires), `list entry ${skill.id} carries requires`)
    }

    const installedRes = makeRes()
    await routeByPath(routes, '/api/skillmarket/installed').handler(makeReq({ method: 'GET' }), installedRes)
    assert.equal(installedRes.status, 200)
    const installed = installedRes.json()
    const installedById = new Map(installed.map((skill) => [skill.id, skill]))
    assert.deepEqual(installedById.get('demo').requires, ['a11y'])
    assert.deepEqual(installedById.get('plain').requires, [])
    assert.deepEqual(installedById.get('orphan').requires, [], 'id absent from the manifest is empty')
    for (const skill of installed) {
      assert.ok(Array.isArray(skill.requires), `installed entry ${skill.id} carries requires`)
    }
  } finally {
    await removeDir(home)
    await removeDir(bundled)
  }
})
