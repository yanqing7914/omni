package com.omnifarious.omniagent

import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.util.ArrayDeque
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.tukaani.xz.ArrayCache
import org.tukaani.xz.BasicArrayCache
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream

/**
 * 可反复打开的 .xz 随机读源：每次 [open] 返回一个**独立游标**的视图。
 *
 * 每个解码线程各拿一个视图，彼此不共享读位置；生产实现是 [XzIndexTotal.ChannelRange]
 * （FileChannel 的 positional read 本身线程安全），单测用临时文件。
 */
fun interface XzRandomSource {
  fun open(): SeekableInputStream
}

/**
 * 多线程按 xz block 解码、按 block 序号**有序**输出的解压流。
 *
 * 为什么只并行解码层：tar 条目会跨 block 边界，tar 解析与写盘必须顺序进行；而 LZMA2 解码是
 * 首装等待里最重的 CPU 部分，且每个 block 可独立解码（xz 的 block 不共享字典）。于是各线程
 * 独立解出整块，消费方按序取用，下游 TarArchiveInputStream 看到的字节流与单线程完全相同。
 *
 * 内存有界：同时持有的 block（解码中 + 已解完待取 + 正被读取）不超过 [window] 个；
 * 每块一个 `blockSize` 的输出缓冲，解码器字典由解码线程各持一份（线程数 ≤ [window]）。
 *
 * 失败传播：某块解码失败时，消费方读到该块即抛出解码器的原异常（类型不变，栈在 cause 链上可追溯）；
 * 之前各块的字节照常交付，与单线程「读到坏处才失败」的语义一致。
 *
 * 取消不用线程中断：FileChannel 是可中断通道，中断正在读的线程会把**共享通道**关掉。改为在每段
 * 读取之间检查关闭标志，[close] 后各线程最多再做完一段读就退出，并在 [close] 内等它们结束。
 */
internal class ParallelXzInputStream private constructor(
  private val source: XzRandomSource,
  private val blockSizes: IntArray,
  private val window: Int,
  threads: Int,
) : InputStream() {

  private val closed = AtomicBoolean(false)
  // 关闭或已失败：解码线程据此尽快停手（失败后其余块的结果不再有人要）。
  private val stopping = AtomicBoolean(false)
  // 每个解码线程一份数组缓存：同一线程解下一块时复用上一块的字典与缓冲，免得每块重新分配 8 MiB 字典；
  // 不跨线程共享，因为 BasicArrayCache 没有承诺线程安全。
  private val arrayCache = ThreadLocal.withInitial<ArrayCache> { BasicArrayCache() }
  private val pool: ExecutorService = Executors.newFixedThreadPool(threads, NamedDaemonThreads())
  private val pending = ArrayDeque<Future<ByteArray>>()
  private var nextToSubmit = 0
  private var nextToTake = 0
  private var current: ByteArray? = null
  private var currentPos = 0
  private var failure: Throwable? = null

  // 单测观测量（B4）：同时在解码的块数、同时被持有的块缓冲数，各自的峰值。
  private val decoding = AtomicInteger(0)
  private val held = AtomicInteger(0)
  private val peakDecodingCounter = AtomicInteger(0)
  private val peakHeldCounter = AtomicInteger(0)

  val blockCount: Int get() = blockSizes.size
  val peakConcurrentDecodes: Int get() = peakDecodingCounter.get()
  val peakHeldBlocks: Int get() = peakHeldCounter.get()
  val decodeThreads: Int = threads

  /** 线程池是否已完全退出（[close] 之后应为 true）。 */
  val workersTerminated: Boolean get() = pool.isTerminated

  init {
    fill()
  }

  override fun read(): Int {
    val one = ByteArray(1)
    return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xFF
  }

  override fun read(b: ByteArray, off: Int, len: Int): Int {
    if (closed.get()) throw IOException("stream closed")
    failure?.let { throw it }
    if (len == 0) return 0
    var buf = current
    while (buf == null || currentPos >= buf.size) {
      if (buf != null) release()
      if (nextToTake >= blockSizes.size) return -1
      buf = take()
    }
    val n = minOf(len, buf.size - currentPos)
    System.arraycopy(buf, currentPos, b, off, n)
    currentPos += n
    return n
  }

  override fun available(): Int = current?.let { it.size - currentPos } ?: 0

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    stopping.set(true)
    current = null
    for (f in pending) f.cancel(false)
    pending.clear()
    pool.shutdown()
    try {
      if (!pool.awaitTermination(TERMINATION_WAIT_SECONDS, TimeUnit.SECONDS)) {
        // 正常情况下各线程一段读之内就会看到关闭标志；超时说明底层读卡住，只能退到中断。
        pool.shutdownNow()
      }
    } catch (e: InterruptedException) {
      pool.shutdownNow()
      Thread.currentThread().interrupt()
    }
  }

  /** 当前块读完：交还缓冲并补投下一块，保持「持有数 ≤ window」。 */
  private fun release() {
    current = null
    currentPos = 0
    held.decrementAndGet()
    fill()
  }

  private fun fill() {
    while (pending.size + (if (current != null) 1 else 0) < window && nextToSubmit < blockSizes.size) {
      val block = nextToSubmit++
      peak(peakHeldCounter, held.incrementAndGet())
      pending.addLast(pool.submit<ByteArray> { decodeBlock(block) })
    }
  }

  private fun take(): ByteArray {
    val future = pending.removeFirst()
    val buf = try {
      future.get()
    } catch (e: ExecutionException) {
      fail(e.cause ?: e)
    } catch (e: CancellationException) {
      fail(IOException("block decode cancelled", e))
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      fail(InterruptedIOException("interrupted while waiting for xz block $nextToTake"))
    }
    nextToTake += 1
    current = buf
    currentPos = 0
    return buf
  }

  /** 记下失败并提前停掉其余解码（不再需要它们的结果）；原异常照抛，类型与单线程路径一致。 */
  private fun fail(cause: Throwable): Nothing {
    val error = when (cause) {
      is IOException, is RuntimeException, is Error -> cause
      else -> IOException(cause)
    }
    failure = error
    stopping.set(true)
    for (f in pending) f.cancel(false)
    throw error
  }

  private fun decodeBlock(block: Int): ByteArray {
    peak(peakDecodingCounter, decoding.incrementAndGet())
    try {
      val out = ByteArray(blockSizes[block])
      // 每块独立打开一个解码器：构造时只读尾部 index（几 KB），seekToBlock 直达块起点。
      // 读满块长时解码器会校验该块的完整性检查（CRC/SHA），坏块在这里抛 CorruptedInputException。
      openXz(source, arrayCache.get()).use { xz ->
        xz.seekToBlock(block)
        var off = 0
        while (off < out.size) {
          if (stopping.get()) throw CancellationException("parallel xz stream closed")
          val n = xz.read(out, off, minOf(READ_SLICE_BYTES, out.size - off))
          if (n < 0) throw IOException("xz block $block ended early at $off of ${out.size} bytes")
          off += n
        }
      }
      return out
    } finally {
      decoding.decrementAndGet()
    }
  }

  private class NamedDaemonThreads : ThreadFactory {
    private val seq = AtomicInteger(0)
    override fun newThread(r: Runnable): Thread =
      Thread(r, THREAD_NAME_PREFIX + seq.incrementAndGet()).apply { isDaemon = true }
  }

  companion object {
    /** 同时持有的 block 上限（解码中 + 待取 + 读取中）。快照每块 24 MiB，4 块的输出缓冲约 96 MiB。 */
    const val MAX_IN_FLIGHT_BLOCKS = 4

    /** 单块解压上限：输出缓冲是一个 ByteArray，超过就不走并行（也挡住 index 声明的离谱块长）。 */
    const val MAX_BLOCK_BYTES = 64L * 1024L * 1024L

    /** 每个解码线程的解码器内存估计（LZMA2 字典 8 MiB + 状态，留余量）。 */
    const val DECODER_ESTIMATE_BYTES = 16L * 1024L * 1024L

    const val THREAD_NAME_PREFIX = "snapshot-xz-"

    private const val READ_SLICE_BYTES = 1024 * 1024
    private const val TERMINATION_WAIT_SECONDS = 30L

    /**
     * 并行度：常量上限、CPU 数、块数、堆预算取最小。
     *
     * 堆预算取最大堆的一半：首装时进程里还有 WebView 与启动页，低端机默认堆 192–256 MiB，
     * 不能让解压缓冲把它吃满。结果小于 2 就没有并行收益，返回 1 让调用方走单线程。
     */
    fun parallelism(cpus: Int, blockCount: Int, largestBlockBytes: Long, maxHeapBytes: Long): Int {
      if (blockCount <= 1 || largestBlockBytes <= 0 || largestBlockBytes > MAX_BLOCK_BYTES) return 1
      val perSlot = largestBlockBytes + DECODER_ESTIMATE_BYTES
      val byHeap = ((maxHeapBytes / 2) / perSlot).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
      return minOf(MAX_IN_FLIGHT_BLOCKS, cpus, blockCount, byHeap).coerceAtLeast(1)
    }

    /**
     * 能并行就返回并行流，否则返回 null（调用方退回单线程 XZCompressorInputStream）。
     *
     * null 的情形：随机读源打不开、index 读失败或损坏、只有一个块、块过大、并行度不足 2。
     * 判定只读尾部 index，不解码任何数据，所以退回单线程时输入流还没被动过。
     */
    fun openOrNull(
      source: XzRandomSource,
      cpus: Int = Runtime.getRuntime().availableProcessors(),
      maxHeapBytes: Long = Runtime.getRuntime().maxMemory(),
    ): ParallelXzInputStream? {
      val sizes = try {
        openXz(source, null).use { index ->
          val count = index.blockCount
          // 多 stream 拼接的文件单线程路径只解第一个 stream（XZCompressorInputStream 默认不解拼接），
          // 并行会解全部，两者字节不同；只在单 stream 时并行，保证与单线程逐字节一致。
          if (count <= 1 || index.streamCount != 1) return null
          LongArray(count) { index.getBlockSize(it) }
        }
      } catch (_: IOException) {
        return null
      } catch (_: RuntimeException) {
        return null
      }
      val largest = sizes.maxOrNull() ?: return null
      if (sizes.any { it < 0 }) return null
      val threads = parallelism(cpus, sizes.size, largest, maxHeapBytes)
      if (threads < 2) return null
      val blockSizes = IntArray(sizes.size) { sizes[it].toInt() }
      // 窗口 = 线程数：持有的块数（含正被 tar 读取的那块）与解码器数同受并行度约束。
      return ParallelXzInputStream(source, blockSizes, threads, threads)
    }

    /** 构造解码器失败（index 坏、非 xz）时也要关掉刚打开的源，否则文件句柄留到 GC。 */
    private fun openXz(source: XzRandomSource, cache: ArrayCache?): SeekableXZInputStream {
      val raw = source.open()
      try {
        return if (cache == null) SeekableXZInputStream(raw) else SeekableXZInputStream(raw, cache)
      } catch (t: Throwable) {
        try {
          raw.close()
        } catch (closeError: Throwable) {
          t.addSuppressed(closeError)
        }
        throw t
      }
    }

    private fun peak(counter: AtomicInteger, value: Int) {
      while (true) {
        val prev = counter.get()
        if (value <= prev || counter.compareAndSet(prev, value)) return
      }
    }
  }
}
