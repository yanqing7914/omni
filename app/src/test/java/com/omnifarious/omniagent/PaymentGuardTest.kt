package com.omnifarious.omniagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 付款硬拦截判据（2026-11-10）。
 *
 * 这些用例钉住两件事：① 提交订单/付款/退款这类动作在淘宝天猫里必拦；
 * ② 「待付款」「付款方式」「退款记录」这类**看**的入口不能误伤——否则模型会报一个
 * 假的「我不能付款」，用户却只是想看订单。
 */
class PaymentGuardTest {

  private val taobao = "com.taobao.taobao"
  private val tmall = "com.tmall.wireless"

  @Test
  fun `blocks order submission and payment on commerce apps`() {
    assertEquals("提交订单", PaymentGuard.blockedKeyword(taobao, listOf("提交订单")))
    assertEquals("付款", PaymentGuard.blockedKeyword(taobao, listOf("立即付款")))
    assertEquals("付款", PaymentGuard.blockedKeyword(tmall, listOf("确认付款")))
    assertEquals("支付", PaymentGuard.blockedKeyword(taobao, listOf("去支付")))
    assertEquals("结算", PaymentGuard.blockedKeyword(taobao, listOf("结算(2)")))
  }

  @Test
  fun `blocks refund receipt and address edits`() {
    assertEquals("确认收货", PaymentGuard.blockedKeyword(taobao, listOf("确认收货")))
    assertEquals("申请退款", PaymentGuard.blockedKeyword(taobao, listOf("申请退款")))
    assertEquals("删除订单", PaymentGuard.blockedKeyword(taobao, listOf("删除订单")))
    assertEquals("修改收货地址", PaymentGuard.blockedKeyword(taobao, listOf("修改收货地址")))
  }

  @Test
  fun `blocks when the pay label sits on a nearby ancestor`() {
    // 图文按钮：图标节点本身无文字，外层可点容器写着「立即付款」。
    val nested = listOf("", "立即付款")
    assertEquals("付款", PaymentGuard.blockedKeyword(taobao, nested))
  }

  @Test
  fun `does not block view-only or settings entries`() {
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("待付款")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("付款方式")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("支付管理")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("退款记录")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("收货地址管理")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("查看物流")))
  }

  @Test
  fun `ignores ordinary product labels`() {
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("加入购物车")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("￥199.00")))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("店铺")))
  }

  @Test
  fun `only applies inside the commerce package list`() {
    assertNull(PaymentGuard.blockedKeyword("com.eg.android.AlipayGphone", listOf("立即付款")))
    assertNull(PaymentGuard.blockedKeyword("com.android.settings", listOf("提交订单")))
    assertNull(PaymentGuard.blockedKeyword(null, listOf("提交订单")))
    assertFalse(PaymentGuard.isCommercePackage(""))
    assertTrue(PaymentGuard.isCommercePackage(taobao))
  }

  @Test
  fun `blocks english action labels for tmall international builds`() {
    assertEquals("submit order", PaymentGuard.blockedKeyword(tmall, listOf("Submit order")))
    assertEquals("pay now", PaymentGuard.blockedKeyword(tmall, listOf("Pay Now")))
    assertNull(PaymentGuard.blockedKeyword(tmall, listOf("Payment method")))
  }

  @Test
  fun `empty labels never block`() {
    assertNull(PaymentGuard.blockedKeyword(taobao, emptyList()))
    assertNull(PaymentGuard.blockedKeyword(taobao, listOf("", "   ")))
  }
}
