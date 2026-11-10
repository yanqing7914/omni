import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseSkillFrontmatter } from './frontmatter.js'
import { KEBAB_ID } from './paths.js'
import type { InstalledSkill } from './types.js'

/** A SKILL.md larger than this is not a skill description; do not read it. */
const MAX_SKILL_BYTES = 1024 * 1024

async function readMeta(path: string): Promise<{ name: string; description: string } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SKILL_BYTES) return null
    const text = await readFile(path, 'utf8')
    const meta = parseSkillFrontmatter(text)
    if (meta === null || !KEBAB_ID.test(meta.name)) return null
    return meta
  } catch {
    return null
  }
}

/**
 * Discover directory-bundle and flat skills directly below one root.
 *
 * Mirrors the engine's filesystem provider: `<root>/<id>/SKILL.md` or
 * `<root>/<id>.md`, with a kebab-case frontmatter name and a description.
 * Anything else is ignored rather than listed and then failing to load.
 */
async function discoverRoot(root: string, source: 'user' | 'bundled'): Promise<InstalledSkill[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const found: InstalledSkill[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (!KEBAB_ID.test(entry.name) || seen.has(entry.name)) continue
      const path = join(root, entry.name, 'SKILL.md')
      const meta = await readMeta(path)
      if (meta === null) continue
      seen.add(entry.name)
      found.push({
        id: entry.name,
        name: meta.name,
        description: meta.description,
        source,
        path: join(root, entry.name),
        removable: source === 'user',
        // The service fills this in after comparing against the market manifest.
        updateAvailable: false,
      })
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const id = basename(entry.name, '.md')
    if (!KEBAB_ID.test(id) || seen.has(id)) continue
    const path = join(root, entry.name)
    const meta = await readMeta(path)
    if (meta === null) continue
    seen.add(id)
    found.push({
      id,
      name: meta.name,
      description: meta.description,
      source,
      path,
      removable: source === 'user',
      // The service fills this in after comparing against the market manifest.
      updateAvailable: false,
    })
  }

  return found
}

/**
 * List installed skills from the writable user root and the read-only bundled
 * root. The bundled root may be absent on a desktop install, which is normal.
 */
export async function scanInstalledRoots(
  userRoot: string,
  bundledRoot: string | undefined,
): Promise<InstalledSkill[]> {
  const bundled = bundledRoot === undefined ? [] : await discoverRoot(bundledRoot, 'bundled')
  const user = await discoverRoot(userRoot, 'user')
  return [...bundled, ...user].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'bundled' ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}
