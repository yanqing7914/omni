/**
 * 应用更新入口（2026-11-10 用户定例）：右下角浮动胶囊 + 抽屉「更多」行右侧的常驻按钮。
 *
 * ## 两个入口为什么共用一份状态
 *
 * 壳侧 `apkUpdate` 是**同步返回 JSON 字符串**的桥（`@JavascriptInterface` 不能回 Promise），
 * 真源在 Android Activity 作用域，页面侧只能「发起 + 轮询读 status」。两个入口若各读各的，
 * 就会各发一份 check / install —— 壳侧 `beginCheck()` 会清掉已发现的新版载荷（currentResult），
 * 同一个包被两个入口轮流检查就等于把它抹掉。所以本模块只保留**一份** current 快照、
 * 一条轮询、一次自动检查，两个入口都从它渲染。
 *
 * ## 自动检查的节流与禁区
 *
 * 只有 `idle` / `up-to-date` / `failed` 才允许自动检查，且距上次自动检查超过 6 小时才发一次
 * （时间戳落 localStorage，读写都 try/catch：隐私模式里 storage 会抛）。
 * `available` / `downloading` / `installing` **绝不**发 check：壳侧 beginCheck() 会清掉已发现的
 * 新版载荷，此刻再检查等于把「可以下载的那个包」丢掉；`checking` 本身就在进行中，也不重发。
 *
 * ## 轮询纪律
 *
 * 只在 `checking` / `downloading` 期间每 2 秒读一次 status，到终态立即 clearInterval；
 * 不做常驻定时器。失败原因原样展示壳侧 `reason`（它已是成句中文，不翻译、不截断、不覆盖）。
 *
 * ## 抽屉按钮的插入方式
 *
 * 目标行是抽屉底部的账号菜单触发行（可见文案「更多」/「More」，`aria-label` 是
 * 「账号菜单」/「Account menu」）。它**不是** `mobile-form.css.ts:174` 隐藏的那个
 * `aria-haspopup=menu aria-label=更多`（PanelMoreMenu，在 nav 里、已隐藏）。
 * 我们只把按钮 append 到该行的容器里作为**最后一个子元素**（`margin-left:auto`），
 * 不 replaceWith、不抢 React 节点、不碰触发行自己的 click。React 重建会删掉我们的节点，
 * MutationObserver 在下一拍补回。
 */
import { tr } from '../i18n.ts'
import { noticeDataAttrs, type Notice } from '../user-copy.ts'
import type {} from '../android-bridge.ts'

/** 壳侧 apkUpdate 快照；字段与 `ApkUpdateState.snapshotJson` 逐字对应（与设置页同一条契约）。 */
interface ApkUpdateStatus {
  /** 本次调用是否被**受理**（不表示更新成功）。 */
  ok?: boolean
  /** idle / checking / up-to-date / available / downloading / installing / need-permission / failed */
  state?: string
  version?: string
  tag?: string
  name?: string
  current?: string
  sizeBytes?: number
  percent?: number
  reused?: boolean
  /** 壳侧用户可读中文原因，原样展示。 */
  reason?: string
  kind?: string
  hasReadyArtifact?: boolean
  canStart?: boolean
  code?: string
}

/** 进行中态：需要轮询。其余一律停止。 */
const BUSY_STATES = new Set(['checking', 'downloading'])
/** 允许自动检查的态；available/downloading/installing 绝不能 check（会清掉待装载荷）。 */
const AUTO_CHECK_STATES = new Set(['idle', 'up-to-date', 'failed'])
/** 右下角胶囊只在这些态出现；其余不占位。 */
const CAPSULE_STATES = new Set(['available', 'downloading', 'installing', 'need-permission', 'failed'])

/** 自动检查时间戳的 localStorage 键。 */
export const AUTO_CHECK_STORAGE_KEY = 'dsh-apk-auto-check-at'
/** 自动检查间隔：6 小时。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 进行中态的轮询间隔。 */
const POLL_INTERVAL_MS = 2000
/** 抽屉按钮提示的展示时长。 */
const NOTICE_DURATION_MS = 4000

const CAPSULE_ATTR = 'data-dsh-update-entry'
const CAPSULE_BUTTON_ATTR = 'data-dsh-update-action'
const CAPSULE_REASON_ATTR = 'data-dsh-update-reason'
const DRAWER_ATTR = 'data-dsh-update-drawer-entry'
const NOTICE_ATTR = 'data-dsh-update-notice'
const SETTINGS_DIALOG_SELECTOR = '[data-dsh-settings-dialog]'
const DRIVER_ATTRIBUTE = 'data-dsh-mobile-form'

/** 是否有可用的 apkUpdate 桥（桌面宿主没有）。 */
function bridgePresent(): boolean {
  try {
    return typeof window.androidBridge?.apkUpdate === 'function'
  } catch {
    return false
  }
}

/** 读壳侧状态；桥缺席或返回不可解析时为 null。 */
function readStatus(): ApkUpdateStatus | null {
  try {
    const raw = window.androidBridge?.apkUpdate?.('status')
    if (typeof raw !== 'string' || raw === '') return null
    const parsed = JSON.parse(raw) as ApkUpdateStatus
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** 发起一次动作；同步桥只回「受理与否」，真实进展仍以 status 读回为准。 */
function invoke(action: 'check' | 'install'): ApkUpdateStatus | null {
  try {
    const raw = window.androidBridge?.apkUpdate?.(action)
    if (typeof raw !== 'string' || raw === '') return null
    const parsed = JSON.parse(raw) as ApkUpdateStatus
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** 上次自动检查的时间戳；读不到/非法按 0（= 从未检查）处理。 */
function lastCheckAt(): number {
  try {
    const raw = localStorage.getItem(AUTO_CHECK_STORAGE_KEY)
    if (raw === null) return 0
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/** 记录本次自动检查的时间；storage 在隐私模式下会抛，吞掉即可（节流退化，不影响功能）。 */
function markCheckAt(): void {
  try {
    localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(Date.now()))
  } catch {
    /* storage unavailable */
  }
}

/** 内联下载图标（圆形描边 + 向下箭头），颜色继承 `currentColor`。 */
function downloadIcon(size: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('class', 'dsh-update-icon')

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '12')
  circle.setAttribute('cy', '12')
  circle.setAttribute('r', '9')
  svg.appendChild(circle)

  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  arrow.setAttribute('d', 'M12 7.2v7.1M8.9 11.4 12 14.5l3.1-3.1M8.5 17.2h7')
  svg.appendChild(arrow)
  return svg
}

/** 一个状态的胶囊文案与可点性；state 不在胶囊集合内时返回 null（不渲染）。 */
interface CapsuleView {
  text: string
  disabled: boolean
  reason: string | null
}

/** 按壳侧状态给出胶囊视图。 */
function capsuleView(state: string, status: ApkUpdateStatus): CapsuleView | null {
  switch (state) {
    case 'available':
      return { text: tr('有可用更新', 'Update available'), disabled: false, reason: null }
    case 'downloading': {
      const percent = typeof status.percent === 'number' && Number.isFinite(status.percent)
        ? String(Math.round(status.percent)) + '%'
        : ''
      return {
        text: percent === '' ? tr('正在下载', 'Downloading') : tr('正在下载 ', 'Downloading ') + percent,
        disabled: true,
        reason: null,
      }
    }
    case 'installing':
      return { text: tr('正在安装…', 'Installing…'), disabled: true, reason: null }
    case 'need-permission':
      return { text: tr('需要允许安装', 'Allow install'), disabled: false, reason: null }
    case 'failed':
      return {
        text: tr('重试更新', 'Retry update'),
        disabled: false,
        reason: status.reason ?? tr('更新未完成，可再次点击重试', 'The update did not finish; tap to retry.'),
      }
    default:
      return null
  }
}

/** 把一次 check 的回执翻成用户可读的提示（码只进 data-*，不上正文）。 */
function checkNotice(reply: ApkUpdateStatus | null): Notice {
  if (reply === null) {
    return { text: tr('更新通道不可用（仅安卓应用内有此能力）', 'Updates are only available inside the Android app.') }
  }
  if (reply.ok !== true) {
    return {
      text: reply.code === 'busy'
        ? tr('上一次更新动作仍在进行中，请稍候', 'The previous update is still running; please wait.')
        : tr('这次请求未被受理：', 'The request was not accepted: ') + (reply.reason ?? tr('可稍后重试', 'try again later')),
      ...(reply.code === undefined ? {} : { code: reply.code }),
    }
  }
  switch (reply.state) {
    case 'checking':
      return { text: tr('正在检查更新…', 'Checking for updates…') }
    case 'up-to-date':
      return {
        text: tr('已是最新版本', 'You are up to date') + (reply.version === undefined ? '' : ' ' + reply.version),
      }
    case 'available':
      return { text: tr('发现新版本，可下载并安装', 'A new version is available.') }
    case 'failed':
      return {
        text: reply.reason ?? tr('检查更新失败，请稍后重试', 'The update check failed; try again later.'),
        ...(reply.code === undefined ? {} : { code: reply.code }),
      }
    case 'need-permission':
      return { text: tr('需要允许安装未知应用', 'Permission to install unknown apps is required.') }
    case 'downloading':
      return { text: tr('正在下载更新…', 'Downloading the update…') }
    case 'installing':
      return { text: tr('正在安装…', 'Installing…') }
    default:
      return { text: tr('已发起检查，请稍候…', 'Checking; please wait…') }
  }
}

/** 抽屉里的「更多」行容器：账号菜单触发行（不是 nav 里被隐藏的 PanelMoreMenu）。 */
function findMoreRow(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
  for (const button of buttons) {
    // PanelMoreMenu 在 nav 里且已被样式隐藏；它也有 aria-label=更多，必须先排除。
    if (button.closest('nav') !== null) continue
    if (button.hasAttribute(DRAWER_ATTR)) continue
    const aria = (button.getAttribute('aria-label') ?? '').trim()
    const text = (button.textContent ?? '').trim()
    const accountMenu = aria === '账号菜单' || aria === 'Account menu'
    const moreLabel = aria === '更多' || aria === 'More' || text === '更多' || text === 'More'
    if (!accountMenu && !moreLabel) continue
    return button.parentElement
  }
  return null
}

/**
 * 安装两个更新入口。
 * @returns 清理函数：断观察器、停轮询、清提示定时器、移除自产节点。
 */
export function installUpdateEntry(): () => void {
  if (typeof document === 'undefined') return () => {}

  let disposed = false
  let current: ApkUpdateStatus | null = readStatus()
  let pollTimer: number | undefined
  let noticeTimer: number | undefined
  let notice: Notice | null = null
  let noticeElement: HTMLDivElement | null = null
  let dialogOpen = document.querySelector(SETTINGS_DIALOG_SELECTOR) !== null
  let scheduled = false
  /** 抽屉发起的 check 若回 checking，等轮询到终态后补一条最终结果提示。 */
  let manualCheckPending = false

  let capsuleRoot: HTMLDivElement | null = null
  let capsuleButton: HTMLButtonElement | null = null
  let capsuleLabel: HTMLSpanElement | null = null
  let capsuleReason: HTMLDivElement | null = null
  let drawerButton: HTMLButtonElement | null = null

  /** 当前壳侧状态名；快照缺席按空串（两边都不渲染或不加徽标）。 */
  const stateOf = (): string => (typeof current?.state === 'string' ? current.state : '')

  /** 停止进行中态轮询。 */
  const stopPoll = (): void => {
    if (pollTimer === undefined) return
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }

  /** 只在 checking/downloading 期间挂 2 秒轮询；终态立即停。 */
  const syncPoll = (): void => {
    if (!BUSY_STATES.has(stateOf())) {
      stopPoll()
      return
    }
    if (pollTimer !== undefined) return
    pollTimer = window.setInterval(() => {
      if (disposed) return
      current = readStatus()
      // 抽屉发起的手动检查：checking 时不急着下结论，等本次轮询读到终态再给最终提示。
      if (manualCheckPending && !BUSY_STATES.has(stateOf())) {
        manualCheckPending = false
        showNotice(checkNotice(current))
      }
      render()
      syncPoll()
    }, POLL_INTERVAL_MS)
  }

  /** 建/取胶囊的固定节点；已存在则复用。 */
  const ensureCapsule = (): void => {
    if (capsuleRoot !== null) return
    const root = document.createElement('div')
    root.className = 'dsh-update-entry'
    root.setAttribute(CAPSULE_ATTR, '')

    const reason = document.createElement('div')
    reason.className = 'dsh-update-entry-reason'
    reason.setAttribute(CAPSULE_REASON_ATTR, '')
    reason.hidden = true
    root.appendChild(reason)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-update-entry-button'
    button.setAttribute(CAPSULE_BUTTON_ATTR, 'install')
    button.appendChild(downloadIcon(20))
    const label = document.createElement('span')
    label.className = 'dsh-update-entry-label'
    button.appendChild(label)
    button.addEventListener('click', onCapsuleClick)
    root.appendChild(button)

    document.body.appendChild(root)
    capsuleRoot = root
    capsuleButton = button
    capsuleLabel = label
    capsuleReason = reason
  }

  /** 移除胶囊节点（其余态不占位；设置弹层打开时也不压在上面）。 */
  const removeCapsule = (): void => {
    if (capsuleRoot === null) return
    capsuleRoot.remove()
    capsuleRoot = null
    capsuleButton = null
    capsuleLabel = null
    capsuleReason = null
  }

  /** 渲染右下角胶囊。 */
  const renderCapsule = (): void => {
    const state = stateOf()
    const view = capsuleView(state, current ?? {})
    if (view === null || dialogOpen) {
      removeCapsule()
      return
    }
    ensureCapsule()
    if (capsuleRoot === null || capsuleButton === null || capsuleLabel === null || capsuleReason === null) return
    capsuleRoot.dataset.updateState = state
    // 只在变化时写 textContent：重复写同一个文本仍是 childList 变更，会与 MutationObserver
    // 互相触发成无尽的微任务循环（实测会把测试进程钉在 100% CPU）。
    if (capsuleLabel.textContent !== view.text) capsuleLabel.textContent = view.text
    capsuleButton.disabled = view.disabled
    capsuleButton.setAttribute('aria-label', view.text)
    if (view.reason === null) {
      capsuleReason.hidden = true
      if (capsuleReason.textContent !== '') capsuleReason.textContent = ''
      capsuleReason.removeAttribute('title')
    } else {
      capsuleReason.hidden = false
      if (capsuleReason.textContent !== view.reason) capsuleReason.textContent = view.reason
      // 一行小字的完整原文仍可从 title 读到（视觉截断不改变壳侧原话）。
      capsuleReason.title = view.reason
    }
  }

  /** 更新抽屉按钮的徽标/无障碍名，并保证它仍是行容器的最后一个子元素。 */
  const syncDrawerButton = (button: HTMLButtonElement): void => {
    const parent = button.parentElement
    if (parent !== null && parent.lastElementChild !== button) parent.appendChild(button)
    const available = stateOf() === 'available'
    button.dataset.updateAvailable = available ? 'true' : 'false'
    button.setAttribute(
      'aria-label',
      available ? tr('有可用更新，点击下载并安装', 'Update available; tap to download and install') : tr('检查更新', 'Check for updates'),
    )
  }

  /** 抽屉里的圆形更新按钮；始终挂在「更多」行容器末尾。 */
  const renderDrawer = (): void => {
    const enabled = bridgePresent() && document.documentElement.hasAttribute(DRIVER_ATTRIBUTE)
    if (!enabled) {
      drawerButton?.remove()
      drawerButton = null
      return
    }

    // 常规路径：按钮还挂在行里（聊天流式输出会高频触发观察器）。只做末位校正与徽标更新，
    // 不重扫整页 —— 只有 React 把节点删掉/换行后 isConnected 才会变 false。
    if (drawerButton !== null && drawerButton.isConnected) {
      syncDrawerButton(drawerButton)
      return
    }

    const row = findMoreRow()
    if (row === null) return

    if (drawerButton === null || drawerButton.parentElement !== row) {
      drawerButton?.remove()
      // 热推重装后旧实例可能留下同标记的按钮；先清掉，避免一行两份。
      for (const stale of row.querySelectorAll('[' + DRAWER_ATTR + ']')) stale.remove()
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-drawer-update'
      button.setAttribute(DRAWER_ATTR, '')
      button.appendChild(downloadIcon(24))
      const dot = document.createElement('span')
      dot.className = 'dsh-drawer-update-dot'
      dot.setAttribute('aria-hidden', 'true')
      button.appendChild(dot)
      button.addEventListener('click', onDrawerClick)
      drawerButton = button
    }
    row.appendChild(drawerButton)
    syncDrawerButton(drawerButton)
  }

  /** 渲染抽屉按钮触发的提示（role=status + aria-live，码只进 data-*）。 */
  const renderNotice = (): void => {
    if (notice === null) {
      noticeElement?.remove()
      noticeElement = null
      return
    }
    if (noticeElement === null) {
      const element = document.createElement('div')
      element.className = 'dsh-update-notice'
      element.setAttribute(NOTICE_ATTR, '')
      element.setAttribute('role', 'status')
      element.setAttribute('aria-live', 'polite')
      document.body.appendChild(element)
      noticeElement = element
    }
    // 同胶囊：重复赋值会产生 childList 变更，必须先比较再写。
    if (noticeElement.textContent !== notice.text) noticeElement.textContent = notice.text
    for (const [name, value] of Object.entries(noticeDataAttrs(notice))) {
      noticeElement.setAttribute(name, value)
    }
  }

  /** 展示一条提示并在数秒后自动收起。 */
  const showNotice = (next: Notice): void => {
    notice = next
    renderNotice()
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      noticeTimer = undefined
      notice = null
      renderNotice()
    }, NOTICE_DURATION_MS)
  }

  /** 统一重绘两个入口。 */
  const render = (): void => {
    if (disposed) return
    renderCapsule()
    renderDrawer()
    renderNotice()
  }

  /** 应用一次动作回执，再重绘与收敛轮询。 */
  const applyReply = (reply: ApkUpdateStatus | null): void => {
    if (reply !== null) current = reply
    else current = readStatus()
    render()
    syncPoll()
  }

  /** 胶囊点击：available / need-permission / failed 都发 install（壳侧负责续继与权限）。 */
  function onCapsuleClick(): void {
    const state = stateOf()
    if (state !== 'available' && state !== 'need-permission' && state !== 'failed') return
    applyReply(invoke('install'))
  }

  /**
   * 抽屉按钮点击：有新版 → install；其余 → check，并把结果用提示呈现。
   * 按钮是触发行的**兄弟节点**，但仍 stopPropagation，避免宿主给容器挂的委托处理器误判。
   */
  function onDrawerClick(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (stateOf() === 'available') {
      manualCheckPending = false
      applyReply(invoke('install'))
      return
    }
    const reply = invoke('check')
    showNotice(checkNotice(reply))
    // 同步桥通常只回 checking；最终结论由后面的轮询给出（不能只停在「检查中」）。
    manualCheckPending = reply !== null && reply.ok === true && reply.state === 'checking'
    applyReply(reply)
  }

  // 自动检查：只在空闲/已最新/失败且距上次超过 6 小时时发一次。
  const initialState = stateOf()
  if (bridgePresent() && AUTO_CHECK_STATES.has(initialState) && Date.now() - lastCheckAt() > AUTO_CHECK_INTERVAL_MS) {
    markCheckAt()
    const reply = invoke('check')
    if (reply !== null) current = reply
  }

  render()
  syncPoll()

  // 设置弹层出现/消失时同步胶囊；React 重建「更多」行时补回抽屉按钮。
  const sync = (): void => {
    if (disposed) return
    const open = document.querySelector(SETTINGS_DIALOG_SELECTOR) !== null
    if (open !== dialogOpen) dialogOpen = open
    render()
  }
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      sync()
    })
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  // 手机形态标记可能在插件装配之后才落到 <html> 上。
  const markerObserver = new MutationObserver(schedule)
  markerObserver.observe(document.documentElement, { attributes: true, attributeFilter: [DRIVER_ATTRIBUTE] })

  return () => {
    disposed = true
    observer.disconnect()
    markerObserver.disconnect()
    stopPoll()
    if (noticeTimer !== undefined) {
      window.clearTimeout(noticeTimer)
      noticeTimer = undefined
    }
    removeCapsule()
    drawerButton?.remove()
    drawerButton = null
    noticeElement?.remove()
    noticeElement = null
    notice = null
  }
}
