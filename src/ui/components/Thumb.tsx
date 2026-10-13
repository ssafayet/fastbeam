import { useEffect, useRef, useState } from 'preact/hooks'
import { requestThumbnail, thumbnailBroken } from '../../media/thumbs'
import type { ViewerItem } from '../../state/media'
import { ImageIcon, VideoIcon } from './Icons'

/**
 * Small lazy thumbnail for a media item; used in the gallery strip, the Done list and the Send sheet.
 * Nothing is requested until the placeholder scrolls into view, so a fling through a long list only
 * decodes what the user stops on. A delivered picture is kept until the Thumb unmounts: the cache
 * never revokes a URL an <img> still shows, so its size cap only bites once a list closes.
 */
export function Thumb({ item, size = 48 }: { item: ViewerItem; size?: number }) {
  // Which item the answer is for: when a reused Thumb gets a new item, the old picture never shows.
  const [got, setGot] = useState<{ item: ViewerItem; url: string | null; later: boolean } | null>(null)
  // Which item was on screen: a reused Thumb asks for its new item only once that one is seen too.
  const [seen, setSeen] = useState<ViewerItem | null>(null)
  const holder = useRef<HTMLSpanElement>(null)
  const answer = got?.item === item ? got : null
  /** undefined: still waiting; null: can't be shown, so an icon. */
  const url = answer ? answer.url : undefined
  // Waiting, or an icon only for now (worker resting, a stalled read): once it has left the screen and
  // comes back, it is asked for again. Never straight away, or a resting worker would be asked in a loop.
  const watching = !answer || answer.later
  // Latched once a lasting answer is in: scrolling away then must not let the cache revoke what is shown.
  const wanted = seen === item || !watching

  // Watch the placeholder until something lasting is showing in its place.
  useEffect(() => {
    const el = holder.current
    if (!watching || !el) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(item)
      return
    }
    const io = new IntersectionObserver((entries) => setSeen(entries[entries.length - 1]!.isIntersecting ? item : null))
    io.observe(el)
    return () => io.disconnect()
  }, [item, watching])

  useEffect(() => {
    if (!wanted) return
    // Scrolling away before the request starts withdraws it; unmounting lets the cache drop the URL.
    const release = requestThumbnail(item, (u, later) => setGot({ item, url: u, later }))
    return () => {
      release()
      // Its URL is no longer held, so it may be revoked: never show it again, even if this item comes back.
      // A for-now icon goes too, so coming back into view asks again.
      setGot((g) => (g?.item === item ? null : g))
    }
  }, [item, wanted])

  const style = { width: size, height: size }
  if (typeof url === 'string') {
    const broken = () => {
      thumbnailBroken(item, url)
      setGot({ item, url: null, later: false })
    }
    return <img class="thumb" style={style} src={url} alt="" decoding="async" onError={broken} />
  }
  // One element for the placeholder and the icon, so the observer keeps watching across a for-now icon.
  return (
    <span ref={holder} class={url === null ? 'thumb thumb--icon' : 'thumb thumb--empty'} style={style} aria-hidden="true">
      {url === null && (item.kind === 'video' ? <VideoIcon /> : <ImageIcon />)}
    </span>
  )
}
