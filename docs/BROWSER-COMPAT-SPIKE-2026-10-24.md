# BrowserHost 旧 WebView 兼容架构可行性验证（PR1 spike 记录）

- 日期：2026-10-24
- 分支：`spike/browser-suffix-scvh`（基于 origin/main @ f00d7197）
- 设备：MuMu `127.0.0.1:16480`（Android 15 / API 35 / x86_64，WebView `com.android.webview 110.0.5481.154.1`）
- 结论：**四项可行性问题全部得到实证答案，兼容架构成立**；附带五条生产实现必须吸收的实锤约束。

## 背景

内置 AI 浏览器当前依赖 androidx `MULTI_PROFILE`（要求 WebView 提供方 114+）。WebView 110 的设备（MuMu 全部四台、部分真机）被 fail-closed 拒绝（`browser-profile-unsupported`）。候选兼容架构：

> 浏览器 WebView 移入独立 `:browser` 进程（`WebView.setDataDirectorySuffix` 隔离数据目录，API 28+），经 `SurfaceControlViewHost`（API 29+）把远端视图树投影回主界面 SurfaceView；主进程 BrowserHost 对桥/面板/插件的接口全部不变。

本 spike 用一个 debug 源集探针（`BrowserSpikeService` @ `:browser_spike` 进程 + `BrowserSpikeActivity` 宿主 + `IBrowserSpike` AIDL + `BrowserCompatSpikeTest` androidTest）在真机 WebView110 上逐项验证。所有代码仅 debug 源集，不进发布产物。

## 四项验证结论

| # | 问题 | 结论 | 关键实测 |
|---|---|---|---|
| S1 | 数据目录后缀隔离 | **PASS** | `:browser_spike` 进程 `setCookie(https://example.com/, dsh_spike=1)` 后，主进程 cookie 罐 `dsh_main=1` / spike 罐 `dsh_spike=1`，互不可见；`app_webview_dsh-spike-v1` 目录独立存在 |
| S2 | SCVH 跨进程投影 | **PASS** | 远端 WebView 建成即加载（800x600）；改尺寸换手到 1200x820 后页面状态存活；CDP `/json/list` 报 `attached:true, visible:true, 1200x820` |
| S3 | 输入转发 | **原生不生效；AIDL 手动转发 PASS** | 真实输入管线（injectInputEvent）点击后宿主窗口计数 0→1（事件到宿主），但远端 view/js 计数 0——child-surface 原生转发在 API35/WebView110 不工作；改宿主 onTouch → `forwardMotion(MotionEvent)` AIDL 转发（含屏幕→视图坐标变换）后远端 `viewTapCount:2`，页面 `jsTaps:2`（CDP 复核） |
| S4 | 后台生命周期 | **PASS** | 宿主退后台 5 秒后绑定进程存活、binder 可响应 |

完整数据：`docs/spike-report-16480.json`（设备内 `files/browser-compat-spike.json` 同源）；驻留截图：`docs/spike-hold-screencap-16480.png`。

## 生产实现必须吸收的实锤约束

1. **宿主窗口 token 必须跨进程递给浏览器进程**。SCVH 构造器第三参传 null 时 `setView` 在 `Session.grantInputChannel` 抛 `SecurityException: Requires INTERNAL_SYSTEM_WINDOW`（系统级权限，应用拿不到）。传宿主 `rootView.windowToken`（IBinder 经 AIDL）即成功——同 APK 同 uid 可授权。生产 AIDL 握手设计必须携带它。
2. **输入走宿主侧手动转发，不指望原生**。实证原生 child-surface 输入转发不生效（事件停在宿主窗口）。可行兜底（已验证）：宿主 SurfaceView `onTouchListener` → AIDL 传 MotionEvent（Parcelable）→ 远端 `WebView.dispatchTouchEvent`，坐标变换 = 平移宿主矩形原点 + 缩放到远端视图尺寸。模型侧 `browserInput` 则直接在远端进程 dispatch（`sendTap` 路径已验证）。生产可在 API 31+ 尝试 `IWindowManager.transferTouchGesture`（InputTransferToken）优化，但手动路径是保底。
3. **surface 重建复用 WebView 有坑**：旧容器必须先 `removeView`（release() 只销毁 surface 不解视图树，否则 "specified child already has a parent"）；且 View 尺寸变为 1200 后页面 `innerWidth` 仍停在 800（渲染器视口未跟随）——生产的改尺寸/密度路径应对齐现有 `recycleView` 语义（销毁重建 WebView），或强制渲染器重排。
4. **浏览器进程有自己的 devtools socket**（`webview_devtools_remote_<browser-pid>`，实测 `@webview_devtools_remote_1991` 与 `pidof :browser_spike` 一致）。CDP 验收脚本必须同时枚举主进程与浏览器进程两个 socket，才能看到浏览器页签 target。
5. **浏览器进程的 WebView 可能吃到算法暗色**：CDP 读到页面背景 `rgb(16,42,67)`，但截图像素 (29,32,36) 有偏移。生产在浏览器进程同样要按 `WebViewShim.applyBaseline` 钉死 force-dark 策略（appOwnsTheme）。
6. （顺带）`loadDataWithBaseURL` 在 devtools `/json/list` 里 URL 报 `about:blank`，验收脚本不要拿 URL 断言数据页，用 DOM evaluate。

## 跑法（复现）

```bash
gradlew :app:assembleDebug :app:assembleDebugAndroidTest
adb -s <dev> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <dev> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <dev> shell am instrument -w -e class com.omnifarious.omniagent.BrowserCompatSpikeTest \
    com.omnifarious.omniagent.test/androidx.test.runner.AndroidJUnitRunner
# 取证：run-as com.omnifarious.omniagent cat files/browser-compat-spike.json
# CDP：adb forward tcp:<p> localabstract:webview_devtools_remote_$(pidof com.omnifarious.omniagent:browser_spike)
```

## 对后续 PR 的输入

- PR2（tier 抽象 + caps）：`isolationTier` 增 `process-suffix`；`available` 改为 tier 判定。
- PR3（核心）：AIDL 面 = 本 spike 的 `IBrowserSpike` 扩展（tab 全生命周期 + 页面事件回调 + 截图走 ParcelFileDescriptor）；握手含宿主 windowToken；输入手动转发；改尺寸走 WebView 重建；浏览器进程复用 WebViewShim/NavigationPolicy 代码。
- PR4（验收）：verify-browser-host/panel 改 tier 感知 + 双 socket 枚举 + 活端口引擎源拒绝用例。
