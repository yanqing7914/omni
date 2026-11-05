package com.omnifarious.omniagent

import android.webkit.WebSettings
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * 浏览器 tab 的共享资源：document-start 脚本、UA-CH 应用、错误页 HTML。
 *
 * 为什么抽出来：这些面被两个执行位共用——主进程 BrowserHost（Profile API 档）与
 * :browser 渲染进程（数据目录后缀档，见 docs/BROWSER-COMPAT-SPIKE-2026-10-24.md）。
 * 两边必须逐字一致，否则同一设备换档后页面行为漂移；内容改动只允许发生在这里。
 */
internal object BrowserTabResources {

  /** 桌面身份脚本：只在 document-start 运行；不暴露桥、不改页面内容。 */
  val IDENTITY_JS: String = """
    (function(){
      try {
        var N = Navigator.prototype;
        Object.defineProperty(N, 'platform', {get:function(){return 'Linux x86_64';}, configurable:true});
        Object.defineProperty(N, 'maxTouchPoints', {get:function(){return 0;}, configurable:true});
        Object.defineProperty(N, 'userAgentData', {get:function(){return undefined;}, configurable:true});
        Object.defineProperty(N, 'hardwareConcurrency', {get:function(){return 8;}, configurable:true});
      } catch (e) {}
      try { delete window.ontouchstart; } catch (e) {}
      try { delete Object.getPrototypeOf(window).ontouchstart; } catch (e) {}
      try {
        var S = Screen.prototype;
        Object.defineProperty(S, 'width', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'height', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'availWidth', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'availHeight', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'colorDepth', {get:function(){return 24;}, configurable:true});
        Object.defineProperty(S, 'pixelDepth', {get:function(){return 24;}, configurable:true});
      } catch (e) {}
    })()
  """.trimIndent()

  /** 视口注入脚本：在页面任何脚本之前把 viewport 固定为请求的 CSS 宽（document-start）。 */
  fun viewportScript(width: Int): String = """
    (function(){
      var W = $width;
      var C = 'width=' + W + ', user-scalable=no';
      function fixViewport(){
        try {
          var metas = document.querySelectorAll('meta[name="viewport"]');
          if (metas.length > 0) {
            for (var i = 0; i < metas.length; i++) {
              if (metas[i].getAttribute('content') !== C) metas[i].setAttribute('content', C);
            }
            var head = document.head;
            if (head) {
              for (var j = 0; j < metas.length; j++) {
                if (metas[j].parentNode !== head) { head.insertBefore(metas[j], head.firstChild); break; }
              }
            }
            return true;
          }
          var target = document.head || document.documentElement;
          if (!target) return false;
          var m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', C);
          target.insertBefore(m, target.firstChild);
          return true;
        } catch (e) { return true; }
      }
      fixViewport();
      var o = new MutationObserver(function(){ fixViewport(); });
      o.observe(document, {childList: true, subtree: true});
      setTimeout(function(){ o.disconnect(); }, 3000);
    })()
  """.trimIndent()

  /** WebView >= 116 时同批设置 UA-CH（与 UA 串脱钩会让站点判定分裂）；本机不支持则如实返回 false。 */
  fun applyUserAgentMetadata(settings: WebSettings, profile: String): Boolean {
    if (profile == "android-real" || !WebViewShim.supports(WebViewFeature.USER_AGENT_METADATA)) return false
    // Metadata follows the applied UA, not an unrelated provider package version.
    val versionText = WebViewShim.chromiumVersionFromUserAgent(settings.userAgentString.orEmpty())
    if (versionText.isEmpty()) return false
    // UA 不含可验证的 Chromium 版本时不伪造 UA-CH 元数据。
    val major = WebViewShim.majorOf(versionText).takeIf { it > 0 }?.toString() ?: ""
    return try {
      val metadata = UserAgentMetadata.Builder()
        .setBrandVersionList(listOf(UserAgentMetadata.BrandVersion.Builder()
          .setBrand("Chromium").setMajorVersion(major).setFullVersion(versionText).build()))
        .setFullVersion(versionText)
        .setPlatform(if (profile == "windows-desktop") "Windows" else "Linux")
        .setPlatformVersion("")
        .setArchitecture("x86")
        .setModel("")
        .setMobile(false)
        .setBitness(64)
        .setWow64(false)
        .build()
      WebSettingsCompat.setUserAgentMetadata(settings, metadata)
      true
    } catch (_: Throwable) {
      false
    }
  }

  /** 浏览器风格错误页（无脚本、无桥；重试链接为绝对 http(s) URL）。 */
  fun errorPageHtml(failedUrl: String, code: Int, description: String): String {
    val names = mapOf(
      -1 to "ERR_FAILED", -2 to "ERR_NAME_NOT_RESOLVED", -3 to "ERR_ABORTED",
      -4 to "ERR_AUTHENTICATION", -5 to "ERR_PROXY_AUTHENTICATION", -6 to "ERR_CONNECTION_REFUSED",
      -7 to "ERR_IO", -8 to "ERR_TIMED_OUT", -9 to "ERR_REDIRECT_LOOP", -10 to "ERR_UNSUPPORTED_SCHEME",
      -11 to "ERR_SSL_PROTOCOL_ERROR", -12 to "ERR_BAD_URL", -13 to "ERR_FILE_NOT_FOUND",
      -14 to "ERR_FILE_ACCESS_DENIED", -15 to "ERR_TOO_MANY_REQUESTS", -16 to "ERR_UNSAFE_RESOURCE",
    )
    val name = names[code] ?: "ERR_FAILED"
    val host = try { java.net.URI(failedUrl).host ?: failedUrl } catch (_: Throwable) { failedUrl }
    val reason = description.ifBlank { "无法访问该页面。" }
    fun esc(text: String): String = text
      .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    return """
<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#e8e8ea;font:16px/1.6 system-ui,sans-serif}
main{max-width:420px;padding:32px 24px}h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 8px;color:#b9b9c0}code{color:#8f8f98;font-size:13px}
a{display:inline-block;margin-top:16px;padding:10px 20px;border-radius:8px;background:#3d6bff;color:#fff;text-decoration:none}
@media (prefers-color-scheme: light){body{background:#f5f5f7;color:#1b1b1f}p{color:#5f5f66}code{color:#8a8a92}}
</style></head><body><main>
<h1>嗯… 无法访问此页面</h1>
<p><strong>${esc(host)}</strong> ${esc(reason)}</p>
<p><code>${esc(name)}</code></p>
<a href="${esc(failedUrl)}">刷新</a>
</main></body></html>
    """.trimIndent()
  }
}
