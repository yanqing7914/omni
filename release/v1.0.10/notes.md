# Omni v1.0.10

可以直接覆盖安装，数据都会保留。

## 淘宝技能：不再依赖 ADB/Shizuku 才能启动应用

- 上一版修好屏幕范围后，真机测试卡在新的一步：`android_app_launch` 只会用特权 shell
  （`monkey -p`）启动应用，Shizuku/ADB 没授权时淘宝技能在第一步就停了。
- 本版改为**优先走无障碍通道**：应用自己持有 `QUERY_ALL_PACKAGES`，直接用
  `PackageManager.getLaunchIntentForPackage` 拉起，不需要第二条通道；失败才回退 ADB。
- 包名先在壳侧校验（只接受标准 Android 包名），不把任意字符串交给系统解析。

## 之前版本

- 屏幕范围从未设置时默认 `all`；扩展页有兜底放行入口。
- 淘宝/天猫的提交订单、付款等按钮仍由设备层硬拦截。
