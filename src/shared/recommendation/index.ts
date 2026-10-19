/**
 * 推荐系统入口：预生成的海克斯画像（scripts/build-recommendation-data.mjs 生成，含人工复核）
 * + 运行时兜底（新海克斯不在表里时，用英雄数据里的海克斯描述现场解析，置信度更低）。
 */

import augmentProfileData from './data/augment-profiles.json'
import itemProfileData from './data/item-profiles.json'
import type { AugmentProfile, ItemProfile, RawAugmentLike } from './profiles.ts'
import { toAugmentProfile, type EngineInput } from './build-engine.ts'
import { buildItemProfileIndex } from './build-engine.ts'

export * from './build-engine.ts'
export * from './augment-synergy.ts'
export type { AugmentProfile, ItemProfile, RawAugmentLike } from './profiles.ts'

interface ProfileFile {
  meta: { version: number; gamePatch?: string; note?: string }
  augments: AugmentProfile[]
}

const file = augmentProfileData as unknown as ProfileFile
const PROFILES = new Map<string, AugmentProfile>(file.augments.map((profile) => [String(profile.id), profile]))

export const AUGMENT_PROFILE_META = file.meta

export function getStoredAugmentProfile(id: number | string): AugmentProfile | null {
  return PROFILES.get(String(id)) ?? null
}

const runtimeCache = new Map<string, AugmentProfile>()

/**
 * 取海克斯画像：先查表；表里没有时用原始数据（英雄数据的 augments / 海克斯列表）现场解析。
 * 两者都没有时返回一个空画像（只保留名字），不会影响出装。
 */
export function resolveAugmentProfile(
  ref: { id: number | string; name?: string },
  raw?: RawAugmentLike | null,
  items?: EngineInput['items'],
): AugmentProfile {
  const stored = getStoredAugmentProfile(ref.id)
  if (stored) return stored
  const key = String(ref.id)
  const cached = runtimeCache.get(key)
  if (cached) return cached
  const source: RawAugmentLike = raw ?? ({ id: Number(ref.id), name: ref.name ?? String(ref.id) } as RawAugmentLike)
  const profile = toAugmentProfile(source, items ? buildItemProfileIndex(items) : undefined)
  runtimeCache.set(key, profile)
  return profile
}

/** CommunityDragon 生成的装备属性表（英雄数据里没有装备列表时兜底） */
export const STORED_ITEM_PROFILES: ItemProfile[] =
  ((itemProfileData as unknown as { items?: ItemProfile[] }).items ?? (itemProfileData as unknown as ItemProfile[]))

export * from './build-plans.ts'
export * from './team-comp.ts'
