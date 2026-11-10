package com.omnifarious.omniagent

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「极简居中」启动页的验收用例 L1–L7（纯 JVM，无 Robolectric）。
 *
 * 启动页由纯代码 View 搭建，JVM 单测拿不到 Activity/View 树，因此延续本仓既有做法：
 * 语义直接可测的（进度行文案、诊断区相位策略）走纯函数；形态类的（无卡片外观、品牌竖排、
 * 按钮两档）走**源码结构断言**——撤掉修复即红。L8 是 `:app:testDebugUnitTest` 全量通过。
 */
class GuideCenteredLayoutTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/omnifarious/omniagent", name),
      File("app/src/main/java/com/omnifarious/omniagent", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取一段代码（[from] 之后、[to] 之前）；找不到锚点即判红，避免空串让断言恒真。 */
  private fun block(src: String, from: String, to: String): String {
    val start = src.indexOf(from)
    assertTrue("找不到起锚点：$from", start >= 0)
    val end = src.indexOf(to, start + from.length)
    assertTrue("找不到止锚点：$to", end > start)
    return src.substring(start, end)
  }

  // ── L1：解压态信息量 ─────────────────────────────────────────────────────

  @Test
  fun `L1 解压态只有一行进度文本且日志与诊断包入口不可见`() {
    // 可见文本行：进度区只有一枚 TextView（百分比与剩余时间在同一行）。
    val chrome = codeOnly(source("GuideChrome.kt"))
    val progressArea = block(chrome, "val progressBar = ProgressBar(", "card.addView(progressText)")
    assertEquals(
      "进度区只允许一个文本节点（旧的阶段句/百分比/剩余时间三枚不得回来）",
      1,
      Regex("TextView\\(activity\\)").findAll(progressArea).count(),
    )
    assertFalse("旧的百分比节点不得存在", progressArea.contains("progressPercent"))
    assertFalse("旧的剩余时间节点不得存在", progressArea.contains("progressEta"))
    // 纯语义：确定态一行 = 百分比 + 分隔符 + 剩余时间。
    val line = formatProgressLine(ExtractProgressView(true, 42, "42%", "预计还需 3 分钟"))!!
    assertTrue("百分比与剩余时间必须同一行", line.contains("42%") && line.contains("预计还需 3 分钟"))
    // 日志区与诊断包入口：解压/启动进行中不得点亮。
    assertFalse("解压中日志区必须隐藏", diagnosticsAllowedForPhase(GuidePhase.Extracting))
    assertFalse("启动中日志区必须隐藏", diagnosticsAllowedForPhase(GuidePhase.Starting))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue(
      "日志区可见性必须受相位策略约束",
      renderer.contains("tail.isNotEmpty() && diagnosticsAllowedForPhase(lastGuidePhase)"),
    )
    assertTrue(
      "诊断包入口可见性必须受相位策略约束",
      renderer.contains("diagnosticsAllowedForPhase(lastGuidePhase)") &&
        renderer.contains("LogShare.shouldOffer(activity.filesDir, phaseIsFailed())"),
    )
  }

  // ── L2：页面上没有卡片外观 ───────────────────────────────────────────────

  @Test
  fun `L2 状态与进度容器没有背景描边和卡片圆角`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    val card = block(chrome, "val card = LinearLayout(activity)", "val statusDot = View(activity)")
    assertFalse("承载状态与进度的容器不得设背景", card.contains("background ="))
    assertFalse("不得再有卡片描边", card.contains("ds_hairline"))
    assertFalse("不得再有卡片圆角", card.contains("ds_radius_card"))
    assertFalse("不得再有卡片内边距式外壳", card.contains("setPadding(dpix(R.dimen.ds_space_24)"))
    assertTrue("内容必须直接落在页面画布上", chrome.contains("setBackgroundColor(color(R.color.ds_bg))"))
  }

  // ── L3：品牌竖排居中 ─────────────────────────────────────────────────────

  @Test
  fun `L3 图标在标题上方且品牌块水平居中`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    val brand = block(chrome, "val brandBlock = LinearLayout(activity)", "content.addView(brandBlock)")
    assertTrue("品牌块必须竖排", brand.contains("orientation = LinearLayout.VERTICAL"))
    assertTrue("品牌块必须水平居中", brand.contains("gravity = Gravity.CENTER_HORIZONTAL"))
    val iconAt = brand.indexOf("brandBlock.addView(iconPlate)")
    val titleAt = brand.indexOf("brandBlock.addView(titleView)")
    assertTrue("图标必须挂在标题之前（上方）", iconAt in 0 until titleAt)
    val title = block(chrome, "val titleView = TextView(activity)", "val subtitleView = TextView(activity)")
    assertTrue("标题必须是 app_name", title.contains("R.string.app_name"))
    assertTrue("标题字号必须在 26–28sp", title.contains("27f"))
    assertTrue("标题必须水平居中", title.contains("gravity = Gravity.CENTER"))
    val subtitle = block(chrome, "val subtitleView = TextView(activity)", "val versionLabel = TextView(activity)")
    assertTrue("副标题必须复用能力说明文案", subtitle.contains("R.string.ds_brand_explain"))
    assertTrue("副标题必须是 14sp", subtitle.contains("14f"))
    assertTrue("副标题必须水平居中", subtitle.contains("gravity = Gravity.CENTER"))
    // 版本号降级：11sp 三级色，不再与标题抢视觉。
    val version = block(chrome, "val versionLabel = TextView(activity)", "val brandBlock = LinearLayout(activity)")
    assertTrue("版本号必须 11sp", version.contains("11f"))
    assertTrue("版本号必须三级色", version.contains("R.color.ds_text_tertiary"))
  }

  // ── L4：进度行文案 ───────────────────────────────────────────────────────

  @Test
  fun `L4 百分比与剩余时间合成一行且缺估计时不留分隔符`() {
    val zh = ExtractProgressView(true, 42, "42%", "预计还需 3 分钟")
    assertEquals("42% · 预计还需 3 分钟", formatProgressLine(zh))
    val en = ExtractProgressView(true, 42, "42%", "About 3 min left")
    assertEquals("42% · About 3 min left", formatProgressLine(en))
    // 只有百分比：不得留「 · 」或空尾巴。
    val pctOnly = ExtractProgressView(true, 42, "42%", null)
    assertEquals("42%", formatProgressLine(pctOnly))
    assertFalse("缺估计时不得出现分隔符", formatProgressLine(pctOnly)!!.contains("·"))
    // 不确定态：整行没有数字，交给阶段句。
    assertNull("不确定态不得有数字行", formatProgressLine(ExtractProgressView.INDETERMINATE))
    for (phrase in RUNTIME_STAGE_PHRASES) {
      assertTrue("阶段句不得含数字：$phrase", numbersOnlyFromModel(phrase, emptyList()))
    }
  }

  // ── L5：底部按钮形态 ─────────────────────────────────────────────────────

  @Test
  fun `L5 进行中主按钮为次级收紧档且空闲恢复强调色满宽`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    val style = block(
      chrome,
      "internal fun applyGuidePrimaryStyle(activity: ComponentActivity, button: Button, compact: Boolean)",
      "private fun chipView",
    )
    assertTrue("进行中高度必须是 ds_btn_secondary_height 这一档", style.contains("R.dimen.ds_btn_secondary_height"))
    assertTrue("进行中必须收窄而不是满宽", style.contains("R.dimen.ds_guide_primary_compact_width"))
    assertTrue("进行中不得再写满宽强调块", style.contains("lp.weight = 0f"))
    assertTrue("进行中必须是描边浅底次级观感", style.contains("R.color.ds_hairline"))
    assertTrue("空闲/失败必须恢复强调色实心", style.contains("R.color.ds_accent"))
    assertTrue("空闲/失败必须满宽", style.contains("lp.weight = 1f"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("渲染层必须按锁定态切换两档", renderer.contains("applyGuidePrimaryStyle(activity, chrome.primaryButton, locked)"))
    assertTrue("进行中文案必须是「启动中」", renderer.contains("ds_starting"))
    assertTrue("空闲文案必须仍是「启动引擎」", renderer.contains("ds_start_engine"))
  }

  // ── L6：颜色 token ───────────────────────────────────────────────────────

  @Test
  fun `L6 启动页新增视图颜色全部来自 ds token`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    val start = chrome.indexOf("val iconPlate = FrameLayout(activity)")
    val end = chrome.indexOf("card.addView(progressText)")
    assertTrue("找不到品牌/状态/进度区", start in 0 until end)
    val region = chrome.substring(start, end)
    val colorCalls = Regex("""color\(([^)]*)\)""").findAll(region).map { it.groupValues[1].trim() }.toList()
    assertTrue("品牌与状态区必须读颜色 token", colorCalls.isNotEmpty())
    for (c in colorCalls) assertTrue("颜色必须是 R.color.ds_*：$c", c.startsWith("R.color.ds_"))
    for (banned in listOf("Color.", "0xFF", "#", "parseColor", "rgb(")) {
      assertFalse("启动页新增视图不得硬编码颜色（$banned）", region.contains(banned))
    }
  }

  // ── L7：错误态不退化（复用既有错误路径，只补相位策略断言）─────────────────

  @Test
  fun `L7 失败相位仍保留日志诊断与修复入口`() {
    assertTrue("Error 相位必须允许日志与诊断包", diagnosticsAllowedForPhase(GuidePhase.Error))
    assertTrue("Closed 相位必须允许日志与诊断包", diagnosticsAllowedForPhase(GuidePhase.Closed))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("错误横幅必须仍在渲染层可点亮", renderer.contains("crashBanner.visibility = View.VISIBLE"))
    assertTrue("修复助手行必须仍在 Error 相位出现", renderer.contains("if (phase == GuidePhase.Error) View.VISIBLE else View.GONE"))
    assertTrue("错误态主按钮必须恢复强调色（locked 为 false 时走实心档）", renderer.contains("startupRetryAction = phase == GuidePhase.Error"))
    assertTrue("分享诊断包入口仍由证据点亮", renderer.contains("LogShare.shouldOffer(activity.filesDir, phaseIsFailed())"))
  }
}
