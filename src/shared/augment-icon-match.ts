/**
 * 海克斯卡片图标匹配（纯函数，无 Electron / sharp 依赖）。
 *
 * 流程：
 *  1. 按与 OCR 相同的卡片布局比例（宽度 16.8%、间距 1.75%、三卡居中）定位每张卡的图标区域；
 *     所有几何都是相对比例，因此与分辨率/缩放无关。
 *  2. 对图标区域做面积平均降采样到 32×32，得到描述子：
 *     - 灰度图零均值单位范数向量（用于归一化互相关 NCC，抗亮度/对比度变化）；
 *     - 4×4 网格的色度（R−G、B−G），区分同图形不同稀有度（白银/黄金/棱彩配色不同）；
 *     - 64 位 dHash（9×8 灰度相邻差分），用于汉明距离。
 *  3. 每张卡生成若干位置/缩放微调变体（容忍几像素偏移与 UI 缩放误差），与官方图标库逐一比较，
 *     取每个海克斯在所有变体上的最高分。
 *  4. 与 OCR 结果合并：图标高置信且领先第二名足够多时以图标为准；否则用 OCR，图标作交叉校验。
 */

export const ICON_SAMPLE_SIZE = 32
const DHASH_WIDTH = 9
const DHASH_HEIGHT = 8
const COLOR_GRID = 4

/** 官方图标合成时使用的卡面背景色（从 1080p 实机截图采样） */
export const CARD_ICON_BACKGROUND = { r: 12, g: 24, b: 24 }

/**
 * 图标区域几何（相对单张卡宽度 / 屏幕高度），用 tests/fixtures/augment-ocr 下的 1080p 实机截图标定。
 * centerX：相对卡片左边缘 / 卡宽；centerY：相对屏幕高度；size：边长 / 卡宽。
 */
export const ICON_GEOMETRY = {
  centerX: 0.5,
  centerY: 0.275,
  size: 0.52,
}

export const ICON_SEARCH_SCALES = [0.9, 1, 1.1]
export const ICON_SEARCH_SHIFTS = [-0.05, 0, 0.05]

export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  /** 3 = RGB，4 = RGBA（必须是 RGB 顺序） */
  channels: number
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface IconDescriptor {
  gray: number[]
  chroma: number[]
  dhash: string
}

export interface IconIndexEntry {
  id: number | string
  name: string
  iconPath?: string | null
  rarity?: number | string | null
  descriptor: IconDescriptor
}

export interface IconMatch {
  id: number | string
  name: string
  iconPath?: string | null
  rarity?: number | string | null
  score: number
  ncc: number
  colorSimilarity: number
  hamming: number
}

/** 与 image-analyzer.ts 的 createCardLayout 保持一致 */
export function createAugmentCardLayout(width: number, height: number) {
  const cardWidth = width * 0.168
  const cardGap = width * 0.0175
  const groupWidth = cardWidth * 3 + cardGap * 2
  const groupLeft = (width - groupWidth) / 2
  return { cardWidth, cardGap, groupWidth, groupLeft, height }
}

export function createIconRegions(width: number, height: number, geometry = ICON_GEOMETRY): Rect[] {
  const { cardWidth, cardGap, groupLeft } = createAugmentCardLayout(width, height)
  return [0, 1, 2].map((index) => {
    const cardLeft = groupLeft + index * (cardWidth + cardGap)
    const size = cardWidth * geometry.size
    const centerX = cardLeft + cardWidth * geometry.centerX
    const centerY = height * geometry.centerY
    return { left: centerX - size / 2, top: centerY - size / 2, width: size, height: size }
  })
}

/** 生成位置/缩放微调后的候选区域 */
export function createRegionVariants(rect: Rect, scales = ICON_SEARCH_SCALES, shifts = ICON_SEARCH_SHIFTS): Rect[] {
  const variants: Rect[] = []
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  for (const scale of scales) {
    const size = rect.width * scale
    for (const dy of shifts) {
      for (const dx of shifts) {
        variants.push({
          left: centerX + dx * rect.width - size / 2,
          top: centerY + dy * rect.height - size / 2,
          width: size,
          height: size,
        })
      }
    }
  }
  return variants
}

/**
 * 面积平均降采样：把 rect 区域缩放到 size×size，返回 RGB float 数组（0..255）。
 * 区域超出图像的部分按背景色处理。
 */
export function sampleRegion(image: RawImage, rect: Rect, size = ICON_SAMPLE_SIZE, background = CARD_ICON_BACKGROUND): Float32Array {
  const out = new Float32Array(size * size * 3)
  const { data, width, height, channels } = image
  const cellW = rect.width / size
  const cellH = rect.height / size
  // 每个输出像素最多取 4×4 个采样点，避免大区域时过慢
  const steps = Math.max(1, Math.min(4, Math.round(Math.min(cellW, cellH))))
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sy = 0; sy < steps; sy++) {
        const y = Math.floor(rect.top + (oy + (sy + 0.5) / steps) * cellH)
        for (let sx = 0; sx < steps; sx++) {
          const x = Math.floor(rect.left + (ox + (sx + 0.5) / steps) * cellW)
          if (x < 0 || y < 0 || x >= width || y >= height) {
            r += background.r
            g += background.g
            b += background.b
          } else {
            const offset = (y * width + x) * channels
            r += data[offset]
            g += data[offset + 1]
            b += data[offset + 2]
          }
          count++
        }
      }
      const index = (oy * size + ox) * 3
      out[index] = r / count
      out[index + 1] = g / count
      out[index + 2] = b / count
    }
  }
  return out
}

function boxDownsample(values: ArrayLike<number>, size: number, outW: number, outH: number): number[] {
  const out: number[] = []
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * size) / outH)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * size) / outH))
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * size) / outW)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * size) / outW))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += values[y * size + x]
          count++
        }
      }
      out.push(sum / count)
    }
  }
  return out
}

export function computeDescriptor(rgb: ArrayLike<number>, size = ICON_SAMPLE_SIZE): IconDescriptor {
  const pixelCount = size * size
  const gray = new Float32Array(pixelCount)
  const rg = new Float32Array(pixelCount)
  const bg = new Float32Array(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
    rg[i] = r - g
    bg[i] = b - g
  }

  let mean = 0
  for (let i = 0; i < pixelCount; i++) mean += gray[i]
  mean /= pixelCount
  let norm = 0
  const centered: number[] = new Array(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const value = gray[i] - mean
    centered[i] = value
    norm += value * value
  }
  norm = Math.sqrt(norm) || 1
  const normalizedGray = centered.map((value) => Number((value / norm).toFixed(5)))

  const rgGrid = boxDownsample(rg, size, COLOR_GRID, COLOR_GRID)
  const bgGrid = boxDownsample(bg, size, COLOR_GRID, COLOR_GRID)
  const chroma: number[] = []
  for (let i = 0; i < COLOR_GRID * COLOR_GRID; i++) {
    chroma.push(Number((rgGrid[i] / 255).toFixed(4)), Number((bgGrid[i] / 255).toFixed(4)))
  }

  const small = boxDownsample(gray, size, DHASH_WIDTH, DHASH_HEIGHT)
  let bits = ''
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      bits += small[y * DHASH_WIDTH + x] > small[y * DHASH_WIDTH + x + 1] ? '1' : '0'
    }
  }
  let dhash = ''
  for (let i = 0; i < bits.length; i += 4) {
    dhash += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }

  return { gray: normalizedGray, chroma, dhash }
}

export function hammingDistance(a: string, b: string): number {
  let distance = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      distance += x & 1
      x >>= 1
    }
  }
  return distance + Math.abs(a.length - b.length) * 4
}

export function compareDescriptors(a: IconDescriptor, b: IconDescriptor) {
  let ncc = 0
  const length = Math.min(a.gray.length, b.gray.length)
  for (let i = 0; i < length; i++) ncc += a.gray[i] * b.gray[i]

  let chromaDistance = 0
  const chromaLength = Math.min(a.chroma.length, b.chroma.length)
  for (let i = 0; i < chromaLength; i++) {
    const diff = a.chroma[i] - b.chroma[i]
    chromaDistance += diff * diff
  }
  chromaDistance = Math.sqrt(chromaDistance / Math.max(1, chromaLength))
  // 色度差 0.1（约 25/255）时相似度约 0.37
  const colorSimilarity = Math.exp(-chromaDistance / 0.1)
  const hamming = hammingDistance(a.dhash, b.dhash)
  const hashSimilarity = 1 - hamming / 64
  const score = 0.6 * Math.max(0, ncc) + 0.25 * colorSimilarity + 0.15 * hashSimilarity
  return { score, ncc, colorSimilarity, hamming }
}

/** 对一张卡的多个变体描述子，与图标库比较，返回前 topN（每个海克斯取所有变体中的最高分） */
export function matchIconVariants(variants: IconDescriptor[], index: IconIndexEntry[], topN = 5): IconMatch[] {
  const results: IconMatch[] = []
  for (const entry of index) {
    let best: ReturnType<typeof compareDescriptors> | null = null
    for (const variant of variants) {
      const comparison = compareDescriptors(variant, entry.descriptor)
      if (!best || comparison.score > best.score) best = comparison
    }
    if (best) {
      results.push({
        id: entry.id,
        name: entry.name,
        iconPath: entry.iconPath ?? null,
        rarity: entry.rarity ?? null,
        score: Number(best.score.toFixed(4)),
        ncc: Number(best.ncc.toFixed(4)),
        colorSimilarity: Number(best.colorSimilarity.toFixed(4)),
        hamming: best.hamming,
      })
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topN)
}

export function describeSlotVariants(image: RawImage, rect: Rect): IconDescriptor[] {
  return createRegionVariants(rect).map((variant) => computeDescriptor(sampleRegion(image, variant)))
}

/** 卡片区域是否像是有图标（避免在非三选一画面上硬匹配）：灰度方差足够大 */
export function regionHasContent(image: RawImage, rect: Rect): boolean {
  const rgb = sampleRegion(image, rect, 16)
  let mean = 0
  const grays: number[] = []
  for (let i = 0; i < 256; i++) {
    const gray = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]
    grays.push(gray)
    mean += gray
  }
  mean /= 256
  let variance = 0
  for (const gray of grays) variance += (gray - mean) ** 2
  return Math.sqrt(variance / 256) > 12
}

// ---------------------------------------------------------------------------
// 与 OCR 合并

export interface SlotOcrResult {
  id: number | string
  name: string
  iconPath?: string | null
  rarity?: number | string | null
  confidence?: number | null
}

export interface RecognitionAlternative {
  id: number | string
  name: string
  iconPath?: string | null
  rarity?: number | string | null
  score: number | null
  source: 'icon' | 'ocr'
}

export interface CombinedSlotResult {
  slot: number
  id: number | string
  name: string
  iconPath?: string | null
  rarity?: number | string | null
  source: 'icon' | 'ocr' | 'icon+ocr' | 'icon-low'
  confidence: number
  iconScore: number | null
  alternatives: RecognitionAlternative[]
}

export interface CombineThresholds {
  /** 图标单独决定所需的最低分 */
  iconConfident: number
  /** 图标第一名领先第二名的最小差距 */
  iconMargin: number
  /** OCR 失败时仍可作为「待确认」结果的最低分 */
  iconFallback: number
}

export const DEFAULT_COMBINE_THRESHOLDS: CombineThresholds = {
  // 用 1080p/810p/1440p 实机截图标定：正确图标 0.85~0.91，空白/不在库中的卡 ≤ 0.72
  iconConfident: 0.84,
  iconMargin: 0.04,
  iconFallback: 0.78,
}

export function combineSlotRecognition(
  slot: number,
  ocr: SlotOcrResult | null,
  iconMatches: IconMatch[],
  thresholds: CombineThresholds = DEFAULT_COMBINE_THRESHOLDS,
): CombinedSlotResult | null {
  const top = iconMatches[0] ?? null
  const second = iconMatches[1] ?? null
  const margin = top ? top.score - (second?.score ?? 0) : 0
  const iconConfident = !!top && top.score >= thresholds.iconConfident && margin >= thresholds.iconMargin

  const alternatives: RecognitionAlternative[] = []
  const pushAlternative = (alt: RecognitionAlternative) => {
    if (!alternatives.some((existing) => String(existing.id) === String(alt.id))) alternatives.push(alt)
  }
  if (ocr) pushAlternative({ id: ocr.id, name: ocr.name, iconPath: ocr.iconPath ?? null, rarity: ocr.rarity ?? null, score: ocr.confidence ?? null, source: 'ocr' })
  for (const match of iconMatches) {
    pushAlternative({ id: match.id, name: match.name, iconPath: match.iconPath ?? null, rarity: match.rarity ?? null, score: match.score, source: 'icon' })
  }

  const iconScoreOf = (id: number | string) =>
    iconMatches.find((match) => String(match.id) === String(id))?.score ?? null

  // OCR 结果与图标第一名一致，或与第一名同分（不少海克斯共用同一张通用图标）→ 互相印证
  const ocrIconScore = ocr ? iconScoreOf(ocr.id) : null
  if (ocr && top && ocrIconScore != null && ocrIconScore >= thresholds.iconFallback &&
    top.score - ocrIconScore <= 0.005) {
    return { slot, ...ocr, source: 'icon+ocr', confidence: 0.99, iconScore: ocrIconScore, alternatives }
  }
  if (iconConfident && top) {
    // 图标很确定，但 OCR 给了别的结果：以图标为准（OCR 常把相似字形认错），OCR 结果保留为候选
    return {
      slot,
      id: top.id,
      name: top.name,
      iconPath: top.iconPath ?? null,
      rarity: top.rarity ?? null,
      source: 'icon',
      confidence: Math.min(0.97, top.score),
      iconScore: top.score,
      alternatives,
    }
  }
  if (ocr) {
    return {
      slot,
      ...ocr,
      source: 'ocr',
      confidence: ocrIconScore != null && ocrIconScore >= thresholds.iconFallback
        ? Math.max(ocr.confidence ?? 0.8, 0.9)
        : (ocr.confidence ?? 0.8),
      iconScore: ocrIconScore,
      alternatives,
    }
  }
  if (top && top.score >= thresholds.iconFallback) {
    return {
      slot,
      id: top.id,
      name: top.name,
      iconPath: top.iconPath ?? null,
      rarity: top.rarity ?? null,
      source: 'icon-low',
      confidence: top.score * 0.8,
      iconScore: top.score,
      alternatives,
    }
  }
  return null
}
