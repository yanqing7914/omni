package com.omnifarious.omniagent

import android.annotation.SuppressLint
import android.app.Application
import android.app.Service
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.MotionEvent
import android.view.SurfaceControlViewHost
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * BrowserHost 兼容架构 spike 的远端宿主（仅 debug 源集，不进发布产物）。
 *
 * 在独立进程 ":browser_spike" 内回答三个问题（对应 PR1 验收）：
 *  1. 进程启动先 setDataDirectorySuffix，再建任何 WebView —— cookie 是否与主进程完全隔离；
 *  2. WebView 放进 SurfaceControlViewHost，SurfacePackage 跨进程交回主进程投影；
 *  3. 触摸事件经 InputDispatcher 直接落在本进程的视图树上（无需手工转发）。
 *
 * 约束（生产实现同样要守住）：setDataDirectorySuffix 必须是该进程第一个 WebView 族调用；
 * 本进程永不注入 androidBridge；测试页为内置静态 HTML。
 */
class BrowserSpikeService : Service() {

  companion object {
    const val SUFFIX = "dsh-spike-v1"
    private const val MAIN_TIMEOUT_S = 8L
  }

  private val main = Handler(Looper.getMainLooper())
  private var suffixApplied = false
  private var suffixError = ""

  private var host: SurfaceControlViewHost? = null
  private var root: FrameLayout? = null
  private var web: WebView? = null
  private var viewTapCount = 0
  private var jsTapCount = 0
  private var pageLoaded = false
  private var loadError = ""
  private var buildError = ""

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 28) {
      try {
        WebView.setDataDirectorySuffix(SUFFIX)
        suffixApplied = true
      } catch (t: Throwable) {
        suffixError = t.toString()
      }
    } else {
      suffixError = "api-" + Build.VERSION.SDK_INT + "-below-28"
    }
  }

  override fun onBind(intent: Intent?): IBinder = object : IBrowserSpike.Stub() {
    override fun processInfo(): String = infoJson()

    override fun setCookie(url: String, value: String): Boolean = onMain {
      try {
        CookieManager.getInstance().setCookie(url, value)
        CookieManager.getInstance().flush()
        true
      } catch (_: Throwable) {
        false
      }
    }

    override fun getCookie(url: String): String = onMain {
      try {
        CookieManager.getInstance().getCookie(url) ?: ""
      } catch (t: Throwable) {
        "error:" + t.javaClass.simpleName
      }
    }

    override fun createView(hostToken: IBinder?, widthPx: Int, heightPx: Int): SurfaceControlViewHost.SurfacePackage? = onMain {
      buildView(hostToken, widthPx, heightPx)?.surfacePackage
    }

    override fun resizeView(hostToken: IBinder?, widthPx: Int, heightPx: Int): SurfaceControlViewHost.SurfacePackage? = onMain {
      val current = web ?: return@onMain null
      teardownHost()
      buildView(hostToken, widthPx, heightPx, reuse = current)?.surfacePackage
    }

    override fun destroyView(): Boolean = onMain {
      teardownHost()
      web?.destroy()
      web = null
      true
    }

    override fun pageState(): String = onMain { stateJson() }

    override fun sendTap(x: Float, y: Float): Boolean = onMain {
      val target = web ?: return@onMain false
      val now = SystemClock.uptimeMillis()
      fun event(action: Int): MotionEvent = MotionEvent.obtain(now, now, action, x, y, 0)
      try {
        target.dispatchTouchEvent(event(MotionEvent.ACTION_DOWN))
        target.dispatchTouchEvent(event(MotionEvent.ACTION_UP))
        true
      } catch (_: Throwable) {
        false
      }
    }

    override fun forwardMotion(event: MotionEvent?): Boolean = onMain {
      val target = web ?: return@onMain false
      if (event == null) return@onMain false
      try {
        target.dispatchTouchEvent(MotionEvent.obtain(event))
        true
      } catch (_: Throwable) {
        false
      }
    }
  }

  /** 所有 WebView 操作都在本进程主线程执行（FutureTask 有界等待，超时向调用方抛错）。 */
  private fun <T> onMain(block: () -> T): T {
    val task = FutureTask(Callable { block() })
    main.post(task)
    return task.get(MAIN_TIMEOUT_S, TimeUnit.SECONDS)
  }

  private fun infoJson(): String = JSONObject().run {
    // applicationInfo.processName 只回 <application> 声明值；实际进程名要读运行态。
    val actualProcess = if (Build.VERSION.SDK_INT >= 28) {
      Application.getProcessName()
    } else {
      File("/proc/self/cmdline").readText().trimEnd('\u0000', ' ', '\n')
    }
    put("processName", actualProcess)
    put("packageName", packageName)
    put("sdkInt", Build.VERSION.SDK_INT)
    put("suffix", SUFFIX)
    put("suffixApplied", suffixApplied)
    put("suffixError", suffixError)
    put("webviewDataDir", filesDir.parentFile?.absolutePath ?: "")
    put("suffixDirExists", File(filesDir.parentFile, "app_webview_" + SUFFIX).exists())
    toString()
  }

  private fun stateJson(): String = JSONObject().run {
    put("created", web != null)
    put("loaded", pageLoaded)
    put("loadError", loadError)
    put("buildError", buildError)
    put("viewTapCount", viewTapCount)
    put("jsTapCount", jsTapCount)
    put("width", web?.width ?: 0)
    put("height", web?.height ?: 0)
    toString()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun buildView(hostToken: IBinder?, widthPx: Int, heightPx: Int, reuse: WebView? = null): SurfaceControlViewHost? {
    buildError = ""
    try {
      if (Build.VERSION.SDK_INT < 29 || !suffixApplied) {
        buildError = "guard sdk=" + Build.VERSION.SDK_INT + " suffix=" + suffixApplied
        return null
      }
      val display: Display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY) ?: run {
        buildError = "default display lookup null"
        return null
      }
      // SCVH 官方要求：用窗口上下文保证密度/配置与目标显示一致。
      // 构造器第三参是宿主窗口 token；跨进程拿不到宿主 token，传 null ——
      // 输入是否仍能经宿主 SurfaceView 转发进来，正是 S3 要实证的问题。
      val context: Context = if (Build.VERSION.SDK_INT >= 30) {
        baseContext.createWindowContext(display, WindowManager.LayoutParams.TYPE_APPLICATION, null)
      } else {
        baseContext.createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION, null)
      }
      // 宿主窗口 token 非空时输入通道授权走宿主所有权验证；null 仅诊断用（会撞
    // INTERNAL_SYSTEM_WINDOW）。S3 断言必须建立在真 token 上。
    val scvh = SurfaceControlViewHost(context, display, hostToken)

    if (reuse != null) {
      // SCVH 重建 = 新容器；先把复用的 WebView 从旧容器摘下（release() 只销毁 surface，不解视图树）。
      (reuse.parent as? ViewGroup)?.removeView(reuse)
    }
    val view = reuse ?: WebView(context).apply {      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.cacheMode = WebSettings.LOAD_NO_CACHE
      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
          pageLoaded = true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (request.isForMainFrame) loadError = error.toString()
        }
      }
      WebView.setWebContentsDebuggingEnabled(true)
    }
    // 视图树级触摸计数：证明事件被投递进本进程（返回 false，不改变分发行为）。
    view.setOnTouchListener { _, _ -> viewTapCount++; false }
    // 页面级 JS 计数由该轮询异步读取缓存，pageState() 只读缓存值。
    view.postDelayed({ pollJsCount(view) }, 250)

    val container = FrameLayout(context).apply {
      addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
    scvh.setView(container, widthPx, heightPx)
    host = scvh
    root = container
    web = view
    if (reuse == null) {
      pageLoaded = false
      loadError = ""
      view.loadDataWithBaseURL("https://dsh-spike.invalid/", TEST_HTML, "text/html", "utf-8", null)
    }
    return scvh
    } catch (t: Throwable) {
      buildError = t.toString()
      var cause = t.cause
      while (cause != null) {
        buildError += " | cause: " + cause.toString()
        cause = cause.cause
      }
      android.util.Log.w("dsh-spike-browser", android.util.Log.getStackTraceString(t))
      return null
    }
  }

  private fun pollJsCount(view: WebView) {
    if (view !== web) return
    view.evaluateJavascript("(window.jsTaps||0)") { value ->
      jsTapCount = value.filter { it.isDigit() }.toIntOrNull() ?: jsTapCount
    }
    view.postDelayed({ pollJsCount(view) }, 250)
  }

  private fun teardownHost() {
    try {
      host?.release()
    } catch (_: Throwable) {
    }
    host = null
    root = null
  }
}

private val TEST_HTML = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#102a43;color:#f0f4f8;
    font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  #zone{position:fixed;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px}
  h1{font-size:22px;margin:0}
  #state{font-size:16px;line-height:1.6;text-align:center;white-space:pre}
</style>
</head>
<body>
<div id="zone">
  <h1>dsh browser spike</h1>
  <div id="state">jsTaps 0</div>
</div>
<script>
  window.jsTaps = 0;
  function show() {
    document.getElementById('state').textContent =
      'jsTaps ' + window.jsTaps + '\nviewport ' + window.innerWidth + 'x' + window.innerHeight;
  }
  window.addEventListener('click', function () { window.jsTaps++; show(); });
  window.addEventListener('resize', show);
  show();
</script>
</body>
</html>
""".trimIndent()
