# SKILL-MARKET.md — 扩展市场（技能与插件）设计

> 读者：要改市场、加技能或排查「装了不生效」的人。代码位置与常量以源码为准，本文只登记结构与判据。

## 1. 一句话

**技能是数据，不是代码。** 市场把一份 `SKILL.md` 装进 `~/.dsh/skills/`，引擎发现后由模型按说明去调用
已有的工具。因此市场本身不执行任何外来代码，装卸都不需要重启。

## 2. 分层

```
UI   dsh-client-ui-responsive · dev-section/extensions.tsx
     └─ fetch /api/skillmarket/*
服务 plugins/dsh-skill-market（引擎进程内）
     ├─ manifest   清单加载：main → jsDelivr → dev → 磁盘缓存
     ├─ installer  staging → 逐文件 sha256 → 原子 rename
     └─ installed  扫描 ~/.dsh/skills + 随包技能；算 updateAvailable
内容 ~/.dsh/skills/<id>/SKILL.md
引擎 dsh-skill（注册表）· dsh-skill-filesystem（发现）· dsh-tool-skill（按需读）
设备 ControlQueue → ControlPoller → DeviceControlService（无障碍）
```

职责边界：
- UI 只渲染与发起请求，不读文件、不判断安装状态。
- 服务层是唯一写盘者，也是唯一知道「什么是已安装」的地方。
- 引擎只认目录里的 frontmatter，不认识市场。
- 设备工具与市场无关：市场装的是说明，动作由 `android_*` 工具完成。

## 3. 三条流程

**安装**：`POST /api/skillmarket/install {id}` → 按清单取文件地址（raw 主、jsDelivr 备）→ 写
`.staging-<id>-<rand>` → 逐文件校验字节数与 sha256 → 同盘 rename 到 `~/.dsh/skills/<id>/`。
任一步失败删除 staging，旧目录不动。已存在且内容不同时必须显式 `overwrite: true`。

**使用**：模型看到目录里的 `name` + `description`，判断任务是否命中，读正文，按正文调设备工具。
技能正文不参与执行，只影响模型的行动选择。

**更新**：`/installed` 与 `/list` 对已安装项做目录清单比对（path/size/sha256），不一致即
`updateAvailable: true`；UI 显示「可更新」，点按走同一个安装流程并带 `overwrite`。

## 4. 清单

真源 `market/skills.json`，由 `scripts/market/build-skill-manifest.mjs` 从
`scripts/market/skill-sources.json` 生成（幂等，输出按 code-unit 排序，两次运行字节一致）。

条目必备：`id`（kebab-case）、`name`、双语 `title`/`description`、`category`、`license`、`source`。
`source` 两种形态：
- 本地技能：`{ local: true, ref: "main", path: "market/skills/<id>" }`，发布期随仓库走；
- 第三方：锁 commit 的 `{ owner, repo, ref: "<sha>", path }`，上游改动不会影响已装内容。

每个文件的 `path`/`sha256`/`size` 都进清单。**新增或修改技能必须重跑生成脚本**，手改数字会让
安装校验必然失败。

## 5. 不变量与判据

| 不变量 | 落在哪 |
|---|---|
| 只允许两个下载域：`raw.githubusercontent.com`、`cdn.jsdelivr.net` | `manifest.ts` 的 URL 断言（精确 origin，拒绝 lookalike/凭据/非默认端口） |
| 写入路径必须落在技能根内 | `paths.ts` 的 realpath 校验 + 清单相对路径校验 |
| 内容与清单逐字节一致 | `installer.ts` 的 size + sha256 |
| 失败不留半成品 | staging 目录 + 原子 rename |
| 内置技能不可删/不可覆盖 | `source: bundled` 判定，返回 `BUNDLED_NOT_REMOVABLE` |
| 清单读不到也不能白屏 | 磁盘缓存 `~/.dsh/market/cache.json`，返回 `stale`/`savedAt` |
| 安装与卸载串行 | 服务端一次性写入 + UI 全局 busy 标记 |

## 6. 降级路径

```
清单  main → jsDelivr → dev → 磁盘缓存(stale) → MARKET_UNAVAILABLE
文件  raw → jsDelivr →（本地技能再试 dev）→ 失败并清理 staging
设备  控件树 → 截图 + 坐标 → 如实报告（不盲点重试）
```

只有「连接失败 / 超时 / 5xx」才换入口；404 表示该地址没有这个资源，按语义分别处理
（清单 404 = 换分支，文件 404 = 失败）。

## 7. 插件 tab

插件走 vendored `dshmarketplace-plugin` 的 `/api/dshmarketplace/{search,install}`，与技能是两套实现：
插件是**代码**，安装后需要重启引擎；技能是**说明**，装完即用。两者在同一个页面里呈现，但不要
把它们的安装语义混为一谈。

## 8. 未做 / 下一步

- **工具依赖声明**：已做（a11y / shizuku）。技能可在清单声明 `requires: ["a11y" | "shizuku"]`，
  服务端只保留这两个值，未知值丢弃并记 warning、不拒绝整条条目。界面判定口径：无障碍读
  `a11yStatus()` 的 `enabled`、Shizuku 读 `shizukuStatus()` 的 `granted`，只有明确 `true`
  才算满足；桥缺席（桌面宿主）或字段读不到按满足处理（不误伤），但不会显示「已满足」标记。
  明确为 `false` 时在安装前给出警示徽标并禁用安装，同时提供「去开启」入口。
- **付款类动作的硬拦截**：已做（无障碍通道）。`DeviceControlService` 在 click / longClick
  真正执行前调用 `PaymentGuard`（纯函数、JVM 单测）：只在淘宝 / 天猫包内生效，命中
  「提交订单 / 结算 / 付款 / 支付 / 退款 / 退货 / 确认收货 / 删除订单 / 修改收货地址」
  等标签即拒绝；nx/ny 坐标点按先按坐标命中节点再判，避免「换坐标绕过」。被拒时只返回
  `payment-blocked` 与「请用户本人操作」的引导，**不提供模型可用的放行开关**。
  边界：纯 Shizuku 的 `input tap`、`ACTION_VIEW` 深链拿不到控件文本，不在覆盖内；
  非购物应用不拦。
- **已装技能的版本说明**：目前只有 `updateAvailable` 布尔，没有版本号与变更说明。
