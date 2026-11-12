/**
 * Host half of the skill market.
 *
 * Four exact routes below `/api/skillmarket` list the catalogue, list installed
 * skills, install one directory-bundle with per-file SHA-256 verification, and
 * uninstall a user copy. Every handler starts with the engine's browser-auth
 * fence; every response is `cache-control: no-store`.
 *
 * The routes are exact on purpose: they must not shadow any `/api` prefix
 * route from another plugin, and the engine checks exact routes first.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SkillMarketError } from './errors.js'
import { authorize, readJsonBody, sendError, sendJson } from './http.js'
import { createService } from './service.js'
import type { SkillMarketService } from './service.js'

export const name = 'dsh-skill-market'
export const inject = ['webServer'] as const

export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** The small slice of the cordis context this plugin uses. */
export interface PluginContext {
  get(name: string): unknown
  webServer: {
    register(route: WebRoute): void
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  sendJson(res, 405, { ok: false, error: `use ${method}`, code: 'METHOD_NOT_ALLOWED' })
  return false
}

/**
 * Register the four routes.
 *
 * Exported separately so the auth and body-limit behaviour can be tested
 * without a live cordis context: a fake `ctx.webServer.register` can capture
 * the same route objects the engine receives.
 */
export function registerSkillMarketRoutes(ctx: PluginContext, service: SkillMarketService): void {
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/skillmarket/list',
    handler: async (req, res) => {
      if (!authorize(req, res, ctx)) return
      if (!requireMethod(req, res, 'GET')) return
      try {
        sendJson(res, 200, await service.list())
      } catch (error) {
        sendError(res, error)
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/skillmarket/installed',
    handler: async (req, res) => {
      if (!authorize(req, res, ctx)) return
      if (!requireMethod(req, res, 'GET')) return
      try {
        sendJson(res, 200, await service.installed())
      } catch (error) {
        sendError(res, error)
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/skillmarket/install',
    handler: async (req, res) => {
      if (!authorize(req, res, ctx)) return
      if (!requireMethod(req, res, 'POST')) return
      try {
        const body = await readJsonBody(req)
        if (!isRecord(body)) throw new SkillMarketError('INVALID_BODY', 'request body must be a JSON object')
        const id = body.id
        if (typeof id !== 'string') throw new SkillMarketError('INVALID_ID', 'id is required')
        const result = await service.install(id, { overwrite: body.overwrite === true })
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, error)
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/skillmarket/uninstall',
    handler: async (req, res) => {
      if (!authorize(req, res, ctx)) return
      if (!requireMethod(req, res, 'POST')) return
      try {
        const body = await readJsonBody(req)
        if (!isRecord(body)) throw new SkillMarketError('INVALID_BODY', 'request body must be a JSON object')
        const id = body.id
        if (typeof id !== 'string') throw new SkillMarketError('INVALID_ID', 'id is required')
        await service.uninstall(id)
        sendJson(res, 200, { ok: true, id, removed: true })
      } catch (error) {
        sendError(res, error)
      }
    },
  })
}

/** Cordis entry point. */
export function apply(ctx: PluginContext): void {
  const service = createService()
  registerSkillMarketRoutes(ctx, service)
}

export { createService } from './service.js'
export { parseManifest, rawFileUrl, assertAllowedUrl } from './manifest.js'
export { scanInstalledRoots } from './installed.js'
export { installSkill, uninstallSkill } from './installer.js'
export { parseSkillFrontmatter } from './frontmatter.js'
export { authorize, readJsonBody, sendJson, sendError, MAX_BODY_BYTES } from './http.js'
export { SkillMarketError } from './errors.js'
export { assertKebabId, assertSafeRelativePath } from './paths.js'
