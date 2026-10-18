import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { analyzeScreenshot, detectAugmentRerollButtons } from '../../src/main/image-analyzer.ts'

describe('image analyzer raw RGBA input (manual capture path)', () => {
  it('gives the same reroll-button gate result for raw RGBA and PNG input', async () => {
    const png = readFileSync('docs/demo1.png')
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const raw = { buffer: data, width: info.width, height: info.height, channels: info.channels }
    const fromPng = await detectAugmentRerollButtons(png)
    const fromRaw = await detectAugmentRerollButtons(raw)
    expect(fromRaw.visible).toBe(true)
    expect(fromRaw.activeSlots).toEqual(fromPng.activeSlots)
  })

  it('accepts raw input in analyzeScreenshot without PNG decoding', async () => {
    const width = 320
    const height = 180
    const raw = { buffer: Buffer.alloc(width * height * 4, 0), width, height, channels: 4 }
    const result = await analyzeScreenshot(raw)
    expect(result.success).toBe(true)
    expect(result.metadata).toMatchObject({ sourceType: 'raw', format: 'raw', bufferSize: width * height * 4 })
    expect(result.analysis.augments).toEqual([])
  })

  it('still rejects empty input', async () => {
    expect((await analyzeScreenshot(Buffer.alloc(0))).success).toBe(false)
    expect((await analyzeScreenshot(null)).success).toBe(false)
  })
})
