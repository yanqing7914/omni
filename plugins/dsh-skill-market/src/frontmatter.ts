/**
 * Minimal YAML frontmatter reader for SKILL.md.
 *
 * The skill format is intentionally small: a leading `---` fence, `key: value`
 * scalars, and the occasional `|`/`>` block for a long description. This parser
 * covers exactly that surface and returns only the two fields the installed
 * listing needs. Malformed frontmatter yields `null` rather than a partial
 * record, so a directory the engine would reject is not advertised as a skill.
 */

export interface SkillDocumentMeta {
  name: string
  description: string
}

/** Remove one layer of YAML quotes and decode the escapes we actually see. */
function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * Parse SKILL.md frontmatter.
 * @param text - full file contents.
 * @returns `{name, description}` only when both are present and non-empty.
 */
export function parseSkillFrontmatter(text: string): SkillDocumentMeta | null {
  // Tolerate a UTF-8 BOM and CRLF, both of which appear in copied files.
  const source = text.replace(/^﻿/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (match === null) return null

  const fields = new Map<string, string>()
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const pair = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1]
    let value = pair[2].trim()

    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '|+' || value === '>+') {
      const collected: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && (/^\s+/.test(lines[cursor]) || lines[cursor].trim() === '')) {
        collected.push(lines[cursor].replace(/^\s{1,4}/, ''))
        cursor += 1
      }
      index = cursor - 1
      value = collected.join(value.startsWith('>') ? ' ' : '\n').trim()
    } else {
      value = unquote(value)
    }

    if (!fields.has(key)) fields.set(key, value)
  }

  const name = fields.get('name')?.trim() ?? ''
  const description = fields.get('description')?.trim() ?? ''
  if (name === '' || description === '') return null
  return { name, description }
}
