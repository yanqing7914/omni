package com.omnifarious.omniagent

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.SeekableFileInputStream
import org.tukaani.xz.XZOutputStream

/**
 * 首启解压真实进度模型（RuntimeExtractProgress.kt）的验收用例 A1–A6。
 *
 * A1 用现场生成的多 block .tar.xz：既验「index 总量 == 实际解压字节数」，也验 APK 内嵌形态
 * （asset 是大文件里的一段，前面有别的字节）与损坏/截断时返回 null。
 */
class RuntimeExtractProgressTest {

  private val newline: String = 10.toChar().toString()

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
    .joinToString(newline)

  /** tar 原始字节（未压缩），内容随机以免 LZMA2 把它压得只剩几字节。 */
  private fun tarBytes(): ByteArray {
    val rnd = java.util.Random(42)
    val out = ByteArrayOutputStream()
    TarArchiveOutputStream(out).use { tar ->
      for (i in 0 until 6) {
        val body = ByteArray(40_000 + i * 7_919).also { rnd.nextBytes(it) }
        val entry = TarArchiveEntry("usr/file$i.bin")
        entry.size = body.size.toLong()
        tar.putArchiveEntry(entry)
        tar.write(body)
        tar.closeArchiveEntry()
      }
    }
    return out.toByteArray()
  }

  /** 按 [blockBytes] 切成多个 xz block（XZOutputStream.endBlock）。 */
  private fun xzMultiBlock(raw: ByteArray, blockBytes: Int): ByteArray {
    val out = ByteArrayOutputStream()
    XZOutputStream(out, LZMA2Options(1)).use { xz ->
      var off = 0
      while (off < raw.size) {
        val n = minOf(blockBytes, raw.size - off)
        xz.write(raw, off, n)
        xz.endBlock()
        off += n
      }
    }
    return out.toByteArray()
  }

  private fun tempFile(bytes: ByteArray): File =
    Files.createTempFile("rt-progress", ".xz").toFile().also { it.writeBytes(bytes); it.deleteOnExit() }

  private fun indexTotalOf(bytes: ByteArray): Long? {
    val f = tempFile(bytes)
    return try {
      SeekableFileInputStream(f).use { XzIndexTotal.uncompressedSize(it) }
    } finally {
      f.delete()
    }
  }

  // ── A1：总量来自 xz index ──────────────────────────────────────────────

  @Test
  fun `A1 多 block 的 xz index 总量等于实际解压字节数`() {
    val raw = tarBytes()
    val xz = xzMultiBlock(raw, 64 * 1024)
    // 自证确实是多 block：block 数 = ceil(raw / 64K) ≥ 4。
    assertTrue("夹具必须是多 block：raw=${raw.size}", raw.size > 3 * 64 * 1024)
    assertEquals(raw.size.toLong(), indexTotalOf(xz))
  }

  @Test
  fun `A1 asset 嵌在大文件中间时按偏移读 index 仍得到真实总量`() {
    // APK 里 STORED 的 asset 就是这种形态：前后都有别的字节，AssetFileDescriptor 给起点与长度。
    val raw = tarBytes()
    val xz = xzMultiBlock(raw, 50_000)
    val prefix = ByteArray(12_345) { 7 }
    val suffix = ByteArray(999) { 9 }
    val f = tempFile(prefix + xz + suffix)
    try {
      RandomAccessFile(f, "r").use { raf ->
        val range = XzIndexTotal.ChannelRange(raf.channel, prefix.size.toLong(), xz.size.toLong())
        assertEquals(raw.size.toLong(), XzIndexTotal.uncompressedSize(range))
        // 不改通道游标（positional read）：共享 fd 的其它读者不受影响。
        assertEquals(0L, raf.channel.position())
      }
    } finally {
      f.delete()
    }
  }

  @Test
  fun `A1 index 损坏或截断时返回 null 且界面不出任何数字`() {
    val xz = xzMultiBlock(tarBytes(), 64 * 1024)
    // 截断尾部：stream footer 丢失。
    assertNull("截断尾部必须返回 null", indexTotalOf(xz.copyOf(xz.size - 7)))
    // 只剩前半截。
    assertNull("只剩一半必须返回 null", indexTotalOf(xz.copyOf(xz.size / 2)))
    // 改坏 index 里的一个字节（index 紧挨在 12 字节 footer 之前；CRC32 会拒绝它）。
    val corrupt = xz.copyOf().also { it[it.size - 14] = (it[it.size - 14].toInt() xor 0x5A).toByte() }
    assertNull("index 字节被改写必须返回 null", indexTotalOf(corrupt))
    // 根本不是 xz。
    assertNull("非 xz 必须返回 null", indexTotalOf(ByteArray(4096) { 1 }))
    assertNull("空文件必须返回 null", indexTotalOf(ByteArray(0)))

    // 拿不到总量 ⇒ total=0 ⇒ 模型给不确定态，界面没有任何数字段。
    val model = RuntimeExtractProgress()
    for (t in 0..20) {
      val v = model.update(t * 1_000L, t * 1_000_000L, 0L, english = false)
      assertFalse("无总量必须是不确定态", v.determinate)
      assertNull(v.percent)
      assertNull(v.percentLabel)
      assertNull(v.etaLabel)
      assertTrue(v.numericSegments.isEmpty())
    }
    assertNull("无总量不得产生预计时长", model.estimatedTotalMinutes)
  }

  @Test
  fun `A1 解压进度分子与 index 总量同口径且走完时恰好相等`() {
    val raw = tarBytes()
    val xz = xzMultiBlock(raw, 64 * 1024)
    val total = indexTotalOf(xz)!!
    val dest = Files.createTempDirectory("rt-progress-dest").toFile()
    try {
      val seen = mutableListOf<Pair<Long, Long>>()
      SnapshotExtractor.extract(xz.inputStream(), total, dest, { d, t -> seen += d to t })
      for ((d, t) in seen) {
        assertEquals("分母必须原样是 index 总量", total, t)
        assertTrue("分子不得超过分母：$d > $t", d <= t)
      }
      // 计数器本身：读完整条流后等于 index 总量（夹具小于 1 MiB，单独用 DecodedProgress 验口径）。
      val counter = SnapshotExtractor.DecodedProgress(
        org.apache.commons.compress.compressors.xz.XZCompressorInputStream(xz.inputStream()), total, { _, _ -> },
      )
      val buf = ByteArray(8192)
      while (counter.read(buf) >= 0) Unit
      assertEquals("解码字节数必须等于 index 总量", total, counter.count)
    } finally {
      dest.deleteRecursively()
    }
  }

  @Test
  fun `A1 生产链路读的是 index 解压总量而不是压缩长度`() {
    val em = codeOnly(source("EngineManager.kt"))
    assertTrue(em.contains("SnapshotExtractor.extract(input, uncompressedTotal, stage, onProgress"))
    assertFalse("压缩长度不得再当进度分母", em.contains("SnapshotExtractor.extract(input, assetLength"))
    assertTrue(em.contains("XzIndexTotal.uncompressedSize(XzIndexTotal.ChannelRange(stream.channel, afd.startOffset, afd.length))"))
  }

  // ── A2：百分比单调、钳位、99 封顶直到完成 ──────────────────────────────

  @Test
  fun `A2 百分比单调不减并钳在 0 到 100`() {
    val p = MonotonicPercent()
    val total = 1_000L
    val inputs = listOf(0L, 100L, 50L, 300L, 299L, -5L, 700L, 650L, 990L, 995L)
    var prev = -1
    for (d in inputs) {
      val v = p.update(d, total)!!
      assertTrue("必须在 [0,100]：$v", v in 0..100)
      assertTrue("不得倒退：$prev -> $v（done=$d）", v >= prev)
      prev = v
    }
    assertEquals(99, prev)
    assertNull("无分母不给数", p.update(10, 0))
    assertNull(p.update(10, -1))
  }

  @Test
  fun `A2 done 超过 total 时显示 99 直到流程报告完成才到 100`() {
    val p = MonotonicPercent()
    assertEquals(99, p.update(1_000, 1_000))
    assertEquals(99, p.update(5_000, 1_000))
    assertEquals(99, p.update(Long.MAX_VALUE, 1_000))
    p.finish()
    assertEquals(100, p.update(10, 1_000))
    assertEquals(100, p.current)

    val model = RuntimeExtractProgress()
    assertEquals(99, model.update(0, 2_000, 1_000, english = false).percent)
    val done = model.finish(english = false)
    assertEquals(100, done.percent)
    assertEquals("100%", done.percentLabel)
    assertNull("完成后不再显示剩余时间", done.etaLabel)
  }

  // ── A3：剩余时间 ───────────────────────────────────────────────────────

  @Test
  fun `A3 少于 3 秒或少于 5 个百分点时返回估算中`() {
    val total = 1_000_000_000L
    // 快：1 秒就到 50%，但不足 3 秒 ⇒ 估算中。
    val fast = RemainingTimeEstimator()
    for (ms in 0L..2_500L step 100L) {
      assertEquals("不足 3 秒（t=$ms）", Eta.Estimating, fast.sample(ms, total / 2 * ms / 1_000, total))
    }
    // 慢：10 秒只到 4% ⇒ 估算中。
    val slow = RemainingTimeEstimator()
    for (ms in 0L..10_000L step 100L) {
      assertEquals("不足 5%（t=$ms）", Eta.Estimating, slow.sample(ms, (total * 0.04 * ms / 10_000).toLong(), total))
    }
    // 之后有值：再走到 6%。
    var last: Eta = Eta.Estimating
    for (ms in 10_100L..14_000L step 100L) last = slow.sample(ms, (total * 0.06 * ms / 14_000).toLong(), total)
    assertTrue("过了 3 秒且过了 5% 必须给出秒数：$last", last is Eta.Seconds)
    assertEquals("正在估算剩余时间…", formatEta(Eta.Estimating, english = false))
    assertEquals("Estimating time left…", formatEta(Eta.Estimating, english = true))
  }

  @Test
  fun `A3 速率一段快一段慢时显示值平滑且按 5 秒粒度`() {
    val total = 800L * 1024 * 1024
    val est = RemainingTimeEstimator()
    var done = 0L
    var prev: Long? = null
    var maxJump = 0L
    // 前 60 秒 8 MiB/s，之后 2 MiB/s（四倍落差），每 100ms 一次回调。
    var rawJumpAtSwitch = 0.0
    for (tick in 0..3_000) {
      val ms = tick * 100L
      done = (done + if (ms < 60_000) 8L * 1024 * 1024 / 10 else 2L * 1024 * 1024 / 10).coerceAtMost(total)
      val eta = est.sample(ms, done, total)
      if (ms == 60_000L) {
        // 不平滑的瞬时估计在切换点的跳变：按旧速率 vs 新速率外推的剩余秒数之差。
        val left = (total - done).toDouble()
        rawJumpAtSwitch = left / (2.0 * 1024 * 1024) - left / (8.0 * 1024 * 1024)
      }
      if (eta is Eta.Seconds) {
        assertTrue("不得为负：${eta.seconds}", eta.seconds >= 0)
        assertEquals("按 5 秒粒度取整：${eta.seconds}", 0L, eta.seconds % RemainingTimeEstimator.GRANULARITY_SEC)
        val p = prev
        if (p != null) {
          val jump = kotlin.math.abs(eta.seconds - p)
          // 单次修正 ≤ max(15%, 5s)，加上取整的 5 秒与相邻样本间流逝的时间（≤1 秒）。
          val bound = maxOf((p * RemainingTimeEstimator.MAX_STEP_FRACTION).toLong() + 1, 5L) + 5L + 1L
          assertTrue("相邻两次显示变化过大：$p -> ${eta.seconds}（上限 $bound）", jump <= bound)
          maxJump = maxOf(maxJump, jump)
        }
        prev = eta.seconds
      }
      if (done >= total) break
    }
    assertNotNull("必须给出过秒数", prev)
    assertTrue("对照：不平滑时切换点会跳 ${rawJumpAtSwitch.toLong()} 秒，平滑后最大单步 $maxJump 秒", maxJump * 4 < rawJumpAtSwitch)
  }

  @Test
  fun `A3 时钟回拨不崩不出负数`() {
    val total = 100L * 1024 * 1024
    val est = RemainingTimeEstimator()
    var done = 0L
    val clock = mutableListOf<Long>()
    for (i in 0..200) clock += i * 100L
    // 中途回拨 30 秒，然后继续往前走；再来一次跳到负值。
    for (i in 0..100) clock += 20_000L - 30_000L + i * 100L
    clock += Long.MIN_VALUE / 2
    for (i in 0..50) clock += i * 200L
    for (now in clock) {
      done = (done + 256 * 1024).coerceAtMost(total)
      val eta = est.sample(now, done, total)
      if (eta is Eta.Seconds) assertTrue("回拨后不得出负数：${eta.seconds}", eta.seconds >= 0)
      assertTrue("有效耗时不得为负：${est.elapsed}", est.elapsed >= 0)
    }
    // 极端：done 超过 total / 负 done 也不出负数。
    val odd = RemainingTimeEstimator()
    for (i in 0..100) {
      val eta = odd.sample(i * 100L, if (i % 2 == 0) -10L else total * 2, total)
      if (eta is Eta.Seconds) assertTrue(eta.seconds >= 0)
    }
  }

  // ── A4：数字必须有来源 ─────────────────────────────────────────────────

  @Test
  fun `A4 不确定态文案不含数字，确定态数字只出现在模型格式化的那段`() {
    for (english in listOf(false, true)) {
      for (kind in RuntimeInstallKind.values()) {
        val title = runtimeExtractTitle(kind, english)
        val hintNoEstimate = runtimeExtractHint(kind, null, english)
        assertTrue("标题不得含数字：$title", numbersOnlyFromModel(title, emptyList()))
        assertTrue("无估计时说明不得含数字：$hintNoEstimate", numbersOnlyFromModel(hintNoEstimate, emptyList()))
      }
      // 首装有估计：数字只在 formatTotalDuration 那一段里。
      val seg = formatTotalDuration(7, english)
      val hint = runtimeExtractHint(RuntimeInstallKind.FIRST_INSTALL, seg, english)
      assertTrue("说明必须带上模型给的时长段：$hint", hint.contains(seg))
      assertTrue(numbersOnlyFromModel(hint, listOf(seg)))
      assertFalse("同一句若不扣掉模型段就含数字（反证判据不是恒真）", numbersOnlyFromModel(hint, emptyList()))
    }
    for (p in RUNTIME_STAGE_PHRASES) assertTrue(numbersOnlyFromModel(p, emptyList()))
    // 手写的数字（不是模型段）必须判红。
    assertFalse(numbersOnlyFromModel("正在解压 700MB（35%）", listOf("35%")))
    assertFalse(numbersOnlyFromModel("约 3 分钟", emptyList()))
    // 确定态：模型给出的数字段就是 numericSegments，视图只照抄这几段。
    val model = RuntimeExtractProgress()
    var view = model.update(0, 0, 1_000_000_000L, english = false)
    for (i in 1..200) view = model.update(i * 100L, i * 4_000_000L, 1_000_000_000L, english = false)
    assertTrue(view.determinate)
    val line = RUNTIME_STAGE_PHRASES[0] + " " + view.percentLabel + " · " + view.etaLabel
    assertTrue(numbersOnlyFromModel(line, view.numericSegments))
  }

  @Test
  fun `A4 渲染层的进度行只来自模型且全页只有这一行`() {
    val r = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue(
      "确定态必须用模型给出的两段拼成唯一一行",
      r.contains("progressText.text = formatProgressLine(view)"),
    )
    assertEquals(
      "进度行的拼法只允许这一处调用（多一处就会出现第二种口径）",
      1,
      Regex("""formatProgressLine\(""").findAll(r).count(),
    )
    val determinate = r.substringAfter("private fun renderDeterminate(")
      .substringBefore("private fun localizedStagePhrase(")
    assertEquals(
      "确定态里进度文本只写一次",
      1,
      Regex("""progressText\.text\s*=""").findAll(determinate).count(),
    )
    assertFalse("旧的三节点（百分比 / 剩余时间各一枚）不得回来", r.contains("progressPercent") || r.contains("progressEta"))
    assertFalse("渲染层不得自己拼百分号", r.contains("+ \"%\""))
  }

  // ── A5：首次/非首次分流 ────────────────────────────────────────────────

  @Test
  fun `A5 首次安装与覆盖更新的判定`() {
    assertEquals(RuntimeInstallKind.FIRST_INSTALL, runtimeInstallKind(liveRuntimePresent = false, committedFingerprintPresent = false))
    assertEquals(RuntimeInstallKind.REFRESH, runtimeInstallKind(liveRuntimePresent = true, committedFingerprintPresent = true))
    assertEquals("只有指纹（树坏了）也不是首次", RuntimeInstallKind.REFRESH, runtimeInstallKind(false, true))
    assertEquals("只有树（指纹丢了）也不是首次", RuntimeInstallKind.REFRESH, runtimeInstallKind(true, false))

    assertTrue(runtimeExtractHint(RuntimeInstallKind.FIRST_INSTALL, null, false).contains("首次安装"))
    assertTrue(runtimeExtractHint(RuntimeInstallKind.FIRST_INSTALL, null, false).contains("只有这一次"))
    assertTrue(runtimeExtractHint(RuntimeInstallKind.FIRST_INSTALL, null, true).contains("only this once"))
    assertFalse("更新不得说首次", runtimeExtractHint(RuntimeInstallKind.REFRESH, null, false).contains("首次"))
    assertTrue(runtimeExtractHint(RuntimeInstallKind.REFRESH, null, false).contains("正在更新运行时"))
    assertTrue(runtimeExtractTitle(RuntimeInstallKind.REFRESH, true).contains("Updating"))
    assertTrue(runtimeExtractTitle(RuntimeInstallKind.FIRST_INSTALL, false).contains("解压"))
    // 更新路径不带时长段（即便传了也不写进去：那句承诺只属于首装）。
    assertFalse(runtimeExtractHint(RuntimeInstallKind.REFRESH, formatTotalDuration(3, false), false).contains("3"))
  }

  @Test
  fun `A5 判定在刷新之前取一次`() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    val kindAt = flow.indexOf("val installKind = activity.engineManager.currentRuntimeInstallKind()")
    val refreshAt = flow.indexOf("val ok = activity.engineManager.refreshSnapshot(")
    assertTrue("必须在流程里取首装判定", kindAt >= 0)
    assertTrue("判定必须在 refreshSnapshot 之前", kindAt < refreshAt)
  }

  // ── A6：新视图颜色只来自 ds_* token ─────────────────────────────────────

  @Test
  fun `A6 进度区新增视图的颜色全部来自 R color ds token`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    val start = chrome.indexOf("val progressBar = ProgressBar(")
    val end = chrome.indexOf("card.addView(progressText)")
    assertTrue("找不到进度区", start in 0 until end)
    val block = chrome.substring(start, end)
    val colorCalls = Regex("""color\(([^)]*)\)""").findAll(block).map { it.groupValues[1].trim() }.toList()
    assertTrue("进度区必须读颜色 token", colorCalls.isNotEmpty())
    for (c in colorCalls) assertTrue("颜色必须是 R.color.ds_*：$c", c.startsWith("R.color.ds_"))
    for (banned in listOf("Color.", "0xFF", "#", "parseColor", "rgb(")) {
      assertFalse("进度区不得硬编码颜色（$banned）", block.contains(banned))
    }
    val model = codeOnly(source("RuntimeExtractProgress.kt"))
    assertFalse("进度模型不得碰颜色", model.contains("R.color") || model.contains("Color."))
  }
}
