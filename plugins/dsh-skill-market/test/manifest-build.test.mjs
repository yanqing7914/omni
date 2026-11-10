import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../lib/manifest.js'
import { removeDir, tempDir } from './helpers.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SCRIPT = resolve(HERE, '..', '..', '..', 'scripts', 'market', 'build-skill-manifest.mjs')
const { buildManifest } = await import(SCRIPT)

function fixtureSources() {
  return {
    schemaVersion: 1,
    categories: [
      { id: 'writing', title: { en: 'Writing', zh: '写作' } },
      { id: 'docs', title: { en: 'Documents', zh: '文档' } },
    ],
    skills: [
      {
        id: 'zulu',
        name: 'zulu',
        title: { en: 'Zulu', zh: 'Zulu' },
        description: { en: 'zulu entry', zh: 'zulu 条目' },
        category: 'writing',
        license: 'MIT',
        local: true,
        source: { ref: 'main', path: 'skills/zulu' },
      },
      {
        id: 'alpha',
        name: 'alpha',
        title: { en: 'Alpha', zh: 'Alpha' },
        description: { en: 'alpha entry', zh: 'alpha 条目' },
        category: 'docs',
        license: 'MIT',
        local: true,
        source: { ref: 'main', path: 'skills/alpha' },
      },
    ],
  }
}

async function prepareRepo() {
  const repo = await tempDir('skill-market-repo-')
  mkdirSync(join(repo, 'skills', 'zulu', 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'zulu', 'SKILL.md'), '---\nname: zulu\ndescription: zulu\n---\n')
  writeFileSync(join(repo, 'skills', 'zulu', 'scripts', 'x.py'), 'print("z")\n')
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha\n---\n')
  return repo
}

test('S9: building the manifest twice over the same input is byte-identical', async () => {
  const repo = await prepareRepo()
  try {
    const options = { sources: fixtureSources(), repoRoot: repo, owner: 'acme', repo: 'fixture', ref: 'main' }
    const first = await buildManifest(options)
    const second = await buildManifest(options)
    assert.equal(first.bytes, second.bytes)

    const parsed = parseManifest(JSON.parse(first.bytes))
    assert.equal(parsed.rejected.length, 0)
    assert.equal(parsed.manifest.skills.length, 2)

    // Input order is irrelevant: skills and files are sorted in the output.
    const reversed = fixtureSources()
    reversed.skills.reverse()
    const third = await buildManifest({ ...options, sources: reversed })
    assert.equal(third.bytes, first.bytes)

    assert.deepEqual(parsed.manifest.skills.map((skill) => skill.id), ['alpha', 'zulu'])
    assert.deepEqual(parsed.manifest.skills.find((skill) => skill.id === 'zulu').files.map((file) => file.path), [
      'SKILL.md',
      'scripts/x.py',
    ])
  } finally {
    await removeDir(repo)
  }
})

test('S9: the CLI writes byte-identical output on repeated runs', async () => {
  const work = await tempDir('skill-market-cli-')
  try {
    const sourcesPath = join(work, 'sources.json')
    const sources = fixtureSources()
    sources.skills = [{
      id: 'git-commit-message',
      name: 'git-commit-message',
      title: { en: 'Git Commit Message', zh: 'Git 提交说明' },
      description: { en: 'commit messages', zh: '提交说明' },
      category: 'writing',
      license: 'MIT',
      local: true,
      source: { ref: 'main', path: 'market/skills/git-commit-message' },
    }]
    writeFileSync(sourcesPath, JSON.stringify(sources))
    const outA = join(work, 'a.json')
    const outB = join(work, 'b.json')

    for (const out of [outA, outB]) {
      const result = spawnSync(process.execPath, [SCRIPT, '--sources', sourcesPath, '--out', out], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(readFileSync(outA, 'utf8'), readFileSync(outB, 'utf8'))
  } finally {
    await removeDir(work)
  }
})
