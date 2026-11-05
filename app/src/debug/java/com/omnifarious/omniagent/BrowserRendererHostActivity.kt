package com.omnifarious.omniagent

import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.SurfaceControlViewHost
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * BrowserProcessService 的主进程测试宿主（仅 debug 源集）：提供窗口 token、
 * SurfaceView 挂载点、触摸转发与屏幕矩形读数，供 androidTest 驱动渲染器全链路。
 */
class BrowserRendererHostActivity : Activity() {

  var surfaceView: SurfaceView? = null
    private set

  /** 手动输入转发回调（原生 child-surface 转发不生效，spike 实锤）。 */
  var touchForwarder: ((android.view.MotionEvent) -> Boolean)? = null

  private val hostTouchCounter = java.util.concurrent.atomic.AtomicInteger(0)
  val hostTouchCount: Int get() = hostTouchCounter.get()

  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) hostTouchCounter.incrementAndGet()
    return super.dispatchTouchEvent(event)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val root = FrameLayout(this)
    root.setBackgroundColor(Color.rgb(0x0b, 0x1c, 0x2d))
    val host = SurfaceView(this)
    root.addView(
      host,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER),
    )
    setContentView(root)
    surfaceView = host
    host.setOnTouchListener { _, event -> touchForwarder?.invoke(event) ?: false }
  }

  fun attach(pkg: SurfaceControlViewHost.SurfacePackage) {
    runOnUiThread { surfaceView?.setChildSurfacePackage(pkg) }
  }

  fun hostToken(): IBinder? {
    var token: IBinder? = null
    val done = CountDownLatch(1)
    runOnUiThread {
      try {
        token = surfaceView?.rootView?.windowToken
      } finally {
        done.countDown()
      }
    }
    done.await(5, TimeUnit.SECONDS)
    return token
  }

  fun surfaceRect(): Rect {
    val rect = Rect()
    val done = CountDownLatch(1)
    runOnUiThread {
      try {
        val view = surfaceView
        if (view == null) rect.setEmpty()
        else {
          val location = IntArray(2)
          view.getLocationOnScreen(location)
          rect.set(location[0], location[1], location[0] + view.width, location[1] + view.height)
        }
      } finally {
        done.countDown()
      }
    }
    done.await(5, TimeUnit.SECONDS)
    return rect
  }
}
