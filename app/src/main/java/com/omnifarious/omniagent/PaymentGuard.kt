package com.omnifarious.omniagent

/**
 * 付款类动作的设备层硬拦截判据（2026-11-10）。
 *
 * 为什么放在设备层：淘宝技能把「下单/付款前必须问用户」写在说明里，那只是提示层约束——
 * 模型漏读、改读别的技能、或干脆直接点坐标都能绕过去。这里把判据放在**动作真正注入的地方**，
 * 文本命中就拒绝，不依赖模型是否守规矩。
 *
 * 覆盖边界（如实记录，别把它当全系统保险）：
 *   - 只对 [commercePackages] 里的应用生效，拦的是「AI 替用户下单/付款」，不是全系统按钮审查；
 *   - 只对**能读到控件文本**的通道生效：无障碍 click/longClick，包括 nx/ny 坐标点按的命中检测；
 *   - 纯 Shizuku 的 `input tap` 与 ACTION_VIEW 深链拿不到控件文本，不在覆盖内。
 *
 * 判据是纯函数（只吃包名 + 标签串），便于在 JVM 单测里穷举，不需要 Android 运行时。
 */
internal object PaymentGuard {

  /** 拦截范围：淘宝、天猫。其它应用里的「支付」字样（如付款码展示）不在此列。 */
  val commercePackages: Set<String> = setOf("com.taobao.taobao", "com.tmall.wireless")

  /**
   * 动作词：命中即拦。
   *
   * 刻意**不含**「立即购买」：它只是打开规格选择，真正不可逆的提交发生在「提交订单/结算/付款」。
   * 把选规格也拦掉会让技能连正常浏览都做不了，而安全收益为零。
   */
  private val BLOCKED = listOf(
    "提交订单", "确认下单", "确认购买",
    "结算",
    "付款", "支付",
    "确认收货",
    "申请退款", "退款", "退货",
    "删除订单",
    "修改收货地址", "修改地址",
    "submit order", "place order", "confirm order", "checkout", "pay now", "confirm payment",
  )

  /**
   * 导航/设置类标签的豁免。
   *
   * 淘宝里「待付款」「付款方式」「退款记录」都是**看**的入口，拦下来只会让模型误报
   * 「我不能付款」，而用户其实只是想看一眼订单。先按整串包含豁免，再判动作词。
   */
  private val VIEW_ONLY = listOf(
    "待付款", "待支付", "付款方式", "支付方式", "支付设置", "支付管理", "支付记录", "支付详情",
    "付款记录", "退款记录", "退款详情", "退货详情", "售后",
    "payment method", "payment settings", "payment history",
  )

  fun isCommercePackage(packageName: String?): Boolean =
    packageName != null && commercePackages.contains(packageName)

  /**
   * 返回命中的动作词；null = 放行。
   *
   * @param packageName 目标控件自己的包名（不是前台包名——覆盖层/弹窗可能来自别的进程）
   * @param labels 目标控件与其近祖宗的文本/描述，按由近到远排列
   */
  fun blockedKeyword(packageName: String?, labels: List<String>): String? {
    if (!isCommercePackage(packageName)) return null
    for (raw in labels) {
      val label = raw.trim().lowercase()
      if (label.isEmpty()) continue
      if (VIEW_ONLY.any { label.contains(it) }) continue
      for (keyword in BLOCKED) {
        if (label.contains(keyword.lowercase())) return keyword
      }
    }
    return null
  }
}
