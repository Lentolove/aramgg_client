import { describe, expect, it } from 'vitest'
import {
  computeRefreshReminder,
  countStagesReached,
  parseLevelSchedule,
  type RefreshReminderInput,
} from '../../src/shared/refresh-reminder.ts'

const base: RefreshReminderInput = {
  level: 3,
  gameTime: 20,
  isDead: false,
  pickedCount: 0,
  acknowledgedStage: 0,
  schedule: [1, 7, 11, 15],
  onlyWhenDead: false,
  startWindowSec: 90,
}

describe('parseLevelSchedule', () => {
  it('parses, dedupes and sorts', () => {
    expect(parseLevelSchedule('15, 7,1，11 7')).toEqual([1, 7, 11, 15])
    expect(parseLevelSchedule([3, 7])).toEqual([3, 7])
  })
  it('falls back to the default schedule on garbage', () => {
    expect(parseLevelSchedule('abc')).toEqual([1, 7, 11, 15])
    expect(parseLevelSchedule('0,99')).toEqual([1, 7, 11, 15])
  })
})

describe('computeRefreshReminder', () => {
  it('counts reached stages', () => {
    expect(countStagesReached(6, [1, 7, 11, 15])).toBe(1)
    expect(countStagesReached(7, [1, 7, 11, 15])).toBe(2)
    expect(countStagesReached(null, [1, 7])).toBe(0)
  })

  it('flashes at the start of the game', () => {
    expect(computeRefreshReminder(base)).toMatchObject({ active: true, urgent: true, stage: 1 })
  })

  it('stays quiet after the opening pick', () => {
    expect(computeRefreshReminder({ ...base, pickedCount: 1, gameTime: 300, level: 6 })).toMatchObject({ active: false, stage: null })
  })

  it('shows a steady hint when a new stage is pending and flashes when dead', () => {
    const alive = computeRefreshReminder({ ...base, pickedCount: 1, level: 7, gameTime: 400 })
    expect(alive).toMatchObject({ active: true, urgent: false, stage: 2 })
    const dead = computeRefreshReminder({ ...base, pickedCount: 1, level: 7, gameTime: 400, isDead: true })
    expect(dead).toMatchObject({ active: true, urgent: true, stage: 2 })
  })

  it('only reminds when dead if configured', () => {
    const input = { ...base, pickedCount: 1, level: 11, gameTime: 700, onlyWhenDead: true }
    expect(computeRefreshReminder(input)).toMatchObject({ active: false, stage: 2 })
    expect(computeRefreshReminder({ ...input, isDead: true })).toMatchObject({ active: true, urgent: true })
  })

  it('respects acknowledged stages', () => {
    expect(computeRefreshReminder({ ...base, level: 7, gameTime: 400, acknowledgedStage: 2 }).active).toBe(false)
  })

  it('does not flash the opening stage after the start window unless dead', () => {
    expect(computeRefreshReminder({ ...base, gameTime: 200, onlyWhenDead: true }).active).toBe(false)
  })

  it('is inactive without live data', () => {
    expect(computeRefreshReminder({ ...base, level: null })).toMatchObject({ active: false, urgent: false })
  })
})
