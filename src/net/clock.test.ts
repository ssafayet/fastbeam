import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvent, subscribe } from 'trystero/nostr'

const reconnectRelays = vi.fn()
vi.mock('./relays', () => ({ reconnectRelays }))

const { measureClockOffset, syncSignalingClock } = await import('./clock')

type ClockGlobal = typeof globalThis & { __fastbeamClockOffsetMs?: number }

/** A server whose Date header reads `serverMs` (truncated to whole seconds, like a real one). */
function serverAt(serverMs: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { headers: { date: new Date(Math.floor(serverMs / 1000) * 1000).toUTCString() } })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  reconnectRelays.mockClear()
  delete (globalThis as ClockGlobal).__fastbeamClockOffsetMs
})

describe('measureClockOffset', () => {
  it('reports a clock running 40 s ahead as a negative offset, to within a second', async () => {
    serverAt(Date.now() - 40_000)
    const offset = await measureClockOffset()
    expect(offset).not.toBeNull()
    expect(Math.abs(offset! + 40_000)).toBeLessThan(1_000)
  })

  it('gives up without a Date header or when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    expect(await measureClockOffset()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await measureClockOffset()).toBeNull()
  })
})

describe('syncSignalingClock', () => {
  it('corrects a skewed clock and reconnects the relays', async () => {
    serverAt(Date.now() + 30_000)
    await syncSignalingClock()
    expect((globalThis as ClockGlobal).__fastbeamClockOffsetMs).toBeGreaterThan(29_000)
    expect(reconnectRelays).toHaveBeenCalledOnce()
  })

  it('leaves a good clock alone', async () => {
    serverAt(Date.now())
    await syncSignalingClock()
    expect((globalThis as ClockGlobal).__fastbeamClockOffsetMs).toBeUndefined()
    expect(reconnectRelays).not.toHaveBeenCalled()
  })
})

// Guards patches/@trystero-p2p+nostr+*.patch: if a reinstall drops it, these fail.
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
