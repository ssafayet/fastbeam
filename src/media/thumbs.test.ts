import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewerItem } from '../state/media'
import type { ThumbJob, ThumbReply, WorkerMessage } from './thumb.worker'

/**
 * How the fake treats each job as it reaches the front of its line. `shrink` / `big`: starts it and
 * answers. `manual`: starts it; the test answers. `hang`: starts it, never answers. `dead`: never starts
 * it (a worker that never booted, or was killed while idle).
 */
type Answer = 'shrink' | 'big' | 'hang' | 'manual' | 'dead'

/** Stands in for thumb.worker.ts: one job at a time, `started` before each answer, as `FakeWorker.answer` says. */
class FakeWorker {
  static all: FakeWorker[] = []
  static answer: Answer = 'shrink'
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: (() => void) | null = null
  jobs: ThumbJob[] = []
  /** Posted and not yet answered, oldest first: the first is the one being worked on. */
  private line: ThumbJob[] = []
  terminated = false
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(job: ThumbJob) {
    this.jobs.push(job)
    this.line.push(job)
    if (this.line.length === 1) this.begin()
  }
  private begin() {
    const job = this.line[0]
    const answer = FakeWorker.answer
    if (!job || answer === 'dead') return
    queueMicrotask(() => {
      this.send({ started: job.id })
      if (answer === 'shrink') this.reply({ id: job.id, blob: new Blob(['t']) })
      else if (answer === 'big') this.reply({ id: job.id, error: 'big' })
    })
  }
  reply(data: ThumbReply) {
    this.line = this.line.filter((j) => j.id !== data.id)
    this.send(data)
    this.begin()
  }
  private send(data: WorkerMessage) {
    this.onmessage?.({ data } as MessageEvent<WorkerMessage>)
  }
  terminate() {
    this.terminated = true
  }
}

function image(name: string, blob: () => Promise<Blob> = async () => new Blob(['x'], { type: 'image/jpeg' })): ViewerItem {
  return { name, size: 1, type: 'image/jpeg', kind: 'image', blob }
}

/** Image items whose bytes arrive only when the test says so. */
function gated(n: number) {
  const started: string[] = []
  const release = new Map<string, () => void>()
  const list = Array.from({ length: n }, (_, i) =>
    image(`IMG_${i}.jpg`, () => {
      started.push(`IMG_${i}.jpg`)
      return new Promise((r) => release.set(`IMG_${i}.jpg`, () => r(new Blob(['x'], { type: 'image/jpeg' }))))
    }),
  )
  return { list, started, release: (i: number) => release.get(`IMG_${i}.jpg`)!() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** What a Thumb is told: a URL, an icon for good (null), or an icon for now ('later'). */
const told = (url: string | null, later: boolean) => (later ? 'later' : url)

describe('requestThumbnail', () => {
  let requestThumbnail: typeof import('./thumbs').requestThumbnail
  let thumbnailBroken: typeof import('./thumbs').thumbnailBroken
  let CACHE_SIZE: number
  let MAX_STRIKES: number
  let VIDEO_TIMEOUT_MS: number
  let WORKER_TIMEOUT_MS: number
  let MAX_WORKER_DEATHS: number
  let WORKER_PAUSE_MS: number

  beforeEach(async () => {
    let n = 0
    FakeWorker.all = []
    FakeWorker.answer = 'shrink'
    vi.stubGlobal('Worker', FakeWorker)
    URL.createObjectURL = vi.fn(() => `blob:${++n}`)
    URL.revokeObjectURL = vi.fn()
    // Fresh modules per test: the worker, its death count and the cache are module state.
    vi.resetModules()
    ;({ requestThumbnail, thumbnailBroken, CACHE_SIZE, MAX_STRIKES, VIDEO_TIMEOUT_MS } = await import('./thumbs'))
    ;({ WORKER_TIMEOUT_MS, MAX_WORKER_DEATHS, WORKER_PAUSE_MS } = await import('./shrinkWorker'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('drops requests that scrolled away before starting, so what is on screen goes next', async () => {
    const { list, started, release } = gated(6)
    const cancel = list.map((it) => requestThumbnail(it, () => {}))
    expect(started).toEqual(['IMG_0.jpg', 'IMG_1.jpg'])
    // Fling past 2 and 3; 4 and 5 are what is on screen now.
    cancel[2]!()
    cancel[3]!()
    release(0)
    release(1)
    await flush()
    expect(started).toEqual(['IMG_0.jpg', 'IMG_1.jpg', 'IMG_4.jpg', 'IMG_5.jpg'])
    release(4)
    release(5)
    await flush()
  })

  it('makes each thumbnail once and shares it', async () => {
    const { list, started, release } = gated(1)
    const got: (string | null)[] = []
    requestThumbnail(list[0]!, (u) => got.push(u))
    requestThumbnail(list[0]!, (u) => got.push(u))
    release(0)
    await flush()
    requestThumbnail(list[0]!, (u) => got.push(u))
    expect(started).toEqual(['IMG_0.jpg'])
    expect(got).toEqual(['blob:1', 'blob:1', 'blob:1'])
  })

  it('never revokes a thumbnail that is on screen; drops the oldest once nothing shows it', async () => {
    const list = Array.from({ length: CACHE_SIZE + 1 }, (_, i) => image(`IMG_${i}.jpg`))
    const release = list.map((it) => requestThumbnail(it, () => {}))
    await flush()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    for (const r of release) r()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })

  it('keeps the line moving when a listener throws', async () => {
    const { list, started, release } = gated(3)
    requestThumbnail(list[0]!, () => {
      throw new Error('render failed')
    })
    requestThumbnail(list[1]!, () => {})
    requestThumbnail(list[2]!, () => {})
    release(0)
    await flush()
    expect(started).toEqual(['IMG_0.jpg', 'IMG_1.jpg', 'IMG_2.jpg'])
    release(1)
    release(2)
    await flush()
  })

  it('times a photo from the worker\'s last answer, not from when it was posted behind another', async () => {
    vi.useFakeTimers()
    const got: (string | null)[] = []
    FakeWorker.answer = 'manual'
    requestThumbnail(image('IMG_0.jpg'), (u) => got.push(u))
    requestThumbnail(image('IMG_1.jpg'), (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    const w = FakeWorker.all[0]!
    const [a, b] = w.jobs
    expect(b).toBeDefined()
    // What a real worker does: the second job only starts once the first is answered, 15 s in.
    await vi.advanceTimersByTimeAsync(15_000)
    w.reply({ id: a!.id, blob: new Blob(['a']) })
    // 25 s after posting but 10 s into its own decode: not hung.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.terminated).toBe(false)
    w.reply({ id: b!.id, blob: new Blob(['b']) })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual(['blob:1', 'blob:2'])
  })

  it('gives a photo too big to decode an icon, and remembers that', async () => {
    FakeWorker.answer = 'big'
    const item = image('PANO.jpg')
    const got: (string | null)[] = []
    requestThumbnail(item, (u) => got.push(u))
    await flush()
    requestThumbnail(item, (u) => got.push(u))
    expect(got).toEqual([null, null])
    expect(FakeWorker.all[0]!.jobs).toHaveLength(1)
  })

  it('replaces a worker that never answers (killed, or never booted) and retries its photos on the new one', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'hang'
    const got: (string | null)[] = []
    requestThumbnail(image('IMG_0.jpg'), (u) => got.push(u))
    requestThumbnail(image('IMG_1.jpg'), (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    FakeWorker.answer = 'shrink'
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS - 1)
    expect(FakeWorker.all[0]!.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWorker.all[0]!.terminated).toBe(true)
    // Nobody was told "no": both photos were posted again, to a fresh worker, and came through.
    expect(FakeWorker.all).toHaveLength(2)
    expect(FakeWorker.all[1]!.jobs.map((j) => j.blob)).toHaveLength(2)
    expect(got).toEqual(['blob:1', 'blob:2'])
  })

  it('gives the next hung photo no extra time just because new work arrived', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'manual'
    requestThumbnail(image('IMG_0.jpg'), () => {})
    await vi.advanceTimersByTimeAsync(15_000)
    requestThumbnail(image('IMG_1.jpg'), () => {})
    await vi.advanceTimersByTimeAsync(0)
    const w = FakeWorker.all[0]!
    expect(w.jobs).toHaveLength(2)
    // Silent since the first post: hung at 20 s, however recently the second job was posted.
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS - 15_000)
    expect(w.terminated).toBe(true)
  })

  it('does not blame a photo for the time the tab was asleep', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'hang'
    requestThumbnail(image('IMG_0.jpg'), () => {})
    await vi.advanceTimersByTimeAsync(0)
    // Phone locked: the clock moves on, but no timer runs.
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(FakeWorker.all[0]!.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(FakeWorker.all[0]!.terminated).toBe(true)
  })

  it('gives up on a photo that keeps killing the worker, without decoding it on the main thread', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'hang'
    const got: (string | null)[] = []
    const item = image('IMG_0.jpg')
    requestThumbnail(item, (u) => got.push(u))
    for (let i = 0; i < MAX_STRIKES; i++) await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(FakeWorker.all).toHaveLength(MAX_STRIKES)
    expect(got).toEqual([null])
    // Remembered: asking again posts nothing.
    requestThumbnail(item, (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual([null, null])
    expect(FakeWorker.all.flatMap((w) => w.jobs)).toHaveLength(MAX_STRIKES)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('rests a worker that keeps dying: icons meanwhile, not remembered, and no main-thread decode', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'hang'
    const got: Record<string, (string | null)[]> = { a: [], b: [] }
    const a = image('IMG_0.jpg')
    const b = image('IMG_1.jpg')
    requestThumbnail(a, (u, later) => got.a!.push(told(u, later)))
    requestThumbnail(b, (u, later) => got.b!.push(told(u, later)))
    for (let i = 0; i < MAX_WORKER_DEATHS; i++) await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(FakeWorker.all).toHaveLength(MAX_WORKER_DEATHS)
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
    // `a` was decoding when two workers died: an icon for good. `b` was decoding once, then met the
    // resting worker: an icon for now.
    expect(got).toEqual({ a: [null], b: ['later'] })

    FakeWorker.answer = 'shrink'
    requestThumbnail(b, (u, later) => got.b!.push(told(u, later)))
    await vi.advanceTimersByTimeAsync(0)
    expect(got.b).toEqual(['later', 'later'])
    expect(FakeWorker.all).toHaveLength(MAX_WORKER_DEATHS)
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WORKER_PAUSE_MS)
    requestThumbnail(b, (u, later) => got.b!.push(told(u, later)))
    requestThumbnail(a, (u, later) => got.a!.push(told(u, later)))
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWorker.all).toHaveLength(MAX_WORKER_DEATHS + 1)
    expect(FakeWorker.all[MAX_WORKER_DEATHS]!.jobs).toHaveLength(1)
    expect(got).toEqual({ a: [null, null], b: ['later', 'later', 'blob:1'] })
  })

  it('shrinks photos on the main thread for good when no worker ever starts', async () => {
    vi.useFakeTimers()
    FakeWorker.answer = 'dead'
    const got: (string | null)[] = []
    requestThumbnail(image('IMG_0.jpg'), (u) => got.push(u))
    for (let i = 0; i < MAX_WORKER_DEATHS; i++) await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWorker.all).toHaveLength(MAX_WORKER_DEATHS)
    // Not blamed on the photo: it went to the main thread, where jsdom's <img> can't decode, so an icon.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(got).toEqual([null])

    await vi.advanceTimersByTimeAsync(WORKER_PAUSE_MS)
    requestThumbnail(image('IMG_1.jpg'), (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWorker.all).toHaveLength(MAX_WORKER_DEATHS)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('does not blame a photo for a worker that died while idle', async () => {
    vi.useFakeTimers()
    const got: (string | null)[] = []
    requestThumbnail(image('IMG_0.jpg'), (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    // Killed between jobs: the next photo is posted but never started.
    FakeWorker.answer = 'dead'
    const photo = image('IMG_1.jpg')
    requestThumbnail(photo, (u) => got.push(u))
    await vi.advanceTimersByTimeAsync(0)
    FakeWorker.answer = 'hang'
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    // The second worker really did die on it: one strike, not two, so it still gets its turn.
    FakeWorker.answer = 'shrink'
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS)
    expect(FakeWorker.all).toHaveLength(3)
    expect(got).toEqual(['blob:1', 'blob:2'])
  })

  it('gives a video that stalls twice an icon for good', async () => {
    vi.useFakeTimers()
    // jsdom plays no media: every video stalls until the timeout.
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const reads = vi.fn(async () => new Blob(['v'], { type: 'video/mp4' }))
    const clip: ViewerItem = { name: 'clip.mp4', size: 1, type: 'video/mp4', kind: 'video', blob: reads }
    const got: (string | null)[] = []
    for (let i = 0; i < MAX_STRIKES; i++) {
      requestThumbnail(clip, (u, later) => got.push(told(u, later)))
      await vi.advanceTimersByTimeAsync(VIDEO_TIMEOUT_MS)
    }
    expect(got).toEqual(['later', null])
    requestThumbnail(clip, (u, later) => got.push(told(u, later)))
    await vi.advanceTimersByTimeAsync(VIDEO_TIMEOUT_MS)
    expect(got).toEqual(['later', null, null])
    expect(reads).toHaveBeenCalledTimes(MAX_STRIKES)
  })

  it('tries again next time when the bytes could not be read', async () => {
    let fail = true
    const item = image('IMG_0.jpg', async () => {
      if (fail) throw new Error('busy')
      return new Blob(['x'], { type: 'image/jpeg' })
    })
    const got: (string | null)[] = []
    requestThumbnail(item, (u, later) => got.push(told(u, later)))
    await flush()
    expect(got).toEqual(['later'])
    fail = false
    requestThumbnail(item, (u, later) => got.push(told(u, later)))
    await flush()
    expect(got).toEqual(['later', 'blob:1'])
  })

  it('gives an icon instead of a thumbnail an <img> could not show, and revokes it once let go', async () => {
    const item = image('IMG_0.jpg')
    const got: (string | null)[] = []
    const shown = requestThumbnail(item, (u) => got.push(u))
    await flush()
    thumbnailBroken(item, 'blob:1')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    requestThumbnail(item, (u) => got.push(u))
    expect(got).toEqual(['blob:1', null])
    expect(FakeWorker.all[0]!.jobs).toHaveLength(1)
    shown()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })
})
