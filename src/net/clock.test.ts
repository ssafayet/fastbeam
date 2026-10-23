import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvent, subscribe } from 'trystero/nostr'

const reconnectRelays = vi.fn()
vi.mock('./relays', () => ({ reconnectRelays }))

type ClockModule = typeof import('./clock')
type ClockGlobal = typeof globalThis & { __fastbeamClockOffsetMs?: number }
const offsetNow = () => (globalThis as ClockGlobal).__fastbeamClockOffsetMs

let clock: ClockModule
/** How far this device's clock runs ahead of true time. */
let ahead = 0
/** What each source does: answer with true time, fail, or (Akamai) answer with junk. */
let akamai: 'up' | 'down' | 'junk' = 'up'
let server: 'up' | 'down' = 'up'
/** How far behind true time our server's Date header is (a cache serving a stale Date). */
let serverLag = 0

beforeEach(async () => {
  vi.resetModules()
  clock = await import('./clock')
  ahead = 0
  akamai = 'up'
  server = 'up'
  serverLag = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const truth = Date.now() - ahead
      if (url.startsWith('https://time.akamai.com/')) {
        if (akamai === 'down') throw new TypeError('blocked')
        return new Response(akamai === 'junk' ? '<html>captive portal</html>' : new Date(truth).toISOString())
      }
      if (server === 'down') throw new TypeError('offline')
      // Whole seconds, like a real Date header.
      const date = new Date(Math.floor((truth - serverLag) / 1000) * 1000).toUTCString()
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
  it('reads a clock running 40 s ahead from Akamai, to within a few ms', async () => {
    ahead = 40_000
    const reading = await clock.measureClockOffset()
    expect(reading?.source).toBe('akamai')
    expect(Math.abs(reading!.offsetMs + 40_000)).toBeLessThan(50)
  })

  it('prefers Akamai over a server Date a cache has left 5 minutes stale', async () => {
    serverLag = 5 * 60_000
    const reading = await clock.measureClockOffset()
    expect(reading?.source).toBe('akamai')
    expect(Math.abs(reading!.offsetMs)).toBeLessThan(50)
  })

  it('falls back to our server when Akamai is blocked or answers with junk', async () => {
    ahead = 40_000
    for (const state of ['down', 'junk'] as const) {
      akamai = state
      const reading = await clock.measureClockOffset()
      expect(reading?.source).toBe('server')
      expect(Math.abs(reading!.offsetMs + 40_000)).toBeLessThan(1_000)
    }
  })

  it('gives up when neither can be reached', async () => {
    akamai = 'down'
    server = 'down'
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
    akamai = 'down'
    server = 'down'
    clock.initClockSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(offsetNow()).toBeUndefined()

    akamai = 'up'
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
