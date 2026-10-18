/**
 * 「可以刷新了」提醒（纯函数）。
 *
 * 海克斯大乱斗（ARAM Mayhem）的强化选择时机（Riot 开发者博客 / LoL Wiki / 官方客服页）：
 *   开局一次，之后在 7、11、15 级各一次；选择界面只在可以使用商店时（泉水内 / 阵亡）弹出，
 *   多个待选会排队。客服页写法为「3、7、11、15 级」，因此等级表可配置。
 *
 * 判断：按 2999 端口的 activePlayer.level 计算「应该已经出现的选择次数」stagesReached，
 * 若大于「已选 / 已确认」次数，说明还有待选的海克斯 → 在可选窗口内（开局前 N 秒 / 阵亡 / 不限）提醒。
 * 不做任何截图。
 */

export const DEFAULT_AUGMENT_LEVELS = [1, 7, 11, 15]
export const AUGMENT_LEVEL_PRESETS = ['1,7,11,15', '3,7,11,15', '1,3,7,11,15']
export const DEFAULT_START_WINDOW_SEC = 90

export function parseLevelSchedule(value: unknown): number[] {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/)
  const levels = parts
    .map((part) => Number(part))
    .filter((level) => Number.isInteger(level) && level >= 1 && level <= 18)
  const unique = Array.from(new Set(levels)).sort((a, b) => a - b)
  return unique.length > 0 ? unique.slice(0, 8) : [...DEFAULT_AUGMENT_LEVELS]
}

export function formatLevelSchedule(levels: number[]): string {
  return parseLevelSchedule(levels).join(',')
}

export interface RefreshReminderInput {
  level: number | null
  gameTime: number | null
  isDead: boolean | null
  pickedCount: number
  acknowledgedStage: number
  schedule: number[]
  onlyWhenDead: boolean
  startWindowSec: number
}

export interface RefreshReminderResult {
  /** 是否显示提醒 */
  active: boolean
  /** 大概率正在弹出选择界面（开局 / 阵亡）→ 闪烁「可以刷新了」 */
  urgent: boolean
  /** 当前待选的是第几次选择（1 起）；没有待选为 null */
  stage: number | null
  stagesReached: number
  /** 已完成（已选或已确认）的次数 */
  stagesDone: number
  reason: string
}

export function countStagesReached(level: number | null, schedule: number[]): number {
  if (level == null || !Number.isFinite(level)) return 0
  return schedule.filter((stageLevel) => stageLevel <= level).length
}

export function computeRefreshReminder(input: RefreshReminderInput): RefreshReminderResult {
  const schedule = parseLevelSchedule(input.schedule)
  const stagesReached = countStagesReached(input.level, schedule)
  const stagesDone = Math.max(0, input.pickedCount, input.acknowledgedStage)
  const base = { stagesReached, stagesDone }

  if (input.level == null) {
    return { ...base, active: false, urgent: false, stage: null, reason: '没有 2999 对局数据' }
  }
  if (stagesReached <= stagesDone) {
    return { ...base, active: false, urgent: false, stage: null, reason: '没有待选的海克斯' }
  }

  const stage = stagesDone + 1
  const inStartWindow = stage === 1 && input.gameTime != null && input.gameTime <= input.startWindowSec
  if (inStartWindow) {
    return { ...base, active: true, urgent: true, stage, reason: '开局海克斯选择' }
  }
  if (input.isDead === true) {
    return { ...base, active: true, urgent: true, stage, reason: `阵亡中，第 ${stage} 次海克斯可选` }
  }
  if (!input.onlyWhenDead) {
    return { ...base, active: true, urgent: false, stage, reason: `第 ${stage} 次海克斯待选（回泉水可选）` }
  }
  return { ...base, active: false, urgent: false, stage, reason: `第 ${stage} 次海克斯待选，回泉水或阵亡时提醒` }
}
