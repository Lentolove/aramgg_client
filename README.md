<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="ARAMGG 助手：只读 LCU 选人建议、本地海克斯 OCR 与游戏内推荐浮窗" />
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/valkia/aramgg_client/releases/latest"><img src="https://img.shields.io/github/v/release/valkia/aramgg_client?style=flat-square&color=c8a96a&label=release" alt="最新版本" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-111923?style=flat-square&logo=windows11&logoColor=f4ecdc" alt="Windows x64" />
  <img src="https://img.shields.io/badge/LCU-read--only-54d884?style=flat-square" alt="LCU 只读" />
  <img src="https://img.shields.io/badge/UI-zh--CN%20%7C%20en--US%20%7C%20zh--TW-c29c6d?style=flat-square" alt="支持简体中文、英文与繁体中文" />
</p>

<p align="center">
  面向 Windows 的英雄联盟极地大乱斗桌面助手：选人阶段给出英雄与席位建议，对局中识别三张海克斯卡片，并把胜率、出装与技能建议放到游戏旁边。
</p>

<p align="center">
  <a href="https://github.com/valkia/aramgg_client/releases/latest"><strong>下载 Windows 安装包</strong></a>
  ·
  <a href="https://aramgg.com"><strong>访问 ARAMGG 主站</strong></a>
  ·
  <a href="./docs/USER_GUIDE_AUTO_AUGMENT.md">使用指南</a>
  ·
  <a href="./docs/LCU_TROUBLESHOOTING.md">LCU 排障</a>
</p>

## 先看实际效果

<p align="center">
  <img src="./docs/aramgg-in-game-preview.png" width="100%" alt="ARAM 对局中的三卡海克斯识别浮窗和右侧推荐列表" />
</p>

<p align="center">
  <sub>顶部浮窗保持左、中、右卡位顺序；右侧列表继续展示海克斯胜率、推荐度和关联出装。</sub>
</p>

<p align="center">
  <img src="./docs/image.png" alt="ARAMGG 助手主控制台" width="380" />
  <img src="./docs/image0.png" alt="英雄详情与 ARAM 席位推荐" width="360" />
</p>

## 一局游戏里，它做什么

| 阶段 | ARAMGG 读取 | 你会看到 |
| --- | --- | --- |
| `ChampSelect` | 只读 LCU 选人、英雄与 bench 状态 | 当前英雄数据和所有可用席位英雄建议 |
| `InProgress` | 屏幕中的左 / 中 / 右海克斯标题区域 | 顶部三卡浮窗和右侧胜率、推荐列表 |
| 全程 | 当前语言的本地缓存或内置数据 | 英雄、海克斯、出装、召唤师技能与加点建议 |

> [!IMPORTANT]
> 推荐链路只读取状态和统计数据。它不会自动选英雄、交换 bench、锁定英雄或接受交易；最终操作始终由玩家完成。

## 为什么它不只是一个数据浮窗

- **先识别游戏阶段。** 应用通过 LCU gameflow 决定何时展示选人建议、何时运行游戏内 OCR，离开对局后会清理过期结果。
- **按真实卡位识别。** PaddleOCR 只读取左、中、右标题区域；某个位置读不到时保留空槽，不用宽区域结果打乱顺序。
- **本地优先展示。** 完整的内置或缓存数据会先渲染，远端版本检查与下载在后台进行，且只在必需文件完整后切换。
- **界面与数据同语言。** `zh-CN`、`en-US`、`zh-TW` 采用事务式切换，避免界面已经变更但数据仍停留在旧语言。
- **内置反馈与诊断。** 原生反馈表单支持可选截图，并在明确提示后自动附带已脱敏的近两天客户端日志，帮助复现问题。

## 安装与使用

1. 从 [Releases](https://github.com/valkia/aramgg_client/releases/latest) 下载最新的 `aramgg_client Setup <version>.exe`。
2. 安装并启动 ARAMGG 助手，再启动 League Client。应用会优先从运行中的客户端自动发现 LCU。
3. 进入极地大乱斗：选人阶段查看英雄详情与席位建议；进入对局后等待海克斯界面出现。
4. 自动识别失败时可按 `F1` 手动截图分析。

「游戏目录」不是必填项。只有进程优先的 LCU 自动发现失败时，才需要把它作为读取 lockfile / 日志的高级兜底。

## 工作方式

```text
League Client ──只读 LCU──> 游戏阶段路由 ──ChampSelect──> 英雄详情 / 席位建议
                                          └─InProgress──> 屏幕截图
                                                            │
本地优先的同语言数据 <────────────── PaddleOCR 标题识别 <────┘
          │
          └──────────────> 顶部三卡浮窗 / 右侧推荐列表
```

Renderer 不拥有 Node 能力，只能通过 sandbox preload 暴露的业务 API 与主进程通信。Electron 窗口保持 `contextIsolation`、`sandbox` 和 `webSecurity` 开启。

## 本地开发

需要 Node `22.18.0` 与 npm 10。

```bash
git clone https://github.com/valkia/aramgg_client.git
cd aramgg_client
npm install
npm run prepare:client-data
npm run dev
```

提交前建议依次运行：

```bash
npm run test:unit
npm run test:augment-ocr
npm run lint
npm run type-check
npm run build
```

项目基于 Electron、Vue 3、electron-vite、TypeScript 和 PaddleOCR。源码按进程边界组织在 `src/main/`、`src/preload/`、`src/renderer/` 与 `src/shared/`；测试位于 `tests/unit/` 和 `tests/electron/`。

## 手动刷新浮窗（manual-overlay 分支）

这个分支把「持续自动截图」改成了「常驻浮窗 + 手动刷新」：

- **浮窗**：进入对局（`InProgress`，也包括加载/重连）后自动出现，始终置顶、可拖动（拖标题栏），位置会被记住；离开对局自动隐藏。显示当前英雄（来自 LCU / 2999 检测，不依赖 OCR）。设置里可勾选「选人阶段也显示」。
- **刷新**：海克斯三选一出现时点「刷新」或按全局快捷键（默认 `Ctrl+Shift+R`，可在浮窗 ⚙ 里改为 `Ctrl+Shift+A` / `Ctrl+Alt+R` / `F8` / `F10` / `Pause`）。每次只截**一张**游戏窗口图，走原有 OCR + 名称匹配，显示三张卡。
- **三选一排序**：经验贝叶斯收缩胜率 `(胜场 + α×英雄平均) / (场次 + α)`（α 默认 300，可调），显示相对英雄平均的百分点差和场次；前两名差距在 1σ 噪声内标「差不多」；标签只在这三张之间相对比较。三张都没有胜率时退回热度（梯度 + 选取率）排序并明确标注。
- **已选海克斯**：点卡片即记为已选，本局内记住，新的一局自动清空，可点 × 移除。
- **出装**：根据已选海克斯给出解释性的推荐：海克斯描述直接提到的装备（如「升级：中娅」→ 中娅沙漏）排第一；再按海克斯属性倾向（法强/攻击/攻速/暴击/护甲/魔抗/生命/技能急速/续航…）在该英雄已有的出装路线里重排；读取游戏内 2999 接口标记「已有」并高亮「下一件」；敌方法强/物理装明显偏一边时补一件对应防御装。每件装备都写明原因。注意：数据源没有「海克斯 → 出装」的统计，这部分是透明规则，不是统计结论。
- **旧的持续自动截图**默认关闭（设置项 `autoScreenshot`），需要时可在浮窗 ⚙ 里重新打开。
- **图标识别 + 文字识别**：截图直接取 RGBA 像素（不做 PNG 编解码），OCR 与「卡片图标匹配」并行。图标库在进入对局时从数据 API 的 `iconUrl`（仅 `cdn.dtodo.cn` / `raw.communitydragon.org`）下载并缓存到 `<数据目录>/cache/augment-icons/`。卡位按分辨率比例裁剪，用实机截图在 810p/1080p/1440p 上标定。两者一致标 ✓；图标高置信时可纠正 OCR 的错字，标「图标」；只有图标、把握不大时标「待确认」。不少海克斯共用同一张通用图标，这种情况以文字为准。浮窗底部显示截图/识别/图标耗时。
- **「可以刷新了」提醒**：每 3 秒读一次 2999 接口的等级、游戏时间、是否阵亡，不截图。按等级表（默认 `1,7,11,15`，可改为 `3,7,11,15` 等）算出应出现的选择次数，大于已选/已忽略次数时提示「第 N 次海克斯待选」；开局窗口内（默认 90 秒）或阵亡时闪烁「可以刷新了」。可设置为只在阵亡时提醒，也可点「忽略」。
- **手动更正**：点卡名（▾）列出 OCR/图标候选（带分数），或按名字搜索全部海克斯；点已选海克斯的名字也可以换。更正会同步排序和已选列表。搜索框会临时让浮窗获得焦点，关闭后恢复。
- **刷新日志**：每次刷新、选择、更正、忽略都追加一行到 `<日志目录>/manual-refresh.jsonl`，包含 gameTime、等级、是否阵亡、识别结果来源与各步耗时，用来校准提醒时机和识别阈值。

### Windows 上构建与运行

1. 安装 Node `22.18.0`（含 npm 10）和 Git。
2. 获取代码：直接解压提供的源码包；或在上游仓库 `e07cef8`（v0.2.17）上执行 `git am aramgg_manual_overlay.patch`。然后安装依赖：
   ```powershell
   cd aramgg_client
   npm install
   npm run prepare:client-data
   ```
3. 开发模式运行：`npm run dev`；打包安装包：`npm run build` 后 `npm run pack`（项目原有的 electron-builder 脚本）。
   实机验证：进入极地大乱斗/海克斯大乱斗对局，确认浮窗出现 → 三选一时按快捷键 → 三张卡与排序出现 → 点一张 → 出装列表更新、已有装备变灰。
4. 提交前检查：`npm run test:unit`、`npm run test:augment-ocr`（OCR 回归，需 Windows/原生模块）、`npm run lint`、`npm run type-check`。

### 使用建议与已知限制

- **随时显示浮窗**：托盘右键「显示手动浮窗 / 隐藏手动浮窗」；或运行 `aramgg_client.exe --show-manual-overlay`（已在运行时也有效）。游戏内 2999 接口有响应就自动显示，不依赖 LCU 阶段事件。显示期间每 1.5 秒重新置顶（不抢焦点），防止被无边框游戏窗口盖住；窗口跑出屏幕时自动拉回。
- 建议游戏使用**无边框窗口**模式；独占全屏下置顶浮窗可能被游戏盖住（需实机确认）。
- 浮窗默认 `focusable: false`，点击按钮不应抢走游戏焦点（Windows 的 no-activate 窗口行为，需实机确认）。如果设置里的下拉框打不开，可勾选「浮窗可获得焦点」后重启。
- 全局快捷键由系统独占，按下后游戏收不到这个按键；若与游戏或其他软件冲突，请在设置里换一个。
- `desktopCapturer` 每次刷新仍会枚举所有窗口生成缩略图（Electron 的限制），但只在你刷新时执行一次，不再持续轮询。

## 文档导航

- [完整架构](./COMPLETE_ARCHITECTURE.md)
- [自动海克斯检测使用指南](./docs/USER_GUIDE_AUTO_AUGMENT.md)
- [客户端反馈与日志边界](./docs/FEEDBACK.md)
- [LCU 排障指南](./docs/LCU_TROUBLESHOOTING.md)
- [性能与发热排查](./docs/PERFORMANCE_DIAGNOSTICS.md)
- [大乱斗 LCU 只读推荐进度](./docs/ARAM_LCU_READONLY_RECOMMENDATION_PROGRESS.md)
- [客户端数据 API 分发策略](./docs/client-api-strategy.md)
- [Electron 客户端版本更新方案](./docs/ELECTRON_APP_UPDATE_STRATEGY.md)
- [TypeScript 开发约定](./docs/TYPESCRIPT_INTEGRATION.md)

客户端数据接口、API Key 申请和接入说明见 [ARAMGG 数据 API 开发者页面](https://data.dtodo.cn/developer.html)。

<details>
<summary><strong>维护者：发布与质量检查</strong></summary>

GitHub Actions 会在 Windows Runner 上执行 lint、type-check、unit tests 和打包。正式发布使用 `npm run release:patch|minor|major` 创建版本提交与 annotated tag，再运行 `npm run release:push`。

源码开发和普通本地打包不会向生产服上传战绩；只有该 GitHub 官方发布 workflow 会注入官方通道标记和生产写接口 origin。

依赖或 lockfile 变更后，发布前使用 npm 10 验证：

```bash
npx -p npm@10 npm ci --ignore-scripts
```

安装包发布后，还需要更新远端 `/api/client/v1/config` 中的 `client.latestVersion`、`client.downloadUrl` 和更新日志。自动更新链路未完整验证前保持 `client.autoUpdateEnabled` 关闭。

</details>

<details>
<summary><strong>Star 趋势</strong></summary>

<p align="center">
  <a href="https://www.star-history.com/?repos=valkia%2Faramgg_client&type=date&legend=top-left">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=valkia/aramgg_client&type=date&theme=dark&legend=top-left&sealed_token=4WUaLyfHuhwVpa6CaVWxo9JwrU2ORlLI9dAYuWiPKDmieAkfPBMEhZVkaRE_Uh1S09rcn68ut9p3OTdv9g44qUeyk6rhtzkLF2KZ2_fbpLsIYVIxlwgpXj4aGR84y6dlAebI8UBtjKZlyxHepOvNbgHdzcQZqUinKSJCfAOSVoRjwL1xngr9YyeBPBBN" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=valkia/aramgg_client&type=date&legend=top-left&sealed_token=4WUaLyfHuhwVpa6CaVWxo9JwrU2ORlLI9dAYuWiPKDmieAkfPBMEhZVkaRE_Uh1S09rcn68ut9p3OTdv9g44qUeyk6rhtzkLF2KZ2_fbpLsIYVIxlwgpXj4aGR84y6dlAebI8UBtjKZlyxHepOvNbgHdzcQZqUinKSJCfAOSVoRjwL1xngr9YyeBPBBN" />
      <img src="https://api.star-history.com/chart?repos=valkia/aramgg_client&type=date&legend=top-left&sealed_token=4WUaLyfHuhwVpa6CaVWxo9JwrU2ORlLI9dAYuWiPKDmieAkfPBMEhZVkaRE_Uh1S09rcn68ut9p3OTdv9g44qUeyk6rhtzkLF2KZ2_fbpLsIYVIxlwgpXj4aGR84y6dlAebI8UBtjKZlyxHepOvNbgHdzcQZqUinKSJCfAOSVoRjwL1xngr9YyeBPBBN" alt="aramgg_client Star 趋势图" width="900" />
    </picture>
  </a>
</p>

</details>

<details>
<summary><strong>支持项目</strong></summary>

如果这个项目对你有帮助，欢迎支持后续开发与维护。

<p align="center">
  <img src="./docs/assets/support/wechat.jpg" alt="微信赞赏码" width="220" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="./docs/assets/support/alipay.jpg" alt="支付宝收款码" width="220" />
</p>

</details>
