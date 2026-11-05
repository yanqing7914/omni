package com.omnifarious.omniagent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.SurfaceControlViewHost
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * BrowserProcessService（旧 WebView 兼容档远端渲染器）全链路设备验收（PR3a）。
 *
 * 覆盖（对应 spike 之后的渲染器能力面）：
 *  R1 进程与档案隔离自证：:browser 进程、后缀已应用；
 *  R2 tab 生命周期：ensureTab 建投影（SurfacePackage 经回调交付）→ loadUrl →
 *     pageStarted/pageFinished 事件 → tabState 就绪；relayout 后视图尺寸跟随；
 *  R3 策略负控：javascript: 拒绝；受保护引擎端口（主进程下发 4199）拒绝；
 *  R4 原语：evaluateJs 序号回执、dispatchTap 驱动页面计数、capture 产出 PNG；
 *  R5 收尾：destroyTab/tabIds/clearBrowsingData。
 *
 * 产物：filesDir/browser-renderer-service.json + logcat tag dsh-renderer-test。
 * 跑法与 VdisplayProbeTest / BrowserCompatSpikeTest 相同（am instrument）。
 */
@RunWith(AndroidJUnit4::class)
class BrowserRendererServiceTest {

  private val tag = "dsh-renderer-test"

  private class Collector : IBrowserRendererCallback.Stub() {
    val events = ConcurrentLinkedQueue<Pair<String, JSONObject>>()
    val surfacePackages = ConcurrentHashMap<String, SurfaceControlViewHost.SurfacePackage>()
    val surfaceLatches = ConcurrentHashMap<String, CountDownLatch>()
    val jsResults = ConcurrentHashMap<Int, JSONObject>()
    val jsLatches = ConcurrentHashMap<Int, CountDownLatch>()

    fun expectSurface(tabId: String) {
      surfaceLatches[tabId] = CountDownLatch(1)
    }

    fun expectJs(seq: Int) {
      jsLatches[seq] = CountDownLatch(1)
    }

    override fun onSurfacePackage(tabId: String?, pkg: SurfaceControlViewHost.SurfacePackage?) {
      if (tabId != null && pkg != null) {
        surfacePackages[tabId] = pkg
        surfaceLatches[tabId]?.countDown()
      }
    }

    override fun onEvent(tabId: String?, eventJson: String?) {
      if (tabId != null && eventJson != null) events += tabId to JSONObject(eventJson)
    }

    override fun onJsResult(tabId: String?, seq: Int, resultJson: String?) {
      if (seq != 0 && resultJson != null) {
        jsResults[seq] = JSONObject(resultJson)
        jsLatches[seq]?.countDown()
      }
    }
  }

  @Test
  fun rendererServiceFullCycle() {
    assumeTrue("renderer needs API 29+ for SCVH", Build.VERSION.SDK_INT >= 29)
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx: Context = inst.targetContext
    val report = JSONObject()
    report.put("device", JSONObject().put("model", Build.MODEL).put("sdkInt", Build.VERSION.SDK_INT))

    val collector = Collector()
    var renderer: IBrowserRenderer? = null
    val connected = CountDownLatch(1)
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        renderer = IBrowserRenderer.Stub.asInterface(service)
        connected.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        renderer = null
      }
    }
    assertTrue("bind BrowserProcessService failed", ctx.bindService(Intent(ctx, BrowserProcessService::class.java), connection, Context.BIND_AUTO_CREATE))
    try {
      assertTrue("service connect timeout", connected.await(20, TimeUnit.SECONDS))
      val api = renderer!!

      // ---------- R1 进程自证 + 受保护端口采用 ----------
      val TEST_ENGINE_PORT = 4199 // 主进程「已确认」端口的替身；策略应拒该端口回环。
      val info = JSONObject(api.start(collector, JSONObject().put("enginePort", TEST_ENGINE_PORT).toString()))
      report.put("start", info)
      Log.i(tag, "start " + info)
      assertTrue("suffix not applied: " + info, info.getBoolean("suffixApplied"))
      assertTrue("not in :browser process: " + info.getString("processName"), info.getString("processName").endsWith(":browser"))

      // ---------- R2 tab 生命周期 ----------
      var scenario: ActivityScenario<BrowserRendererHostActivity>? = ActivityScenario.launch(BrowserRendererHostActivity::class.java)
      fun activity(): BrowserRendererHostActivity? {
        var handle: BrowserRendererHostActivity? = null
        val local = scenario
        local?.onActivity { handle = it }
        return handle
      }
      val token = activity()?.hostToken()
      assertNotNull("host token null", token)

      collector.expectSurface("t1")
      val ensured = JSONObject(api.ensureTab("t1", token, JSONObject()
        .put("widthPx", 800).put("heightPx", 600).put("identityId", "android-real").toString()))
      report.put("ensureTab", ensured)
      assertTrue("ensureTab failed: " + ensured, ensured.optBoolean("ok"))

      // 本地回环 HTTP 测试页（隔离档案允许回环，引擎端口除外）。
      val server = LoopbackPageServer()
      server.start()
      try {
        assertTrue("surface package not delivered", collector.surfaceLatches["t1"]!!.await(20, TimeUnit.SECONDS))
        activity()?.attach(collector.surfacePackages["t1"]!!)
        report.put("surfacePackageDelivered", true)

        val pageUrl = "http://127.0.0.1:" + server.port + "/"
        assertTrue("loadUrl failed", JSONObject(api.loadUrl("t1", pageUrl)).optBoolean("ok"))
        val loaded = poll(45_000) {
          val s = JSONObject(api.tabState("t1"))
          s.optString("loadState") == "loaded" && s.optString("url") == pageUrl && s.optLong("generation") >= 1L
        }
        val state = JSONObject(api.tabState("t1"))
        report.put("loadedState", state)
        Log.i(tag, "loaded " + state)
        assertTrue("page never reached loaded: " + state, loaded)
        assertTrue("no pageStarted event", collector.events.any { it.first == "t1" && it.second.optString("type") == "pageStarted" })
        assertTrue("no pageFinished event", collector.events.any { it.first == "t1" && it.second.optString("type") == "pageFinished" })
        report.put("r2_lifecycle", "PASS")

        // ---------- R3 策略负控 ----------
        Log.i(tag, "step: r3-begin")
        val jsRejected = JSONObject(api.loadUrl("t1", "javascript:alert(1)"))
        val engineRejected = JSONObject(api.loadUrl("t1", "http://127.0.0.1:$TEST_ENGINE_PORT/"))
        report.put("negativeControls", JSONObject()
          .put("javascript", jsRejected.toString()).put("protectedEnginePort", engineRejected.toString()))
        assertFalse("javascript: must be denied", jsRejected.optBoolean("ok"))
        assertFalse("protected engine port must be denied", engineRejected.optBoolean("ok"))
        assertEquals("javascript: reason", "unsupported-url", jsRejected.optString("reason"))
        report.put("r3_policy", "PASS")

        // ---------- R4 原语 ----------
        Log.i(tag, "step: r4-begin")
        val titleSeq = 1
        collector.expectJs(titleSeq)
        assertTrue("evaluateJs dispatch failed", api.evaluateJs("t1", "document.title", titleSeq))
        assertTrue("js result timeout", collector.jsLatches[titleSeq]!!.await(15, TimeUnit.SECONDS))
        val titleValue = collector.jsResults[titleSeq]?.opt("value") ?: ""
        report.put("jsTitle", titleValue)
        assertTrue("unexpected title: " + titleValue, titleValue.toString().contains("renderer-test-page"))

        // dispatchTap 打页面中心 → JS 计数增长（同时证明 tap 与 js 回执双通道）。
        Log.i(tag, "step: r4-tap-begin")
        val before = jsNumber(api, collector, "window.taps || 0", 2)
        val w = state.optInt("width")
        val h = state.optInt("height")
        assertTrue("dispatchTap failed", api.dispatchTap("t1", w / 2f, h / 2f))
        val tapsAfter = poll(10_000) { jsNumber(api, collector, "window.taps || 0", 3) > before }
        report.put("taps", JSONObject().put("before", before).put("after", jsNumberQuiet(api, collector, 4)))
        assertTrue("remote tap did not reach page (taps stuck at $before)", tapsAfter)
        report.put("r4_primitives", "PASS")

        // capture → PNG 魔数。
        Log.i(tag, "step: r4-capture-begin")
        val pipe = ParcelFileDescriptor.createPipe()
        assertTrue("capture failed", api.capture("t1", pipe[1], 1280, 1280))
        pipe[1].close()
        val png = java.io.FileInputStream(pipe[0].fileDescriptor).use { it.readBytes() }
        report.put("pngBytes", png.size)
        assertTrue("capture output not PNG (size=" + png.size + ")", png.size > 8 && png[0] == 0x89.toByte() && png[1] == 0x50.toByte() && png[2] == 0x4E.toByte())
        report.put("r4_capture", "PASS")

        // relayout：视图尺寸跟随（spike 实锤：页面 innerWidth 可能滞后，仅断言视图尺寸）。
        // latch 必须先于 relayout 注册（包可能在轮询期间送达）。
        collector.expectSurface("t1")
        assertTrue(JSONObject(api.relayout("t1", 1200, 820)).optBoolean("ok"))
        val resized = poll(10_000) {
          val s = JSONObject(api.tabState("t1"))
          s.optInt("width") == 1200 && s.optInt("height") == 820
        }
        assertTrue("relayout did not deliver a new surface package", collector.surfaceLatches["t1"]!!.await(15, TimeUnit.SECONDS))
        activity()?.attach(collector.surfacePackages["t1"]!!)
        report.put("resizedState", JSONObject(api.tabState("t1")))
        assertTrue("view did not relayout to 1200x820", resized)
        report.put("r2_relayout", "PASS")

        // ---------- R5 收尾 ----------
        assertTrue(JSONObject(api.destroyTab("t1")).optBoolean("ok"))
        assertEquals("no tabs after destroy", "[]", api.tabIds())
        assertTrue(JSONObject(api.clearBrowsingData()).optBoolean("ok"))
        api.destroyAll()
        report.put("r5_teardown", "PASS")
        scenario?.close()
        scenario = null
      } finally {
        server.stop()
      }
    } finally {
      runCatching { ctx.unbindService(connection) }
      report.put("finishedAt", System.currentTimeMillis())
      val outFile = File(ctx.filesDir, "browser-renderer-service.json")
      outFile.writeText(report.toString(2))
      Log.i(tag, report.toString())
    }
  }

  private fun jsNumber(api: IBrowserRenderer, collector: Collector, script: String, seq: Int): Long {
    collector.expectJs(seq)
    assertTrue("evaluateJs($script) dispatch failed", api.evaluateJs("t1", script, seq))
    assertTrue("js($script) timeout", collector.jsLatches[seq]!!.await(15, TimeUnit.SECONDS))
    val raw = collector.jsResults[seq]?.opt("value") ?: "0"
    return raw.toString().filter { it.isDigit() }.toLongOrNull() ?: 0L
  }

  private fun jsNumberQuiet(api: IBrowserRenderer, collector: Collector, seq: Int): Long {
    collector.expectJs(seq)
    if (!api.evaluateJs("t1", "window.taps || 0", seq)) return -1
    if (collector.jsLatches[seq]!!.await(10, TimeUnit.SECONDS)) {
      val raw = collector.jsResults[seq]?.opt("value") ?: "0"
      return raw.toString().filter { it.isDigit() }.toLongOrNull() ?: 0L
    }
    return -1
  }

  private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      if (runCatching(condition).getOrDefault(false)) return true
      SystemClock.sleep(250)
    }
    return runCatching(condition).getOrDefault(false)
  }
}

/** 回环测试页服务器：标题 renderer-test-page，全屏点按计数 window.taps。 */
private class LoopbackPageServer {
  private val server = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
  val port: Int get() = server.localPort
  @Volatile private var running = true
  private lateinit var thread: Thread

  private val page = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>renderer-test-page</title>
<style>
  html,body{margin:0;height:100%;background:#0f2b46;color:#eef4fa;
    font-family:system-ui,sans-serif}
  #zone{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    font-size:18px}
</style>
</head>
<body>
<div id="zone">renderer test page</div>
<script>
  window.taps = 0;
  window.addEventListener('click', function () { window.taps++; });
</script>
</body>
</html>
  """.trimIndent()

  fun start() {
    thread = Thread {
      while (running) {
        val socket = try {
          server.accept()
        } catch (_: Throwable) {
          break
        } ?: break
        Thread {
          try {
            socket.getInputStream().read(ByteArray(4096))
            val body = page.toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
              "Content-Length: " + body.size + "\r\nConnection: close\r\n\r\n"
            socket.getOutputStream().apply {
              write(head.toByteArray(Charsets.US_ASCII))
              write(body)
              flush()
            }
          } catch (_: Throwable) {
          } finally {
            runCatching { socket.close() }
          }
        }.apply { isDaemon = true }.start()
      }
    }.apply { isDaemon = true }
    thread.start()
  }

  fun stop() {
    running = false
    runCatching { server.close() }
  }
}
