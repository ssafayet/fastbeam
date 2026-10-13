import { signal } from '@preact/signals'
import type { SavedFile } from '../transfer/sinks'

export type MediaKind = 'image' | 'video'

export interface ViewerItem {
  name: string
  size: number
  type: string
  kind: MediaKind
  /** Resolve the bytes on demand so the gallery never holds everything at once. */
  blob: () => Promise<Blob>
}

export const viewer = signal<{ items: ViewerItem[]; index: number } | null>(null)

// No svg: it can script, so it is never previewed on our origin (see inertType).
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif)$/i
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|3gp)$/i

export function mediaKind(type: string, name: string): MediaKind | null {
  if (type.startsWith('image/')) return type.startsWith('image/svg') ? null : 'image'
  if (type.startsWith('video/')) return 'video'
  if (IMAGE_EXT.test(name)) return 'image'
  if (VIDEO_EXT.test(name)) return 'video'
  return null
}

/** Something the gallery can show: a picked File, or a received file the sink can still read back. */
export type GallerySource = File | SavedFile

// Same source, same item: thumbnails and the viewer cache by item, so a fresh one would decode again.
// Weak: once the File or the finished transfer is dropped, its item and the bytes it reads go too.
const sourceItems = new WeakMap<GallerySource, ViewerItem | null>()

/** The gallery item for a file, or null when it isn't a photo or video (or its bytes are gone). */
export function mediaItem(src: GallerySource): ViewerItem | null {
  let item = sourceItems.get(src)
  if (item === undefined) {
    const kind = mediaKind(src.type, src.name)
    const blob = src instanceof File ? async () => src : src.blob
    item = kind && blob ? { name: src.name, size: src.size, type: src.type, kind, blob } : null
    sourceItems.set(src, item)
  }
  return item
}

export function itemsFromFiles(files: File[]): ViewerItem[] {
  return files.map(mediaItem).filter((it): it is ViewerItem => !!it)
}

export function openViewer(items: ViewerItem[], index = 0): void {
  if (!items.length) return
  viewer.value = { items, index: Math.max(0, Math.min(index, items.length - 1)) }
}

export function closeViewer(): void {
  viewer.value = null
}
