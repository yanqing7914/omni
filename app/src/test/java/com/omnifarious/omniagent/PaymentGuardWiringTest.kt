package com.omnifarious.omniagent

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 付款硬拦截的**接线形状锁**（2026-11-10）。
 *
 * 判据本身由 [PaymentGuardTest] 穷举；这里锁的是「判据确实挂在执行点上」——
 * 只在工具文案里写「别付款」不算数，三层入口（语义点击、长按、坐标点按）都得过闸。
 */
class PaymentGuardWiringTest {

  private fun serviceSource(): String {
    val candidates = listOf(
      File("src/main/java/com/omnifarious/omniagent/DeviceControlService.kt"),
      File("app/src/main/java/com/omnifarious/omniagent/DeviceControlService.kt"),
    )
    return candidates.firstOrNull { it.isFile }?.readText() ?: error("DeviceControlService.kt not found")
  }

  @Test
  fun `click guards the final target before ACTION_CLICK`() {
    val text = serviceSource()
    val start = text.indexOf("private fun handleClick(")
    val end = text.indexOf("private fun pressAt(")
    assertTrue("handleClick 区段必须存在（锚点漂移需同步本测试）", start >= 0 && end > start)
    val body = text.substring(start, end)
    val guard = body.indexOf("paymentBlock(node)")
    val action = body.indexOf("AccessibilityNodeInfo.ACTION_CLICK")
    assertTrue("handleClick 必须调用 paymentBlock(node)", guard >= 0)
    assertTrue("拦截必须在 performAction 之前", action > guard)
    assertTrue("nx/ny 坐标路径必须命中检测", body.contains("paymentBlockAt(x, y)"))
  }

  @Test
  fun `long click is guarded on both paths`() {
    val text = serviceSource()
    val start = text.indexOf("private fun handleLongClick(")
    val end = text.indexOf("private fun tapAt(")
    assertTrue("handleLongClick 区段必须存在", start >= 0 && end > start)
    val body = text.substring(start, end)
    val guard = body.indexOf("paymentBlock(node)")
    assertTrue("长按必须调用 paymentBlock(node)", guard >= 0)
    assertTrue("长按坐标路径必须命中检测", body.contains("paymentBlockAt(x, y)"))
  }

  @Test
  fun `coordinate guard checks the foreground package before walking the tree`() {
    val text = serviceSource()
    val start = text.indexOf("private fun paymentBlockAt(")
    val end = text.indexOf("private fun nodeAtPoint(")
    assertTrue("paymentBlockAt 区段必须存在", start >= 0 && end > start)
    val body = text.substring(start, end)
    assertTrue("先看包名再点树：非购物应用不为全树遍历付账", body.contains("PaymentGuard.isCommercePackage"))
    assertTrue("命中检测必须真的落地", body.contains("nodeAtPoint(root, x, y)"))
  }
}
