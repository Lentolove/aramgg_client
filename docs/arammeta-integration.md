# arammeta 数据接入

数据来自 arammeta / Lanternko，MIT（https://github.com/Lanternko/ARAM-Mayhem-Database，https://arammeta.com）。
README 写着 "License: MIT"，但仓库里没有 LICENSE 文件。

## 数据清单（docs/api）

- `champions/<id>.json`（173 个英雄）
  - `poolAugments`：海克斯池，后验胜率与选取率
  - `top` / `bot`：按稀有度排的海克斯，含 lift、lcb、score、pickLift
  - `items.top` / `items.bot`：两件组合
  - `singleItems`：单件，以及「热门但胜率低」的装备
  - `boots`、`spells`
  - `itemClusters.groups`：出装路线，含核心、搭配选项（popular / winrate）、尾件、补全、路线鞋
  - `augTypes`：英雄 × 海克斯类型
- `tier-list.json`
  - 版本（`patchChanges`：16.20，本版本 552,574 场）
  - 英雄基线与阵容特征（`comp`：局均物理 / 魔法 / 真实伤害，以及 front / engage / wave / poke / sustain / cc）
  - 阵容表 `recommendation_composition`：队伍层面的胜率修正
  - `team_score`、`detailVersion`
- **没有**海克斯 × 装备、海克斯类型 × 装备的统计；阵容表也只是队伍层面的胜率修正，不涉及装备。
- 服务器：元数据里没有这个字段。作者脚本默认 `--platform TW2`，名称为繁体，推断为台服。
- ID：海克斯 211/211 与本项目一致；英雄 173/173 一致；装备只有 3039、124011 不在 `item-profiles.json` 里（CDragon 有），引擎会忽略这两件。

## 代码

| 文件 | 作用 |
|---|---|
| `src/shared/arammeta/normalize.ts` | 原始 JSON → 精简结构（缓存与快照都存这个） |
| `src/shared/arammeta/augment-ranking.ts` | 三选一：Beta 收缩到英雄基线（k=350），10% 下界 − 基线，同稀有度名次；逐卡退回 dtodo |
| `src/shared/arammeta/builds.ts` | 路线 → `ChampionBuildLike`（核心 / 搭配 / 鞋 / 尾件） |
| `src/shared/arammeta/composition.ts` | 移植 site.js `teamComposition`；「我去当前排」的实测效果；实测伤害构成 |
| `src/main/services/arammeta/arammeta-service.ts` | 内存 → 磁盘缓存 → 镜像（ETag）→ 旧缓存 → 打包快照 |
| `scripts/build-arammeta-snapshot.mjs` | 生成 `resources/arammeta`（`npm run prepare:arammeta`；`pack` 自动运行，失败不阻断） |

## 仍是规则的部分

- 海克斯 → 装备加成，包括描述点名、属性倾向、机制协同
- 阵容需求 → 装备的映射，包括抗性、重伤、穿透、保命、坦度权重
- 敌方装备 → 防御装
- 「本英雄用不上的属性」惩罚
- 三选一的契合度，最多 ±2 个百分点
- 路线里没给场次的尾件，以及按路线占比折算的英雄级鞋子场次（估算）
