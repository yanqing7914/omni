import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseManifest } from '../lib/manifest.js'
import { makeManifest, makeSkill } from './helpers.mjs'

const valid = makeSkill('good-skill', { 'SKILL.md': '# good\n', 'scripts/x.py': 'print(1)\n' })

test('S1: a valid manifest parses categories and entries', () => {
  const parsed = parseManifest(
    makeManifest([valid], [
      { id: 'writing', title: { en: 'Writing', zh: '写作' } },
      { id: 'test', title: { en: 'Test' } },
    ]),
  )
  assert.equal(parsed.rejected.length, 0)
  assert.equal(parsed.manifest.categories.length, 2)
  assert.equal(parsed.manifest.skills.length, 1)
  assert.equal(parsed.manifest.skills[0].id, 'good-skill')
  assert.equal(parsed.manifest.skills[0].files.length, 2)
  assert.deepEqual(parsed.manifest.skills[0].description, {
    en: 'good-skill description',
    zh: 'good-skill 简介',
  })
})

test('S1: invalid entries are filtered with reasons and the rest survives', () => {
  const badName = { ...makeSkill('bad-name', { 'SKILL.md': '# bad\n' }), name: 'Bad Name' }
  const noDescription = { ...makeSkill('no-description', { 'SKILL.md': '# x\n' }), description: undefined }
  const noSha = {
    ...makeSkill('no-sha', { 'SKILL.md': '# x\n' }),
    files: [{ path: 'SKILL.md', size: 3 }],
  }

  const parsed = parseManifest(makeManifest([valid, badName, noDescription, noSha]))
  assert.equal(parsed.manifest.skills.length, 1, 'only the valid entry survives')
  assert.equal(parsed.manifest.skills[0].id, 'good-skill')

  const byId = new Map(parsed.rejected.map((entry) => [entry.id, entry.reasons.join(' | ')]))
  assert.match(byId.get('bad-name'), /name is not kebab-case/)
  assert.match(byId.get('no-description'), /description is required/)
  assert.match(byId.get('no-sha'), /sha256/)
})

test('S1: a structurally invalid document fails as a whole', () => {
  assert.throws(() => parseManifest({ skills: [] }), /categories and skills/)
  assert.throws(() => parseManifest('nope'), /must be a JSON object/)
})
