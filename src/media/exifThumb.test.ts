import { describe, expect, it } from 'vitest'
import { findExifThumb } from './exifThumb'

/** A JPEG header with an EXIF block: IFD0 (orientation, Exif IFD pointer), Exif IFD (size), IFD1 (preview). */
function jpegWithExif(opts: { le: boolean; orientation?: number; size?: [number, number]; thumb: number[] }): ArrayBuffer {
  const { le } = opts
  const tiff: number[] = []
  const u16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255])
  const u32 = (n: number) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])
  const entry = (tag: number, type: number, value: number) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(value), 0, 0] : u32(value))]
  const ifd = (entries: number[][], next: number) => [...u16(entries.length), ...entries.flat(), ...u32(next)]

  const ifd0At = 8
  const ifd0Len = 2 + 2 * 12 + 4
  const exifAt = ifd0At + ifd0Len
  const exifLen = 2 + 2 * 12 + 4
  const ifd1At = exifAt + exifLen
  const ifd1Len = 2 + 3 * 12 + 4
  const thumbAt = ifd1At + ifd1Len
  const [w, h] = opts.size ?? [4032, 3024]
  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0At))
  tiff.push(...ifd([entry(0x0112, 3, opts.orientation ?? 1), entry(0x8769, 4, exifAt)], ifd1At))
  tiff.push(...ifd([entry(0xa002, 4, w), entry(0xa003, 3, h)], 0))
  tiff.push(...ifd([entry(0x0103, 3, 6), entry(0x0201, 4, thumbAt), entry(0x0202, 4, opts.thumb.length)], 0))
  tiff.push(...opts.thumb)

  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const jfif = [0xff, 0xe0, 0, 4, 0, 0]
  const bytes = [0xff, 0xd8, ...jfif, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2]
  return new Uint8Array(bytes).buffer
}

describe('findExifThumb', () => {
  for (const le of [true, false]) {
    it(`finds the preview, orientation and size (${le ? 'Intel' : 'Motorola'} byte order)`, () => {
      const thumb = [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]
      const buf = jpegWithExif({ le, orientation: 6, size: [4000, 2250], thumb })
      const t = findExifThumb(buf)!
      expect(t).toMatchObject({ orientation: 6, width: 4000, height: 2250, length: thumb.length })
      expect([...new Uint8Array(buf, t.offset, t.length)]).toEqual(thumb)
    })
  }

  it('says no for files without a preview, or that are not JPEG', () => {
    expect(findExifThumb(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull()
    expect(findExifThumb(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull()
  })

  it('says no when the preview runs past the bytes read', () => {
    const buf = jpegWithExif({ le: true, thumb: [0xff, 0xd8, 0xff, 0xd9] })
    expect(findExifThumb(buf.slice(0, buf.byteLength - 8))).toBeNull()
  })
})

describe('findExifThumb on a head that stops inside the EXIF block', () => {
  it('says no instead of reading past the buffer', () => {
    const buf = jpegWithExif({ le: true, thumb: [0xff, 0xd8, 0xff, 0xd9] })
    // Cut at every length from the APP1 marker onwards: a truncated header, IFD or preview.
    for (let n = 8; n < buf.byteLength; n++) expect(() => findExifThumb(buf.slice(0, n))).not.toThrow()
    expect(findExifThumb(buf.slice(0, 8 + 10))).toBeNull()
    expect(findExifThumb(buf.slice(0, 8 + 10 + 7))).toBeNull()
  })
})
