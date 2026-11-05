package com.omnifarious.omniagent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * BrowserHost 旧 WebView 兼容架构 spike（PR1）：在真实设备上回答三个可行性问题。
 *
 * 背景：MULTI_PROFILE 需要 WebView 提供方 114+；MuMu 等设备停在 110，内置浏览器被
 * fail-closed 拒绝（browser-profile-unsupported）。候选兼容架构 = 独立进程 +
 * WebView.setDataDirectorySuffix + SurfaceControlViewHost 投影。本测试逐项实证：
 *
 *  S1 数据目录后缀隔离：:browser_spike 进程与主进程 cookie 互不可见、后缀目录独立存在；
 *  S2 SCVH 跨进程投影：远端 WebView 经 SurfacePackage 回投主进程，页面加载、改尺寸重建、
 *     页面状态在 surface 换手后存活；
 *  S3 输入转发：真实输入管线（injectInputEvent → InputDispatcher）点击落在远端进程的
 *     WebView 上（视图级与页面级 JS 计数器同时增长）；另证远端程序化 input 可行（模型
 *     browserInput 通道）；
 *  S4 后台生命周期：宿主退后台 5 秒，绑定进程仍存活可响应。
 *
 * 产物（与 VdisplayProbeTest 同口径，双证据）：
 *   ① 设备内文件 filesDir/browser-compat-spike.json
 *      （adb shell run-as com.omnifarious.omniagent cat files/browser-compat-spike.json）
 *   ② logcat tag dsh-spike-browser
 *
 * 跑法（与 VdisplayProbeTest 相同）：
 *   gradlew :app:assembleDebug :app:assembleDebugAndroidTest
 *   adb -s <dev> install -r app/build/outputs/apk/debug/app-debug.apk
 *   adb -s <dev> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
 *   adb -s <dev> shell am instrument -w -e class com.omnifarious.omniagent.BrowserCompatSpikeTest \
 *       com.omnifarious.omniagent.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4::class)
class BrowserCompatSpikeTest {

  private val tag = "dsh-spike-browser"
  private val cookieUrl = "https://example.com/"

  @Test
  fun browserCompatSpike() {
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx: Context = inst.targetContext
    val report = JSONObject()
    report.put("device", JSONObject()
      .put("model", Build.MODEL)
      .put("sdkInt", Build.VERSION.SDK_INT)
      .put("abis", Build.SUPPORTED_ABIS.joinToString(",")))

    var binder: IBrowserSpike? = null
    val connected = java.util.concurrent.CountDownLatch(1)
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        binder = IBrowserSpike.Stub.asInterface(service)
        connected.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        binder = null
      }
    }
    val bound = ctx.bindService(
      Intent(ctx, BrowserSpikeService::class.java),
      connection,
      Context.BIND_AUTO_CREATE,
    )
    assertTrue("bind BrowserSpikeService failed", bound)
    try {
      assertTrue("service connect timeout", connected.await(15, java.util.concurrent.TimeUnit.SECONDS))
      val api = binder!!
      var scenario: ActivityScenario<BrowserSpikeActivity>? = null

      // ---------- S1 数据目录后缀隔离 ----------
      val info = JSONObject(api.processInfo())
      report.put("spikeProcess", info)
      Log.i(tag, "processInfo " + info)
      assertTrue("suffix not applied: " + info, info.getBoolean("suffixApplied"))
      assertTrue(
        "service not in :browser_spike process: " + info.getString("processName"),
        info.getString("processName").endsWith(":browser_spike"),
      )

      assertTrue("spike setCookie failed", api.setCookie(cookieUrl, "dsh_spike=1"))
      val mainCookieManager = android.webkit.CookieManager.getInstance()
      mainCookieManager.setAcceptCookie(true)
      mainCookieManager.setCookie(cookieUrl, "dsh_main=1")
      mainCookieManager.flush()

      val spikeCookie = api.getCookie(cookieUrl)
      val mainCookie = mainCookieManager.getCookie(cookieUrl) ?: ""
      report.put("spikeCookieJar", spikeCookie).put("mainCookieJar", mainCookie)
      Log.i(tag, "cookies spike=[" + spikeCookie + "] main=[" + mainCookie + "]")
      assertTrue("spike jar missing own cookie: " + spikeCookie, spikeCookie.contains("dsh_spike=1"))
      assertFalse("ENGINE-COOKIE LEAK: main cookie visible in spike jar: " + spikeCookie, spikeCookie.contains("dsh_main"))
      assertTrue("main jar missing own cookie: " + mainCookie, mainCookie.contains("dsh_main=1"))
      assertFalse("SPIKE LEAK into main jar: " + mainCookie, mainCookie.contains("dsh_spike"))

      val infoAfter = JSONObject(api.processInfo())
      report.put("suffixDirExistsAfterCookie", infoAfter.getBoolean("suffixDirExists"))
      assertTrue("suffix dir not created", infoAfter.getBoolean("suffixDirExists"))
      report.put("s1_cookie_isolation", "PASS")

      // ---------- S2 SCVH 跨进程投影 ----------
      assumeTrue("SCVH needs API 29+, skip S2-S4", Build.VERSION.SDK_INT >= 29)
      scenario = ActivityScenario.launch(BrowserSpikeActivity::class.java)
      // 局部函数不能带 getter，用显式取柄函数（onActivity 在主线程同步执行后返回）。
      fun activityHandle(): BrowserSpikeActivity? {
        var handle: BrowserSpikeActivity? = null
        scenario?.onActivity { handle = it }
        return handle
      }

      val hostToken = activityHandle()?.hostToken()
      assertTrue("host window token null (activity not attached)", hostToken != null)

      val pkg1 = api.createView(hostToken, 800, 600)
      assertTrue("createView returned null: " + api.pageState(), pkg1 != null)
      activityHandle()?.attach(pkg1)

      val stateLoaded = poll(45_000) {
        val s = JSONObject(api.pageState())
        s.getBoolean("created") && s.getBoolean("loaded") && s.getInt("width") == 800 && s.getInt("height") == 600
      }
      val firstState = JSONObject(api.pageState())
      report.put("s2_first_state", firstState)
      Log.i(tag, "s2 first " + firstState)
      assertTrue("remote WebView never loaded in SCVH: " + firstState, stateLoaded)

      val pkg2 = api.resizeView(hostToken, 1200, 820)
      assertTrue("resizeView returned null: " + api.pageState(), pkg2 != null)
      activityHandle()?.attach(pkg2)
      val stateResized = poll(30_000) {
        val s = JSONObject(api.pageState())
        s.getBoolean("loaded") && s.getInt("width") == 1200 && s.getInt("height") == 820
      }
      val resizedState = JSONObject(api.pageState())
      report.put("s2_resized_state", resizedState)
      assertTrue("WebView did not relayout after surface swap: " + resizedState, stateResized)
      report.put("s2_scvh_projection", "PASS")

      // ---------- S3 输入转发（真实输入管线 + 远端程序化注入） ----------
      val rect = activityHandle()?.surfaceRect() ?: android.graphics.Rect()
      report.put("surfaceRect", JSONObject().put("l", rect.left).put("t", rect.top).put("r", rect.right).put("b", rect.bottom))
      assertFalse("surface rect empty", rect.isEmpty)
      val cx = rect.centerX().toFloat()
      val cy = rect.centerY().toFloat()

      val before = JSONObject(api.pageState())
      var hostBefore = 0
      scenario.onActivity { hostBefore = it.hostTouchCount }
      injectTap(inst, cx, cy)
      var hostAfter = -1
      scenario.onActivity { hostAfter = it.hostTouchCount }
      report.put("s3_host_touch_before_after", JSONObject().put("before", hostBefore).put("after", hostAfter))
      Log.i(tag, "s3 host touches " + hostBefore + " -> " + hostAfter)
      // 信息位：原生 child-surface 输入转发是否生效（不强求）。
      val nativeForwarded = poll(4_000) {
        val s = JSONObject(api.pageState())
        s.getInt("viewTapCount") > before.getInt("viewTapCount")
      }
      report.put("s3_native_input_forwarded", nativeForwarded)
      Log.i(tag, "s3 native forwarded " + nativeForwarded)

      // 兜底硬断言：宿主 onTouch → AIDL 转发 MotionEvent（含屏幕→远端视图坐标变换）。
      if (!nativeForwarded) {
        scenario.onActivity { act ->
          act.touchForwarder = { e ->
            val webW = JSONObject(api.pageState()).getInt("width").coerceAtLeast(1)
            val webH = JSONObject(api.pageState()).getInt("height").coerceAtLeast(1)
            val mapped = MotionEvent.obtain(e)
            mapped.offsetLocation(-rect.left.toFloat(), -rect.top.toFloat())
            val matrix = android.graphics.Matrix()
            matrix.setScale(webW.toFloat() / rect.width(), webH.toFloat() / rect.height())
            mapped.transform(matrix)
            runCatching { api.forwardMotion(mapped) }.getOrDefault(false)
          }
        }
        val beforeManual = JSONObject(api.pageState())
        injectTap(inst, cx, cy)
        val manualForwarded = poll(10_000) {
          val s = JSONObject(api.pageState())
          s.getInt("viewTapCount") > beforeManual.getInt("viewTapCount") && s.getInt("jsTapCount") > beforeManual.getInt("jsTapCount")
        }
        val afterTap = JSONObject(api.pageState())
        report.put("s3_after_manual_input", afterTap)
        Log.i(tag, "s3 manual input " + afterTap)
        assertTrue(
          "neither native nor manual (AIDL MotionEvent) input reached the remote process: " + afterTap,
          manualForwarded,
        )
        report.put("s3_input_forwarding", "PASS(manual-aidl)")
      } else {
        val forwarded = poll(10_000) {
          val s = JSONObject(api.pageState())
          s.getInt("viewTapCount") > before.getInt("viewTapCount") && s.getInt("jsTapCount") > before.getInt("jsTapCount")
        }
        assertTrue("native forwarding counters regressed", forwarded)
        report.put("s3_input_forwarding", "PASS(native)")
      }

      val beforeRemote = JSONObject(api.pageState())
      assertTrue("remote sendTap failed", api.sendTap(60f, 60f))
      val remoteInjected = poll(10_000) {
        val s = JSONObject(api.pageState())
        s.getInt("jsTapCount") > beforeRemote.getInt("jsTapCount")
      }
      assertTrue("remote programmatic tap did not register", remoteInjected)
      report.put("s3_input_forwarding", "PASS")

      // ---------- S4 后台生命周期 ----------
      inst.targetContext.startActivity(
        Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      SystemClock.sleep(5_000)
      val aliveAfterBackground = runCatching { JSONObject(api.processInfo()).getBoolean("suffixApplied") }.getOrDefault(false)
      report.put("s4_alive_after_background", aliveAfterBackground)
      assertTrue("spike process died while host backgrounded", aliveAfterBackground)
      report.put("s4_background_lifetime", "PASS")

      // ---------- 证据驻留（可选）：-e holdMs 15000 供 adb 侧抓屏/查 devtools socket。 ----------
      val holdMs = InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull() ?: 0L
      if (holdMs > 0) {
        Log.i(tag, "holding for external evidence capture " + holdMs + "ms")
        SystemClock.sleep(holdMs)
      }

      api.destroyView()
      scenario.close()
    } finally {
      runCatching { ctx.unbindService(connection) }
      report.put("finishedAt", System.currentTimeMillis())
      val outFile = File(ctx.filesDir, "browser-compat-spike.json")
      outFile.writeText(report.toString(2))
      Log.i(tag, report.toString())
    }
  }

  /** 真实输入管线注入（injectInputEvent → InputDispatcher → 宿主窗口 → 远端输入通道）。 */
  @Suppress("DEPRECATION")
  private fun injectTap(instrumentation: android.app.Instrumentation, x: Float, y: Float) {
    val now = SystemClock.uptimeMillis()
    val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0)
    val up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, x, y, 0)
    instrumentation.sendPointerSync(down)
    instrumentation.sendPointerSync(up)
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
