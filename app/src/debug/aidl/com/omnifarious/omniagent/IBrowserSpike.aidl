// BrowserHost 兼容架构 spike（PR1，仅 debug 源集）：主进程对 :browser_spike 进程的探针接口。
// 三个待验证事实：数据目录后缀隔离 / SurfaceControlViewHost 跨进程投影 / 触摸转发。
package com.omnifarious.omniagent;

import android.view.SurfaceControlViewHost.SurfacePackage;

interface IBrowserSpike {
  // 进程自证：进程名、后缀是否已应用、后缀数据目录是否存在（JSON 字符串）。
  String processInfo();
  boolean setCookie(String url, String value);
  String getCookie(String url);
  // hostToken = 宿主窗口 token（宿主 rootView.windowToken 经 AIDL 传人）。
  // 实锤（2026-10-24 MuMu/API35）：不传 token，setView 在 grantInputChannel 处
  // 抛 SecurityException(INTERNAL_SYSTEM_WINDOW)——输入通道授权必须验宿主所有权。
  SurfacePackage createView(IBinder hostToken, int widthPx, int heightPx);
  SurfacePackage resizeView(IBinder hostToken, int widthPx, int heightPx);
  boolean destroyView();
  // 页面状态 JSON：created/loaded/viewTapCount/jsTapCount/width/height/loadError/buildError。
  String pageState();
  // 远端进程内程序化点击（验证模型侧 input op 的可行路径）。
  boolean sendTap(float x, float y);
  // 兜底输入通道：宿主 SurfaceView 收到触摸后原样转发（MotionEvent 可 Parcelable 跨 Binder）。
  // 原生转发实锤不生效时（见验证记录），生产实现走这条路。
  boolean forwardMotion(in MotionEvent event);
}
