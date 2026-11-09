package com.omnifarious.omniagent

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.tukaani.xz.CorruptedInputException
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.SeekableFileInputStream
import org.tukaani.xz.SeekableXZInputStream
import org.tukaani.xz.XZOutputStream

/**
 * 首装快照按 xz block 并行解码的验收用例 B1–B7。
 *
 * 夹具是现场生成的多 block .tar.xz；并行路径与单线程路径各解一次，逐文件比对。
 * 并行度由测试固定（不依赖跑测试机器的 CPU 数与堆），以免 CI 上因核数少而悄悄退回单线程、变成假绿。
 */
class ParallelSnapshotExtractTest {

  private val tempRoots = mutableListOf<File>()

  private fun tempDir(name: String): File =
    Files.createTempDirectory(name).toFile().also { tempRoots += it }

  private fun cleanup() {
    for (r in tempRoots) SnapshotFs.deletePath(r)
    tempRoots.clear()
  }

  /** 夹具条目：普通文件、可执行（ELF / #!）、目录、符号链接、空文件、跨多个 block 的大文件。 */
  private fun fixtureTar(extra: (TarArchiveOutputStream) -> Unit = {}): ByteArray {
    val rnd = java.util.Random(7)
    val out = ByteArrayOutputStream()
    TarArchiveOutputStream(out).use { tar ->
      tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
      dir(tar, "usr/")
      dir(tar, "usr/bin/")
      dir(tar, "home/")
      file(tar, "usr/bin/node", byteArrayOf(0x7f, 'E'.code.toByte(), 'L'.code.toByte(), 'F'.code.toByte()) + random(rnd, 90_000), 0b111_101_101)
      file(tar, "usr/bin/tool.sh", "#!/bin/sh\necho hi\n".toByteArray(), 0b111_101_101)
      file(tar, "usr/etc/motd", "hello".toByteArray(), 0b110_100_100)
      file(tar, "usr/etc/empty", ByteArray(0), 0b110_100_100)
      // 大文件：约 5 个 64 KiB block 长，必然跨 block 边界。
      file(tar, "usr/lib/big.bin", random(rnd, 330_000), 0b110_100_100)
      for (i in 0 until 40) file(tar, "home/small/f$i.txt", ("line $i\n").repeat(i * 37).toByteArray(), 0b110_100_100)
      link(tar, "usr/bin/nodelink", "node")
      link(tar, "usr/lib/up", "../bin/tool.sh")
      extra(tar)
      tar.finish()
    }
    return out.toByteArray()
  }

  private fun random(rnd: java.util.Random, n: Int): ByteArray = ByteArray(n).also { rnd.nextBytes(it) }

  private fun dir(tar: TarArchiveOutputStream, name: String) {
    tar.putArchiveEntry(TarArchiveEntry(name))
    tar.closeArchiveEntry()
  }

  private fun file(tar: TarArchiveOutputStream, name: String, body: ByteArray, mode: Int = 0b110_100_100, preserveAbsolute: Boolean = false) {
    val e = TarArchiveEntry(name, preserveAbsolute)
    e.size = body.size.toLong()
    e.mode = mode or 0x8000
    tar.putArchiveEntry(e)
    tar.write(body)
    tar.closeArchiveEntry()
  }

  private fun link(tar: TarArchiveOutputStream, name: String, target: String) {
    val e = TarArchiveEntry(name, TarArchiveEntry.LF_SYMLINK)
    e.linkName = target
    tar.putArchiveEntry(e)
    tar.closeArchiveEntry()
  }

  /** 按 [blockBytes] 切 block 的单 stream .xz（与快照构建同形态：多 block、CRC64）。 */
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
    File(tempDir("pxz-src"), "a.xz").also { it.writeBytes(bytes) }

  private fun fileSource(f: File) = XzRandomSource { SeekableFileInputStream(f) }

  /** 并行度固定为 [threads]：CPU 数与堆都按测试给定值，不看宿主机。 */
  private fun fixedParallel(threads: Int, onOpen: (ParallelXzInputStream) -> Unit = {}): (XzRandomSource) -> ParallelXzInputStream? = { src ->
    ParallelXzInputStream.openOrNull(src, cpus = threads, maxHeapBytes = Long.MAX_VALUE)?.also(onOpen)
  }

  private fun extractSingle(xz: ByteArray, dest: File, total: Long = 0L, onProgress: (Long, Long) -> Unit = { _, _ -> }): Int =
    SnapshotExtractor.extract(xz.inputStream(), total, dest, onProgress)

  /** 并行路径不应读顺序输入：给一个一读就失败的流，证明字节确实来自随机读源。 */
  private val unreadable = object : java.io.InputStream() {
    override fun read(): Int = throw AssertionError("parallel path must not read the sequential input")
  }

  private fun extractParallel(
    source: XzRandomSource,
    dest: File,
    threads: Int = 4,
    total: Long = 0L,
    limits: SnapshotExtractor.Limits = SnapshotExtractor.Limits.DEFAULT,
    runtimeRoot: File = dest,
    onProgress: (Long, Long) -> Unit = { _, _ -> },
    onOpen: (ParallelXzInputStream) -> Unit = {},
  ): Int = SnapshotExtractor.extractWith(
    unreadable, total, dest, onProgress, runtimeRoot, limits, source, fixedParallel(threads, onOpen),
  )

  /** 目录树摘要：相对路径 → 类型 + 内容 sha256 / 链接目标 + 权限位。 */
  private fun tree(root: File): Map<String, String> {
    val rootPath = root.toPath()
    val out = sortedMapOf<String, String>()
    Files.walk(rootPath).use { paths ->
      for (p in paths) {
        if (p == rootPath) continue
        val rel = rootPath.relativize(p).toString()
        val perms = java.nio.file.attribute.PosixFilePermissions.toString(
          Files.getPosixFilePermissions(p, java.nio.file.LinkOption.NOFOLLOW_LINKS),
        )
        out[rel] = when {
          Files.isSymbolicLink(p) -> "link:" + Files.readSymbolicLink(p)
          Files.isDirectory(p, java.nio.file.LinkOption.NOFOLLOW_LINKS) -> "dir"
          else -> "file:" + sha256(p.toFile()) + ":" + perms
        }
      }
    }
    return out
  }

  private fun sha256(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { input ->
      val buf = ByteArray(1 shl 16)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  private fun indexTotal(f: File): Long = SeekableFileInputStream(f).use { XzIndexTotal.uncompressedSize(it)!! }

  private fun liveDecoderThreads(): List<Thread> =
    Thread.getAllStackTraces().keys.filter { it.isAlive && it.name.startsWith(ParallelXzInputStream.THREAD_NAME_PREFIX) }

  private fun causeChain(t: Throwable): List<Throwable> = generateSequence(t) { it.cause }.toList()

  // ── B1：字节一致 ──────────────────────────────────────────────────────

  @Test
  fun `B1 并行与单线程解出的目录树逐文件一致`() {
    try {
      val xz = xzMultiBlock(fixtureTar(), BLOCK)
      val src = tempFile(xz)
      val blocks = SeekableFileInputStream(src).use { SeekableXZInputStream(it).blockCount }
      assertTrue("夹具必须是多 block（实际 $blocks）", blocks >= 6)

      val single = tempDir("pxz-single")
      val parallel = tempDir("pxz-parallel")
      assertEquals(1, extractSingle(xz, single))
      assertEquals("必须真的走并行路径", 4, extractParallel(fileSource(src), parallel, threads = 4))

      val a = tree(single)
      val b = tree(parallel)
      assertEquals(a, b)
      // 自证夹具覆盖到了各类条目，比对不是在两棵空树上做的。
      assertTrue(b["usr/bin/node"]!!.endsWith("rwx------"))
      assertTrue(b["usr/bin/tool.sh"]!!.endsWith("rwx------"))
      assertTrue(b["usr/etc/motd"]!!.endsWith("rw-------"))
      assertEquals("link:node", b["usr/bin/nodelink"])
      assertEquals("link:../bin/tool.sh", b["usr/lib/up"])
      assertEquals(0L, File(parallel, "usr/etc/empty").length())
      assertEquals(330_000L, File(parallel, "usr/lib/big.bin").length())
      assertEquals("dir", b["home/small"])
    } finally {
      cleanup()
    }
  }

  @Test
  fun `B1 可选 真实快照并行与单线程逐文件一致`() {
    // 约 800 MiB 解压两次加逐文件摘要，本机几十秒到数分钟；CI 不开，手动设 OMNI_REAL_SNAPSHOT_COMPARE=1 才跑。
    assumeTrue("设 OMNI_REAL_SNAPSHOT_COMPARE=1 才对真实快照做比对", System.getenv("OMNI_REAL_SNAPSHOT_COMPARE") == "1")
    val asset = listOf(File("src/main/assets/snapshot.tar.xz"), File("app/src/main/assets/snapshot.tar.xz")).firstOrNull { it.isFile }
    assumeTrue("缺 app/src/main/assets/snapshot.tar.xz", asset != null)
    try {
      val single = tempDir("pxz-real-single")
      val parallel = tempDir("pxz-real-parallel")
      asset!!.inputStream().buffered().use { SnapshotExtractor.extract(it, 0L, single, { _, _ -> }) }
      assertTrue(extractParallel(fileSource(asset), parallel, threads = 4) >= 2)
      val a = tree(single)
      assertTrue("真实快照应解出大量条目", a.size > 1000)
      assertEquals(a, tree(parallel))
    } finally {
      cleanup()
    }
  }

  // ── B2：安全与语义不变 ────────────────────────────────────────────────

  @Test
  fun `B2 并行路径同样拒绝路径穿越 绝对路径与越界符号链接`() {
    try {
      val outside = tempDir("pxz-outside")
      val evilAbs = File(outside, "abs.txt")
      val raw = fixtureTar { tar ->
        file(tar, "../escape.txt", "x".toByteArray())
        file(tar, "usr/../../escape2.txt", "x".toByteArray())
        file(tar, evilAbs.absolutePath, "x".toByteArray(), preserveAbsolute = true)
        link(tar, "usr/bin/passwd", "../../../../../../../../etc/passwd")
        link(tar, "usr/bin/abs-out", File(outside, "target").absolutePath)
        link(tar, "usr/bin/termux", "/data/data/com.termux/files/usr/bin/sh")
      }
      val xz = xzMultiBlock(raw, BLOCK)
      val src = tempFile(xz)
      val root = tempDir("pxz-sec")
      val single = File(root, "single").apply { mkdirs() }
      val parallel = File(root, "parallel").apply { mkdirs() }
      extractSingle(xz, single)
      assertEquals(4, extractParallel(fileSource(src), parallel))

      val b = tree(parallel)
      assertEquals(tree(single), b)
      assertFalse("../ 穿越不得落到解压根之外", File(root, "escape.txt").exists() || File(root, "escape2.txt").exists())
      assertFalse("绝对路径不得写到原绝对位置", evilAbs.exists())
      assertTrue("绝对路径条目不得以绝对路径出现在树外", b.keys.none { it.contains("escape") })
      assertNull("越界相对链接必须被跳过", b["usr/bin/passwd"])
      assertNull("运行时根之外的绝对链接必须被跳过", b["usr/bin/abs-out"])
      assertNull("Termux 残留链接必须被跳过", b["usr/bin/termux"])
      assertEquals("正常链接仍保留（不是恒拒的假绿）", "link:node", b["usr/bin/nodelink"])
    } finally {
      cleanup()
    }
  }

  @Test
  fun `B2 并行路径上解压上限照常生效`() {
    try {
      val src = tempFile(xzMultiBlock(fixtureTar(), BLOCK))
      val tooMany = runCatching {
        extractParallel(fileSource(src), tempDir("pxz-lim-a"), limits = SnapshotExtractor.Limits(maxEntries = 5))
      }.exceptionOrNull()
      assertTrue("条目数超限必须中止：$tooMany", tooMany is java.io.IOException)
      val tooWide = runCatching {
        extractParallel(fileSource(src), tempDir("pxz-lim-b"), limits = SnapshotExtractor.Limits(maxSingleFileBytes = 100_000))
      }.exceptionOrNull()
      assertTrue("单文件超限必须中止：$tooWide", tooWide is java.io.IOException)
      assertTrue("上限中止后解码线程必须全部退出", awaitNoDecoderThreads())
    } finally {
      cleanup()
    }
  }

  // ── B3：失败传播 ──────────────────────────────────────────────────────

  @Test(timeout = 60_000)
  fun `B3 中间某个 block 损坏时抛出解码器异常 不挂起且线程全部回收`() {
    try {
      val xz = xzMultiBlock(fixtureTar(), BLOCK)
      val corrupt = xz.copyOf()
      val f0 = tempFile(xz)
      val (pos, size) = SeekableFileInputStream(f0).use {
        SeekableXZInputStream(it).let { s -> s.getBlockCompPos(3) to s.getBlockCompSize(3) }
      }
      val at = (pos + size / 2).toInt()
      corrupt[at] = (corrupt[at].toInt() xor 0x5A).toByte()
      val src = tempFile(corrupt)

      val singleError = runCatching { extractSingle(corrupt, tempDir("pxz-bad-single")) }.exceptionOrNull()
      assertNotNull("单线程路径对照：同一坏块必须失败", singleError)
      assertTrue(causeChain(singleError!!).any { it is CorruptedInputException })

      var opened: ParallelXzInputStream? = null
      val dest = tempDir("pxz-bad-parallel")
      val parallelError = runCatching {
        extractParallel(fileSource(src), dest, onOpen = { opened = it })
      }.exceptionOrNull()
      assertNotNull("并行路径必须失败，不得产出看似完整的结果", parallelError)
      assertTrue("cause 链上必须能追到 CorruptedInputException：$parallelError",
        causeChain(parallelError!!).any { it is CorruptedInputException })
      assertEquals("异常类型与单线程路径同类", singleError.javaClass, parallelError.javaClass)
      assertNotNull("必须确实走了并行路径", opened)
      assertTrue("线程池必须已 shutdown 并终止", opened!!.workersTerminated)
      assertTrue("不得残留解码线程", awaitNoDecoderThreads())
      // 坏块之后的条目不应出现（解压停在坏处）。
      assertFalse(File(dest, "home/small/f39.txt").exists())
    } finally {
      cleanup()
    }
  }

  @Test(timeout = 60_000)
  fun `B3 中间块只坏 check 字段而压缩数据完好时两条路径都报错`() {
    try {
      val xz = xzMultiBlock(fixtureTar(), BLOCK)
      val f0 = tempFile(xz)
      // xz 格式：块 = 头 + 压缩数据 + Block Padding + Check；index 里的块长（getBlockCompSize）
      // 是含填充与 check 的 TotalSize，所以 check 正好是块的最后 8 字节（夹具用 CRC64）。
      val (checkStart, checkType) = SeekableFileInputStream(f0).use {
        SeekableXZInputStream(it).let { s -> (s.getBlockCompPos(3) + s.getBlockCompSize(3) - 8) to s.getBlockCheckType(3) }
      }
      assertEquals("夹具必须用 CRC64（8 字节 check）", org.tukaani.xz.XZ.CHECK_CRC64, checkType)
      val corrupt = xz.copyOf()
      for (i in 0 until 8) {
        val at = (checkStart + i).toInt()
        corrupt[at] = (corrupt[at].toInt() xor 0xFF).toByte()
      }
      val src = tempFile(corrupt)

      val singleError = runCatching { extractSingle(corrupt, tempDir("pxz-check-single")) }.exceptionOrNull()
      assertNotNull("单线程路径对照：check 不符必须失败", singleError)
      assertTrue(causeChain(singleError!!).any { it is CorruptedInputException })

      var opened: ParallelXzInputStream? = null
      val parallelError = runCatching {
        extractParallel(fileSource(src), tempDir("pxz-check-parallel"), onOpen = { opened = it })
      }.exceptionOrNull()
      assertNotNull("并行路径不得静默通过 check 不符的块", parallelError)
      val corrupted = causeChain(parallelError!!).filterIsInstance<CorruptedInputException>()
      assertTrue("cause 链上必须有 CorruptedInputException：$parallelError", corrupted.isNotEmpty())
      assertTrue("必须是完整性检查失败而不是压缩数据损坏：${corrupted.first().message}",
        corrupted.first().message.orEmpty().contains("Integrity check"))
      assertNotNull("必须确实走了并行路径", opened)
      assertTrue(opened!!.workersTerminated)
      assertTrue(awaitNoDecoderThreads())
    } finally {
      cleanup()
    }
  }

  @Test(timeout = 60_000)
  fun `B3 tar 层提前失败时关闭流会停掉仍在解码的线程`() {
    try {
      val src = tempFile(xzMultiBlock(fixtureTar(), BLOCK))
      var opened: ParallelXzInputStream? = null
      // 第一个条目就超出条目上限 0 不可能；用单文件上限在 node 上中止，此时后续块仍在飞。
      val error = runCatching {
        extractParallel(fileSource(src), tempDir("pxz-early"),
          limits = SnapshotExtractor.Limits(maxSingleFileBytes = 1), onOpen = { opened = it })
      }.exceptionOrNull()
      assertTrue(error is java.io.IOException)
      assertTrue(opened!!.workersTerminated)
      assertTrue(awaitNoDecoderThreads())
    } finally {
      cleanup()
    }
  }

  // ── B4：内存有界 ──────────────────────────────────────────────────────

  @Test
  fun `B4 在飞 block 数从不超过常量上限`() {
    assertEquals("上限是锁定的常量", 4, ParallelXzInputStream.MAX_IN_FLIGHT_BLOCKS)
    try {
      val f = tempFile(xzMultiBlock(fixtureTar(), BLOCK))
      // 慢速源：每次读停 1 ms，让多个块确实同时在解码，上限才被真正考验到。
      val slow = XzRandomSource {
        object : org.tukaani.xz.SeekableInputStream() {
          private val inner = SeekableFileInputStream(f)
          override fun length() = inner.length()
          override fun position() = inner.position()
          override fun seek(pos: Long) = inner.seek(pos)
          override fun read(): Int = inner.read()
          override fun read(b: ByteArray, off: Int, len: Int): Int {
            Thread.sleep(1)
            return inner.read(b, off, minOf(len, 4096))
          }
          override fun close() = inner.close()
        }
      }
      var opened: ParallelXzInputStream? = null
      // 宿主声称 16 核：并行度仍被常量钳到 4。
      val threads = extractParallel(slow, tempDir("pxz-bound"), threads = 16, onOpen = { opened = it })
      val s = opened!!
      assertEquals(4, threads)
      assertTrue("同时解码的块数 ${s.peakConcurrentDecodes} 超过上限", s.peakConcurrentDecodes <= 4)
      assertTrue("持有的块缓冲 ${s.peakHeldBlocks} 超过上限", s.peakHeldBlocks <= 4)
      assertTrue("慢速源下应确有并发（否则上限没被考验）：${s.peakConcurrentDecodes}", s.peakConcurrentDecodes >= 2)
    } finally {
      cleanup()
    }
  }

  @Test
  fun `B4 并行度取常量 CPU 块数与堆预算的最小值`() {
    val mib = 1024L * 1024L
    assertEquals(4, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 34, largestBlockBytes = 24 * mib, maxHeapBytes = 4096 * mib))
    assertEquals(2, ParallelXzInputStream.parallelism(cpus = 2, blockCount = 34, largestBlockBytes = 24 * mib, maxHeapBytes = 4096 * mib))
    assertEquals(3, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 3, largestBlockBytes = 24 * mib, maxHeapBytes = 4096 * mib))
    // 256 MiB 堆：预算 128 MiB / (24 + 16) MiB = 3。
    assertEquals(3, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 34, largestBlockBytes = 24 * mib, maxHeapBytes = 256 * mib))
    // 堆太小、单块、块过大：都不并行。
    assertEquals(1, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 34, largestBlockBytes = 24 * mib, maxHeapBytes = 64 * mib))
    assertEquals(1, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 1, largestBlockBytes = 24 * mib, maxHeapBytes = 4096 * mib))
    assertEquals(1, ParallelXzInputStream.parallelism(cpus = 8, blockCount = 34, largestBlockBytes = 65 * mib, maxHeapBytes = 4096 * mib))
  }

  // ── B5：进度不变 ──────────────────────────────────────────────────────

  @Test
  fun `B5 并行路径进度分子单调且最后一次等于 index 总量`() {
    try {
      // 进度约每 MiB 一次：夹具加一个 3 MiB 文件，保证有多次回调。
      val big = random(java.util.Random(3), 3 * 1024 * 1024)
      val f = tempFile(xzMultiBlock(fixtureTar { tar -> file(tar, "usr/lib/huge.bin", big) }, BLOCK))
      val total = indexTotal(f)
      for (parallel in listOf(false, true)) {
        val seen = mutableListOf<Pair<Long, Long>>()
        val dest = tempDir("pxz-progress")
        if (parallel) {
          assertEquals(4, extractParallel(fileSource(f), dest, total = total, onProgress = { d, t -> seen += d to t }))
        } else {
          extractSingle(f.readBytes(), dest, total) { d, t -> seen += d to t }
        }
        val label = if (parallel) "并行" else "单线程"
        assertTrue("$label：应有多次回调（${seen.size}）", seen.size >= 3)
        assertTrue("$label：分母必须原样是 index 总量", seen.all { it.second == total })
        assertTrue("$label：分子必须单调递增", seen.zipWithNext().all { (a, b) -> b.first > a.first })
        assertEquals("$label：最后一次分子必须等于 index 总量", total, seen.last().first)
      }
    } finally {
      cleanup()
    }
  }

  // ── B6：回退路径 ──────────────────────────────────────────────────────

  @Test
  fun `B6 无随机读源 单 block 源打不开或多 stream 时走单线程且结果一致`() {
    try {
      val raw = fixtureTar()
      val multi = xzMultiBlock(raw, BLOCK)
      val reference = tree(tempDir("pxz-ref").also { extractSingle(multi, it) })

      // ① 不给随机读源。
      val d1 = tempDir("pxz-fb-none")
      assertEquals(1, SnapshotExtractor.extract(multi.inputStream(), 0L, d1, { _, _ -> }, randomSource = null))
      assertEquals(reference, tree(d1))

      // ② 单 block。
      val one = xzMultiBlock(raw, raw.size)
      val oneFile = tempFile(one)
      assertNull("单 block 不得并行", ParallelXzInputStream.openOrNull(fileSource(oneFile), cpus = 8, maxHeapBytes = Long.MAX_VALUE))
      val d2 = tempDir("pxz-fb-one")
      assertEquals(1, SnapshotExtractor.extract(one.inputStream(), 0L, d2, { _, _ -> }, randomSource = fileSource(oneFile)))
      assertEquals(reference, tree(d2))

      // ③ 随机读源打不开（openFd 失败、通道不可用的同类情形）。
      val broken = XzRandomSource { throw java.io.IOException("not seekable") }
      val d3 = tempDir("pxz-fb-broken")
      assertEquals(1, SnapshotExtractor.extract(multi.inputStream(), 0L, d3, { _, _ -> }, randomSource = broken))
      assertEquals(reference, tree(d3))

      // ④ index 读不出（源不是 xz）：判定阶段失败，顺序输入未被动过，单线程照常解。
      val garbage = tempFile(ByteArray(4096) { 1 })
      val d4 = tempDir("pxz-fb-garbage")
      assertEquals(1, SnapshotExtractor.extract(multi.inputStream(), 0L, d4, { _, _ -> }, randomSource = fileSource(garbage)))
      assertEquals(reference, tree(d4))

      // ⑤ 两个 stream 拼接：单线程只解第一个，并行若解全部字节就不同，所以必须退回。
      val concat = multi + xzMultiBlock(fixtureTar { tar -> file(tar, "usr/second", "2".toByteArray()) }, BLOCK)
      val concatFile = tempFile(concat)
      assertNull(ParallelXzInputStream.openOrNull(fileSource(concatFile), cpus = 8, maxHeapBytes = Long.MAX_VALUE))
      val d5 = tempDir("pxz-fb-concat")
      assertEquals(1, SnapshotExtractor.extract(concat.inputStream(), 0L, d5, { _, _ -> }, randomSource = fileSource(concatFile)))
      assertEquals(reference, tree(d5))
    } finally {
      cleanup()
    }
  }

  @Test
  fun `B6 内嵌快照按 openFd 段提供随机读源 APK 内偏移也能并行解出同样的树`() {
    try {
      // APK 里 STORED 的 asset 是大文件中间的一段：前后都有别的字节。
      val xz = xzMultiBlock(fixtureTar(), BLOCK)
      val prefix = ByteArray(12_345) { 7 }
      val apk = tempFile(prefix + xz + ByteArray(999) { 9 })
      val reference = tree(tempDir("pxz-apk-ref").also { extractSingle(xz, it) })
      RandomAccessFile(apk, "r").use { raf ->
        val source = XzRandomSource { XzIndexTotal.ChannelRange(raf.channel, prefix.size.toLong(), xz.size.toLong()) }
        val dest = tempDir("pxz-apk")
        assertEquals(4, extractParallel(source, dest))
        assertEquals(reference, tree(dest))
        assertEquals("positional read 不移动共享通道游标", 0L, raf.channel.position())
        assertTrue("通道归调用方，解压后仍打开", raf.channel.isOpen)
      }
      val em = File(listOf("src/main/java", "app/src/main/java").first { File(it).isDirectory }, "com/omnifarious/omniagent/EngineManager.kt").readText()
      assertTrue("生产调用点必须把随机读源传进去", em.contains("randomSource = randomSource"))
      assertTrue(em.contains("XzRandomSource { XzIndexTotal.ChannelRange(channel, start, length) }"))
    } finally {
      cleanup()
    }
  }

  /** 解码线程池终止后，线程本身还要片刻才真正退出；限时等待，避免把调度抖动当成泄漏。 */
  private fun awaitNoDecoderThreads(): Boolean {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (System.nanoTime() < deadline) {
      val live = liveDecoderThreads()
      if (live.isEmpty()) return true
      live.forEach { it.join(100) }
    }
    return liveDecoderThreads().isEmpty()
  }

  private companion object {
    const val BLOCK = 64 * 1024
  }
}
