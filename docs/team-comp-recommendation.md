# 对局阵容 → 出装（局势适配）

**输入**
- 对局中：2999 `allgamedata.allPlayers`，即双方 10 人（team、items、level、scores）。英雄按 `rawChampionName`（`game_character_displayname_<DDragonId>`）匹配，和客户端语言无关；匹配不到时退回中英文名。
- 选人阶段：LCU champ-select 的 `myTeam`。只有我方，因为 ARAM 选人时看不到对面。只在 phase = ChampSelect 时才请求。

**英雄画像** `src/shared/recommendation/data/champion-profiles.json`
- 由 `node scripts/build-champion-profiles.mjs` 生成。
- 自动推断：根据 DDragon 16.20.1 zh_CN 的 tags / info / attackrange 推断，置信度 0.4。
- 人工整理：`champion-profile-overrides.json` 收录 158 个 ARAM 常见英雄，置信度 0.8。
- 字段（0–1 的相对强度）：
  - 伤害构成 ap/ad/true
  - 前排、回复、护盾
  - 硬控（≈个数）
  - 爆发、持续输出、突进、消耗、百分比伤害
  - 射程

**阵容分析** `team-comp.ts`
- 敌方伤害构成 = 英雄画像与已出装备的加权混合。装备越多越信装备，最多占 0.7。
- 威胁加权：击杀多的敌人权重更高，坦克的输出权重更低。
- needs（0–1）：魔抗、护甲、重伤、破盾、对坦（穿透/百分比）、韧性/解控、保命（中娅/女妖/守护天使）、补前排、补输出。
- 补前排 / 补输出：只有该英雄的数据路线里同时有肉装路线和输出路线时才生效（墨菲特可以，安妮不会被劝出肉）。

**引擎** `build-engine.ts`
- 每件装备的阵容项封顶在 −2 ～ +3.5，并带理由。
- 同类需求多件满足时递减：
  - 抗性 ×0.7；
  - 补前排 / 补输出 ×0.85；
  - 重伤、破盾、保命、解控只给第一件。
- 选流派时加一项：缺前排 / 缺输出 × 路线坦度差。
- 有阵容信息时，不再单独计算旧的「敌方装备」项，避免重复计分。
- 结果附带：
  - `team.added` / `team.removed` / `team.routeNote`：与「不看阵容」的同一套海克斯相比的差异；
  - `contributions`：海克斯与阵容各自的分数合计。

**方案**
- 默认方案改名为「局势适配」（海克斯 + 阵容）。
- 「主流」「高胜率」仍是纯数据，不看阵容。

**海克斯卡**：契合度里加 `team` 分项，上限 1.5。例如缺前排时坦度卡加分、对面法伤高时魔抗卡加分。

**限制**：没有「阵容 × 装备」的胜率统计，以上都是规则模型，权重是人工设定的。
