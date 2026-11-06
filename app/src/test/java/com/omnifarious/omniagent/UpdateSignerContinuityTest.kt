package com.omnifarious.omniagent

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #675 回归：应用内自更新链的「发布者连续性」判据。
 *
 * 缺陷形态：发布私钥随公开仓分发（keystore/debug.keystore 直接签 release），APK 摘要与
 * 载荷又同出自镜像——「签名不匹配由系统安装器天然拒绝」不成立（同私钥 = 同证书，安装器
 * 只会放行），更新链因此没有真实性防线。
 *
 * 修法：安装前以待装 APK 的证书 vs **当前安装**的本应用证书做连续性校验（fail-closed：
 * 读不出/不一致一律拒装）。锚点刻意是「已安装证书」而不是硬编码指纹：本项目的签名密钥
 * 随仓公开是**既定选择**（开源、不上 Google Play），硬编码同一把密钥的指纹等于没有校验；
 * 已安装应用的证书是发行链可信的最小事实，且**不要求存在第二把密钥**。
 *
 * 纯判据 + 静态判据各守一半：archive/installed 证书读取走 PackageManager，属设备面
 * （本批未做设备验证，PR 显式标注，发版候选前补验）。
 * 反证（本类必须能红）：invokeInstaller 摘掉校验前置 → 静态判据红；
 * signerDigestsMatch 放宽空集合或改为顺序敏感 → 纯判据红。
 */
class UpdateSignerContinuityTest {

  private fun repoFile(rel: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) return File(dir, rel)
      dir = dir.parentFile
    }
    throw AssertionError("找不到仓根（settings.gradle.kts），工作目录 = " + File(".").absolutePath)
  }

  /** 去掉注释行（注释里写 API 名不算命中——与本仓静态门禁同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun b(s: String): ByteArray = s.toByteArray()

  // ── 纯判据 ──────────────────────────────────────────────────────────────────

  @Test
  fun sameCertificateSetPasses() {
    val certs = listOf(b("official-release-cert"))
    assertTrue("同证书 = 官方发行链的合法升级", UpdateChecker.signerDigestsMatch(certs, certs))
  }

  @Test
  fun differentCertificateIsRejected() {
    val incoming = listOf(b("attessor-signed-with-leaked-repo-key"))
    val installed = listOf(b("official-release-cert"))
    assertFalse("证书不一致必须拒（repoDebug 私钥公开，同证书可被任何人签出）",
      UpdateChecker.signerDigestsMatch(incoming, installed))
  }

  @Test
  fun unreadableSignaturesFailClosed() {
    val certs = listOf(b("official-release-cert"))
    assertFalse("待装包读不出签名块必须拒", UpdateChecker.signerDigestsMatch(emptyList(), certs))
    assertFalse("已安装侧读不出证书同样拒（锚不可得 = 不放行）", UpdateChecker.signerDigestsMatch(certs, emptyList()))
    assertFalse("两侧都读不出更不能放行", UpdateChecker.signerDigestsMatch(emptyList(), emptyList()))
  }

  @Test
  fun multiSignerComparisonIsOrderInsensitive() {
    val a = listOf(b("cert-1"), b("cert-2"))
    val b = listOf(b("cert-2"), b("cert-1"))
    assertTrue("多签名者按集合比较（框架返回顺序不保证）", UpdateChecker.signerDigestsMatch(a, b))
    val c = listOf(b("cert-1"), b("cert-3"))
    assertFalse("集合有差即拒", UpdateChecker.signerDigestsMatch(a, c))
  }

  // ── 静态判据 ────────────────────────────────────────────────────────────────

  @Test
  fun invokeInstallerEnforcesContinuityBeforeFiring() {
    val code = codeOnly(repoFile("app/src/main/java/com/omnifarious/omniagent/UpdateChecker.kt").readText())
    val body = code.substringAfter("fun invokeInstaller(")
    val check = body.indexOf("signerContinuityHolds(")
    val fire = body.indexOf("startActivity(")
    assertTrue("invokeInstaller 必须先做发布者连续性校验", check >= 0)
    assertTrue("校验必须先于 startActivity（安装链最后一道闸，调用方绕不过）", fire >= 0 && check < fire)
  }

  @Test
  fun stateMachineRejectsWithAnHonestUserFacingReason() {
    val code = codeOnly(repoFile("app/src/main/java/com/omnifarious/omniagent/ApkUpdateAction.kt").readText())
    val body = code.substringAfter("private fun install(")
    assertTrue("状态机层必须有连续性校验前置（给出比「拉起失败」更诚实的文案）",
      body.contains("UpdateChecker.signerContinuityHolds("))
    assertTrue("拒绝必须走被拒产物语义（KIND_ARTIFACT_REJECTED），不得伪装成拉起失败",
      body.substringBefore("UpdateChecker.invokeInstaller(").contains("KIND_ARTIFACT_REJECTED"))
  }

  /**
   * 签名配置：正式发布密钥只从环境变量读取（不进仓库），debug 与 release 用同一个签名档。
   *
   * 仓库里的 repoDebug 口令公开，任何人都能用它签出同证书的包，所以它只能做「没有正式密钥时」
   * 的本地兜底；真正可发布的包由签名门禁的证书锚（正式密钥指纹）把关。这条用例钉住三件事：
   * 正式密钥不以文件形式出现在仓库路径里、release/debug 不各自分叉、repoDebug 兜底仍在。
   */
  @Test
  fun releaseSigningComesOnlyFromEnvironment() {
    val gradle = repoFile("app/build.gradle.kts").readText()
    for (name in listOf("OMNI_RELEASE_KEYSTORE", "OMNI_RELEASE_KEYSTORE_PASSWORD", "OMNI_RELEASE_KEY_ALIAS")) {
      assertTrue("正式密钥参数 $name 必须从环境变量读取",
        gradle.contains("providers.environmentVariable(\"$name\")"))
    }
    assertFalse("正式密钥不得指向仓库内文件",
      Regex("""create\("omniRelease"\)[\s\S]*?rootProject\.file""").containsMatchIn(
        gradle.substringBefore("create(\"repoDebug\")")))
    assertEquals("release 与 debug 必须用同一个签名档（不静默分叉）", 2,
      Regex("""signingConfig = signingConfigs\.getByName\(shippingSigning\)""").findAll(gradle).count())
    assertTrue("缺正式密钥时退回仓库 repoDebug",
      gradle.contains("val shippingSigning = if (hasReleaseKey) \"omniRelease\" else \"repoDebug\""))
    assertTrue("repoDebug 必须仍指向仓库内置 keystore",
      gradle.contains("storeFile = rootProject.file(\"keystore/debug.keystore\")"))
  }
}
