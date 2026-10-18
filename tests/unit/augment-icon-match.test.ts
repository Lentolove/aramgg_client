import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import {
  combineSlotRecognition,
  compareDescriptors,
  computeDescriptor,
  createIconRegions,
  createRegionVariants,
  describeSlotVariants,
  hammingDistance,
  matchIconVariants,
  regionHasContent,
  sampleRegion,
  type IconIndexEntry,
  type IconMatch,
  type RawImage,
} from '../../src/shared/augment-icon-match.ts'
import { describeIconImage } from '../../src/main/services/manual-overlay/augment-icon-index.ts'

const FIXTURES = path.resolve(__dirname, '../fixtures')

function syntheticImage(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): RawImage {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(paint(x, y), (y * width + x) * 3)
    }
  }
  return { data, width, height, channels: 3 }
}

const full = (image: RawImage) => ({ left: 0, top: 0, width: image.width, height: image.height })

describe('augment icon descriptors', () => {
  const diagonal = syntheticImage(64, 64, (x, y) => (x > y ? [220, 180, 90] : [12, 24, 24]))
  const ring = syntheticImage(64, 64, (x, y) => {
    const distance = Math.hypot(x - 32, y - 32)
    return distance > 14 && distance < 24 ? [220, 180, 90] : [12, 24, 24]
  })
  const purpleDiagonal = syntheticImage(64, 64, (x, y) => (x > y ? [200, 90, 230] : [12, 24, 24]))

  it('matches an image with itself perfectly and ranks a different shape lower', () => {
    const a = computeDescriptor(sampleRegion(diagonal, full(diagonal)))
    const b = computeDescriptor(sampleRegion(ring, full(ring)))
    expect(compareDescriptors(a, a).score).toBeCloseTo(1, 3)
    expect(compareDescriptors(a, a).hamming).toBe(0)
    expect(compareDescriptors(a, b).score).toBeLessThan(0.6)
  })

  it('separates the same glyph in a different tier colour', () => {
    const gold = computeDescriptor(sampleRegion(diagonal, full(diagonal)))
    const purple = computeDescriptor(sampleRegion(purpleDiagonal, full(purpleDiagonal)))
    const same = compareDescriptors(gold, gold).score
    const recoloured = compareDescriptors(gold, purple)
    expect(recoloured.ncc).toBeGreaterThan(0.9)
    expect(recoloured.colorSimilarity).toBeLessThan(0.5)
    expect(recoloured.score).toBeLessThan(same - 0.1)
  })

  it('is invariant to resolution (area-averaged sampling)', () => {
    const big = syntheticImage(256, 256, (x, y) => (x > y ? [220, 180, 90] : [12, 24, 24]))
    const small = computeDescriptor(sampleRegion(diagonal, full(diagonal)))
    const large = computeDescriptor(sampleRegion(big, full(big)))
    expect(compareDescriptors(small, large).score).toBeGreaterThan(0.95)
  })

  it('computes hamming distances on hex hashes', () => {
    expect(hammingDistance('0000', '0000')).toBe(0)
    expect(hammingDistance('000f', '0000')).toBe(4)
    expect(hammingDistance('ffff', '0000')).toBe(16)
  })

  it('treats out-of-bounds samples as card background', () => {
    const rgb = sampleRegion(diagonal, { left: -64, top: 0, width: 32, height: 32 }, 4)
    expect([...rgb.slice(0, 3)]).toEqual([12, 24, 24])
  })

  it('detects empty regions', () => {
    const flat = syntheticImage(64, 64, () => [12, 24, 24])
    expect(regionHasContent(flat, full(flat))).toBe(false)
    expect(regionHasContent(ring, full(ring))).toBe(true)
  })
})

describe('icon regions', () => {
  it('scales proportionally with resolution', () => {
    const r1080 = createIconRegions(1920, 1080)
    const r1440 = createIconRegions(2560, 1440)
    expect(r1080).toHaveLength(3)
    r1080.forEach((rect, index) => {
      expect(r1440[index].left / 2560).toBeCloseTo(rect.left / 1920, 6)
      expect(r1440[index].top / 1440).toBeCloseTo(rect.top / 1080, 6)
      expect(r1440[index].width / 2560).toBeCloseTo(rect.width / 1920, 6)
    })
    // 三张卡居中对称
    expect(r1080[0].left + r1080[0].width / 2 + r1080[2].left + r1080[2].width / 2).toBeCloseTo(1920, 3)
  })

  it('creates scale × shift variants', () => {
    expect(createRegionVariants({ left: 0, top: 0, width: 100, height: 100 })).toHaveLength(27)
  })
})

async function loadFixtureIndex(ids: number[]): Promise<IconIndexEntry[]> {
  return Promise.all(ids.map(async (id) => ({
    id,
    name: String(id),
    descriptor: await describeIconImage(readFileSync(path.join(FIXTURES, 'augment-icons', `${id}.png`))),
  })))
}

async function loadScreenshot(file: string, scale = 1): Promise<RawImage> {
  const input = path.join(FIXTURES, 'augment-ocr', file)
  const meta = await sharp(input).metadata()
  const { data, info } = await sharp(input)
    .resize(Math.round(meta.width! * scale), Math.round(meta.height! * scale))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

describe('icon matching on real screenshots', () => {
  for (const scale of [1, 0.75, 4 / 3]) {
    it(`recognises the card icons at ${Math.round(1080 * scale)}p`, async () => {
      const index = await loadFixtureIndex([1390, 1129, 1332, 1054, 1204])
      const fullCards = await loadScreenshot('full-three-cards.png', scale)
      const regions = createIconRegions(fullCards.width, fullCards.height)
      const slot1 = matchIconVariants(describeSlotVariants(fullCards, regions[1]), index)
      const slot2 = matchIconVariants(describeSlotVariants(fullCards, regions[2]), index)
      expect(slot1[0].id).toBe(1390)
      expect(slot1[0].score).toBeGreaterThan(0.84)
      expect(slot1[0].score - slot1[1].score).toBeGreaterThan(0.04)
      expect(slot2[0].id).toBe(1129)

      const partial = await loadScreenshot('partial-one-card.png', scale)
      const partialRegions = createIconRegions(partial.width, partial.height)
      const slot0 = matchIconVariants(describeSlotVariants(partial, partialRegions[0]), index)
      expect(slot0[0].id).toBe(1332)
      // 不祥契约（棱彩）与物法皆修图形相近，但颜色让它领先
      expect(slot0[0].score - slot0[1].score).toBeGreaterThan(0.02)
    })
  }

  it('does not confidently match a card whose icon is not in the index', async () => {
    const index = await loadFixtureIndex([1390, 1129, 1332, 1054, 1204])
    const fullCards = await loadScreenshot('full-three-cards.png')
    const regions = createIconRegions(fullCards.width, fullCards.height)
    // 第 1 张是「裁决使」，不在图标库里
    const slot0 = matchIconVariants(describeSlotVariants(fullCards, regions[0]), index)
    expect(slot0[0].score).toBeLessThan(0.78)
  })
})

describe('combineSlotRecognition', () => {
  const match = (id: number, score: number): IconMatch => ({
    id, name: `aug${id}`, score, ncc: score, colorSimilarity: score, hamming: 10, iconPath: `${id}.png`, rarity: 1,
  })

  it('marks agreement between OCR and icon', () => {
    const result = combineSlotRecognition(0, { id: 1, name: 'aug1', confidence: 0.95 }, [match(1, 0.9), match(2, 0.7)])
    expect(result).toMatchObject({ id: 1, source: 'icon+ocr', confidence: 0.99 })
  })

  it('treats OCR inside an exact icon tie (shared generic icon) as agreement', () => {
    const result = combineSlotRecognition(0, { id: 3, name: 'aug3', confidence: 0.8 }, [match(2, 0.88), match(3, 0.88), match(4, 0.88)])
    expect(result).toMatchObject({ id: 3, source: 'icon+ocr' })
  })

  it('prefers a confident icon over a conflicting OCR result and keeps OCR as an alternative', () => {
    const result = combineSlotRecognition(1, { id: 9, name: 'aug9', confidence: 0.8 }, [match(1, 0.9), match(2, 0.8)])
    expect(result?.id).toBe(1)
    expect(result?.source).toBe('icon')
    expect(result?.alternatives.map((alt) => alt.id)).toEqual([9, 1, 2])
  })

  it('falls back to OCR when the icon is ambiguous', () => {
    const result = combineSlotRecognition(0, { id: 9, name: 'aug9', confidence: 0.8 }, [match(1, 0.86), match(2, 0.85)])
    expect(result).toMatchObject({ id: 9, source: 'ocr' })
  })

  it('uses a tentative icon result when OCR found nothing', () => {
    expect(combineSlotRecognition(2, null, [match(5, 0.8), match(6, 0.79)])).toMatchObject({ id: 5, source: 'icon-low' })
    expect(combineSlotRecognition(2, null, [match(5, 0.7)])).toBeNull()
    expect(combineSlotRecognition(2, null, [])).toBeNull()
  })
})
