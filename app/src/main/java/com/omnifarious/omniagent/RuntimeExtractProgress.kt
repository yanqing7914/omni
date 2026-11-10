package com.omnifarious.omniagent

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream

// 首启解压的**真实进度模型**（纯 JVM，无 Android 类型）。
//
// 旧形态（GuidePageRenderer 0.14.2 P2 说明）：分子是解压后的 tar 条目字节，分母是 xz **压缩**长度，
// 于是读数能超过 100%；当年只能把数字整体下线、只留循环动画。真分母一直写在 xz 尾部 index 里：
// 每个 block 的解压后大小都记在那里，加起来就是整条解压流的字节数，读它只需随机访问文件尾部。
// 分子同口径：SnapshotExtractor 统计从 xz 解码器读出的字节数（含 tar 头与填充），走完恰好等于分母。
//
// 本文件只放判据与格式化；视图写入在 GuidePageRenderer，数据来源在 EngineManager。

/** xz 尾部 index 里的解压后总字节数。 */
internal object XzIndexTotal {

  /**
   * 读 [input] 指向的整条 .xz 流的解压后总大小。
   *
   * @returns 字节数；index 损坏、截断、流不完整或总量非正时返回 null（调用方据此走不确定态）。
   *   不关闭 [input]：它的生命周期归调用方。
   */
  fun uncompressedSize(input: SeekableInputStream): Long? = try {
    // SeekableXZInputStream 的构造函数只做两件事：从尾部倒读 stream footer 与 index，校验它们。
    // 不解码任何 block，故对 160 MB 资产也只读几 KB。
    val xz = SeekableXZInputStream(input)
    xz.length().takeIf { it > 0 }
  } catch (_: IOException) {
    null
  } catch (_: RuntimeException) {
    null
  }

  /**
   * 文件中 `[base, base + length)` 这一段的随机读视图。
   *
   * APK 里 STORED 的 asset 就是 APK 文件里的一段连续字节（AssetFileDescriptor 给出起点与长度）。
   * 用 positional read（`channel.read(buf, pos)`）而不是 `channel.position()`，不改共享 fd 的游标。
   * [close] 不关闭 [channel]——通道归打开它的一方。
   */
  class ChannelRange(
    private val channel: FileChannel,
    private val base: Long,
    private val length: Long,
  ) : SeekableInputStream() {
    private var pos = 0L

    init {
      require(base >= 0 && length >= 0) { "invalid range base=$base length=$length" }
    }

    override fun length(): Long = length

    override fun position(): Long = pos

    override fun seek(pos: Long) {
      if (pos < 0) throw IOException("negative seek position $pos")
      this.pos = pos
    }

    override fun read(): Int {
      val one = ByteArray(1)
      return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xFF
    }

    override fun read(buf: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      if (pos >= length) return -1
      val want = minOf(len.toLong(), length - pos).toInt()
      val n = channel.read(ByteBuffer.wrap(buf, off, want), base + pos)
      if (n <= 0) return -1
      pos += n
      return n
    }

    override fun close() = Unit
  }
}

/** 本次解压属于首次安装还是覆盖安装后的运行时刷新（决定标题与说明文案）。 */
internal enum class RuntimeInstallKind { FIRST_INSTALL, REFRESH }

/**
 * 首次/非首次的判定（纯函数）。
 *
 * 只有「live 树里没有 node、也没有已提交指纹」才算首次安装：那是用户第一次打开、磁盘上什么都没有的状态，
 * 「只有这一次」这句承诺才成立。任一存在都说明之前装好过（覆盖安装后刷新、或树受损后重解压），
 * 这时说「首次安装」就是错的。
 */
internal fun runtimeInstallKind(liveRuntimePresent: Boolean, committedFingerprintPresent: Boolean): RuntimeInstallKind =
  if (!liveRuntimePresent && !committedFingerprintPresent) RuntimeInstallKind.FIRST_INSTALL else RuntimeInstallKind.REFRESH

/**
 * 单调百分比（钳在 0..100）。
 *
 * - 显示值只增不减：解压回调来自同一线程但经 runOnUiThread 排队，乱序或重复样本不得让进度条倒退；
 * - 流程未报告完成前最多 99：分子达到或超过分母只说明解码读完，后面还有校验与换树，不能先写 100；
 * - [finish] 之后恒为 100。
 */
internal class MonotonicPercent {
  private var shown = 0
  private var finished = false

  /** @returns 应显示的百分比；[total] 非正时返回 null（无可信分母）。 */
  fun update(done: Long, total: Long): Int? {
    if (total <= 0) return null
    if (finished) return 100
    val raw = if (done <= 0) 0 else ((done.toDouble() / total.toDouble()) * 100.0).toInt()
    shown = maxOf(shown, raw.coerceIn(0, 99))
    return shown
  }

  fun finish() {
    finished = true
    shown = 100
  }

  val current: Int get() = shown

  fun reset() {
    shown = 0
    finished = false
  }
}

/** 剩余时间：还在估算，或一个已平滑、按 [RemainingTimeEstimator.GRANULARITY_SEC] 取整的秒数。 */
internal sealed interface Eta {
  object Estimating : Eta
  data class Seconds(val seconds: Long) : Eta
}

/**
 * 剩余时间估计（单调时钟 + 字节速率，纯逻辑）。
 *
 * - 至少累计 [minElapsedMs] 且进度达到 [minFraction] 才给数：起步阶段的速率主要是 IO 预热与小文件，
 *   据此外推会给出离谱的值；
 * - 速率 = 窗口速率的指数平滑与全程平均速率各半：前者跟得上变化，后者压住抖动；
 * - 显示值按时间流逝递减，再向新的原始估计靠拢，单次修正幅度不超过 [MAX_STEP_FRACTION]（或
 *   [MIN_STEP_SEC] 秒，取大者）；最后向上取整到 5 秒粒度，免得读数每秒都在跳；
 * - 时钟回拨（nowMs 小于上次）不计时长、不出负数，只重新锚定窗口起点。
 */
internal class RemainingTimeEstimator(
  private val minElapsedMs: Long = MIN_ELAPSED_MS,
  private val minFraction: Double = MIN_FRACTION,
) {
  private var started = false
  private var windowStartMs = 0L
  private var windowStartDone = 0L
  private var firstDone = 0L
  private var lastDone = 0L
  private var elapsedMs = 0L
  private var rateEwma: Double? = null
  private var smoothedSec: Double? = null
  private var lastShownAtElapsed = 0L

  /** 当前累计的有效耗时（毫秒，回拨期间不计）。 */
  val elapsed: Long get() = elapsedMs

  fun sample(nowMs: Long, done: Long, total: Long): Eta {
    if (total <= 0) return Eta.Estimating
    val safeDone = done.coerceIn(0, total)
    if (!started) {
      started = true
      windowStartMs = nowMs
      windowStartDone = safeDone
      firstDone = safeDone
      lastDone = safeDone
      return Eta.Estimating
    }
    lastDone = maxOf(lastDone, safeDone)
    if (nowMs < windowStartMs) {
      // 时钟回拨：丢弃当前窗口，从新时刻重新起算；已累计的时长与速率保留。
      windowStartMs = nowMs
      windowStartDone = lastDone
      return held()
    }
    val dt = nowMs - windowStartMs
    // 窗口未满：不重算（否则同一窗口内的多次回调会各自叠一次修正幅度，平滑形同虚设）。
    if (dt < WINDOW_MS) return held()
    val windowRate = (lastDone - windowStartDone).coerceAtLeast(0).toDouble() / dt.toDouble()
    rateEwma = rateEwma?.let { it + EWMA_ALPHA * (windowRate - it) } ?: windowRate
    elapsedMs += dt
    windowStartMs = nowMs
    windowStartDone = lastDone
    return recompute(total)
  }

  /** 不重算时沿用上一次的显示值（尚无显示值则仍在估算）。 */
  private fun held(): Eta = smoothedSec?.let { shown(it) } ?: Eta.Estimating

  private fun recompute(total: Long): Eta {
    val fraction = lastDone.toDouble() / total.toDouble()
    val ewma = rateEwma
    if (elapsedMs < minElapsedMs || fraction < minFraction || ewma == null) return held()
    val average = (lastDone - firstDone).coerceAtLeast(0).toDouble() / elapsedMs.toDouble()
    val rate = 0.5 * ewma + 0.5 * average
    if (rate <= 0.0) return held()
    val rawSec = (total - lastDone).coerceAtLeast(0).toDouble() / rate / 1000.0
    val prior = smoothedSec
    val next = if (prior == null) {
      rawSec
    } else {
      val expected = (prior - (elapsedMs - lastShownAtElapsed) / 1000.0).coerceAtLeast(0.0)
      val step = maxOf(expected * MAX_STEP_FRACTION, MIN_STEP_SEC)
      expected + (rawSec - expected).coerceIn(-step, step)
    }
    smoothedSec = next.coerceAtLeast(0.0)
    lastShownAtElapsed = elapsedMs
    return shown(smoothedSec!!)
  }

  private fun shown(sec: Double): Eta.Seconds {
    val g = GRANULARITY_SEC
    val rounded = (kotlin.math.ceil(sec / g) * g).toLong()
    return Eta.Seconds(rounded.coerceAtLeast(0))
  }

  fun reset() {
    started = false
    windowStartMs = 0L
    windowStartDone = 0L
    firstDone = 0L
    lastDone = 0L
    elapsedMs = 0L
    rateEwma = null
    smoothedSec = null
    lastShownAtElapsed = 0L
  }

  companion object {
    const val MIN_ELAPSED_MS = 3_000L
    const val MIN_FRACTION = 0.05
    /** 速率窗口：短于它的样本只累计字节，不单独算速率（每 MB 一次回调，间隔可短到几毫秒）。 */
    const val WINDOW_MS = 500L
    const val EWMA_ALPHA = 0.2
    const val MAX_STEP_FRACTION = 0.15
    const val MIN_STEP_SEC = 5.0
    const val GRANULARITY_SEC = 5L
  }
}

/**
 * 进度面要显示的一切（由 [RuntimeExtractProgress] 产出，视图层只照抄）。
 *
 * [determinate] 为 false 时 [percent]/[percentLabel]/[etaLabel] 全为 null：没有可信分母就不显示任何数字。
 */
internal data class ExtractProgressView(
  val determinate: Boolean,
  val percent: Int?,
  val percentLabel: String?,
  val etaLabel: String?,
) {
  /** 由模型格式化出来、允许含数字的那几段。 */
  val numericSegments: List<String> get() = listOfNotNull(percentLabel, etaLabel)

  companion object {
    val INDETERMINATE = ExtractProgressView(false, null, null, null)
  }
}

/** 百分比 + 剩余时间 + 首装预计总时长的组合模型（UI 线程调用；纯逻辑）。 */
internal class RuntimeExtractProgress {
  private val percent = MonotonicPercent()
  private val eta = RemainingTimeEstimator()

  /** 首次给出剩余时间时冻结的「约需 N 分钟」（全程预计总时长）；之后不再变，避免说明文案反复改写。 */
  var estimatedTotalMinutes: Int? = null
    private set

  fun update(nowMs: Long, done: Long, total: Long, english: Boolean): ExtractProgressView {
    val pct = percent.update(done, total) ?: return ExtractProgressView.INDETERMINATE
    val remaining = eta.sample(nowMs, done, total)
    if (estimatedTotalMinutes == null && remaining is Eta.Seconds) {
      estimatedTotalMinutes = ceilMinutes(eta.elapsed / 1000 + remaining.seconds)
    }
    // 还在估算时不给 etaLabel：进度行只应该出现「已知道的数字」。
    // 旧实现把「正在估算剩余时间…」也塞进进度行，于是同一行在百分比后挂着一段无信息量的字，
    // 用户读到的仍然是「不知道」。现在缺估计就只留百分比。
    val etaLabel = (remaining as? Eta.Seconds)?.let { formatEta(it, english) }
    return ExtractProgressView(true, pct, formatPercent(pct), etaLabel)
  }

  /** 流程报告解压完成后调用：百分比到 100，剩余时间不再显示。 */
  fun finish(english: Boolean): ExtractProgressView {
    percent.finish()
    return ExtractProgressView(true, 100, formatPercent(100), null)
  }

  fun reset() {
    percent.reset()
    eta.reset()
    estimatedTotalMinutes = null
  }
}

private fun ceilMinutes(seconds: Long): Int = ((seconds.coerceAtLeast(1) + 59) / 60).toInt().coerceAtLeast(1)

internal fun formatPercent(percent: Int): String = percent.coerceIn(0, 100).toString() + "%"

internal fun formatEta(eta: Eta, english: Boolean): String = when (eta) {
  Eta.Estimating -> UiText.t(english, "正在估算剩余时间…", "Estimating time left…")
  is Eta.Seconds -> when {
    eta.seconds <= 0L -> UiText.t(english, "即将完成", "Almost done")
    eta.seconds < 60L -> UiText.t(english, "预计还需不到 1 分钟", "Less than 1 min left")
    else -> {
      val minutes = ceilMinutes(eta.seconds)
      UiText.t(english, "预计还需 $minutes 分钟", "About $minutes min left")
    }
  }
}

/**
 * 进度区唯一文本行的拼法（确定态）。
 *
 * 形态由用户选定：`42% · 预计还需 3 分钟`。剩余时间缺席时只显示百分比，**不留分隔符**——
 * 「42% · 」这种尾随符号会让用户以为后面还有内容没加载出来。
 * 不确定态没有可信数字，返回 null，由渲染层改显示阶段句。
 */
internal fun formatProgressLine(view: ExtractProgressView): String? {
  if (!view.determinate) return null
  val pct = view.percentLabel ?: return null
  val eta = view.etaLabel
  return if (eta.isNullOrBlank()) pct else pct + " · " + eta
}

/** 首装说明里那段时长（由模型格式化，是说明文案里唯一允许出现数字的地方）。 */
internal fun formatTotalDuration(minutes: Int, english: Boolean): String =
  UiText.t(english, "约需 $minutes 分钟", "about $minutes min")

/** 解压相位的标题。 */
internal fun runtimeExtractTitle(kind: RuntimeInstallKind, english: Boolean): String = when (kind) {
  RuntimeInstallKind.FIRST_INSTALL -> UiText.t(english, "正在解压运行时", "Unpacking the runtime")
  RuntimeInstallKind.REFRESH -> UiText.t(english, "正在更新运行时", "Updating the runtime")
}

/**
 * 解压相位的说明。
 *
 * @param durationSegment [formatTotalDuration] 的输出；null = 还没有估计，句子里就不写数字。
 */
internal fun runtimeExtractHint(kind: RuntimeInstallKind, durationSegment: String?, english: Boolean): String = when (kind) {
  RuntimeInstallKind.FIRST_INSTALL -> if (durationSegment != null) {
    UiText.t(english,
      "首次安装需要准备运行时，只有这一次，$durationSegment。",
      "The first launch prepares the runtime, only this once, $durationSegment.")
  } else {
    UiText.t(english,
      "首次安装需要准备运行时，只有这一次。",
      "The first launch prepares the runtime, only this once.")
  }
  RuntimeInstallKind.REFRESH -> UiText.t(english,
    "应用已更新，正在更新运行时，你的数据会保留。请保持应用在前台。",
    "The app was updated; refreshing the runtime. Your data stays. Keep the app open.")
}

/**
 * 「数字必须有来源」判据（替换 0.14.2 的 stagePhraseHasNoNumbers 一刀切规则）。
 *
 * 0.14.2 下线数字的理由是分母编造；现在分母来自 xz index，数字可以回来，但只能来自进度模型。
 * 判法：把 [modelSegments]（模型格式化出的那几段）在 [text] 里出现的那一处各删一次，剩下的部分必须不含数字与百分号。
 * 不确定态下 [modelSegments] 为空，于是退化为「整句不含数字」。
 */
internal fun numbersOnlyFromModel(text: String, modelSegments: List<String>): Boolean {
  var rest = text
  for (segment in modelSegments) {
    if (segment.isEmpty()) continue
    val at = rest.indexOf(segment)
    if (at < 0) continue
    rest = rest.removeRange(at, at + segment.length)
  }
  return stagePhraseHasNoNumbers(rest)
}
