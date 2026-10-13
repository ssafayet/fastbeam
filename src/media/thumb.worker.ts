/// <reference lib="webworker" />
import { findExifThumb } from './exifThumb'
import { drawSquare, type Picture } from './square'

declare const self: DedicatedWorkerGlobalScope

/** EXIF is at most 64 KiB and sits near the start; this covers it plus a JFIF header or two. */
const HEAD_BYTES = 128 * 1024
/**
 * Pixel decodes are asked for at this many times the edge in width. Up to a 3:1 panorama the short
 * side still covers the edge either way round, and a browser that can decode scaled never builds the
 * full-size bitmap.
 */
const DECODE_WIDTH_FACTOR = 3

export interface ThumbJob {
  id: number
  blob: Blob
  edge: number
  /** Files over this size only get a thumbnail from their EXIF preview, never a full decode. */
  decodeMax: number
}

/**
 * `big`: over decodeMax with no EXIF preview. `decode`: this browser can't decode the format (HEIC on
 * Chrome). `canvas`: no OffscreenCanvas here (Safari < 16.4), so nothing was decoded; the main thread can.
 */
export type ThumbReply = { id: number; blob: Blob } | { id: number; error: 'big' | 'decode' | 'canvas' }

/** Everything the worker posts: `started` as it begins each job, then that job's answer. */
export type WorkerMessage = ThumbReply | { started: number }

function square(bmp: ImageBitmap, edge: number, pic: Omit<Picture, 'width' | 'height'> = {}): OffscreenCanvas {
  try {
    const canvas = new OffscreenCanvas(edge, edge)
    if (!drawSquare(canvas.getContext('2d')!, bmp, { width: bmp.width, height: bmp.height, ...pic }, edge)) throw new Error('empty image')
    return canvas
  } finally {
    bmp.close()
  }
}

/** The camera's own preview, if the file has one big enough: a few KB to decode instead of 12 MP. */
async function fromExif(blob: Blob, edge: number): Promise<OffscreenCanvas | null> {
  const head = await blob.slice(0, HEAD_BYTES).arrayBuffer()
  const t = findExifThumb(head)
  if (!t) return null
  const bmp = await createImageBitmap(new Blob([new Uint8Array(head, t.offset, t.length)], { type: 'image/jpeg' }))
  // A 16:9 photo's preview is often 160x120 with black bars; crop to the picture inside them.
  let w = bmp.width
  let h = bmp.height
  if (t.width && t.height) {
    const r = t.width / t.height
    if (r > w / h) h = w / r
    else w = h * r
  }
  if (Math.min(w, h) < edge / 2) {
    bmp.close()
    return null
  }
  return square(bmp, edge, { inner: { width: w, height: h }, orientation: t.orientation })
}

async function fromPixels(blob: Blob, edge: number): Promise<OffscreenCanvas> {
  const bmp = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    resizeWidth: edge * DECODE_WIDTH_FACTOR,
    resizeQuality: 'high',
  })
  return square(bmp, edge)
}

/** OffscreenCanvas with a 2D context: Safari 16.0–16.3 has the class but no 2D drawing on it. */
function canDraw(): boolean {
  try {
    return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d')
  } catch {
    return false
  }
}
const CAN_DRAW = canDraw()

async function shrink({ id, blob, edge, decodeMax }: ThumbJob): Promise<ThumbReply> {
  // Checked before any decode: without a canvas the pixels would only be thrown away.
  if (!CAN_DRAW) return { id, error: 'canvas' }
  try {
    let canvas = await fromExif(blob, edge).catch(() => null)
    if (!canvas) {
      if (blob.size > decodeMax) return { id, error: 'big' }
      canvas = await fromPixels(blob, edge)
    }
    // Safari has no WebP encoder and quietly gives PNG instead, which is fine at this size.
    return { id, blob: await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }) }
  } catch {
    return { id, error: 'decode' }
  }
}

// One decode at a time: two full-size photos in flight at once is what runs a phone out of memory.
let line = Promise.resolve()

/** Decode a picked or received image off the main thread and hand back a small square crop of it. */
self.onmessage = (e: MessageEvent<ThumbJob>) => {
  const { id } = e.data
  line = line
    .then(async () => {
      // Said first, so a death from here to the answer is blamed on this photo and no other.
      self.postMessage({ started: id } satisfies WorkerMessage)
      self.postMessage(await shrink(e.data))
    })
    // Every job gets an answer, and `line` never stays rejected: that would skip every job after it.
    .catch(() => self.postMessage({ id, error: 'decode' } satisfies ThumbReply))
    .catch(() => {})
}
