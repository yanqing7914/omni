// @vitest-environment jsdom
// 应用更新入口（2026-11-10 用户定例）：
//   - 右下角：只在发现新版/下载/安装/需要权限/失败时出现的深色胶囊；
//   - 抽屉「更多」行右侧：常驻的圆形更新按钮。
// 两个入口共用一份状态与一次轮询（壳侧 beginCheck() 会清掉已发现的新版载荷，
// 各读各的会把可下载的包抹掉）。本套用例钉住：
//   U1 胶囊只在五种态出现；idle/up-to-date 不占位。
//   U2 点击 → install；downloading 显示真实百分比并禁用。
//   U3 桥缺席不渲染、不抛错（桌面宿主）。
//   U4 自动检查 6 小时节流；available 绝不 check（会清掉载荷）。
//   U5 checking 期间每 2 秒读 status，到终态立即停。
//   U6 need-permission / failed 的文案、可点性与壳侧 reason 原文。
//   U7 设置弹层存在时不渲染。
//   U8 新文件无硬编码颜色、用户可见文案全部经 tr()。
//   U9 设置页「应用更新」分区仍冻结，开发者选项的旧指路已删除。
//   N1-N6 抽屉「更多」行按钮：位置、重建自愈、桥缺席、动作分流、行点击不受影响、颜色 token。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { installUpdateEntry, AUTO_CHECK_STORAGE_KEY } from '../src/client/mobile/update-entry.ts'

const MOBILE_ATTR = 'data-dsh-mobile-form'
const DRAWER_ATTR = 'data-dsh-update-drawer-entry'
const CAPSULE_ATTR = 'data-dsh-update-entry'
const CAPSULE_ACTION = 'data-dsh-update-action'
const CAPSULE_REASON = 'data-dsh-update-reason'
const SETTINGS_DIALOG = '[data-dsh-settings-dialog]'

let cleanup: (() => void) | undefined

/** 让自动检查在本次用例里不触发（除非用例自己写成过期时间戳）。 */
function preventAutoCheck(): void {
  localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(Date.now()))
}

/** 让自动检查视作「上次检查已超过 6 小时」。 */
function allowAutoCheck(): void {
  localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(Date.now() - 7 * 60 * 60 * 1000))
}

/** 装桥并记录动作序列；handler 按动作返回快照。 */
function setBridge(handler: (action: string, index: number) => Record<string, unknown>): string[] {
  const calls: string[] = []
  Object.defineProperty(window, 'androidBridge', {
    value: {
      apkUpdate: (action: string) => {
        calls.push(action)
        return JSON.stringify(handler(action, calls.length))
      },
    },
    configurable: true,
    writable: true,
  })
  return calls
}

/** 所有动作都回同一个状态的桥。 */
function bridgeStatus(state: string, extra: Record<string, unknown> = {}): string[] {
  return setBridge(() => ({ ok: true, state, ...extra }))
}

/** 手机形态标记（抽屉按钮只在这个标记下插入）。 */
function enableMobileForm(): void {
  document.documentElement.setAttribute(MOBILE_ATTR, '')
}

/** 造一个「更多」行：账号菜单触发行（可见文案「更多」，aria-label 账号菜单）。 */
function makeMoreTrigger(): HTMLButtonElement {
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-label', '账号菜单')
  const glyph = document.createElement('span')
  glyph.textContent = '⋯'
  const label = document.createElement('span')
  label.textContent = '更多'
  trigger.append(glyph, label)
  return trigger
}

interface MoreRow {
  row: HTMLElement
  trigger: HTMLButtonElement
}

/** 把「更多」行挂进 body，返回行容器与触发行。 */
function seedMoreRow(): MoreRow {
  const sidebar = document.createElement('div')
  const row = document.createElement('div')
  const trigger = makeMoreTrigger()
  row.appendChild(trigger)
  sidebar.appendChild(row)
  document.body.appendChild(sidebar)
  return { row, trigger }
}

/** 安装入口。 */
function mount(): void {
  cleanup = installUpdateEntry()
}

/** 等一次宏任务：MutationObserver 的微任务链之后。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const capsule = (): HTMLElement | null => document.querySelector('[' + CAPSULE_ATTR + ']')
const capsuleButton = (): HTMLButtonElement | null => document.querySelector('[' + CAPSULE_ACTION + '="install"]')
const drawerButton = (): HTMLButtonElement | null => document.querySelector('[' + DRAWER_ATTR + ']')

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute(MOBILE_ATTR)
  document.body.innerHTML = ''
  Object.defineProperty(window, 'androidBridge', { value: undefined, configurable: true, writable: true })
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  document.documentElement.removeAttribute(MOBILE_ATTR)
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('U1 胶囊的出现条件', () => {
  it('available 渲染「有可用更新」；idle / up-to-date 不渲染任何节点', () => {
    preventAutoCheck()
    bridgeStatus('available', { tag: 'v1.0.1' })
    mount()
    expect(capsule()?.textContent).toContain('有可用更新')
    expect(capsuleButton()?.disabled).toBe(false)

    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
    bridgeStatus('idle')
    mount()
    expect(capsule(), 'idle 不占位').toBeNull()

    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
    bridgeStatus('up-to-date', { version: 'v1.0.0' })
    mount()
    expect(capsule(), 'up-to-date 不占位').toBeNull()
  })
})

describe('U2 点击与下载进度', () => {
  it('点击发 install；downloading percent=42 显示「正在下载 42%」且禁用', () => {
    preventAutoCheck()
    const calls = setBridge((action) => action === 'install'
      ? { ok: true, state: 'downloading', percent: 42 }
      : { ok: true, state: 'available', tag: 'v1.0.1' })
    mount()
    calls.length = 0
    capsuleButton()!.click()
    expect(calls).toContain('install')
    expect(capsule()?.textContent).toContain('正在下载 42%')
    expect(capsuleButton()!.disabled, '下载中禁止重复点击').toBe(true)
  })

  it('percent 缺失时只显示「正在下载」', () => {
    preventAutoCheck()
    bridgeStatus('downloading', { name: 'x.apk' })
    mount()
    expect(capsule()?.textContent).toContain('正在下载')
    expect(capsule()?.textContent).not.toContain('%')
    expect(capsuleButton()!.disabled).toBe(true)
  })
})

describe('U3 桥缺席', () => {
  it('桌面宿主不渲染胶囊、不插入抽屉按钮、不抛错', () => {
    enableMobileForm()
    seedMoreRow()
    expect(() => mount()).not.toThrow()
    expect(capsule()).toBeNull()
    expect(drawerButton()).toBeNull()
  })
})

describe('U4 自动检查节流', () => {
  it('未满 6h 不发 check；超过 6h 只发一次', () => {
    preventAutoCheck()
    const recent = bridgeStatus('idle')
    mount()
    expect(recent.filter((call) => call === 'check'), '6 小时内不自动检查').toHaveLength(0)

    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
    allowAutoCheck()
    const stale = bridgeStatus('idle')
    mount()
    expect(stale.filter((call) => call === 'check'), '超过 6 小时发一次').toHaveLength(1)
  })

  it('available / downloading / installing 时永不发 check（壳侧会清掉载荷）', () => {
    for (const state of ['available', 'downloading', 'installing']) {
      cleanup?.()
      cleanup = undefined
      document.body.innerHTML = ''
      allowAutoCheck()
      const calls = bridgeStatus(state, { tag: 'v1.0.1', percent: 10 })
      mount()
      expect(calls.filter((call) => call === 'check'), state + ' 下不得自动 check').toHaveLength(0)
    }
  })
})

describe('U5 轮询收敛', () => {
  it('checking 期间每 2s 读 status；到 up-to-date 立即停', async () => {
    vi.useFakeTimers()
    preventAutoCheck()
    let statusCalls = 0
    setBridge((action) => {
      if (action === 'status') {
        statusCalls += 1
        return statusCalls === 1
          ? { ok: true, state: 'checking' }
          : { ok: true, state: 'up-to-date', version: 'v1.0.0' }
      }
      return { ok: true, state: 'up-to-date' }
    })
    mount()
    expect(statusCalls, '挂载时读一次').toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusCalls, '第一次轮询读到终态').toBe(2)

    const terminal = statusCalls
    await vi.advanceTimersByTimeAsync(6000)
    expect(statusCalls, '终态后不再读').toBe(terminal)
  })
})

describe('U6 需要权限与失败态', () => {
  it('need-permission：文案「需要允许安装」、可点击且发 install', () => {
    preventAutoCheck()
    const calls = bridgeStatus('need-permission')
    mount()
    expect(capsule()?.textContent).toContain('需要允许安装')
    expect(capsuleButton()!.disabled).toBe(false)
    calls.length = 0
    capsuleButton()!.click()
    expect(calls).toContain('install')
  })

  it('failed：可再次点击发 install，壳侧 reason 原文显示在胶囊上方', () => {
    preventAutoCheck()
    const reason = '下载失败：镜像链全部不可用'
    const calls = bridgeStatus('failed', { reason })
    mount()
    expect(document.querySelector('[' + CAPSULE_REASON + ']')?.textContent).toBe(reason)
    const button = capsuleButton()!
    expect(button.disabled, '失败态应可重试').toBe(false)
    calls.length = 0
    button.click()
    expect(calls).toContain('install')
  })
})

describe('U7 设置弹层遮挡', () => {
  it('设置对话框存在时不渲染；关闭后恢复', async () => {
    preventAutoCheck()
    bridgeStatus('available', { tag: 'v1.0.1' })
    const dialog = document.createElement('div')
    dialog.setAttribute('data-dsh-settings-dialog', '')
    document.body.appendChild(dialog)
    mount()
    expect(capsule(), '弹层打开时不压在上面').toBeNull()

    dialog.remove()
    await flush()
    expect(capsule(), '弹层关闭后恢复').not.toBeNull()

    const reopened = document.createElement('div')
    reopened.setAttribute('data-dsh-settings-dialog', '')
    document.body.appendChild(reopened)
    await flush()
    expect(capsule()).toBeNull()
  })
})

describe('U8 源码纪律', () => {
  const files = [
    ['src/client/mobile/update-entry.ts', readFileSync('src/client/mobile/update-entry.ts', 'utf8')],
    ['src/client/mobile/update-entry.css.ts', readFileSync('src/client/mobile/update-entry.css.ts', 'utf8')],
  ] as const

  it('新增文件无硬编码颜色', () => {
    for (const [name, source] of files) {
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, name).not.toMatch(/\brgba?\(/)
      expect(source, name).not.toMatch(/\bhsla?\(/)
    }
  })

  it('用户可见文案全部经 tr()', () => {
    const source = files[0][1]
    for (const label of [
      "tr('有可用更新'",
      "tr('正在下载 '",
      "tr('正在下载'",
      "tr('正在安装…'",
      "tr('需要允许安装'",
      "tr('重试更新'",
      "tr('检查更新'",
      "tr('有可用更新，点击下载并安装'",
    ]) {
      expect(source, '缺少经 tr() 的文案：' + label).toContain(label)
    }
    // 直接把中文字面量赋给 textContent 会绕过 tr()（壳侧语言切换后停在中文）。
    expect(source).not.toMatch(/textContent\s*=\s*['"`][^'"`]*[一-鿿]/)
  })
})

describe('U9 设置分区冻结', () => {
  it('APK_UPDATE_SECTION_FROZEN = true，注册被开关包住', () => {
    const index = readFileSync('src/client/index.ts', 'utf8')
    expect(index).toContain('APK_UPDATE_SECTION_FROZEN = true')
    expect(index).toMatch(/if \(!APK_UPDATE_SECTION_FROZEN\) \{\s*ctx\.slots\.inject/)
    expect(index).toContain("id: 'android-apk-update'")
  })

  it('开发者选项不再有指向设置页的旧指路', () => {
    const dev = readFileSync('src/client/dev-section/DevSection.tsx', 'utf8')
    expect(dev).not.toContain('应用更新在「设置 → 应用更新」里')
  })
})

describe('N1-N3 抽屉「更多」行按钮', () => {
  it('N1 行容器末尾渲染一枚更新按钮', () => {
    enableMobileForm()
    preventAutoCheck()
    bridgeStatus('idle')
    const { row } = seedMoreRow()
    mount()
    const button = row.querySelector<HTMLButtonElement>('[' + DRAWER_ATTR + ']')
    expect(button, '应插入更新按钮').not.toBeNull()
    expect(row.lastElementChild, '必须是行容器的最后一个子元素').toBe(button)
    expect(row.querySelectorAll('[' + DRAWER_ATTR + ']')).toHaveLength(1)
  })

  it('N2 React 重建行内节点后，下一拍补回且只有一份', async () => {
    enableMobileForm()
    preventAutoCheck()
    bridgeStatus('idle')
    const { row } = seedMoreRow()
    mount()
    expect(row.querySelectorAll('[' + DRAWER_ATTR + ']')).toHaveLength(1)

    // 模拟 React 把行内节点整批重建：旧节点（含我们的按钮）全部消失。
    row.innerHTML = ''
    row.appendChild(makeMoreTrigger())
    await flush()

    expect(row.querySelectorAll('[' + DRAWER_ATTR + ']'), '必须补回且只有一份').toHaveLength(1)
    expect(row.lastElementChild?.hasAttribute(DRAWER_ATTR)).toBe(true)
  })

  it('N3 桥缺席时不插入、不抛错', () => {
    enableMobileForm()
    const { row } = seedMoreRow()
    expect(() => mount()).not.toThrow()
    expect(row.querySelector('[' + DRAWER_ATTR + ']')).toBeNull()
  })
})

describe('N4-N6 抽屉按钮行为与样式', () => {
  it('N4 available 发 install；其余发 check', () => {
    enableMobileForm()
    preventAutoCheck()
    const availableCalls = setBridge((action) => action === 'install'
      ? { ok: true, state: 'downloading', percent: 10 }
      : { ok: true, state: 'available', tag: 'v1.0.1' })
    const first = seedMoreRow()
    mount()
    availableCalls.length = 0
    first.row.querySelector<HTMLButtonElement>('[' + DRAWER_ATTR + ']')!.click()
    expect(availableCalls).toEqual(['install'])

    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
    enableMobileForm()
    preventAutoCheck()
    const checkCalls = bridgeStatus('up-to-date', { version: 'v1.0.0' })
    const second = seedMoreRow()
    mount()
    checkCalls.length = 0
    second.row.querySelector<HTMLButtonElement>('[' + DRAWER_ATTR + ']')!.click()
    expect(checkCalls).toEqual(['check'])
    expect(checkCalls).not.toContain('install')
  })

  it('N5 点「更多」行仍触发行自己的 handler；点更新按钮不触发行 handler', () => {
    enableMobileForm()
    preventAutoCheck()
    bridgeStatus('idle')
    const { row, trigger } = seedMoreRow()
    const rowClick = vi.fn()
    trigger.addEventListener('click', rowClick)
    mount()

    trigger.click()
    expect(rowClick, '行文字点击不受影响').toHaveBeenCalledTimes(1)

    rowClick.mockClear()
    row.querySelector<HTMLButtonElement>('[' + DRAWER_ATTR + ']')!.click()
    expect(rowClick, '更新按钮是兄弟节点且 stopPropagation').not.toHaveBeenCalled()
  })

  it('N6 抽屉按钮颜色只走 --dsw-* token', () => {
    const css = readFileSync('src/client/mobile/update-entry.css.ts', 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).toContain('var(--dsw-alias-label-secondary)')
    expect(css).toContain('var(--dsw-alias-state-warn-primary)')
  })
})
