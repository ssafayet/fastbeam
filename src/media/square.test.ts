import { describe, expect, it, vi } from 'vitest'
import { drawSquare } from './square'

function fakeCtx() {
  return { imageSmoothingQuality: 'low', translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn() }
}
const src = {} as CanvasImageSource

describe('drawSquare', () => {
  it('crops the centred square of a landscape picture to the whole edge', () => {
    const ctx = fakeCtx()
    expect(drawSquare(ctx as never, src, { width: 400, height: 300 }, 128)).toBe(true)
    expect(ctx.drawImage).toHaveBeenCalledWith(src, 50, 0, 300, 300, -64, -64, 128, 128)
    expect(ctx.rotate).toHaveBeenCalledWith(0)
    expect(ctx.scale).toHaveBeenCalledWith(1, 1)
  })

  it('takes the square from the picture inside letterbox bars, centred on the source', () => {
    const ctx = fakeCtx()
    drawSquare(ctx as never, src, { width: 160, height: 120, inner: { width: 160, height: 90 } }, 128)
    expect(ctx.drawImage).toHaveBeenCalledWith(src, 35, 15, 90, 90, -64, -64, 128, 128)
  })

  it('turns an orientation-6 (90° CW) picture upright and treats anything else as upright', () => {
    const ctx = fakeCtx()
    drawSquare(ctx as never, src, { width: 100, height: 100, orientation: 6 }, 64)
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2)
    const plain = fakeCtx()
    drawSquare(plain as never, src, { width: 100, height: 100, orientation: 42 }, 64)
    expect(plain.rotate).toHaveBeenCalledWith(0)
  })

  it('draws nothing for an empty source', () => {
    const ctx = fakeCtx()
    expect(drawSquare(ctx as never, src, { width: 0, height: 50 }, 64)).toBe(false)
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })
})
