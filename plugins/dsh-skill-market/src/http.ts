import { SkillMarketError } from './errors.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Request bodies are tiny JSON documents; anything larger is refused. */
export const MAX_BODY_BYTES = 16 * 1024

/** The slice of the cordis context the guard needs. */
export interface ConnectionContext {
  get(name: string): unknown
}

/**
 * Honour the engine's browser-auth rejection for this request.
 *
 * Mirrors the marketplace / session-delete fence: Host, Origin and the browser
 * session cookie are decided by `connection.requestRejection`. Any failure to
 * read the connection is treated as unauthenticated (401), never as allowed.
 */
export function authorize(req: IncomingMessage, res: ServerResponse, ctx: ConnectionContext): boolean {
  let rejection: unknown = 401
  try {
    const connection = ctx.get('connection') as { requestRejection?: (request: IncomingMessage) => unknown } | undefined
    if (typeof connection?.requestRejection === 'function') {
      rejection = connection.requestRejection(req)
    }
  } catch {
    /* treat an unreadable connection as unauthenticated */
  }
  if (rejection === undefined) return true
  if (rejection === 403) {
    res.writeHead(403, { 'cache-control': 'no-store' })
    res.end()
  } else {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end('{"ok":false,"error":"unauthorized"}')
  }
  return false
}

/** Read a bounded JSON body; oversized bodies are rejected before parsing. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > maxBytes) {
      throw new SkillMarketError('BODY_TOO_LARGE', 'request body is too large')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SkillMarketError('INVALID_BODY', 'request body must be JSON')
  }
}

/** Send one JSON response; every response is non-cacheable. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Translate a typed installer failure into a non-cacheable JSON body. */
export function sendError(res: ServerResponse, error: unknown): void {
  const known = error instanceof SkillMarketError ? error : new SkillMarketError('INTERNAL', 'internal error')
  const payload: Record<string, unknown> = { ok: false, error: known.message, code: known.code }
  if (known.cached !== undefined) payload.cached = known.cached
  sendJson(res, known.status, payload)
}
