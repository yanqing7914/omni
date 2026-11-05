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
 * spike 的主进程宿主（仅 debug 源集）：把 :browser_spike 进程交回的 SurfacePackage
 * 附着到全屏 SurfaceView 上，模拟生产中「浏览器投影覆盖在引擎界面之上」的几何关系。
 */
class BrowserSpikeActivity : Activity() {

  var surfaceView: SurfaceView? = null
    private set

  /**
   * 兜底输入通道开关：原生 child-surface 输入转发不可用时，把 SurfaceView 收到的
   * 触摸交给该回调（测试里经 AIDL 转发到浏览器进程）。返回 true 表示已消费。
   */
  var touchForwarder: ((android.view.MotionEvent) -> Boolean)? = null

  /** 宿主窗口收到的 ACTION_DOWN 计数：区分「事件没到宿主窗口」与「到了但没转发远端」。 */
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

  fun attach(packageHandle: SurfaceControlViewHost.SurfacePackage) {
    runOnUiThread { surfaceView?.setChildSurfacePackage(packageHandle) }
  }

  /** 宿主窗口 token（rootView.windowToken），跨进程交给浏览器进程建 SCVH 用（同步等待主线程）。 */
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

  /** SurfaceView 在屏幕上的像素矩形，测试据此用真实输入管线点击中心点（同步等待主线程完成）。 */
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
