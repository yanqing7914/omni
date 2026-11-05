package com.omnifarious.omniagent;

import android.view.SurfaceControlViewHost.SurfacePackage;

interface IBrowserRendererCallback {
  // tab 的投影句柄。每次 ensureTab/relayout 重建 SCVH 后各发一次；主进程只挂当前
  // 活动 tab 的包（挂载即可见性）。
  oneway void onSurfacePackage(String tabId, in SurfacePackage pkg);
  // 页面事件（JSON：type=pageStarted|pageFinished|title|loadError|sslError|renderGone|scroll,
  // 附 url/title/reason/generation/pageWidth/pageHeight/y/direction 等按 type 取舍）。
  oneway void onEvent(String tabId, String eventJson);
  // evaluateJs 的结果（seq 对应请求序号；resultJson 为原始返回或 {__error:...}）。
  oneway void onJsResult(String tabId, int seq, String resultJson);
}
