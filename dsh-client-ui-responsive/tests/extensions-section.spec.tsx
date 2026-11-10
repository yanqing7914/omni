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
