import type { ViewerItem } from '../state/media'
import { logger } from '../state/log'
import { inertBlob } from '../transfer/protocol'
import { shrinkInWorker, WorkerStopped } from './shrinkWorker'
import { drawSquare } from './square'

const L = logger('thumb')

/** Edge of the square thumbnail bitmap: covers the largest Thumb (48 px) at up to ~2.7x density. */
const EDGE = 128
/** A job may decode one photo or open one video; two at a time keeps memory flat when 100 are picked at once. */
const PARALLEL = 2
/** Thumbnails kept once nothing shows them (each holds a small object URL), least recently used dropped first. */
export const CACHE_SIZE = 400
/**
 * Photos bigger than this are never decoded in full: decoding one stalls phones. The worker can still
 * use an EXIF preview they carry; the main-thread fallback can't, so there they get an icon.
 */
const DECODE_MAX_BYTES = 30 * 1024 * 1024
/** A video that hasn't produced a frame by now gets an icon for now (stalled read, busy device). */
export const VIDEO_TIMEOUT_MS = 10_000
/**
 * Strikes before a file gets an icon for good: a worker died while decoding it, or a video stalled.
 * Once can be bad luck; twice is the file, and every retry would cost a worker or a slot for 10 s.
 */
export const MAX_STRIKES = 2

/** An icon for now, but not remembered: the next request tries again (read failed, video stalled, worker resting). */
const LATER = Symbol('later')
/** The worker died under the job: it goes back in line. */
const RETRY = Symbol('retry')

/** A thumbnail's object URL; null when this file can't have one; or LATER / RETRY. */
type Outcome = string | null | typeof LATER | typeof RETRY

/** `later`: no picture for now (LATER), so asking again another time may get one. */
type Listener = (url: string | null, later: boolean) => void

/**
 * A finished thumbnail. Kept apart from its item so the cache never holds an item, and with it the
 * received file its `blob()` reads from. `url` is null when the file can't have one. Cached while in
 * `lru`; once out of it (evicted, or found broken) it is never handed out again.
 */
interface Entry {
  url: string | null
  /** Thumbs showing it right now; an entry on screen is never revoked, or its <img> would break. */
  holds: number
}

type Waiter = (entry: Entry, later: boolean) => void

const thumbnails = new WeakMap<ViewerItem, Entry>()
/** Every cached entry, least recently used first. */
const lru = new Set<Entry>()
/** Requested but not started, oldest first. Only on-screen thumbs are in here: the rest withdraw. */
const queued = new Map<ViewerItem, Set<Waiter>>()
const running = new Map<ViewerItem, Set<Waiter>>()
const strikes = new WeakMap<ViewerItem, number>()

/** Count a strike against `item`; true once it has run out. */
function strike(item: ViewerItem): boolean {
  const n = (strikes.get(item) ?? 0) + 1
  strikes.set(item, n)
  return n >= MAX_STRIKES
}

/** The centred square of `source`, drawn at EDGE px and encoded small. */
function encodeSquare(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = EDGE
  if (!drawSquare(canvas.getContext('2d')!, source, { width, height }, EDGE)) return Promise.resolve(null)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
}

/** Main-thread fallback for when the worker can't draw (none here, or no OffscreenCanvas). Decodes at full size, once. */
async function shrinkHere(blob: Blob, type: string): Promise<Blob | null> {
  if (blob.size > DECODE_MAX_BYTES) return null
  const src = URL.createObjectURL(inertBlob(blob, type))
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    return await encodeSquare(img, img.naturalWidth, img.naturalHeight)
  } finally {
    URL.revokeObjectURL(src)
  }
}

async function shrinkImage(blob: Blob, type: string): Promise<Blob | null | typeof LATER> {
  const reply = await shrinkInWorker({ blob, edge: EDGE, decodeMax: DECODE_MAX_BYTES })
  // The worker kept dying, most likely short on memory: a full-size decode here would be next to go.
  if (reply === 'resting') return LATER
  if (reply === 'none') return shrinkHere(blob, type)
  if ('blob' in reply) return reply.blob
  if (reply.error === 'canvas') return shrinkHere(blob, type)
  // Too big, or a format this browser can't decode: <img> couldn't either (HEIC on Chrome), so don't try.
  return null
}

/**
 * One frame of a video, drawn small. Workers have no <video>, so this runs on the main thread, but
 * the browser never reads the whole file to show one frame: a 2 GB file costs about the same as 20 MB.
 */
function videoFrame(blob: Blob, type: string): Promise<Blob | null | typeof LATER> {
  return new Promise((resolve) => {
    const src = URL.createObjectURL(inertBlob(blob, type))
    const video = document.createElement('video')
    let settled = false
    const finish = (out: Blob | null | typeof LATER) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(src)
      resolve(out)
    }
    const timer = setTimeout(() => finish(LATER), VIDEO_TIMEOUT_MS)
    video.muted = true
    video.playsInline = true
    // 'auto', not 'metadata': the frame after the seek has to be decoded, not just the header. The
    // element is unloaded the moment that frame is drawn, so it never buffers far past it.
    video.preload = 'auto'
    // Fires for a codec or container this browser can't play: that won't change, so it is an icon for good.
    video.onerror = () => finish(null)
    // A second in (or a tenth of a short clip) skips the black frame many videos open on.
    video.onloadedmetadata = () => {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 10) : 0.001
    }
    // Through a promise, so a throw while drawing (no canvas memory) is an icon, not a 10 s stall.
    video.onseeked = () => {
      Promise.resolve()
        .then(() => encodeSquare(video, video.videoWidth, video.videoHeight))
        .then(finish, () => finish(null))
    }
    video.src = src
  })
}

async function makeThumbnail(item: ViewerItem): Promise<Outcome> {
  let blob: Blob
  try {
    blob = await item.blob()
  } catch (err) {
    // The bytes may be back next time (a busy disk, a sink mid-write); nothing about the file is known yet.
    L.debug('no bytes for thumbnail', { name: item.name, err: err instanceof Error ? err.message : String(err) })
    return LATER
  }
  try {
    if (item.kind === 'video') {
      const frame = await videoFrame(blob, item.type)
      if (frame !== LATER) return frame && URL.createObjectURL(frame)
      return strike(item) ? null : LATER
    }
    const small = await shrinkImage(blob, item.type)
    return small instanceof Blob ? URL.createObjectURL(small) : small
  } catch (err) {
    if (err instanceof WorkerStopped) {
      if (!err.culprit || !strike(item)) return RETRY
      L.warn('photo keeps killing the thumbnail worker; icon instead', { name: item.name })
      return null
    }
    L.debug('no thumbnail', { name: item.name, err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function touch(entry: Entry) {
  lru.delete(entry)
  lru.add(entry)
}

/** Drop the least recently used entries nothing is showing, until the cache is back to size. */
function trim() {
  for (const entry of lru) {
    if (lru.size <= CACHE_SIZE) return
    if (entry.holds) continue
    lru.delete(entry)
    if (entry.url) URL.revokeObjectURL(entry.url)
  }
}

/** Cache an answer for `item`, least recently used last. */
function remember(item: ViewerItem, url: string | null): Entry {
  const entry: Entry = { url, holds: 0 }
  thumbnails.set(item, entry)
  lru.add(entry)
  return entry
}

function finished(item: ViewerItem, waiters: Set<Waiter>, outcome: Outcome) {
  running.delete(item)
  if (outcome === RETRY) {
    // Nothing is cached, and whoever still wants it goes back in line for the replacement worker.
    if (waiters.size) queued.set(item, waiters)
    return
  }
  const later = outcome === LATER
  const entry = later ? { url: null, holds: 0 } : remember(item, outcome)
  for (const w of waiters) {
    try {
      w(entry, later)
    } catch (err) {
      // One listener's problem is not the next one's, and the line keeps moving either way.
      L.warn('thumbnail listener threw', err)
    }
  }
}

function startNext() {
  while (running.size < PARALLEL && queued.size) {
    const [item, waiters] = queued.entries().next().value!
    queued.delete(item)
    running.set(item, waiters)
    void makeThumbnail(item).then((outcome) => {
      finished(item, waiters, outcome)
      trim()
      startNext()
    })
  }
}

/**
 * Ask for a small square thumbnail of a photo or video; `onReady` gets its object URL, or null when it
 * can't be shown, with `later` when that is only for now. Call the returned function when the thumb no
 * longer wants it: a request that has not started yet is dropped, so whatever is on screen now is next
 * in line, and a delivered URL may be revoked from then on (so only call it once it is no longer shown).
 *
 * Handing a 12 MP photo straight to a 40 px <img> makes the browser decode it at full size, and again
 * every time it falls out of the decoded-image cache, which is what made long lists stutter.
 */
export function requestThumbnail(item: ViewerItem, onReady: Listener): () => void {
  let held: Entry | null = null
  const take: Waiter = (entry, later) => {
    if (entry.url) {
      held = entry
      entry.holds++
    }
    onReady(entry.url, later)
  }
  const release = () => {
    if (!held) return
    // Out of the cache while shown (found broken): the last Thumb to let go revokes it.
    if (!--held.holds && !lru.has(held)) URL.revokeObjectURL(held.url!)
    held = null
    trim()
  }

  const hit = thumbnails.get(item)
  if (hit && lru.has(hit)) {
    touch(hit)
    take(hit, false)
    return release
  }
  const waiters = running.get(item) ?? queued.get(item) ?? new Set<Waiter>()
  waiters.add(take)
  if (!running.has(item)) queued.set(item, waiters)
  startNext()
  return () => {
    waiters.delete(take)
    if (!waiters.size && queued.get(item) === waiters) queued.delete(item)
    release()
  }
}

/**
 * An <img> could not show `url`: from now on `item` gets an icon instead of the same broken picture.
 * Thumbs still showing it keep it until they let go.
 */
export function thumbnailBroken(item: ViewerItem, url: string): void {
  const entry = thumbnails.get(item)
  if (!entry || entry.url !== url || !lru.has(entry)) return
  lru.delete(entry)
  if (!entry.holds) URL.revokeObjectURL(url)
  remember(item, null)
}
