/**
 * 设置页「扩展」分区：技能 + 插件两个 tab。
 *
 * 为什么落在这里：技能市场与插件市场的服务端路由都已经存在（`dsh-skill-market` 的
 * `/api/skillmarket/*` 与 vendored 的 `/api/dshmarketplace/*`），但设置页一直没有页面侧入口。
 * 本组件只做页面侧编排：同源 fetch、分组、搜索、安装/卸载与如实错误呈现，不改服务端。
 *
 * 数据面纪律：
 *  - 技能目录是一次性小列表，搜索在本地过滤（名称 + 中英简介都参与匹配）；
 *  - 插件目录有上万条，搜索必须走服务端 `q`（300ms 防抖），页面只做分组与分页追加；
 *  - 安装/卸载成功后**重新 GET 已安装列表**，不把成功响应当成展示真源；
 *  - 服务端写入串行，同一时刻只允许一个操作，其余按钮禁用；
 *  - 失败原因按服务端错误码翻成人话，原始码只进 `data-code`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { tr, isEnglish } from '../i18n.ts'
import { noticeDataAttrs, type Notice } from '../user-copy.ts'

// ── 接口形态（以服务端实际返回为准） ───────────────────────────────────────

/** 技能可声明的能力依赖闭集；与服务端 `SkillRequirement` 保持一致。 */
type SkillRequirement = 'a11y' | 'shizuku' | 'real-screen'

interface InstalledSkill {
  id: string
  name: string
  description: string
  source: 'user' | 'bundled'
  path?: string
  removable: boolean
  requires: SkillRequirement[]
  updateAvailable: boolean
}

interface BilingualText {
  en?: string
  zh?: string
}

interface MarketSkill {
  id: string
  name: string
  title?: BilingualText
  description?: BilingualText
  category?: string
  installed?: boolean
  installedSource?: 'user' | 'bundled'
  removable?: boolean
  requires: SkillRequirement[]
  updateAvailable?: boolean
}

interface MarketCategory {
  id: string
  title?: BilingualText
}

interface MarketList {
  categories: MarketCategory[]
  skills: MarketSkill[]
  /** 服务端用了缓存清单（离线兜底）时为 true。 */
  stale: boolean
  /** 缓存写入时间（毫秒时间戳）；没有缓存或服务端未带时为空。 */
  savedAt?: number
}

interface PluginItem {
  fullName: string
  name?: string
  owner?: string
  summary?: string
  summaryZh?: string
  category?: string
  compat?: string
  compatNote?: string
  stars?: number
  installable?: boolean
}

interface PluginPage {
  total: number
  count?: number
  results: PluginItem[]
}

type LoadKind = 'loading' | 'ok' | 'error'

/** 一次只允许一个写操作的状态；`id` 为空表示空闲。 */
interface BusyOperation {
  id: string
  kind: 'install' | 'uninstall' | 'update'
}

// ── 文案与错误码 ───────────────────────────────────────────────────────────

/**
 * 技能市场错误码 → 人话。
 *
 * 码来自 `plugins/dsh-skill-market/src/errors.ts` 的闭集；新增码在这里必须同步补一句，
 * 否则兜底句会把它变成「操作失败」——用户看不到该做什么。
 */
function describeSkillError(code: string): string {
  switch (code) {
    case 'INVALID_ID':
      return tr('技能标识无效——请刷新市场后重试', 'That skill id is not valid. Refresh the market and try again.')
    case 'INVALID_BODY':
    case 'BODY_TOO_LARGE':
      return tr('请求格式不正确——请更新应用到较新版本后重试', 'The request format was rejected. Update the app and try again.')
    case 'INVALID_MANIFEST':
      return tr('技能市场的清单格式不正确——请稍后重试', 'The skill market manifest is malformed. Try again later.')
    case 'MARKET_UNAVAILABLE':
      return tr('技能市场暂时不可用——请检查网络后重试', 'The skill market is unavailable. Check your connection and try again.')
    case 'SKILL_NOT_FOUND':
      return tr('市场里找不到这个技能——请刷新后重试', 'The market has no skill with that id. Refresh and try again.')
    case 'ALREADY_EXISTS':
      return tr('本地已有同名技能目录——请先卸载它，或换一个技能', 'A skill with this id already exists locally. Uninstall it first, or pick another skill.')
    case 'ALREADY_INSTALLED':
      return tr('这个技能已经安装', 'This skill is already installed.')
    case 'CHECKSUM_MISMATCH':
      return tr('下载内容校验不通过（文件损坏或被篡改），已拒绝安装——请重试', 'The download failed its checksum (corrupt or tampered) and was refused. Try again.')
    case 'DOWNLOAD_FAILED':
      return tr('技能文件下载失败——请检查网络后重试', 'The skill files could not be downloaded. Check your connection and try again.')
    case 'URL_NOT_ALLOWED':
      return tr('市场地址不在允许列表内——请更新应用后重试', 'The market address is not allowlisted. Update the app and try again.')
    case 'UNSAFE_PATH':
      return tr('技能包含不安全的路径，已拒绝安装', 'The skill contains an unsafe path and was refused.')
    case 'INSTALL_TIMEOUT':
      return tr('安装超时——请重试', 'The install timed out. Try again.')
    case 'BUNDLED_NOT_REMOVABLE':
      return tr('内置技能不能卸载', 'Built-in skills cannot be uninstalled.')
    case 'NOT_INSTALLED':
      return tr('这个技能当前未安装——请刷新后重试', 'This skill is not installed. Refresh and try again.')
    case 'INTERNAL':
      return tr('应用内部出错——请稍后重试；仍失败可复制日志反馈', 'The app hit an internal error. Try again; if it keeps failing, copy the log and report it.')
    default:
      return tr('操作失败——请重试；仍失败可复制日志反馈', 'The operation failed. Try again; if it keeps failing, copy the log and report it.')
  }
}

/**
 * 插件市场错误码 → 人话。
 *
 * 码来自 vendored 插件的 `InstallError` 与两条目录查询路径；服务端同时会带 `error` 原文，
 * 已登记的码优先用这里的成句解释，未登记的码回显原文（原文本身是用户可读的英文句子）。
 */
function describePluginError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'NO_LISTING':
    case 'NO_COMMAND':
      return tr('这个插件没有可用的安装命令——请换一个插件', 'This plugin has no usable install command. Pick another plugin.')
    case 'LISTING_NOT_FOUND':
      return tr('目录里找不到这个插件——请刷新后重试', 'The catalogue has no matching plugin. Refresh and try again.')
    case 'LISTING_LOOKUP_FAILED':
      return tr('查询插件目录失败——请检查网络后重试', 'The plugin catalogue lookup failed. Check your connection and try again.')
    case 'UNSAFE_COMMAND':
      return tr('安装命令未通过安全校验，已拒绝', 'The install command failed the safety check and was refused.')
    case 'INSTALL_FAILED':
      return tr('插件安装失败——请稍后重试；仍失败可复制日志反馈', 'The plugin install failed. Try again; if it keeps failing, copy the log and report it.')
    default:
      if (message !== undefined && message.trim() !== '') return message
      return tr('插件安装失败——请重试', 'The plugin install failed. Try again.')
  }
}

/** HTTP 状态 → 人话（与本包其它设置面同一分档；动作名已由调用方按语言取好）。 */
function describeHttpError(action: string, status: number): string {
  if (status === 401 || status === 403) {
    return action + tr('：未获授权——请确认是在本机应用内操作；仍失败请重新打开应用', ' was not authorized. Make sure you are in the app; reopen it if it still fails.')
  }
  if (status === 404) {
    return action + tr('：接口不存在（本版不匹配或安装包不完整）——请更新或重新安装应用', ' is unavailable in this build (version mismatch or incomplete install). Update or reinstall the app.')
  }
  if (status === 405) {
    return action + tr('：不被允许——请更新应用到较新版本后再试', ' is not allowed. Update the app and try again.')
  }
  if (status >= 500) {
    return action + tr('时应用内部出错——请稍后重试；仍失败可复制日志反馈', ' hit an internal error. Try again; if it keeps failing, copy the log and report it.')
  }
  if (status >= 400) {
    return action + tr('被应用拒绝——请稍后重试', ' was refused by the app. Try again later.')
  }
  return action + tr('失败——请稍后重试', ' failed. Try again later.')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 从错误响应体里取 `code`/`error`，翻成 [Notice]。 */
function noticeFromResponse(
  payload: unknown,
  status: number,
  action: string,
): Notice {
  const body = asRecord(payload)
  const code = body !== null && typeof body.code === 'string' && body.code !== '' ? body.code : undefined
  if (code !== undefined) return { text: describeSkillError(code), code }
  return { text: describeHttpError(action, status), http: status }
}

function networkNotice(): Notice {
  return {
    text: tr('网络或应用内连接不可用——请确认网络通畅后重试', 'The network or in-app connection is unavailable. Check your connection and try again.'),
  }
}

// ── 数据归一化与筛选 ───────────────────────────────────────────────────────

function readBilingual(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  const record = asRecord(value)
  if (record === null) return []
  const out: string[] = []
  if (typeof record.zh === 'string' && record.zh !== '') out.push(record.zh)
  if (typeof record.en === 'string' && record.en !== '') out.push(record.en)
  return out
}

/**
 * 只保留服务端允许的两个值。
 *
 * 服务端解析已经过滤过一遍；页面再收窄一次，避免旧/新服务端形态不一致时把一个
 * 不认识的依赖当成「必须满足」而误禁用安装。
 */
function normalizeRequires(value: unknown): SkillRequirement[] {
  if (!Array.isArray(value)) return []
  const requires: SkillRequirement[] = []
  for (const item of value) {
    if ((item === 'a11y' || item === 'shizuku' || item === 'real-screen') && !requires.includes(item)) requires.push(item)
  }
  return requires
}

/** 按当前语言取展示文本（中文优先作为默认语言）。 */
function displayBilingual(value: unknown): string {
  const texts = readBilingual(value)
  if (texts.length === 0) return ''
  if (!isEnglish()) return texts[0]
  return texts.length > 1 ? texts[1] : texts[0]
}

function normalizeInstalled(raw: unknown): InstalledSkill | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id : ''
  if (id === '') return null
  return {
    id,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : id,
    description: typeof record.description === 'string' ? record.description : '',
    source: record.source === 'bundled' ? 'bundled' : 'user',
    path: typeof record.path === 'string' ? record.path : undefined,
    // 卸载入口只认服务端明确的 removable=true；缺字段按不可卸载处理。
    removable: record.removable === true,
    requires: normalizeRequires(record.requires),
    // 更新入口只认服务端明确的 true；缺字段按「没有新版」处理，避免误报。
    updateAvailable: record.updateAvailable === true,
  }
}

function parseInstalled(payload: unknown): InstalledSkill[] {
  const record = asRecord(payload)
  // 服务端当前返回数组；同时兼容 `{ skills: [...] }`，避免两侧形态微调时白屏。
  const list = Array.isArray(payload)
    ? payload
    : (record !== null && Array.isArray(record.skills) ? record.skills : null)
  if (list === null) throw new Error('unexpected installed payload')
  return list.map(normalizeInstalled).filter((skill): skill is InstalledSkill => skill !== null)
}

function normalizeMarketSkill(raw: unknown): MarketSkill | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id : ''
  if (id === '') return null
  return {
    id,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : id,
    title: asRecord(record.title) as BilingualText | undefined,
    description: (typeof record.description === 'string'
      ? { en: record.description }
      : asRecord(record.description)) as BilingualText | undefined,
    category: typeof record.category === 'string' ? record.category : undefined,
    installed: record.installed === true,
    installedSource: record.installedSource === 'bundled' ? 'bundled' : (record.installedSource === 'user' ? 'user' : undefined),
    removable: record.removable === true,
    requires: normalizeRequires(record.requires),
    updateAvailable: record.updateAvailable === true,
  }
}

function parseMarket(payload: unknown): MarketList {
  const record = asRecord(payload)
  if (record === null) throw new Error('unexpected market payload')
  const skills = Array.isArray(record.skills)
    ? record.skills.map(normalizeMarketSkill).filter((skill): skill is MarketSkill => skill !== null)
    : []
  const categories = Array.isArray(record.categories)
    ? record.categories.flatMap((entry): MarketCategory[] => {
      const category = asRecord(entry)
      if (category === null || typeof category.id !== 'string' || category.id === '') return []
      return [{ id: category.id, title: asRecord(category.title) as BilingualText | undefined }]
    })
    : []
  return {
    categories,
    skills,
    // 只有明确的 true 才算离线清单；字段缺失表示服务端正常在线返回。
    stale: record.stale === true,
    savedAt: typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : undefined,
  }
}

/**
 * 缓存时间 → 展示用短日期（中文「M月D日」，英文「Mon D」）。
 *
 * 为什么自己拼：服务端只给毫秒时间戳，直接 toLocaleString 会带上年份与时分，
 * 在设置页这一行里过长；这里只要「哪天的清单」这一层信息。
 */
function formatSavedAt(savedAt: number): string {
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return ''
  // 两种语言都交给 Intl：省掉「月/日」这类只有中文一半的拼接字面量（i18n 门禁会判「文案缺英文」）。
  return isEnglish()
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function normalizePlugin(raw: unknown): PluginItem | null {
  const record = asRecord(raw)
  if (record === null) return null
  const fullName = typeof record.fullName === 'string' ? record.fullName : ''
  if (fullName === '') return null
  return {
    fullName,
    name: typeof record.name === 'string' ? record.name : undefined,
    owner: typeof record.owner === 'string' ? record.owner : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    summaryZh: typeof record.summaryZh === 'string' ? record.summaryZh : undefined,
    category: typeof record.category === 'string' ? record.category : undefined,
    compat: typeof record.compat === 'string' ? record.compat : undefined,
    compatNote: typeof record.compatNote === 'string' ? record.compatNote : undefined,
    stars: typeof record.stars === 'number' ? record.stars : undefined,
    installable: record.installable === true,
  }
}

function parsePluginPage(payload: unknown): PluginPage {
  const record = asRecord(payload)
  if (record === null) throw new Error('unexpected plugin payload')
  const results = Array.isArray(record.results)
    ? record.results.map(normalizePlugin).filter((plugin): plugin is PluginItem => plugin !== null)
    : []
  return {
    total: typeof record.total === 'number' ? record.total : results.length,
    count: typeof record.count === 'number' ? record.count : results.length,
    results,
  }
}

function sourceBadge(source: 'user' | 'bundled' | undefined): string {
  if (source === 'bundled') return tr('内置', 'Built-in')
  if (source === 'user') return tr('已安装', 'Installed')
  return tr('市场', 'Market')
}

/** 一次能力回读的结论。`unknown` 表示桥或字段读不到，按满足处理但不显示任何「已满足」标记。 */
type RequirementState = 'met' | 'unmet' | 'unknown'

function requirementBadgeLabel(requirement: SkillRequirement): string {
  if (requirement === 'a11y') return tr('需要开启无障碍', 'Needs accessibility')
  if (requirement === 'shizuku') return tr('需要开启 Shizuku', 'Needs Shizuku')
  return tr('需要访问真实屏幕', 'Needs real screen')
}

/** 依赖未满足时的按钮文案：系统页跳转 vs 本页直接放行。 */
function requirementActionLabel(requirement: SkillRequirement): string {
  return requirement === 'real-screen'
    ? tr('允许真实屏幕', 'Allow real screen')
    : tr('去开启', 'Enable')
}

/** 读桥返回的 JSON；非字符串、解析失败或缺方法都归为「读不到」。 */
function readBridgeRecord(read: (() => string) | undefined): Record<string, unknown> | null {
  if (typeof read !== 'function') return null
  try {
    const raw = read()
    if (typeof raw !== 'string') return null
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * 判定一项能力依赖。
 *
 * 只有明确的 `enabled:false` / `granted:false` 才算不满足：桥缺席（桌面宿主）或字段
 * 读不到时必须放行，不能把宿主能力差异误报成用户的配置问题。`unknown` 不渲染绿标，
 * 所以「没读到」也不会被展示成「已满足」。
 */
function readRequirement(requirement: SkillRequirement): RequirementState {
  const bridge = window.androidBridge
  if (bridge === undefined) return 'unknown'
  // 屏幕范围不是 JSON 状态，而是三值枚举：virtual-only 才是「技能用不了真实屏」。
  if (requirement === 'real-screen') {
    let scope: unknown
    try {
      scope = bridge.getScreenScope?.()
    } catch {
      return 'unknown'
    }
    if (scope === 'virtual-only') return 'unmet'
    return scope === 'real-only' || scope === 'all' ? 'met' : 'unknown'
  }
  const record = requirement === 'a11y'
    ? readBridgeRecord(bridge.a11yStatus)
    : readBridgeRecord(bridge.shizukuStatus)
  if (record === null) return 'unknown'
  const flag = requirement === 'a11y' ? record.enabled : record.granted
  if (flag === false) return 'unmet'
  return flag === true ? 'met' : 'unknown'
}

/** 打开系统侧开启入口；屏幕范围由本页直接放行（点按本身就是明确同意）。 */
function openRequirementSettings(requirement: SkillRequirement): void {
  try {
    if (requirement === 'a11y') window.androidBridge?.openA11ySettings?.()
    else if (requirement === 'shizuku') window.androidBridge?.openShizukuManager?.()
    else window.androidBridge?.setScreenScope?.('all')
  } catch {
    /* 桌面宿主没有桥；不把异常冒到页面 */
  }
}

/** 本地搜索：名称、中英标题、中英简介都参与匹配。 */
function matchesQuery(query: string, parts: ReadonlyArray<string | undefined>): boolean {
  if (query === '') return true
  return parts.some((part) => part !== undefined && part.toLowerCase().includes(query))
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// ── 技能 tab ───────────────────────────────────────────────────────────────

/**
 * 技能 tab：已安装（优先）与市场两段。
 *
 * 组件始终保持挂载（切到插件 tab 只隐藏），因此搜索词、滚动位置和已加载状态在 tab 之间不丢。
 */
function SkillsPanel({ active }: { active: boolean }) {
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [installedKind, setInstalledKind] = useState<LoadKind>('loading')
  const [installedError, setInstalledError] = useState<Notice | null>(null)
  const [market, setMarket] = useState<MarketList>({ categories: [], skills: [], stale: false })
  const [marketKind, setMarketKind] = useState<LoadKind>('loading')
  const [marketError, setMarketError] = useState<Notice | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<BusyOperation | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, Notice>>({})
  // 卸载成功后市场回包里的 `installed` 仍是旧值：用本地集合压住，直到下次整表刷新。
  const [locallyRemoved, setLocallyRemoved] = useState<ReadonlySet<string>>(new Set())
  // 依赖状态挂在组件上而不是行上：一次回读服务所有行，且能被「回到设置页」重新触发。
  const [requirementStates, setRequirementStates] = useState<Record<SkillRequirement, RequirementState>>({
    a11y: 'unknown',
    shizuku: 'unknown',
    'real-screen': 'unknown',
  })

  const refreshRequirements = useCallback((): void => {
    setRequirementStates({
      a11y: readRequirement('a11y'),
      shizuku: readRequirement('shizuku'),
      'real-screen': readRequirement('real-screen'),
    })
  }, [])

  useEffect(() => {
    refreshRequirements()
  }, [refreshRequirements])

  // 从系统设置页回来时重新判定：点击「去开启」只是把用户送走，真正的变化发生在别处。
  useEffect(() => {
    const onFocus = (): void => { refreshRequirements() }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshRequirements()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshRequirements])

  // 两个 tab 常驻挂载：切回技能 tab 也算一次「回到本页」，需要重新回读。
  useEffect(() => {
    if (active) refreshRequirements()
  }, [active, refreshRequirements])

  const clearRowError = useCallback((id: string): void => {
    setRowErrors((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const setRowError = useCallback((id: string, notice: Notice): void => {
    setRowErrors((prev) => ({ ...prev, [id]: notice }))
  }, [])

  const loadInstalled = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setInstalledKind('loading')
    try {
      const response = await fetch('/api/skillmarket/installed', { credentials: 'same-origin', cache: 'no-store' })
      const payload = await readJson(response)
      if (!response.ok) {
        setInstalledKind('error')
        setInstalledError(noticeFromResponse(payload, response.status, tr('读取已安装技能', 'Reading installed skills')))
        return
      }
      setInstalled(parseInstalled(payload))
      setInstalledKind('ok')
      setInstalledError(null)
    } catch {
      setInstalledKind('error')
      setInstalledError(networkNotice())
    }
  }, [])

  const loadMarket = useCallback(async (silent = false): Promise<void> => {
    // 更新成功后的静默刷新不把整段切回「加载中」，避免已展示的市场列表闪一下。
    if (!silent) setMarketKind('loading')
    try {
      const response = await fetch('/api/skillmarket/list', { credentials: 'same-origin', cache: 'no-store' })
      const payload = await readJson(response)
      if (!response.ok) {
        setMarketKind('error')
        setMarketError(noticeFromResponse(payload, response.status, tr('读取技能市场', 'Reading the skill market')))
        return
      }
      setMarket(parseMarket(payload))
      setMarketKind('ok')
      setMarketError(null)
    } catch {
      setMarketKind('error')
      setMarketError(networkNotice())
    }
  }, [])

  useEffect(() => {
    void loadInstalled()
    void loadMarket()
  }, [loadInstalled, loadMarket])

  const installSkill = useCallback(async (skill: MarketSkill): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: skill.id, kind: 'install' })
    clearRowError(skill.id)
    try {
      const response = await fetch('/api/skillmarket/install', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: skill.id }),
      })
      const payload = await readJson(response)
      if (!response.ok) {
        setRowError(skill.id, noticeFromResponse(payload, response.status, tr('安装技能', 'Installing the skill')))
        return
      }
      // 成功以重新读取的已安装列表为准，不把安装响应当展示真源。
      await loadInstalled(true)
      setLocallyRemoved((prev) => {
        if (!prev.has(skill.id)) return prev
        const next = new Set(prev)
        next.delete(skill.id)
        return next
      })
    } catch {
      setRowError(skill.id, networkNotice())
    } finally {
      setBusy(null)
    }
  }, [busy, clearRowError, loadInstalled, setRowError])

  /**
   * 覆盖安装：服务端把「更新」建模成同一条 install 路由 + overwrite。
   *
   * 成功后必须同时重读 installed 与 list：标签挂在 installed 行上，而市场条目
   * 也带 updateAvailable，只刷一边会让两段对同一个技能给出矛盾状态。
   */
  const updateSkill = useCallback(async (skill: InstalledSkill): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: skill.id, kind: 'update' })
    clearRowError(skill.id)
    try {
      const response = await fetch('/api/skillmarket/install', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: skill.id, overwrite: true }),
      })
      const payload = await readJson(response)
      if (!response.ok) {
        // 失败时保留「可更新」：本地仍是旧版本，用户可再点一次。
        setRowError(skill.id, noticeFromResponse(payload, response.status, tr('更新技能', 'Updating the skill')))
        return
      }
      await Promise.all([loadInstalled(true), loadMarket(true)])
    } catch {
      setRowError(skill.id, networkNotice())
    } finally {
      setBusy(null)
    }
  }, [busy, clearRowError, loadInstalled, loadMarket, setRowError])

  const uninstallSkill = useCallback(async (skill: InstalledSkill): Promise<void> => {
    if (busy !== null) return
    setConfirmId(null)
    setBusy({ id: skill.id, kind: 'uninstall' })
    clearRowError(skill.id)
    try {
      const response = await fetch('/api/skillmarket/uninstall', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: skill.id }),
      })
      const payload = await readJson(response)
      if (!response.ok) {
        setRowError(skill.id, noticeFromResponse(payload, response.status, tr('卸载技能', 'Uninstalling the skill')))
        return
      }
      setLocallyRemoved((prev) => new Set(prev).add(skill.id))
      await loadInstalled(true)
    } catch {
      setRowError(skill.id, networkNotice())
    } finally {
      setBusy(null)
    }
  }, [busy, clearRowError, loadInstalled, setRowError])

  const normalisedQuery = query.trim().toLowerCase()
  const installedFiltered = useMemo(
    () => installed.filter((skill) => matchesQuery(normalisedQuery, [skill.name, skill.description, skill.id])),
    [installed, normalisedQuery],
  )
  const marketFiltered = useMemo(
    () => market.skills.filter((skill) => matchesQuery(normalisedQuery, [
      skill.name,
      skill.id,
      ...readBilingual(skill.title),
      ...readBilingual(skill.description),
    ])),
    [market.skills, normalisedQuery],
  )

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledSkill>()
    for (const skill of installed) map.set(skill.id, skill)
    return map
  }, [installed])

  // 市场按 category 分组：先按目录声明的顺序，未知分类追加在末尾。
  const groups = useMemo(() => {
    const byCategory = new Map<string, MarketSkill[]>()
    for (const skill of marketFiltered) {
      const key = skill.category !== undefined && skill.category !== '' ? skill.category : 'uncategorised'
      const list = byCategory.get(key)
      if (list === undefined) byCategory.set(key, [skill])
      else list.push(skill)
    }
    const order = market.categories.map((category) => category.id)
    const keys = [
      ...order.filter((id) => byCategory.has(id)),
      ...Array.from(byCategory.keys()).filter((id) => !order.includes(id)),
    ]
    return keys.map((id) => {
      const category = market.categories.find((entry) => entry.id === id)
      const title = displayBilingual(category?.title)
      return {
        id,
        title: title !== '' ? title : id,
        skills: byCategory.get(id) ?? [],
      }
    })
  }, [market.categories, marketFiltered])

  const installLabel = (skillId: string): string => {
    if (busy !== null && busy.id === skillId && busy.kind === 'install') return tr('安装中…', 'Installing…')
    return tr('安装', 'Install')
  }

  return (
    <div className="dsh-ext-panel" data-panel="skills">
      <label className="dsh-ext-search-wrap">
        <span className="dsh-ext-visually-hidden">{tr('搜索技能', 'Search skills')}</span>
        <input
          className="dsh-ext-search"
          type="search"
          value={query}
          placeholder={tr('搜索名称或简介…', 'Search by name or description…')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </label>

      <section className="dsh-ext-segment" aria-label={tr('已安装', 'Installed')} data-segment="installed">
        <h3 className="dsh-ext-segment-title">{tr('已安装', 'Installed')}</h3>
        {installedKind === 'loading' && (
          <p className="dsh-dev-hint" data-state="loading">{tr('加载中…', 'Loading…')}</p>
        )}
        {installedKind === 'error' && (
          <div className="dsh-ext-error" role="alert" data-state="error">
            <p className="dsh-dev-warn" {...(installedError === null ? {} : noticeDataAttrs(installedError))}>
              {installedError?.text ?? tr('读取已安装技能失败——请重试', 'Reading installed skills failed. Try again.')}
            </p>
            <button type="button" className="dsh-dev-btn" onClick={() => { void loadInstalled() }}>
              {tr('重试', 'Retry')}
            </button>
          </div>
        )}
        {installedKind === 'ok' && installedFiltered.length === 0 && (
          <p className="dsh-dev-hint" data-state="empty">
            {installed.length === 0
              ? tr('还没有已安装的技能', 'No skills installed yet')
              : tr('没有匹配的已安装技能', 'No matching installed skills')}
          </p>
        )}
        {installedKind === 'ok' && installedFiltered.length > 0 && (
          <ul className="dsh-ext-list">
            {installedFiltered.map((skill) => {
              const rowError = rowErrors[skill.id]
              const rowBusy = busy !== null && busy.id === skill.id
              const updating = rowBusy && busy?.kind === 'update'
              return (
                <li className="dsh-ext-row" key={skill.id} data-skill-id={skill.id}>
                  <div className="dsh-ext-main">
                    <div className="dsh-ext-titleline">
                      <span className="dsh-ext-name">{skill.name}</span>
                      <span className="dsh-ext-badge" data-source={skill.source}>
                        {sourceBadge(skill.source)}
                      </span>
                      {/* 已安装但依赖暂不满足：技能还在，只是用不了；只提示，不加额外按钮。 */}
                      {skill.requires.map((requirement) => requirementStates[requirement] === 'unmet' ? (
                        <span
                          key={requirement}
                          className="dsh-ext-badge dsh-ext-require"
                          data-requires={requirement}
                        >
                          {requirementBadgeLabel(requirement)}
                        </span>
                      ) : null)}
                      {/* 内置技能由应用包管理，覆盖安装没有意义，因此只在可卸载技能上给更新入口。 */}
                      {skill.removable && skill.updateAvailable && (
                        <button
                          type="button"
                          className="dsh-ext-badge dsh-ext-update"
                          data-update-available="true"
                          disabled={busy !== null}
                          onClick={() => { void updateSkill(skill) }}
                        >
                          {updating ? tr('更新中…', 'Updating…') : tr('可更新', 'Updatable')}
                        </button>
                      )}
                    </div>
                    {skill.description !== '' && <p className="dsh-ext-desc">{skill.description}</p>}
                    {rowError !== undefined && (
                      <p className="dsh-dev-warn dsh-ext-row-error" {...noticeDataAttrs(rowError)}>
                        {rowError.text}
                      </p>
                    )}
                  </div>
                  {skill.removable && (
                    <div className="dsh-ext-actions">
                      {confirmId === skill.id ? (
                        <div className="dsh-ext-confirm" role="group" aria-label={tr('确认卸载', 'Confirm uninstall')}>
                          <p className="dsh-ext-confirm-text">
                            {tr('确认卸载「', 'Uninstall “')}{skill.name}{tr('」？', '”?')}
                          </p>
                          <button
                            type="button"
                            className="dsh-dev-btn dsh-dev-danger"
                            disabled={busy !== null}
                            onClick={() => { void uninstallSkill(skill) }}
                          >
                            {rowBusy && busy?.kind === 'uninstall' ? tr('卸载中…', 'Uninstalling…') : tr('确认卸载', 'Uninstall')}
                          </button>
                          <button
                            type="button"
                            className="dsh-dev-btn"
                            disabled={busy !== null}
                            onClick={() => { setConfirmId(null) }}
                          >
                            {tr('取消', 'Cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="dsh-dev-btn dsh-dev-danger"
                          disabled={busy !== null}
                          onClick={() => { setConfirmId(skill.id) }}
                        >
                          {tr('卸载', 'Uninstall')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="dsh-ext-segment" aria-label={tr('市场', 'Market')} data-segment="market">
        <h3 className="dsh-ext-segment-title">{tr('市场', 'Market')}</h3>
        {marketKind === 'ok' && market.stale && (
          <p className="dsh-dev-hint dsh-ext-offline" data-state="stale">
            {market.savedAt === undefined
              ? tr('离线，显示上次获取的清单', 'Offline. Showing the last fetched list.')
              : tr('离线，显示上次获取的清单（保存于 ', 'Offline. Showing the last fetched list (saved ')
                + formatSavedAt(market.savedAt)
                + tr('）', ')')}
          </p>
        )}
        {marketKind === 'loading' && (
          <p className="dsh-dev-hint" data-state="loading">{tr('加载中…', 'Loading…')}</p>
        )}
        {marketKind === 'error' && (
          <div className="dsh-ext-error" role="alert" data-state="error">
            <p className="dsh-dev-warn" {...(marketError === null ? {} : noticeDataAttrs(marketError))}>
              {marketError?.text ?? tr('读取技能市场失败——请重试', 'Reading the skill market failed. Try again.')}
            </p>
            <button type="button" className="dsh-dev-btn" onClick={() => { void loadMarket() }}>
              {tr('重试', 'Retry')}
            </button>
          </div>
        )}
        {marketKind === 'ok' && groups.length === 0 && (
          <p className="dsh-dev-hint" data-state="empty">
            {normalisedQuery !== ''
              ? tr('没有匹配的技能', 'No matching skills')
              : tr('市场暂时没有可用的技能', 'No skills are available right now')}
          </p>
        )}
        {marketKind === 'ok' && groups.map((group) => (
          <div className="dsh-ext-group" key={group.id} data-category={group.id}>
            <h4 className="dsh-ext-category">{group.title}</h4>
            <ul className="dsh-ext-list">
              {group.skills.map((skill) => {
                const hit = installedById.get(skill.id)
                const installedNow = hit !== undefined
                  || (skill.installed === true && !locallyRemoved.has(skill.id))
                const removable = hit?.removable ?? (skill.removable === true)
                const source = hit?.source ?? skill.installedSource ?? (skill.installed === true ? 'user' : undefined)
                const rowError = rowErrors[skill.id]
                const rowBusy = busy !== null && busy.id === skill.id
                const missingRequirements = skill.requires.filter(
                  (requirement) => requirementStates[requirement] === 'unmet',
                )
                return (
                  <li className="dsh-ext-row" key={skill.id} data-market-id={skill.id}>
                    <div className="dsh-ext-main">
                      <div className="dsh-ext-titleline">
                        <span className="dsh-ext-name">{skill.name}</span>
                        <span
                          className="dsh-ext-badge"
                          data-source={installedNow ? (source ?? 'user') : 'market'}
                        >
                          {installedNow ? sourceBadge(source ?? 'user') : sourceBadge(undefined)}
                        </span>
                        {missingRequirements.map((requirement) => (
                          <span
                            key={requirement}
                            className="dsh-ext-badge dsh-ext-require"
                            data-requires={requirement}
                          >
                            {requirementBadgeLabel(requirement)}
                          </span>
                        ))}
                      </div>
                      {displayBilingual(skill.description) !== '' && (
                        <p className="dsh-ext-desc">{displayBilingual(skill.description)}</p>
                      )}
                      {rowError !== undefined && (
                        <p className="dsh-dev-warn dsh-ext-row-error" {...noticeDataAttrs(rowError)}>
                          {rowError.text}
                        </p>
                      )}
                    </div>
                    <div className="dsh-ext-actions">
                      {installedNow ? (
                        // 已安装条目不重复给「安装」；卸载统一在已安装段操作，避免同一动作两处入口。
                        removable && hit !== undefined ? (
                          <span className="dsh-dev-hint">{tr('可在上方卸载', 'Uninstall above')}</span>
                        ) : null
                      ) : (
                        <>
                          {/* 缺能力时先给开启入口，安装按钮禁用：不给一个点下去必然用不了的假入口。 */}
                          {missingRequirements.map((requirement) => (
                            <button
                              key={requirement}
                              type="button"
                              className="dsh-dev-btn"
                              data-require-action={requirement}
                              onClick={() => {
                                openRequirementSettings(requirement)
                                // 屏幕范围在本页改完就能回读；a11y/Shizuku 等用户从系统页回来再判定。
                                if (requirement === 'real-screen') refreshRequirements()
                              }}
                            >
                              {requirementActionLabel(requirement)}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="dsh-dev-btn"
                            disabled={busy !== null || missingRequirements.length > 0}
                            onClick={() => { void installSkill(skill) }}
                          >
                            {installLabel(skill.id)}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}

// ── 插件 tab ───────────────────────────────────────────────────────────────

/** 插件目录每页条数：一次 30 条，避免手机上一次性渲染上千行。 */
const PLUGIN_PAGE_SIZE = 30
/** 搜索防抖：目录有上万条，按键即搜会把请求打爆。 */
const PLUGIN_SEARCH_DEBOUNCE_MS = 300

function compatLabel(compat: string | undefined): string {
  if (compat === 'ok') return tr('移动可用', 'Mobile-ready')
  if (compat === 'desktop') return tr('仅桌面', 'Desktop only')
  if (compat === 'native') return tr('含原生依赖', 'Native deps')
  if (compat === 'unknown') return tr('未验证', 'Unverified')
  return ''
}

function pluginCategoryTitle(category: string | undefined): string {
  if (category === undefined || category === '') return tr('未分类', 'Uncategorised')
  return category
}

/** 插件安装失败：优先按服务端码翻译，未登记的码回显服务端原文。 */
function noticeFromPluginResponse(payload: unknown, status: number, action: string): Notice {
  const body = asRecord(payload)
  const code = body !== null && typeof body.code === 'string' && body.code !== '' ? body.code : undefined
  const message = body !== null && typeof body.error === 'string' && body.error !== '' ? body.error : undefined
  if (code !== undefined || message !== undefined) {
    return { text: describePluginError(code, message), ...(code === undefined ? {} : { code }) }
  }
  return { text: describeHttpError(action, status), http: status }
}

/**
 * 插件 tab：服务端搜索 + 按 category 分组 + 加载更多。
 *
 * 为什么不本地过滤：目录有 17000+ 条，一次拉全量既慢又占内存；`mobile=1` 让服务端先筛掉
 * 未在安卓验证过的条目，页面只负责按页追加。
 */
function PluginsPanel() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PluginItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [activeQuery, setActiveQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [error, setError] = useState<Notice | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, Notice>>({})
  // 只为「丢弃过期响应」：搜索词变化后，旧请求晚到也不得覆盖新结果。
  const requestSeq = useRef(0)
  const firstLoad = useRef(true)

  const loadPage = useCallback(async (search: string, nextPage: number, append: boolean): Promise<void> => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    setError(null)
    try {
      const url = '/api/dshmarketplace/search?q=' + encodeURIComponent(search)
        + '&limit=' + String(PLUGIN_PAGE_SIZE) + '&page=' + String(nextPage) + '&mobile=1'
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const payload = await readJson(response)
      if (seq !== requestSeq.current) return
      if (!response.ok) {
        setError(noticeFromPluginResponse(payload, response.status, tr('读取插件市场', 'Reading the plugin market')))
        return
      }
      const parsed = parsePluginPage(payload)
      setItems((prev) => (append ? [...prev, ...parsed.results] : parsed.results))
      setTotal(parsed.total)
      setPage(nextPage)
      setActiveQuery(search)
      setLoadedOnce(true)
    } catch {
      if (seq === requestSeq.current) setError(networkNotice())
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  // 首屏立即请求；之后每次输入以 300ms 防抖合并（连续输入只发最后一次）。
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false
      void loadPage(query.trim(), 1, false)
      return
    }
    const timer = setTimeout(() => { void loadPage(query.trim(), 1, false) }, PLUGIN_SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [query, loadPage])

  const installPlugin = useCallback(async (plugin: PluginItem): Promise<void> => {
    if (busyId !== null) return
    const fullName = plugin.fullName
    setBusyId(fullName)
    setRowErrors((prev) => {
      if (!(fullName in prev)) return prev
      const next = { ...prev }
      delete next[fullName]
      return next
    })
    try {
      const summary = plugin.summaryZh !== undefined && plugin.summaryZh !== '' ? plugin.summaryZh : plugin.summary
      const body = {
        confirmed: true,
        plugin: {
          fullName,
          name: plugin.name ?? fullName,
          ...(plugin.owner === undefined ? {} : { owner: plugin.owner }),
          ...(summary === undefined ? {} : { summary }),
        },
      }
      const response = await fetch('/api/dshmarketplace/install', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await readJson(response)
      if (!response.ok) {
        setRowErrors((prev) => ({
          ...prev,
          [fullName]: noticeFromPluginResponse(payload, response.status, tr('安装插件', 'Installing the plugin')),
        }))
        return
      }
      // 安装成功只需标记：重启引擎后由插件加载器接管，页面不自动重启。
      setInstalled((prev) => new Set(prev).add(fullName))
    } catch {
      setRowErrors((prev) => ({ ...prev, [fullName]: networkNotice() }))
    } finally {
      setBusyId(null)
    }
  }, [busyId])

  const groups = useMemo(() => {
    const byCategory = new Map<string, PluginItem[]>()
    for (const item of items) {
      const key = item.category !== undefined && item.category !== '' ? item.category : ''
      const list = byCategory.get(key)
      if (list === undefined) byCategory.set(key, [item])
      else list.push(item)
    }
    return Array.from(byCategory.entries()).map(([id, plugins]) => ({
      id: id === '' ? 'uncategorised' : id,
      title: pluginCategoryTitle(id),
      plugins,
    }))
  }, [items])

  const hasMore = loadedOnce && items.length < total
  const loadMore = (): void => {
    if (loading || !hasMore) return
    void loadPage(activeQuery, page + 1, true)
  }

  return (
    <div className="dsh-ext-panel" data-panel="plugins">
      <label className="dsh-ext-search-wrap">
        <span className="dsh-ext-visually-hidden">{tr('搜索插件', 'Search plugins')}</span>
        <input
          className="dsh-ext-search"
          type="search"
          value={query}
          placeholder={tr('搜索插件名称、作者或能力…', 'Search by name, author, or capability…')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </label>

      {loading && !loadedOnce && (
        <p className="dsh-dev-hint" data-state="loading">{tr('加载中…', 'Loading…')}</p>
      )}

      {!loadedOnce && error !== null && (
        <div className="dsh-ext-error" role="alert" data-state="error">
          <p className="dsh-dev-warn" {...noticeDataAttrs(error)}>{error.text}</p>
          <button type="button" className="dsh-dev-btn" onClick={() => { void loadPage(query.trim(), 1, false) }}>
            {tr('重试', 'Retry')}
          </button>
        </div>
      )}

      {loadedOnce && error !== null && (
        <div className="dsh-ext-error" role="status" data-state="error">
          <p className="dsh-dev-warn" {...noticeDataAttrs(error)}>{error.text}</p>
          <button type="button" className="dsh-dev-btn" onClick={() => { void loadPage(query.trim(), 1, false) }}>
            {tr('重试', 'Retry')}
          </button>
        </div>
      )}

      {loadedOnce && items.length === 0 && error === null && (
        <p className="dsh-dev-hint" data-state="empty">
          {query.trim() !== ''
            ? tr('没有匹配的插件', 'No matching plugins')
            : tr('市场暂时没有可用的插件', 'No plugins are available right now')}
        </p>
      )}

      {items.length > 0 && groups.map((group) => (
        <div className="dsh-ext-group" key={group.id} data-category={group.id}>
          <h4 className="dsh-ext-category">{group.title}</h4>
          <ul className="dsh-ext-list">
            {group.plugins.map((plugin) => {
              const summary = plugin.summaryZh !== undefined && plugin.summaryZh !== ''
                ? plugin.summaryZh
                : (plugin.summary ?? '')
              const compat = compatLabel(plugin.compat)
              const rowError = rowErrors[plugin.fullName]
              const isInstalling = busyId === plugin.fullName
              return (
                <li className="dsh-ext-row" key={plugin.fullName} data-plugin-name={plugin.fullName}>
                  <div className="dsh-ext-main">
                    <div className="dsh-ext-titleline">
                      <span className="dsh-ext-name">{plugin.name ?? plugin.fullName}</span>
                      {compat !== '' && (
                        <span className="dsh-ext-badge" data-compat={plugin.compat}>{compat}</span>
                      )}
                    </div>
                    {summary !== '' && <p className="dsh-ext-desc">{summary}</p>}
                    {rowError !== undefined && (
                      <p className="dsh-dev-warn dsh-ext-row-error" {...noticeDataAttrs(rowError)}>{rowError.text}</p>
                    )}
                  </div>
                  <div className="dsh-ext-actions">
                    {installed.has(plugin.fullName) ? (
                      <span className="dsh-ext-badge" data-source="user">
                        {tr('已安装（重启后生效）', 'Installed (restart to apply)')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="dsh-dev-btn"
                        disabled={busyId !== null}
                        onClick={() => { void installPlugin(plugin) }}
                      >
                        {isInstalling ? tr('安装中…', 'Installing…') : tr('安装', 'Install')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      {hasMore && (
        <button
          type="button"
          className="dsh-dev-btn dsh-ext-load-more"
          disabled={loading}
          onClick={loadMore}
        >
          {loading ? tr('加载中…', 'Loading…') : tr('加载更多', 'Load more')}
        </button>
      )}
    </div>
  )
}

// ── 分区壳 ─────────────────────────────────────────────────────────────────

/**
 * 「扩展」设置分区。
 * @returns 技能与插件两个 tab；插件 tab 首次点开才挂载（避免无谓请求）。
 */
export function ExtensionsSection(_props: PropsRuntime<'settings.section'>) {
  const [tab, setTab] = useState<'skills' | 'plugins'>('skills')
  const [pluginsMounted, setPluginsMounted] = useState(false)

  return (
    <section className="dsh-screen-control-card" aria-labelledby="dsh-extensions-title">
      <header className="dsh-screen-control-header">
        <span>
          <strong id="dsh-extensions-title">{tr('扩展', 'Extensions')}</strong>
          <small>{tr('技能与插件', 'Skills and plugins')}</small>
        </span>
      </header>
      <div className="dsh-ext" data-plugin="dev-extensions">
        <div className="dsh-ext-tabs" role="tablist" aria-label={tr('扩展类型', 'Extension type')}>
          <button
            type="button"
            role="tab"
            className="dsh-ext-tab"
            data-tab="skills"
            aria-selected={tab === 'skills'}
            onClick={() => { setTab('skills') }}
          >
            {tr('技能', 'Skills')}
          </button>
          <button
            type="button"
            role="tab"
            className="dsh-ext-tab"
            data-tab="plugins"
            aria-selected={tab === 'plugins'}
            onClick={() => {
              setPluginsMounted(true)
              setTab('plugins')
            }}
          >
            {tr('插件', 'Plugins')}
          </button>
        </div>

        {/* 两个面板都保持挂载：切 tab 只隐藏，已加载的列表与搜索词不会丢。 */}
        <div hidden={tab !== 'skills'}>
          <SkillsPanel active={tab === 'skills'} />
        </div>
        {pluginsMounted && (
          <div hidden={tab !== 'plugins'}>
            <PluginsPanel />
          </div>
        )}
      </div>
    </section>
  )
}
