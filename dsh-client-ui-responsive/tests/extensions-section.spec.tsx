// @vitest-environment jsdom
// 「扩展」设置分区：技能 tab（E1–E9）与插件 tab（P1–P6）。
//
// 接口形态以服务端实际返回为准：
//  - /api/skillmarket/installed → InstalledSkill[]（同时兼容 { skills: [...] }）
//  - /api/skillmarket/list → { categories, skills, rejected }
//  - /api/dshmarketplace/search?mobile=1 → { total, count, results }
// 所有请求均为同源 fetch；测试只用假 fetch，不触网。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { ExtensionsSection } from '../src/client/dev-section/extensions.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface Call {
  url: string
  method: string
  body?: string
  credentials?: string
}

interface FakeResult {
  status?: number
  body?: unknown
}

type Route = (call: Call) => FakeResult | Promise<FakeResult>

/** 假 fetch：按 URL 分派并记录调用；未登记的路由直接失败（防漏断言）。 */
function makeFetch(routes: Record<string, Route>) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials,
    }
    calls.push(call)
    // 精确路由优先；以 `*` 结尾的键按前缀匹配（插件搜索带查询串，无法逐字枚举）。
    const exact = routes[call.url]
    const prefixKey = exact === undefined
      ? Object.keys(routes).find((key) => key.endsWith('*') && call.url.startsWith(key.slice(0, -1)))
      : undefined
    const handler = exact ?? (prefixKey === undefined ? undefined : routes[prefixKey])
    if (handler === undefined) throw new Error('unexpected fetch: ' + call.url)
    const result = await handler(call)
    const status = result.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body ?? {},
    }
  })
  return { calls, impl }
}

let root: Root | undefined
let host: HTMLElement | undefined

/** 冲掉 fetch 链上的微任务（假 fetch 不触网，只需若干轮 Promise）。 */
async function settle(rounds = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve()
  })
}

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<ExtensionsSection />) })
  await settle()
  return host
}

function panel(el: HTMLElement, name: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-panel="${name}"]`)
  if (found === null) throw new Error('找不到面板：' + name)
  return found
}

function rows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('.dsh-ext-row')]
}

function row(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-skill-id="${id}"], [data-market-id="${id}"]`)
  if (found === null) throw new Error('找不到行：' + id)
  return found
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const button = [...el.querySelectorAll('button')].find((entry) => entry.textContent === text)
  if (button === undefined) throw new Error('找不到按钮：' + text)
  return button as HTMLButtonElement
}

/** React 受控输入：必须走原生 setter + input 事件，直接改 value 会被 value tracker 吞掉。 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const INSTALLED_TWO = [
  { id: 'docx', name: 'docx', description: '创建与编辑 Word 文档', source: 'user', path: '/skills/docx', removable: true },
  { id: 'pdf', name: 'pdf', description: '读取 PDF 文件', source: 'bundled', path: '/skills/pdf', removable: false },
]

function marketFixture() {
  return {
    ok: true,
    cached: false,
    categories: [
      { id: 'docs', title: { en: 'Documents', zh: '文档' } },
      { id: 'code', title: { en: 'Code', zh: '代码' } },
    ],
    skills: [
      { id: 'docx', name: 'docx', title: { en: 'docx', zh: 'docx' }, description: { en: 'Create and edit Word documents', zh: '创建与编辑 Word 文档' }, category: 'docs', license: 'MIT', installed: false },
      { id: 'slides', name: 'slides', title: { en: 'slides', zh: '幻灯片' }, description: { en: 'Make slide decks', zh: '制作演示文稿' }, category: 'docs', license: 'MIT', installed: false },
      { id: 'refactor', name: 'refactor', title: { en: 'refactor', zh: '重构' }, description: { en: 'Refactor code safely', zh: '安全重构代码' }, category: 'code', license: 'MIT', installed: false },
    ],
    rejected: [],
  }
}

function emptyMarket() {
  return { ok: true, categories: [], skills: [], rejected: [] }
}

beforeEach(() => {
  document.documentElement.lang = ''
})

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  document.documentElement.lang = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── E1 注册 ────────────────────────────────────────────────────────────────

describe('E1 设置页注册', () => {
  it('index.ts 以 android-extensions / order 95 / 双语 label 注册，并带短说明', () => {
    const index = readFileSync('src/client/index.ts', 'utf8')
    expect(index).toContain("id: 'android-extensions'")
    expect(index).toContain('order: 95')
    expect(index).toMatch(/label:\s*\(\)\s*=>\s*tr\('扩展', 'Extensions'\)/)
    expect(index).toContain('ExtensionsSection')

    const nav = readFileSync('src/client/mobile/settings-nav.ts', 'utf8')
    expect(nav).toContain("['扩展', '技能与插件']")
    expect(nav).toContain("['扩展', 'Skills and plugins']")
  })
})

// ── E2 已安装段 ────────────────────────────────────────────────────────────

describe('E2 已安装段', () => {
  it('渲染名称/简介/来源；内置条目不出现卸载按钮', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: INSTALLED_TWO }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const installed = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="installed"]')!

    expect(installed.textContent).toContain('docx')
    expect(installed.textContent).toContain('创建与编辑 Word 文档')
    expect(installed.textContent).toContain('已安装')
    expect(installed.textContent).toContain('内置')

    // user 来源（removable=true）有卸载；bundled（removable=false）没有。
    expect(row(el, 'docx').querySelector('button')).not.toBeNull()
    expect(row(el, 'pdf').querySelector('button')).toBeNull()
  })

  it('空列表显示空态文案（中文与英文各一条）', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(panel(el, 'skills').textContent).toContain('还没有已安装的技能')

    await act(async () => { root!.unmount() })
    root = undefined
    host?.remove()
    host = undefined

    document.documentElement.lang = 'en'
    const english = await render()
    expect(panel(english, 'skills').textContent).toContain('No skills installed yet')
  })
})

// ── E3 市场段 ──────────────────────────────────────────────────────────────

describe('E3 市场段', () => {
  it('按 category 分组；搜索 docx 只留相关条目，搜不到显示「没有匹配」', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: marketFixture() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const market = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!

    expect(market.textContent).toContain('文档')
    expect(market.textContent).toContain('代码')
    expect(market.querySelectorAll('[data-category]')).toHaveLength(2)

    const search = panel(el, 'skills').querySelector<HTMLInputElement>('input[type="search"]')!
    await typeInto(search, 'docx')
    const visibleIds = rows(market).map((entry) => entry.getAttribute('data-market-id'))
    expect(visibleIds).toEqual(['docx'])

    await typeInto(search, '不存在的能力')
    expect(market.textContent).toContain('没有匹配的技能')
  })
})

// ── E4 安装成功 ────────────────────────────────────────────────────────────

describe('E4 安装成功', () => {
  it('按钮变「安装中…」且禁用；成功后重新请求 installed 并标记已安装；重复点击不发第二次请求', async () => {
    let installedCalls = 0
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve })
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => {
        installedCalls += 1
        return { body: installedCalls === 1 ? [] : [{ id: 'docx', name: 'docx', description: '创建与编辑 Word 文档', source: 'user', path: '/skills/docx', removable: true }] }
      },
      '/api/skillmarket/list': () => ({ body: { ...emptyMarket(), categories: [{ id: 'docs', title: { en: 'Documents', zh: '文档' } }], skills: [marketFixture().skills[0]] } }),
      '/api/skillmarket/install': async () => {
        await installGate
        return { body: { ok: true, status: 'installed', id: 'docx', path: '/skills/docx' } }
      },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const install = buttonByText(row(el, 'docx'), '安装')
    await act(async () => { install.click() })
    await settle(1)

    // 安装中：同一颗按钮变文案并禁用。
    const busyButton = buttonByText(row(el, 'docx'), '安装中…')
    expect(busyButton.disabled).toBe(true)

    // 重复点击不得再发 POST。
    await act(async () => { busyButton.click() })
    expect(fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/install')).toHaveLength(1)

    await act(async () => { releaseInstall() })
    await settle(8)

    expect(installedCalls).toBe(2)
    expect(fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/install')).toHaveLength(1)
    // 市场行被标记为已安装（来自重新读取的 installed 列表）。
    expect(row(el, 'docx').textContent).toContain('已安装')
  })
})

// ── E5 安装失败 ────────────────────────────────────────────────────────────

describe('E5 安装失败', () => {
  it('CHECKSUM_MISMATCH 显示对应人话，按钮恢复可点，且不从市场移除', async () => {
    let installedCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => { installedCalls += 1; return { body: [] } },
      '/api/skillmarket/list': () => ({ body: { ...emptyMarket(), categories: [{ id: 'docs', title: { en: 'Documents', zh: '文档' } }], skills: [marketFixture().skills[0]] } }),
      '/api/skillmarket/install': () => ({ status: 502, body: { ok: false, error: 'checksum', code: 'CHECKSUM_MISMATCH' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    await act(async () => { buttonByText(row(el, 'docx'), '安装').click() })
    await settle(8)

    const failed = row(el, 'docx')
    expect(failed.textContent).toContain('校验不通过')
    expect(failed.querySelector('[data-code="CHECKSUM_MISMATCH"]'), '原始码只进 data-code').not.toBeNull()
    // 行还在市场里，按钮恢复为「安装」且可点。
    expect(buttonByText(failed, '安装').disabled).toBe(false)
    expect(installedCalls, '失败不刷新已安装列表').toBe(1)
  })
})

// ── E6 卸载 ────────────────────────────────────────────────────────────────

describe('E6 卸载', () => {
  it('只有 user 来源出现卸载；先内联确认，取消不发请求，确认后才 POST 并刷新', async () => {
    let installedCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => {
        installedCalls += 1
        return { body: installedCalls === 1 ? INSTALLED_TWO : [INSTALLED_TWO[1]] }
      },
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/skillmarket/uninstall': () => ({ body: { ok: true, id: 'docx', removed: true } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(row(el, 'docx').querySelector('button')).not.toBeNull()
    expect(row(el, 'pdf').querySelector('button')).toBeNull()

    // 第一下只进入确认态，不发 POST。
    await act(async () => { buttonByText(row(el, 'docx'), '卸载').click() })
    expect(fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/uninstall')).toHaveLength(0)

    // 取消不发请求。
    await act(async () => { buttonByText(row(el, 'docx'), '取消').click() })
    expect(fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/uninstall')).toHaveLength(0)

    // 再点一次并确认。
    await act(async () => { buttonByText(row(el, 'docx'), '卸载').click() })
    await act(async () => { buttonByText(row(el, 'docx'), '确认卸载').click() })
    await settle(8)

    const posts = fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/uninstall')
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toBe(JSON.stringify({ id: 'docx' }))
    expect(installedCalls, '成功后必须重新 GET 已安装列表').toBe(2)
    expect(el.querySelector('[data-skill-id="docx"]')).toBeNull()
  })
})

// ── E7 接口失败 ────────────────────────────────────────────────────────────

describe('E7 接口失败', () => {
  it('/installed 500 显示错误行与重试；重试重新请求', async () => {
    let installedCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => {
        installedCalls += 1
        return installedCalls === 1
          ? { status: 500, body: { ok: false, error: 'boom', code: 'INTERNAL' } }
          : { body: [INSTALLED_TWO[0]] }
      },
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const installed = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="installed"]')!

    expect(installed.textContent).toContain('内部出错')
    expect(installed.querySelector('[data-code="INTERNAL"]')).not.toBeNull()

    await act(async () => { buttonByText(installed, '重试').click() })
    await settle(8)
    expect(installedCalls).toBe(2)
    expect(installed.textContent).toContain('docx')
  })

  it('/list 失败不影响已安装段', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [INSTALLED_TWO[0]] }),
      '/api/skillmarket/list': () => ({ status: 502, body: { ok: false, error: 'down', code: 'MARKET_UNAVAILABLE' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const installed = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="installed"]')!
    const market = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!

    expect(installed.textContent).toContain('docx')
    expect(installed.querySelector('[data-state="error"]')).toBeNull()
    expect(market.textContent).toContain('技能市场暂时不可用')
    expect(buttonByText(market, '重试')).not.toBeNull()
  })
})

// ── E8 并发 ────────────────────────────────────────────────────────────────

describe('E8 并发保护', () => {
  it('一个安装进行中时，其他行按钮禁用且不会发第二个 POST', async () => {
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve })
    const fixture = marketFixture()
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: { ...emptyMarket(), categories: fixture.categories, skills: [fixture.skills[0], fixture.skills[1]] } }),
      '/api/skillmarket/install': async () => { await installGate; return { body: { ok: true } } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    await act(async () => { buttonByText(row(el, 'docx'), '安装').click() })
    await settle(1)
    expect(buttonByText(row(el, 'docx'), '安装中…').disabled).toBe(true)
    expect(buttonByText(row(el, 'slides'), '安装').disabled).toBe(true)

    // 即使强行点被禁用的按钮，也不得发出第二个写请求。
    await act(async () => { buttonByText(row(el, 'slides'), '安装').click() })
    expect(fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/install')).toHaveLength(1)

    await act(async () => { releaseInstall() })
    await settle(8)
  })
})

// ── 插件 tab（P1–P6） ──────────────────────────────────────────────────────

function pluginItem(
  fullName: string,
  category: string,
  compat: string,
  extra: Partial<{ name: string; summary: string; summaryZh: string; owner: string }> = {},
) {
  return {
    fullName,
    name: extra.name ?? fullName.split('/').pop(),
    owner: extra.owner ?? fullName.split('/')[0],
    summary: extra.summary ?? 'A plugin',
    summaryZh: extra.summaryZh ?? '一个插件',
    category,
    compat,
    compatNote: '',
    stars: 1,
    installable: true,
    riskFlags: [],
  }
}

function patchPluginPage() {
  return {
    total: 3,
    count: 3,
    results: [
      pluginItem('alice/memory', 'memory', 'ok', { name: 'memory', summaryZh: '记忆插件' }),
      pluginItem('bob/desktop-only', 'terminal', 'desktop', { name: 'desktop-only', summaryZh: '桌面插件' }),
      pluginItem('carol/native', 'vision', 'native', { name: 'native', summaryZh: '原生插件' }),
      pluginItem('dave/unknown', 'misc', 'unknown', { name: 'unknown', summaryZh: '未验证插件' }),
    ],
  }
}

function tabButton(el: HTMLElement, name: string): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)
  if (button === null) throw new Error('找不到 tab：' + name)
  return button
}

async function openPlugins(el: HTMLElement): Promise<HTMLElement> {
  await act(async () => { tabButton(el, 'plugins').click() })
  await settle(8)
  return panel(el, 'plugins')
}

function searchCalls(calls: Call[]) {
  return calls.filter((call) => call.url.startsWith('/api/dshmarketplace/search'))
}

describe('P1 搜索防抖', () => {
  it('连续输入只发一次请求，参数带 mobile=1 与 q', async () => {
    vi.useFakeTimers()
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/dshmarketplace/search*': () => ({ body: patchPluginPage() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await openPlugins(el)

    const before = searchCalls(fetchSpy.calls).length
    const input = panel(el, 'plugins').querySelector<HTMLInputElement>('input[type="search"]')!
    await typeInto(input, 'm')
    await typeInto(input, 'me')
    await typeInto(input, 'memory')
    expect(searchCalls(fetchSpy.calls).length, '防抖窗口内不得发请求').toBe(before)

    await act(async () => { vi.advanceTimersByTime(300) })
    await settle(8)

    const after = searchCalls(fetchSpy.calls)
    expect(after.length - before).toBe(1)
    const params = new URL(after[after.length - 1].url, 'http://localhost').searchParams
    expect(params.get('mobile')).toBe('1')
    expect(params.get('q')).toBe('memory')
    expect(params.get('limit')).toBe('30')
  })
})

describe('P2 分组与徽标', () => {
  it('按 category 分组；desktop/native/unknown 各显示对应中文徽标', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/dshmarketplace/search*': () => ({ body: patchPluginPage() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const plugins = await openPlugins(el)

    expect(plugins.querySelectorAll('[data-category]')).toHaveLength(4)
    expect(plugins.textContent).toContain('memory')
    expect(plugins.textContent).toContain('terminal')
    expect(plugins.textContent).toContain('vision')

    expect(plugins.textContent).toContain('移动可用')
    expect(plugins.textContent).toContain('仅桌面')
    expect(plugins.textContent).toContain('含原生依赖')
    expect(plugins.textContent).toContain('未验证')
  })
})

describe('P3 插件安装成功', () => {
  it('POST body 含 confirmed 与 plugin.fullName；成功后标记「已安装（重启后生效）」且不重复发请求', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/dshmarketplace/search*': () => ({ body: patchPluginPage() }),
      '/api/dshmarketplace/install': () => ({ body: { ok: true, target: 'npm:@alice/memory' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await openPlugins(el)

    const target = el.querySelector<HTMLElement>('[data-plugin-name="alice/memory"]')!
    await act(async () => { buttonByText(target, '安装').click() })
    await settle(8)

    const posts = fetchSpy.calls.filter((call) => call.url === '/api/dshmarketplace/install')
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0].body!) as { confirmed?: boolean; plugin?: { fullName?: string } }
    expect(body.confirmed).toBe(true)
    expect(body.plugin?.fullName).toBe('alice/memory')

    const installedRow = el.querySelector<HTMLElement>('[data-plugin-name="alice/memory"]')!
    expect(installedRow.textContent).toContain('已安装（重启后生效）')
    expect(installedRow.querySelector('button')).toBeNull()
    // 标记已安装后不再有可点的安装入口，因此不会重复发请求。
    expect(fetchSpy.calls.filter((call) => call.url === '/api/dshmarketplace/install')).toHaveLength(1)
  })
})

describe('P4 插件安装失败', () => {
  it('INSTALL_FAILED 行内显示对应人话，按钮恢复可点', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/dshmarketplace/search*': () => ({ body: patchPluginPage() }),
      '/api/dshmarketplace/install': () => ({ status: 500, body: { error: 'Install failed: boom', code: 'INSTALL_FAILED' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await openPlugins(el)

    const target = el.querySelector<HTMLElement>('[data-plugin-name="alice/memory"]')!
    await act(async () => { buttonByText(target, '安装').click() })
    await settle(8)

    const failed = el.querySelector<HTMLElement>('[data-plugin-name="alice/memory"]')!
    expect(failed.textContent).toContain('插件安装失败')
    expect(failed.querySelector('[data-code="INSTALL_FAILED"]')).not.toBeNull()
    expect(buttonByText(failed, '安装').disabled).toBe(false)
  })
})

describe('P5 加载更多', () => {
  it('首屏 30 条，点加载更多请求 page=2 并追加而不是替换', async () => {
    const all = Array.from({ length: 60 }, (_, index) =>
      pluginItem('owner/plugin-' + String(index), index < 30 ? 'first' : 'second', 'ok', { name: 'plugin-' + String(index) }))
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/dshmarketplace/search*': (call) => {
        const page = Number(new URL(call.url, 'http://localhost').searchParams.get('page') ?? '1')
        const start = (page - 1) * 30
        return { body: { total: 60, count: 30, results: all.slice(start, start + 30) } }
      },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    const plugins = await openPlugins(el)

    expect(plugins.querySelectorAll('[data-plugin-name]')).toHaveLength(30)

    await act(async () => { buttonByText(plugins, '加载更多').click() })
    await settle(8)

    const pages = searchCalls(fetchSpy.calls).map((call) => new URL(call.url, 'http://localhost').searchParams.get('page'))
    expect(pages).toContain('2')
    const rowsAfter = plugins.querySelectorAll('[data-plugin-name]')
    expect(rowsAfter).toHaveLength(60)
    // 追加语义：第一条仍在场。
    expect(plugins.querySelector('[data-plugin-name="owner/plugin-0"]')).not.toBeNull()
  })
})

describe('P6 两个 tab 互不干扰', () => {
  it('插件 tab 的请求不重置技能 tab 的已加载列表与搜索词', async () => {
    let installedCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => { installedCalls += 1; return { body: [INSTALLED_TWO[0]] } },
      '/api/skillmarket/list': () => ({ body: marketFixture() }),
      '/api/dshmarketplace/search*': () => ({ body: patchPluginPage() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const skillSearch = panel(el, 'skills').querySelector<HTMLInputElement>('input[type="search"]')!
    await typeInto(skillSearch, 'docx')
    expect(rows(panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!)).toHaveLength(1)

    await openPlugins(el)
    expect(installedCalls, '插件 tab 不得重新请求技能已安装列表').toBe(1)
    expect(panel(el, 'plugins').textContent).toContain('memory')

    await act(async () => { tabButton(el, 'skills').click() })
    await settle(2)
    const skillSearchAfter = panel(el, 'skills').querySelector<HTMLInputElement>('input[type="search"]')!
    expect(skillSearchAfter.value).toBe('docx')
    expect(rows(panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!)).toHaveLength(1)
  })
})

// ── E9 颜色与双语 ──────────────────────────────────────────────────────────

// ── M7 可更新标签与离线提示 ────────────────────────────────────────────────

/**
 * 已安装夹具：
 *  - docx：可卸载，是否可更新由参数决定；
 *  - slides：可卸载但不可更新（M7-1 的反例）；
 *  - pdf：内置（removable=false）且服务端声称可更新（M7-6 的反例）。
 */
function installedForUpdate(docxUpdate: boolean) {
  return [
    { id: 'docx', name: 'docx', description: '创建与编辑 Word 文档', source: 'user', path: '/skills/docx', removable: true, updateAvailable: docxUpdate },
    { id: 'slides', name: 'slides', description: '制作演示文稿', source: 'user', path: '/skills/slides', removable: true, updateAvailable: false },
    { id: 'pdf', name: 'pdf', description: '读取 PDF 文件', source: 'bundled', path: '/skills/pdf', removable: false, updateAvailable: true },
  ]
}

function updateBadge(el: HTMLElement, id: string): HTMLElement | null {
  return row(el, id).querySelector<HTMLElement>('[data-update-available="true"]')
}

async function unmountCurrent(): Promise<void> {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
}

describe('M7-1 可更新标签', () => {
  it('updateAvailable:true 的可卸载行显示「可更新」，false 的行不显示', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: installedForUpdate(true) }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(updateBadge(el, 'docx')).not.toBeNull()
    expect(updateBadge(el, 'docx')!.textContent).toBe('可更新')
    expect(updateBadge(el, 'slides')).toBeNull()
    expect(row(el, 'slides').textContent).not.toContain('可更新')
  })
})

describe('M7-2 覆盖安装请求', () => {
  it('点「可更新」发出 overwrite:true；期间显示「更新中…」并禁用；重复点击不发第二次', async () => {
    let releaseUpdate!: () => void
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve })
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: installedForUpdate(true) }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/skillmarket/install': async () => {
        await updateGate
        return { body: { ok: true, status: 'installed', id: 'docx' } }
      },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    await act(async () => { buttonByText(row(el, 'docx'), '可更新').click() })
    await settle(1)

    const busyButton = buttonByText(row(el, 'docx'), '更新中…')
    expect(busyButton.disabled).toBe(true)
    // 同一时刻只允许一个写操作：其他行的按钮（卸载等）也被禁用。
    expect(buttonByText(row(el, 'slides'), '卸载').disabled).toBe(true)

    // 即使强行点被禁用的按钮，也不得发出第二个写请求。
    await act(async () => { busyButton.click() })
    const posts = fetchSpy.calls.filter((call) => call.url === '/api/skillmarket/install')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0].body!)).toEqual({ id: 'docx', overwrite: true })

    await act(async () => { releaseUpdate() })
    await settle(8)
  })
})

describe('M7-3 更新成功', () => {
  it('成功后重新请求 installed 与 list，标签消失', async () => {
    let installedCalls = 0
    let listCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => {
        installedCalls += 1
        return { body: installedForUpdate(installedCalls === 1) }
      },
      '/api/skillmarket/list': () => {
        listCalls += 1
        return { body: emptyMarket() }
      },
      '/api/skillmarket/install': () => ({ body: { ok: true, status: 'installed', id: 'docx' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(updateBadge(el, 'docx')).not.toBeNull()

    await act(async () => { buttonByText(row(el, 'docx'), '可更新').click() })
    await settle(8)

    expect(installedCalls, '成功后必须重新 GET installed').toBe(2)
    expect(listCalls, '成功后必须重新 GET list').toBe(2)
    expect(updateBadge(el, 'docx')).toBeNull()
    expect(row(el, 'docx').textContent).not.toContain('可更新')
  })
})

describe('M7-4 更新失败', () => {
  it('INTERNAL 显示对应文案，标签保留，按钮恢复可点', async () => {
    let installedCalls = 0
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => { installedCalls += 1; return { body: installedForUpdate(true) } },
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
      '/api/skillmarket/install': () => ({ status: 500, body: { ok: false, error: 'boom', code: 'INTERNAL' } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    await act(async () => { buttonByText(row(el, 'docx'), '可更新').click() })
    await settle(8)

    const failed = row(el, 'docx')
    expect(failed.textContent).toContain('内部出错')
    expect(failed.querySelector('[data-code="INTERNAL"]'), '原始码只进 data-code').not.toBeNull()
    // 本地仍是旧版本，标签不消失，按钮恢复为「可更新」且可点。
    expect(updateBadge(el, 'docx')).not.toBeNull()
    expect(buttonByText(failed, '可更新').disabled).toBe(false)
    expect(installedCalls, '失败不刷新已安装列表').toBe(1)
  })
})

describe('M7-5 离线提示', () => {
  it('stale:true 且带 savedAt 时在市场段顶部显示离线说明与日期', async () => {
    const savedAt = new Date(2026, 5, 3, 12, 0, 0).getTime()
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: { ...emptyMarket(), stale: true, savedAt } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const market = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!
    const notice = market.querySelector<HTMLElement>('[data-state="stale"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('离线，显示上次获取的清单')
    expect(notice!.textContent).toContain('保存于 6月3日')
  })

  it('stale:false 或无该字段时不渲染任何离线节点', async () => {
    for (const listBody of [{ ...emptyMarket(), stale: false }, emptyMarket()]) {
      const fetchSpy = makeFetch({
        '/api/skillmarket/installed': () => ({ body: [] }),
        '/api/skillmarket/list': () => ({ body: listBody }),
      })
      vi.stubGlobal('fetch', fetchSpy.impl)
      const el = await render()

      const market = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!
      expect(market.querySelector('[data-state="stale"]')).toBeNull()
      expect(market.textContent).not.toContain('离线')

      await unmountCurrent()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})

describe('M7-6 内置技能', () => {
  it('removable:false 的内置技能即使服务端说可更新也不显示「可更新」', async () => {
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: installedForUpdate(false) }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(updateBadge(el, 'pdf')).toBeNull()
    expect(row(el, 'pdf').textContent).not.toContain('可更新')
  })
})

describe('M7-7 文案与样式', () => {
  it('新增文案全部经 tr() 双语；新增样式没有硬编码颜色', async () => {
    const source = readFileSync('src/client/dev-section/extensions.tsx', 'utf8')
    expect(source).toContain("tr('可更新', 'Updatable')")
    expect(source).toContain("tr('更新中…', 'Updating…')")
    expect(source).toContain("tr('离线，显示上次获取的清单', 'Offline. Showing the last fetched list.'")

    const css = readFileSync('src/client/dev-section/extensions.css.ts', 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/rgba?\(/)
    expect(css).toContain('.dsh-ext-update')
    expect(css).toContain('var(--dsw-alias-state-warn-primary)')

    // 英文环境同一批文案必须切到英文，日期也换成英文短日期。
    await unmountCurrent()
    document.documentElement.lang = 'en'
    const savedAt = new Date(2026, 5, 3, 12, 0, 0).getTime()
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: installedForUpdate(true) }),
      '/api/skillmarket/list': () => ({ body: { ...emptyMarket(), stale: true, savedAt } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(updateBadge(el, 'docx')!.textContent).toBe('Updatable')
    const market = panel(el, 'skills').querySelector<HTMLElement>('[data-segment="market"]')!
    expect(market.textContent).toContain('Offline. Showing the last fetched list')
    expect(market.textContent).toContain('saved Jun 3')
  })
})

// ── R 能力依赖声明 ─────────────────────────────────────────────────────────

function marketWithRequires(requires?: string[]) {
  const fixture = marketFixture()
  return {
    ...fixture,
    skills: fixture.skills.map((skill, index) => (
      index === 0 && requires !== undefined ? { ...skill, requires } : skill
    )),
  }
}

function requiredBadge(el: HTMLElement, id: string, requirement = 'a11y'): HTMLElement | null {
  return row(el, id).querySelector<HTMLElement>(`[data-requires="${requirement}"]`)
}

function a11yBridge(enabled: boolean, extra: Record<string, unknown> = {}) {
  const openA11ySettings = vi.fn()
  vi.stubGlobal('androidBridge', {
    a11yStatus: () => JSON.stringify({ enabled }),
    openA11ySettings,
    ...extra,
  })
  return openA11ySettings
}

describe('R3 依赖不满足', () => {
  it('requires a11y 且 enabled:false → 徽标、安装禁用、去开启调用 openA11ySettings', async () => {
    const openA11ySettings = a11yBridge(false)
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: marketWithRequires(['a11y']) }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const target = row(el, 'docx')
    expect(requiredBadge(el, 'docx')).not.toBeNull()
    expect(target.textContent).toContain('需要开启无障碍')
    expect(buttonByText(target, '安装').disabled).toBe(true)

    await act(async () => { buttonByText(target, '去开启').click() })
    expect(openA11ySettings).toHaveBeenCalledTimes(1)
  })
})

describe('R4 重新判定', () => {
  it('开启后切 tab 再回来 → 徽标消失、安装可点', async () => {
    let enabled = false
    a11yBridge(false)
    // 用可变实现替换，模拟用户从系统设置页开启后回到应用。
    ;(window.androidBridge as { a11yStatus: () => string }).a11yStatus = () => JSON.stringify({ enabled })

    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: marketWithRequires(['a11y']) }),
      '/api/dshmarketplace/search*': () => ({ body: { total: 0, count: 0, results: [] } }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(requiredBadge(el, 'docx')).not.toBeNull()

    await act(async () => { buttonByText(row(el, 'docx'), '去开启').click() })
    enabled = true

    await openPlugins(el)
    await act(async () => { tabButton(el, 'skills').click() })
    await settle(4)

    expect(requiredBadge(el, 'docx')).toBeNull()
    expect(buttonByText(row(el, 'docx'), '安装').disabled).toBe(false)
  })
})

describe('R5 无依赖不新增节点', () => {
  it('requires:[] 或缺省 → 不出现徽标/开启按钮', async () => {
    for (const extra of [{ requires: [] }, {}]) {
      const fixture = marketWithRequires()
      const withField = {
        ...fixture,
        skills: fixture.skills.map((skill, index) => (index === 0 ? { ...skill, ...extra } : skill)),
      }
      const fetchSpy = makeFetch({
        '/api/skillmarket/installed': () => ({ body: [] }),
        '/api/skillmarket/list': () => ({ body: withField }),
      })
      vi.stubGlobal('fetch', fetchSpy.impl)
      const el = await render()

      expect(el.querySelector('[data-requires]')).toBeNull()
      expect(el.querySelector('[data-require-action]')).toBeNull()
      expect(el.textContent).not.toContain('需要开启')
      expect(buttonByText(row(el, 'docx'), '安装').disabled).toBe(false)

      await unmountCurrent()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})

describe('R6 桥缺席', () => {
  it('没有 androidBridge 或状态读不到 → 不显示徽标、安装可点', async () => {
    const bridges: Array<Record<string, unknown> | undefined> = [
      undefined,
      { a11yStatus: () => 'not-json' },
    ]
    for (const bridge of bridges) {
      if (bridge !== undefined) vi.stubGlobal('androidBridge', bridge)
      const fetchSpy = makeFetch({
        '/api/skillmarket/installed': () => ({ body: [] }),
        '/api/skillmarket/list': () => ({ body: marketWithRequires(['a11y']) }),
      })
      vi.stubGlobal('fetch', fetchSpy.impl)
      const el = await render()

      expect(requiredBadge(el, 'docx')).toBeNull()
      expect(el.textContent).not.toContain('需要开启无障碍')
      expect(buttonByText(row(el, 'docx'), '安装').disabled).toBe(false)

      await unmountCurrent()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})

describe('R7 已安装但依赖不满足', () => {
  it('已安装行显示徽标，且不额外给「去开启」，原有卸载入口保留', async () => {
    a11yBridge(false)
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({
        body: [{
          id: 'docx',
          name: 'docx',
          description: '创建与编辑 Word 文档',
          source: 'user',
          path: '/skills/docx',
          removable: true,
          requires: ['a11y'],
        }],
      }),
      '/api/skillmarket/list': () => ({ body: emptyMarket() }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const installedRow = row(el, 'docx')
    expect(installedRow.textContent).toContain('需要开启无障碍')
    expect(installedRow.querySelector('[data-require-action]')).toBeNull()
    expect(buttonByText(installedRow, '卸载')).not.toBeNull()
  })
})

describe('R8 文案与样式', () => {
  it('新增文案全部经 tr() 双语；新增样式只用 --dsw-* 变量', async () => {
    const source = readFileSync('src/client/dev-section/extensions.tsx', 'utf8')
    expect(source).toContain("tr('需要开启无障碍', 'Needs accessibility')")
    expect(source).toContain("tr('需要开启 Shizuku', 'Needs Shizuku')")
    expect(source).toContain("tr('去开启', 'Enable')")

    const css = readFileSync('src/client/dev-section/extensions.css.ts', 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/rgba?\(/)
    expect(css).toContain('.dsh-ext-require')
    expect(css).toContain('var(--dsw-alias-state-warn-primary)')

    // 英文环境同一批文案切到英文。
    await unmountCurrent()
    document.documentElement.lang = 'en'
    a11yBridge(false)
    const fetchSpy = makeFetch({
      '/api/skillmarket/installed': () => ({ body: [] }),
      '/api/skillmarket/list': () => ({ body: marketWithRequires(['a11y']) }),
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(requiredBadge(el, 'docx')!.textContent).toBe('Needs accessibility')
    expect(buttonByText(row(el, 'docx'), 'Enable')).not.toBeNull()
    expect(buttonByText(row(el, 'docx'), 'Install').disabled).toBe(true)
  })
})

// ── E9 颜色与双语 ──────────────────────────────────────────────────────────

describe('E9 颜色与双语', () => {
  it('新增 TSX 无硬编码颜色；中文字面量都作为 tr() 的第一参数', () => {
    const source = readFileSync('src/client/dev-section/extensions.tsx', 'utf8')
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    expect(withoutComments).not.toMatch(/rgba?\(/)

    const chineseLiterals = [...withoutComments.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)]
      .filter((match) => /[\u4e00-\u9fff]/.test(match[1]))
    expect(chineseLiterals.length).toBeGreaterThan(0)
    for (const literal of chineseLiterals) {
      const before = withoutComments.slice(0, literal.index)
      expect(before, '中文文案必须走 tr()：' + literal[1]).toMatch(/tr\(\s*$/)
    }
  })
})
