import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestThumbnail, thumbnailBroken } from '../../media/thumbs'
import type { ViewerItem } from '../../state/media'
import { Thumb } from './Thumb'

vi.mock('../../media/thumbs', () => ({ requestThumbnail: vi.fn(), thumbnailBroken: vi.fn() }))

/** Stands in for IntersectionObserver: the test says when the placeholder is on screen. */
class FakeObserver {
  static last: FakeObserver | null = null
  constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.last = this
  }
  observe() {}
  disconnect() {}
  show(on: boolean) {
    act(() => this.cb([{ isIntersecting: on }]))
  }
}

const item = (name: string): ViewerItem => ({ name, size: 1, type: 'image/jpeg', kind: 'image', blob: async () => new Blob() })

describe('Thumb', () => {
  let root: HTMLElement
  /** The listener of each requestThumbnail call, by item name. */
  let deliver: Map<string, (url: string | null, later: boolean) => void>

  beforeEach(() => {
    root = document.createElement('div')
    deliver = new Map()
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    vi.mocked(requestThumbnail).mockReset()
    vi.mocked(requestThumbnail).mockImplementation((it, onReady) => {
      deliver.set(it.name, onReady)
      return () => {}
    })
    vi.mocked(thumbnailBroken).mockReset()
  })
  afterEach(() => {
    render(null, root)
    vi.unstubAllGlobals()
  })

  const show = (it: ViewerItem) => act(() => render(h(Thumb, { item: it }), root))
  const requested = () => vi.mocked(requestThumbnail).mock.calls.map(([it]) => it.name)

  it('asks for a reused Thumb\'s new item only once that one is on screen', () => {
    const a = item('a.jpg')
    const b = item('b.jpg')
    show(a)
    FakeObserver.last!.show(true)
    act(() => deliver.get('a.jpg')!('blob:a', false))
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:a')

    show(b)
    expect(root.querySelector('img')).toBeNull()
    expect(requested()).toEqual(['a.jpg'])
    FakeObserver.last!.show(false)
    expect(requested()).toEqual(['a.jpg'])
    FakeObserver.last!.show(true)
    expect(requested()).toEqual(['a.jpg', 'b.jpg'])
  })

  it('keeps showing what arrived, even if a late callback says it scrolled away', () => {
    const release = vi.fn()
    vi.mocked(requestThumbnail).mockImplementation((it, onReady) => {
      deliver.set(it.name, onReady)
      return release
    })
    show(item('a.jpg'))
    const observer = FakeObserver.last!
    observer.show(true)
    act(() => deliver.get('a.jpg')!('blob:a', false))
    observer.show(false)
    expect(release).not.toHaveBeenCalled()
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:a')
    render(null, root)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('never shows a picture it let go of, when its item comes back', () => {
    const a = item('a.jpg')
    show(a)
    FakeObserver.last!.show(true)
    act(() => deliver.get('a.jpg')!('blob:a', false))
    show(item('b.jpg'))
    show(a)
    // blob:a may have been revoked meanwhile: a placeholder until the cache answers again.
    expect(root.querySelector('img')).toBeNull()
    FakeObserver.last!.show(true)
    expect(requested()).toEqual(['a.jpg', 'a.jpg'])
  })

  it('reports a picture its <img> could not show, and shows the icon', () => {
    const a = item('a.jpg')
    show(a)
    FakeObserver.last!.show(true)
    act(() => deliver.get('a.jpg')!('blob:a', false))
    act(() => {
      root.querySelector('img')!.dispatchEvent(new Event('error'))
    })
    expect(thumbnailBroken).toHaveBeenCalledWith(a, 'blob:a')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('.thumb--icon')).not.toBeNull()
  })

  it('asks again for an icon that was only for now, once it has left the screen and come back', () => {
    show(item('a.jpg'))
    const observer = FakeObserver.last!
    observer.show(true)
    act(() => deliver.get('a.jpg')!(null, true))
    expect(root.querySelector('.thumb--icon')).not.toBeNull()
    // Still on screen: no asking again straight away, or a resting worker would be asked in a loop.
    observer.show(true)
    expect(requested()).toEqual(['a.jpg'])
    observer.show(false)
    expect(root.querySelector('.thumb--icon')).toBeNull()
    observer.show(true)
    expect(requested()).toEqual(['a.jpg', 'a.jpg'])
    act(() => deliver.get('a.jpg')!('blob:a', false))
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:a')
  })

  it('keeps an icon that is for good, without asking again', () => {
    show(item('a.jpg'))
    const observer = FakeObserver.last!
    observer.show(true)
    act(() => deliver.get('a.jpg')!(null, false))
    observer.show(false)
    observer.show(true)
    expect(requested()).toEqual(['a.jpg'])
    expect(root.querySelector('.thumb--icon')).not.toBeNull()
  })
})
