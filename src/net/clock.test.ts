import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvent, subscribe } from 'trystero/nostr'

const reconnectRelays = vi.fn()
vi.mock('./relays', () => ({ reconnectRelays }))

type ClockModule = typeof import('./clock')
type ClockGlobal = typeof globalThis & { __fastbeamClockOffsetMs?: number }
const offsetNow = () => (globalThis as ClockGlobal).__fastbeamClockOffsetMs

let clock: ClockModule
/** How far this device's clock runs ahead of the server's. */
let ahead = 0
let serverDown = false

beforeEach(async () => {
  vi.resetModules()
  clock = await import('./clock')
  ahead = 0
  serverDown = false
  // The server's Date header: true time, truncated to whole seconds like a real one.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (serverDown) throw new TypeError('offline')
      const date = new Date(Math.floor((Date.now() - ahead) / 1000) * 1000).toUTCString()
      return new Response(null, { headers: { date } })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  reconnectRelays.mockClear()
  delete (globalThis as ClockGlobal).__fastbeamClockOffsetMs
})

describe('measureClockOffset', () => {
  it('reports a clock running 40 s ahead as a negative offset, to within a second', async () => {
    ahead = 40_000
    const offset = await clock.measureClockOffset()
    expect(Math.abs(offset! + 40_000)).toBeLessThan(1_000)
  })

  it('gives up without a Date header or when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    expect(await clock.measureClockOffset()).toBeNull()
    serverDown = true
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await clock.measureClockOffset()).toBeNull()
  })
})

describe('syncClock', () => {
  it('leaves a good clock alone', async () => {
    await clock.syncClock('test')
    expect(offsetNow()).toBeUndefined()
    expect(reconnectRelays).not.toHaveBeenCalled()
  })

  it('corrects a skewed clock, and removes the correction once the clock is fixed', async () => {
    ahead = -30_000
    await clock.syncClock('test')
    expect(offsetNow()).toBeGreaterThan(29_000)
    expect(reconnectRelays).toHaveBeenCalledTimes(1)

    ahead = 0
    await clock.syncClock('test')
    expect(offsetNow()).toBeUndefined()
    expect(reconnectRelays).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect the relays for measurement noise', async () => {
    ahead = -30_000
    await clock.syncClock('test')
    ahead = -30_800
    await clock.syncClock('test')
    expect(reconnectRelays).toHaveBeenCalledTimes(1)
  })
})

describe('initClockSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  })

  it('measures again when the wall clock jumps while the app is open', async () => {
    clock.initClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(offsetNow()).toBeUndefined()

    // The clock is set 45 s ahead (or slept and resynced); the monotonic clock does not move with it.
    vi.setSystemTime(Date.now() + 45_000)
    ahead = 45_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(offsetNow()).toBeLessThan(-44_000)
    expect(reconnectRelays).toHaveBeenCalledOnce()
  })

  it('retries a measurement that failed at startup', async () => {
    ahead = 60_000
    serverDown = true
    clock.initClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(offsetNow()).toBeUndefined()

    serverDown = false
    await vi.advanceTimersByTimeAsync(15_000)
    expect(offsetNow()).toBeLessThan(-59_000)
  })
})

// Guards patches/@trystero-p2p+nostr+*.patch: if a reinstall drops it, this fails.
describe('patched Trystero signaling time', () => {
  it('stamps events and filters subscriptions with the corrected clock, looking back 15 s', async () => {
    ;(globalThis as ClockGlobal).__fastbeamClockOffsetMs = 120_000
    const corrected = Math.floor((Date.now() + 120_000) / 1000)

    const [, , filter] = JSON.parse(subscribe('sub', 'topic')) as [string, string, { since: number }]
    expect(filter.since).toBeGreaterThanOrEqual(corrected - 15)
    expect(filter.since).toBeLessThanOrEqual(corrected - 14)

    const [, event] = JSON.parse(await createEvent('topic', '{}')) as [string, { created_at: number }]
    expect(event.created_at).toBeGreaterThanOrEqual(corrected)
    expect(event.created_at).toBeLessThanOrEqual(corrected + 1)
  })
})
