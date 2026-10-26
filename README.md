<div align="center">

# ARAM 海克斯大乱斗 · 浮窗助手

**三选一出来，点一下刷新，就知道该拿哪个海克斯、下一件出什么。**

<a href="https://github.com/Lentolove/aramgg_client/releases/latest"><img src="https://img.shields.io/github/v/release/Lentolove/aramgg_client?style=for-the-badge&label=%E4%B8%8B%E8%BD%BD&color=c8a96a" alt="下载最新版" /></a>
<img src="https://img.shields.io/badge/Windows-x64-111923?style=for-the-badge" alt="Windows x64" />

<img src="docs/screenshots/overlay-yasuo.png" alt="海克斯三选一排名和推荐出装" width="420" />

</div>

## 它能帮你做什么

- 🎯 **海克斯怎么选**：识别当前三张卡，结合这个英雄的真实对局数据、双方阵容和你已经拿到的海克斯，给每张卡打 S/A/B/C 档（强烈推荐 / 推荐 / 一般 / 不推荐），按这一轮三张卡的差距来分档，附一句为什么。
- 🛡️ **装备怎么出**：根据你已经拿到的海克斯和双方阵容实时调整，该出肉装还是输出装、要不要重伤和魔抗，它会告诉你。
- 🔀 **不止一套出装**：主流、高胜率、局势适配三套可以切换，每件装备都有一句大白话原因（比如「敌方 4 个法师，优先魔抗」）。
- 🪶 **不打扰**：只在你点刷新时截一张图，不会一直截屏。浮窗可以收起成一条，只显示下一件装备；钱不够时会告诉你先买哪个小件。

<img src="docs/screenshots/overlay-collapsed.png" alt="收起后的样子" width="244" />

<sub>截图是浮窗用真实数据渲染的效果，背景是占位图。</sub>

## 三步用起来

1. 到 [Releases](https://github.com/Lentolove/aramgg_client/releases/latest) 下载 `aramgg_client-Setup-版本号.exe`，然后安装。安装包没有签名，Windows 提示时点“仍要运行”。
2. 游戏设置成**无边框窗口**，进大乱斗后浮窗会自动出现。
3. 三选一出来时点 **刷新**，或者按 `Ctrl+Shift+R`。按 `Ctrl+Shift+H` 收起或展开浮窗。

有新版本时会提醒你，打游戏的时候不会下载。

## 数据从哪来

海克斯和出装统计来自 [arammeta](https://arammeta.com)，一个开源的海克斯大乱斗真实对局数据库，每隔几个小时自动同步一次。基础数据来自 dtodo，图标来自 CommunityDragon。数据大概率来自台服，跟国服的环境可能有差别。

想了解算法细节、开发或发布流程，看 [技术说明](docs/TECHNICAL.md)。

## 说明

- 只支持 Windows。
- 本项目 fork 自 [valkia/aramgg_client](https://github.com/valkia/aramgg_client)，感谢原作者。原项目没有开源许可证，原代码版权归原作者。
- Riot 不允许产品显示海克斯胜率，这个工具的胜率显示处于灰色地带。胜率数字可以在设置里隐藏，使用风险自负。
- 本项目与 Riot Games 无关，也没有得到 Riot 的认可。
