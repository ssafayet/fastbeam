/** What a picture source holds, so the same crop can be drawn from an ImageBitmap, an <img> or a <video>. */
export interface Picture {
  /** Size of the source in its own pixels. */
  width: number
  height: number
  /**
   * The picture inside the source, when bars surround it: a 16:9 photo's EXIF preview is often 160x120
   * with black bands. Same aspect as the real photo, centred in the source. Default: all of it.
   */
  inner?: { width: number; height: number } | undefined
  /** EXIF orientation 1–8 the source is stored in; the drawing comes out upright. Default 1. */
  orientation?: number | undefined
}

/** Quarter turns (radians) and axis flips that bring each EXIF orientation upright. */
const TURN = [0, 0, 0, Math.PI, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2, -Math.PI / 2]
const FLIP = [[1, 1], [1, 1], [-1, 1], [1, 1], [1, -1], [1, -1], [1, 1], [-1, 1], [1, 1]]

/**
 * Draw the centred square of a picture over the whole of an `edge` x `edge` context, upright. A square
 * crop keeps its centre, so every orientation is a turn or a flip about it. False when there is nothing
 * to draw (an empty source).
 */
export function drawSquare(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  pic: Picture,
  edge: number,
): boolean {
  const inner = pic.inner ?? pic
  const side = Math.min(inner.width, inner.height)
  if (!(side > 0)) return false
  const o = pic.orientation && pic.orientation >= 1 && pic.orientation <= 8 ? pic.orientation : 1
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(edge / 2, edge / 2)
  ctx.rotate(TURN[o]!)
  ctx.scale(FLIP[o]![0]!, FLIP[o]![1]!)
  ctx.drawImage(source, (pic.width - side) / 2, (pic.height - side) / 2, side, side, -edge / 2, -edge / 2, edge, edge)
  return true
}
