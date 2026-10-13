import { describe, expect, it } from 'vitest'
import type { SavedFile } from '../transfer/sinks'
import { itemsFromFiles, mediaItem, mediaKind } from './media'

describe('mediaKind', () => {
  it('never previews SVG, which can run script', () => {
    expect(mediaKind('image/svg+xml', 'logo.svg')).toBeNull()
    expect(mediaKind('', 'logo.svg')).toBeNull()
  })

  it('falls back to the extension when the type is missing', () => {
    expect(mediaKind('', 'IMG_1.HEIC')).toBe('image')
    expect(mediaKind('', 'clip.mov')).toBe('video')
  })
})

describe('mediaItem', () => {
  it('returns the same item for the same File, so thumbnails are not rebuilt', () => {
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.mp4', { type: 'video/mp4' })
    const doc = new File(['c'], 'c.pdf', { type: 'application/pdf' })
    const first = itemsFromFiles([a, doc, b])
    expect(first.map((it) => it.kind)).toEqual(['image', 'video'])
    expect(itemsFromFiles([b, a])).toEqual([first[1], first[0]])
    expect(mediaItem(b)).toBe(first[1])
    expect(mediaItem(doc)).toBeNull()
  })

  it('returns the same item for the same received file, and none once the sink has no bytes', () => {
    const saved: SavedFile = { name: 'a.jpg', size: 1, type: 'image/jpeg', blob: async () => new Blob(['a']) }
    const gone: SavedFile = { name: 'b.jpg', size: 1, type: 'image/jpeg' }
    expect(mediaItem(saved)).toBe(mediaItem(saved))
    expect(mediaItem(saved)?.blob).toBe(saved.blob)
    expect(mediaItem(gone)).toBeNull()
  })
})
