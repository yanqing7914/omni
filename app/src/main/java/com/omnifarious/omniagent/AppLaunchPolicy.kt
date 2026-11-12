package com.omnifarious.omniagent

/**
 * `appLaunch` op 的包名判据（2026-11-12）。
 *
 * 单独拆出来是为了可测：拉起动作本身依赖 Android 的 PackageManager，JVM 单测只能锁住
 * 「什么样的包名才允许进入 startActivity」这一段。与 manage 工具侧的 `/^[a-zA-Z][\w.]*$/`
 * 保持同一形状——多一个字符（空格、连字符、`..`）都直接拒绝，不交给系统解析。
 */
internal object AppLaunchPolicy {
  private val PKG = Regex("^[a-zA-Z][a-zA-Z0-9_.]*$")

  fun isValidPackage(pkg: String?): Boolean {
    if (pkg == null || !PKG.matches(pkg)) return false
    // 段不能为空：`com..example` / `com.example.` 都不是合法包名，交给系统解析只会得到歧义。
    return !pkg.contains("..") && !pkg.endsWith(".")
  }
}
