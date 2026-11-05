# Omni

手机上的 AI Agent，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

一个 APK 装下完整的 agent 运行时：AI 能看懂屏幕、替你点击滑动输入，也能在内置 Linux 环境里真实执行命令。不需要 root。

## 能做什么

- 操作手机：开启无障碍授权后，AI 读取屏幕内容并执行点击、滑动、输入、截屏
- 执行命令：内置 Termux 环境，AI 跑的 bash 命令真实生效
- 后台运行：前台服务保活，切走应用或锁屏任务照跑
- 插件扩展：新能力以 DeepSeek Harness 插件形式加入，不改核心

## 安装

| 项目 | 要求 |
|---|---|
| 系统 | Android 8.0 及以上，arm64 |
| 安装包 | 约 160 MB |
| root | 不需要 |

1. 安装 APK，首次启动会解压运行环境，需要几分钟，期间不要强行停止
2. 按引导开启无障碍、通知权限
3. 在设置里填写模型 API 的地址和 Key（OpenAI / Anthropic 协议均可）

小米 / HyperOS 设备还需要打开：自启动、省电策略「无限制」、后台弹出界面，并在多任务里锁定应用。

## 开发

- Android 壳：`app/`（Kotlin）
- 引擎侧插件：`plugins/`（TypeScript，Cordis 插件）
- 构建与环境：`docs/AGENTS/build-and-env.md`

## License

MIT，见 [LICENSE](LICENSE)。第三方组件按各自许可，见 [`LICENSES/`](LICENSES) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
