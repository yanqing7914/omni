package com.omnifarious.omniagent

/**
 * 虚拟屏查看器的 letterbox 纯几何（无任何 Android import，纯 JVM 可测）。
 *
 * 两条铁律（注释与测试共同钉死）：
 *   1. 绝不拉伸：frame 按内容宽高比等比缩放（极端宽高比下整像素取整误差占比会放大，
 *      如 4096x240 进窄高舞台偏差约 1.7%，但绝不系统性单向拉伸）；
 *   2. 绝不越界：frame 恒含于 stage，stage 恒含于 root。
 *
 * 为什么集中抽纯函数（0.14.10 issue ① 设备锤定）：letterbox 的内容尺寸信息源此前是
 * 「建屏瞬间写入的 Record.width/height 快照」（VdisplayController 建屏后从不回写），而虚拟屏
 * 带 FLAG_ROTATES_WITH_CONTENT 会随内容旋转——建屏方向与活内容方向相反时，按陈旧宽高比算的
 * SurfaceView frame 与活内容渲染方向相反，画面整体拉伸。修复 = 信息源活值化
 * （VdisplayController.liveOrSnapshotSize 经 [chooseLiveOrSnapshot] 决策）+ 几何集中到这里可测。
 */
internal object VdisplayLetterbox {

  /** 轴对齐像素矩形：left/top 为 root 坐标系内位置，width/height 为尺寸。 */
  internal data class Frame(val left: Int, val top: Int, val width: Int, val height: Int)

  /**
   * 舞台矩形：页面 CSS 舞台（已按 scale 映射为 px）coerce 进 root。
   *
   * 这是 VdisplayHost.applyStageBounds 既有 coerce 行为的**等价抽取**（clamp 结果逐一相等，
   * 仅集中为可测函数，不是行为修复）：left/top clamp 到 [0, root-1]，宽高 clamp 到
   * [1, root-对角]，故恒 stage 恒含于 root；极端越界退化为 1x1 而不抛。
   */
  internal fun stageRectInRoot(
    leftPx: Int,
    topPx: Int,
    widthPx: Int,
    heightPx: Int,
    rootW: Int,
    rootH: Int,
  ): Frame {
    val left = leftPx.coerceIn(0, (rootW - 1).coerceAtLeast(0))
    val top = topPx.coerceIn(0, (rootH - 1).coerceAtLeast(0))
    val width = widthPx.coerceIn(1, (rootW - left).coerceAtLeast(1))
    val height = heightPx.coerceIn(1, (rootH - top).coerceAtLeast(1))
    return Frame(left, top, width, height)
  }

  /**
   * contain：按「内容宽高比」在舞台内尽力放大并居中（0.14.8 设备实测修正的显式二选一语义）。
   *
   * useHeight = byWidth > stageHeight：宽受限算出的高装不下舞台 → 改按高受限。
   * 延续既有语义：绝不双向留边、绝不拉伸。病态 content（非正尺寸）按「与舞台同比例」处理
   * = 满舞台，不抛。恒 frame 恒含于 stage（stage 恒含于 root 由 [stageRectInRoot] 保证）。
   */
  internal fun containFrame(stage: Frame, contentW: Int, contentH: Int): Frame {
    if (contentW <= 0 || contentH <= 0) return stage
    val aspect = contentW.toDouble() / contentH.toDouble()
    val byWidth = stage.width / aspect // 宽受限分支的 frame 高
    val byHeight = stage.height * aspect // 高受限分支的 frame 宽
    val useHeight = byWidth > stage.height
    val width = (if (useHeight) byHeight else stage.width.toDouble())
      .toInt().coerceIn(1, stage.width.coerceAtLeast(1))
    val height = (if (useHeight) stage.height.toDouble() else byWidth)
      .toInt().coerceIn(1, stage.height.coerceAtLeast(1))
    // 居中：把等比后的 frame 摆在舞台中央（两侧/上下对称留边，不堆左上）。
    val left = stage.left + (stage.width - width) / 2
    val top = stage.top + (stage.height - height) / 2
    return Frame(left, top, width, height)
  }

  /**
   * 统一 scale：只以 X 基准（viewWidth/cssWidth）算一个缩放系数。
   *
   * 为什么不用 Y 做第二基准（0.14.10 issue ③ 实锤）：输入法弹起时 WebView 高度不变而页面
   * css 视口高度经 padding 缩短，双源里的 scaleY 随 cssHeight 变小而虚增 → 舞台盒纵向被放大
   * → 画面与页面舞台错位（「半截画面」）。X 方向不受 IME padding 影响；单基准后纵向映射与
   * 横向一致，无 IME 时 X/Y 本就相等，无退化。cssWidth <= 0（页面未上报视口）→ 0，调用点早退。
   */
  internal fun uniformScale(viewWidth: Int, cssWidth: Double): Double =
    if (viewWidth <= 0 || cssWidth <= 0.0) 0.0 else viewWidth.toDouble() / cssWidth

  /**
   * 内容尺寸信息源决策：活值合法用活值，否则回退建屏快照。
   *
   * FLAG_ROTATES_WITH_CONTENT 的虚拟屏建屏后方向可随内容翻转，建屏快照只代表建屏瞬间。
   * 活值来自 Display.getRealMetrics（VdisplayController 与 screens() 同一读取模式）。
   * 快照本身非法时**原样返回**，交调用点按舞台比例兜底（与既有行为一致），不在决策层造假值。
   */
  internal fun chooseLiveOrSnapshot(
    liveW: Int?,
    liveH: Int?,
    snapshotW: Int,
    snapshotH: Int,
  ): Pair<Int, Int> =
    if (liveW != null && liveH != null && liveW > 0 && liveH > 0) liveW to liveH
    else snapshotW to snapshotH
}
