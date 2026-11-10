import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRoutes, makeManifest, makeReq, makeRes, makeSkill, rawUrl, serviceFor, tempDir, removeDir } from './helpers.mjs'

const bytes = { 'SKILL.md': '---\nname: demo\ndescription: demo skill\n---\n' }
const skill = makeSkill('demo', bytes)
const files = new Map([[rawUrl(skill, 'SKILL.md'), Buffer.from(bytes['SKILL.md'])]])

function routeByPath(routes, path) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route, `route ${path} registered`)
  assert.equal(route.kind, 'exact')
  return route
}

async function dispatch(path, { rejection, method, body } = {}) {
  const home = await tempDir()
  try {
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
    const routes = buildRoutes(service, rejection)
    const res = makeRes()
    await routeByPath(routes, path).handler(makeReq({ method, body }), res)
    return res
  } finally {
    await removeDir(home)
  }
}

test('S8: unauthenticated requests get 401/403 with cache-control no-store', async () => {
  const paths = ['/api/skillmarket/list', '/api/skillmarket/installed', '/api/skillmarket/install', '/api/skillmarket/uninstall']
  for (const path of paths) {
    const unauthorized = await dispatch(path, { rejection: 401 })
    assert.equal(unauthorized.status, 401, path)
    assert.equal(unauthorized.headers['cache-control'], 'no-store', path)
    assert.equal(unauthorized.json().error, 'unauthorized', path)

    const forbidden = await dispatch(path, { rejection: 403 })
    assert.equal(forbidden.status, 403, path)
    assert.equal(forbidden.headers['cache-control'], 'no-store', path)
    assert.equal(forbidden.body, '', path)
  }
})

test('S8: successful responses also carry cache-control no-store', async () => {
  const list = await dispatch('/api/skillmarket/list', { rejection: undefined, method: 'GET' })
  assert.equal(list.status, 200)
  assert.equal(list.headers['cache-control'], 'no-store')
  assert.equal(list.json().ok, true)
  assert.equal(list.json().skills[0].id, 'demo')

  const installed = await dispatch('/api/skillmarket/installed', { rejection: undefined, method: 'GET' })
  assert.equal(installed.status, 200)
  assert.equal(installed.headers['cache-control'], 'no-store')
  assert.ok(Array.isArray(installed.json()))

  const install = await dispatch('/api/skillmarket/install', {
    rejection: undefined,
    method: 'POST',
    body: JSON.stringify({ id: 'demo' }),
  })
  assert.equal(install.status, 200)
  assert.equal(install.headers['cache-control'], 'no-store')
  assert.equal(install.json().status, 'installed')

  // Uninstall needs the same service that installed the skill, so exercise it
  // on a home that already contains a user copy.
  const home = await tempDir()
  try {
    const service = serviceFor({ dshHome: home, manifest: makeManifest([skill]), files })
    await service.install('demo')
    const routes = buildRoutes(service, undefined)
    const res = makeRes()
    await routeByPath(routes, '/api/skillmarket/uninstall').handler(
      makeReq({ method: 'POST', body: JSON.stringify({ id: 'demo' }) }),
      res,
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.deepEqual(res.json(), { ok: true, id: 'demo', removed: true })
  } finally {
    await removeDir(home)
  }
})

test('S8: an oversized request body is refused with 413 and no-store', async () => {
  const res = await dispatch('/api/skillmarket/install', {
    rejection: undefined,
    method: 'POST',
    body: Buffer.alloc(16 * 1024 + 1, 0x61),
  })
  assert.equal(res.status, 413)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json().code, 'BODY_TOO_LARGE')
})

test('S8: a malformed JSON body is a typed 400', async () => {
  const res = await dispatch('/api/skillmarket/uninstall', {
    rejection: undefined,
    method: 'POST',
    body: '{not json',
  })
  assert.equal(res.status, 400)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json().code, 'INVALID_BODY')
})
