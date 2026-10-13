/** Where a camera's embedded preview sits inside a JPEG, plus what is needed to show it upright. */
export interface ExifThumb {
  /** Byte range of the embedded JPEG within the buffer that was parsed. */
  offset: number
  length: number
  /** EXIF orientation 1–8 of the main image; the preview is stored the same way round. */
  orientation: number
  /** Stored size of the main image, if recorded: tells letterbox bars in the preview apart from the picture. */
  width?: number | undefined
  height?: number | undefined
}

const SOI = 0xffd8
const APP1 = 0xffe1
const SOS = 0xffda
const EXIF = 0x45786966 // "Exif"

/**
 * Find the preview a camera embeds in a JPEG's EXIF block. `buf` only needs to hold the start of the
 * file (EXIF is capped at 64 KiB and comes before the image data). Null when there is none.
 */
export function findExifThumb(buf: ArrayBuffer): ExifThumb | null {
  const v = new DataView(buf)
  if (v.byteLength < 4 || v.getUint16(0) !== SOI) return null
  let p = 2
  while (p + 4 <= v.byteLength) {
    const marker = v.getUint16(p)
    if ((marker & 0xff00) !== 0xff00 || marker === SOS) return null
    const len = v.getUint16(p + 2)
    if (marker === APP1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === EXIF && v.getUint16(p + 8) === 0) {
      return parseTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len))
    }
    p += 2 + len
  }
  return null
}

function parseTiff(v: DataView, tiff: number, end: number): ExifThumb | null {
  // Byte order, magic and the IFD0 offset: 8 bytes before anything else can be read.
  if (end - tiff < 8) return null
  const order = v.getUint16(tiff)
  if (order !== 0x4949 && order !== 0x4d4d) return null
  const le = order === 0x4949
  const fits = (off: number, n: number) => off >= 0 && tiff + off + n <= end
  const u16 = (off: number) => v.getUint16(tiff + off, le)
  const u32 = (off: number) => v.getUint32(tiff + off, le)

  /** SHORT and LONG tags of one IFD, and the offset of the next IFD (0 when last). */
  const readIfd = (off: number): { tags: Map<number, number>; next: number } | null => {
    if (!fits(off, 2)) return null
    const n = u16(off)
    if (!fits(off + 2, n * 12 + 4)) return null
    const tags = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      const type = u16(e + 2)
      if (type === 3) tags.set(u16(e), u16(e + 8))
      else if (type === 4) tags.set(u16(e), u32(e + 8))
    }
    return { tags, next: u32(off + 2 + n * 12) }
  }

  const ifd0 = readIfd(u32(4))
  if (!ifd0?.next) return null
  const ifd1 = readIfd(ifd0.next)
  if (!ifd1) return null
  const compression = ifd1.tags.get(0x0103)
  const offset = ifd1.tags.get(0x0201)
  const length = ifd1.tags.get(0x0202)
  if ((compression !== undefined && compression !== 6) || !offset || !length || !fits(offset, length)) return null

  const exifIfd = ifd0.tags.get(0x8769)
  const exif = exifIfd ? readIfd(exifIfd)?.tags : undefined
  const orientation = ifd0.tags.get(0x0112) ?? 1
  return {
    offset: tiff + offset,
    length,
    orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
    width: exif?.get(0xa002),
    height: exif?.get(0xa003),
  }
}
