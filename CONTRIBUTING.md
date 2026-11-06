# 开发流程

[English version](CONTRIBUTING.en.md)

Omni 是 DeepSeek Harness 的安卓客户端。参与前先读 [`AGENTS.md`](AGENTS.md)，里面有项目地图、构建命令和常见坑。

## 分支

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 正式版，用户装的版本从这里发出 | 只接受来自 `dev` 的 PR；不直接 push |
| `dev` | 测试版，日常开发合到这里 | 通过 PR 合入，PR Gate 绿了才能合 |
| `feat/…` `fix/…` `docs/…` `chore/…` | 一件事一个分支 | 从 `dev` 拉出，合并后删除 |
| `upgrade/dsh-<版本>` | 升级 DeepSeek Harness 引擎 | 见下文「引擎升级」 |

提交信息写 `<类型>: <描述>`，类型取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `ci`。一个 PR 只做一件事，可以独立回退。

## 日常开发

1. 从最新的 `dev` 拉分支：`git switch dev && git pull && git switch -c feat/xxx`
2. 本地改代码，构建并跑测试（命令见 `AGENTS.md`）：
   ```bash
   ./gradlew :app:assembleDebug :app:testDebugUnitTest
   ```
3. 改动涉及界面或手机行为的，装到手机上试一遍。
4. 推分支，开 PR 到 `dev`。描述写清：改了什么、为什么、怎么验证的。没在手机上试就写「未做设备验证」。
5. PR Gate 绿了再合并，合并后删分支。

新增的界面文案同时提供中文和英文。

## 版本号

| 版本 | versionCode |
|---|---|
| 1.0.0 | 10000 |
| 1.0.1 … 1.0.99 | 10001 … 10099 |
| 1.1.0 | 10100 |

规则：`versionCode = 主 × 10000 + 次 × 100 + 修订`，修订号 0–99。两者都在 `app/build.gradle.kts`，每次发版一起升。

- versionCode 不升，手机拒绝覆盖安装。
- versionName 不升，App 内的「检查更新」永远提示已是最新。

## 发版

1. 在 `dev` 上开 `chore/release-1.0.x` 分支：改版本号，写 `release/v1.0.x/notes.md`（用户看得懂的更新说明），PR 合入 `dev`。
2. 测试包在手机上用过、没问题后，开 PR 把 `dev` 合入 `main`。
3. 在 Actions 里手动运行 `release`，输入版本号 `1.0.x`。它会构建、跑门禁，产出 `omni-v1.0.x-arm64.apk` 和 `MANIFEST.txt`，建一个 draft Release。
4. 核对 draft Release 的资产和说明，确认后转为正式版。正式版发布后，下载站自动更新。
5. 用户在 App 里点「检查更新」即可升级，数据保留。

签名：所有正式版必须用同一把发布密钥签名，换了密钥用户就只能卸载重装。

- 密钥不进仓库。CI 从 Secrets（`OMNI_RELEASE_KEYSTORE_BASE64`、`OMNI_RELEASE_KEYSTORE_PASSWORD`、`OMNI_RELEASE_KEY_ALIAS`）还原，见 `scripts/ci/restore-release-key.sh`。
- 本机构建可发布的包：先 `source ~/.omni-release/env.sh`，再跑 Gradle。不设这三个变量时用仓库里的 `keystore/debug.keystore` 签名，这种包过不了签名门禁，只能自己调试用。
- 签名门禁只认 `scripts/fixtures/apk-expected-cert.sha256` 里的证书指纹。

## 引擎升级

DeepSeek Harness 官方发布新版（npm 上的 `@deepseek-ai/dsh`）后：

1. 从 `dev` 开 `upgrade/dsh-<版本>` 分支。
2. 改 `scripts/snapshot-config/engine-overlay.json` 里的版本号。
3. 检查 `scripts/patches/` 里的运行时补丁：新版已修复的删掉，失效的重新适配。
4. 重建快照，跑门禁和测试，装到手机上验证。
5. PR 合入 `dev`，之后按「发版」流程走。

新功能尽量写成插件（`plugins/`），不改引擎本身，这样升级时冲突最少。

## 提交前自查

```bash
git diff --check
git status --short
git diff --cached --stat
```

- 只暂存本次涉及的文件，不用 `git add .`。
- 没有调试残留、本机路径、API Key、设备序列号。
- 快照、APK 等大文件不进 git。
