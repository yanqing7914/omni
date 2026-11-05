package com.omnifarious.omniagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * letterbox 纯几何回归（0.14.10）。
 *
 * 断言域收窄纪律：等比偏差断言只用于常规输入域；极端/病态输入（超宽/超高/1x1 舞台）的判据
 * 改为「不抛 + frame 恒含于 stage + 宽高 >= 1」——不写全输入域 <1% 的不变量（整像素取整在
 * 极端宽高比下偏差占比会放大，见 [extremeAspectsStayInsideStageWithoutThrowing]）。
 *
 * 限频重试依赖 SystemClock/主线程，不进 JVM 单测，由 CDP 层验收覆盖。
 */
class VdisplayLetterboxTest {

  /** frame 恒含于 stage 且宽高 >= 1（极端/病态域的唯一判据）。 */
  private fun assertFrameWithinStage(stage: VdisplayLetterbox.Frame, frame: VdisplayLetterbox.Frame) {
    assertTrue("frame 左边界不得越 stage", frame.left >= stage.left)
    assertTrue("frame 上边界不得越 stage", frame.top >= stage.top)
    assertTrue("frame 右边界不得越 stage", frame.left + frame.width <= stage.left + stage.width)
    assertTrue("frame 下边界不得越 stage", frame.top + frame.height <= stage.top + stage.height)
    assertTrue("frame 宽 >= 1", frame.width >= 1)
    assertTrue("frame 高 >= 1", frame.height >= 1)
  }

  /** 常规域等比断言：|frameAspect - contentAspect| / contentAspect < 1%。 */
  private fun assertIsometric(frame: VdisplayLetterbox.Frame, contentW: Int, contentH: Int) {
    val contentAspect = contentW.toDouble() / contentH.toDouble()
    val frameAspect = frame.width.toDouble() / frame.height.toDouble()
    val deviation = abs(frameAspect - contentAspect) / contentAspect
    assertTrue("等比偏差 $deviation 应 < 0.01", deviation < 0.01)
  }

  /**
   * issue ① 端到端组合反证（钉住完整因果链）：同一舞台 434x682@root 800x1600——
   * 建屏竖屏快照 675x1200 时 frame=383x682，活内容 1.7778 按该 frame 显示拉伸约 3.17 倍
   * （修复前形态）；活值 1200x675 时 frame=434x244，拉伸系数约 1.0（修复后形态）。
   */
  @Test
  fun issue1StaleSnapshotStretchesLiveLandscapeContent() {
    val stage = VdisplayLetterbox.stageRectInRoot(0, 0, 434, 682, 800, 1600)
    assertEquals(VdisplayLetterbox.Frame(0, 0, 434, 682), stage)

    // 修复前形态：按陈旧建屏快照（竖屏 675x1200）算 frame，与活内容方向相反 → 拉伸。
    val stale = VdisplayLetterbox.containFrame(stage, 675, 1200)
    assertEquals(VdisplayLetterbox.Frame(25, 0, 383, 682), stale)
    val staleStretch = (1200.0 / 675.0) / (383.0 / 682.0)
    assertEquals(3.17, staleStretch, 0.02)

    // 修复后形态：chooseLiveOrSnapshot 选中活值 1200x675，等比 contain。
    val liveSize = VdisplayLetterbox.chooseLiveOrSnapshot(1200, 675, 675, 1200)
    assertEquals(1200 to 675, liveSize)
    val live = VdisplayLetterbox.containFrame(stage, liveSize.first, liveSize.second)
    assertEquals(VdisplayLetterbox.Frame(0, 219, 434, 244), live)
    val liveStretch = (1200.0 / 675.0) / (434.0 / 244.0)
    assertEquals(1.0, liveStretch, 0.01)
  }

  /** issue ① 纯数学反证：2400x1602 进 434x682 窄高舞台——宽受限分支生效、等比、垂直居中、绝不满舞台。 */
  @Test
  fun wideContentIntoNarrowTallStageIsWidthLimitedNotStretched() {
    val stage = VdisplayLetterbox.Frame(0, 0, 434, 682)
    val frame = VdisplayLetterbox.containFrame(stage, 2400, 1602)
    // 宽受限：width = 舞台宽 434，height = 434/(2400/1602) = 289；垂直居中 top = (682-289)/2 = 196。
    assertEquals(VdisplayLetterbox.Frame(0, 196, 434, 289), frame)
    assertTrue("height 绝不满舞台", frame.height < 682)
    assertFalse("绝不 434x682 满框", frame.width == stage.width && frame.height == stage.height)
    assertIsometric(frame, 2400, 1602)
  }

  /** 高受限分支：675x1200 进 434x682 → 383x682 水平居中（左 25）；同比例回归 0.14.9 基线组 2 形态不变。 */
  @Test
  fun tallContentIntoWideStageIsHeightLimited() {
    val frame = VdisplayLetterbox.containFrame(VdisplayLetterbox.Frame(0, 0, 434, 682), 675, 1200)
    assertEquals(VdisplayLetterbox.Frame(25, 0, 383, 682), frame)
    assertIsometric(frame, 675, 1200)

    // 0.14.9 基线组 2 同比例回归：1200x675 进 689x371 → 659x371（形态不变）。
    val baseline = VdisplayLetterbox.containFrame(VdisplayLetterbox.Frame(0, 0, 689, 371), 1200, 675)
    assertEquals(VdisplayLetterbox.Frame(15, 0, 659, 371), baseline)
    assertIsometric(baseline, 1200, 675)
  }

  /** 极端宽高比（偏差 >1%）：判据收窄为「不抛 + frame 恒含于 stage + >=1」，不断言等比不变量。 */
  @Test
  fun extremeAspectsStayInsideStageWithoutThrowing() {
    val stage = VdisplayLetterbox.Frame(0, 0, 434, 682)
    // 超宽 4096x240（实算 434x25，偏差约 1.72%）：不抛、在舞台内、不满足舞台高。
    val wide = VdisplayLetterbox.containFrame(stage, 4096, 240)
    assertEquals(434, wide.width)
    assertEquals(25, wide.height)
    assertFrameWithinStage(stage, wide)
    // 超高 240x4096（实算 39x682，偏差约 2.40%）。
    val tall = VdisplayLetterbox.containFrame(stage, 240, 4096)
    assertEquals(39, tall.width)
    assertEquals(682, tall.height)
    assertFrameWithinStage(stage, tall)
  }

  /** 1x1 舞台病态用例：不抛、frame 恒含于 stage、宽高 >= 1。 */
  @Test
  fun degenerateOneByOneStageNeverThrows() {
    val stage = VdisplayLetterbox.Frame(0, 0, 1, 1)
    val frame = VdisplayLetterbox.containFrame(stage, 4096, 240)
    assertFrameWithinStage(stage, frame)
    assertEquals(1, frame.width)
    assertEquals(1, frame.height)
    // 病态 content（非正尺寸）按「与舞台同比例」= 满舞台，不抛。
    assertEquals(stage, VdisplayLetterbox.containFrame(stage, 0, 240))
    assertEquals(stage, VdisplayLetterbox.containFrame(stage, -1, -1))
  }

  /** stageRectInRoot 等价行为回归（非缺陷修复）：与既有 applyStageBounds coerce 结果逐一相等。 */
  @Test
  fun stageRectInRootMatchesLegacyCoerce() {
    // 正常映射不变。
    assertEquals(
      VdisplayLetterbox.Frame(10, 20, 434, 682),
      VdisplayLetterbox.stageRectInRoot(10, 20, 434, 682, 800, 1600),
    )
    // 负 left/top 归零。
    assertEquals(
      VdisplayLetterbox.Frame(0, 0, 434, 682),
      VdisplayLetterbox.stageRectInRoot(-5, -9, 434, 682, 800, 1600),
    )
    // right/bottom 超 root 收宽高（与现状 coerce 结果逐一相等：left=500 时宽收为 300）。
    assertEquals(
      VdisplayLetterbox.Frame(500, 0, 300, 682),
      VdisplayLetterbox.stageRectInRoot(500, 0, 600, 682, 800, 1600),
    )
    // 极端越界退化为 1x1，不抛。
    assertEquals(
      VdisplayLetterbox.Frame(799, 1599, 1, 1),
      VdisplayLetterbox.stageRectInRoot(10_000, 10_000, 10_000, 10_000, 800, 1600),
    )
    // 0 尺寸 root 不抛（守卫在前，但函数自身也不炸）。
    assertEquals(
      VdisplayLetterbox.Frame(0, 0, 1, 1),
      VdisplayLetterbox.stageRectInRoot(0, 0, 1, 1, 0, 0),
    )
  }

  /** chooseLiveOrSnapshot：活值合法用活值；活值 null/非正回退建屏快照；快照非法原样透传。 */
  @Test
  fun chooseLiveOrSnapshotPrefersLegalLiveValue() {
    // 活值合法 → 活值。
    assertEquals(1200 to 675, VdisplayLetterbox.chooseLiveOrSnapshot(1200, 675, 675, 1200))
    // 活值 null 或非正 → 建屏快照。
    assertEquals(675 to 1200, VdisplayLetterbox.chooseLiveOrSnapshot(null, null, 675, 1200))
    assertEquals(675 to 1200, VdisplayLetterbox.chooseLiveOrSnapshot(null, 675, 675, 1200))
    assertEquals(675 to 1200, VdisplayLetterbox.chooseLiveOrSnapshot(0, 675, 675, 1200))
    assertEquals(675 to 1200, VdisplayLetterbox.chooseLiveOrSnapshot(1200, -1, 675, 1200))
    // 快照本身非法时原样返回，交调用点舞台比例兜底（与既有行为一致），决策层不造假值。
    assertEquals(0 to 0, VdisplayLetterbox.chooseLiveOrSnapshot(null, null, 0, 0))
  }

  /**
   * uniformScale：viewWidth/cssWidth 正常除法；cssWidth<=0 返回 0（调用点早退）。
   * IME 失配免疫反证（issue ③）：统一 X 基准后纵向映射用同一个 scale，页面 css 视口高度经
   * padding 缩短不再放大舞台盒。签名无 cssHeight 参数本身就是免疫的一半（调用点接线由
   * VdisplayHost 源码审查与 CDP 层保证），这里钉死数值语义。
   */
  @Test
  fun uniformScaleUsesXBasisAndIsImmuneToImeMismatch() {
    assertEquals(2.0, VdisplayLetterbox.uniformScale(800, 400.0), 1e-9)
    assertEquals(0.0, VdisplayLetterbox.uniformScale(800, 0.0), 1e-9)
    assertEquals(0.0, VdisplayLetterbox.uniformScale(800, -1.0), 1e-9)
    assertEquals(0.0, VdisplayLetterbox.uniformScale(0, 400.0), 1e-9)
    // IME 场景对照：viewW=800、cssW=400 → scale=2.0；舞台高 682 css 映射 1364 px。
    // 失配的 Y 基准（1600/650≈2.4615）会把同一舞台盒纵向放大到 1678 px（「半截画面」形态）。
    val scale = VdisplayLetterbox.uniformScale(800, 400.0)
    assertEquals(1364, (682.0 * scale).toInt())
    assertTrue((682.0 * (1600.0 / 650.0)).toInt() > (682.0 * scale).toInt())
  }
}
