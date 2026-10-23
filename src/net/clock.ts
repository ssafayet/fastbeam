/**
 * Signaling clock.
 *
 * Nostr relays forward an event to a subscription only if the event's timestamp (the sender's clock) is
 * not older than the subscription's "since" (the listener's clock). A device whose clock runs ahead never
 * hears the replies to its own first announces and only meets others at Trystero's next one-minute
 * announce; one that lags is not heard right after others subscribe. Windows clocks drift by tens of
 * seconds. We measure this device's offset against our own server's Date header and hand it to the patched
 * Trystero (patches/@trystero-p2p+nostr+*.patch), which stamps and filters with the corrected time.
 */
import { CLOCK_CORRECT_MIN_MS, CLOCK_MAX_RTT_MS } from '../config'
import { logger } from '../state/log'
import { reconnectRelays } from './relays'

const L = logger('clock')

type ClockGlobal = typeof globalThis & { __fastbeamClockOffsetMs?: number }

/** Server time minus this device's time in ms, or null when it cannot be measured well. */
export async function measureClockOffset(): Promise<number | null> {
  try {
    const sent = Date.now()
    // A file the service worker does not precache, with a fresh query so no cache answers for the server.
    const res = await fetch(`/robots.txt?clock=${sent}`, { method: 'HEAD', cache: 'no-store' })
    const received = Date.now()
    const header = res.headers.get('date')
    const server = header ? Date.parse(header) : NaN
    if (!Number.isFinite(server) || received - sent > CLOCK_MAX_RTT_MS) return null
    // The header has whole seconds, so the server's time was somewhere in [server, server + 1 s).
    return Math.round(server + 500 - (sent + received) / 2)
  } catch {
    return null
  }
}

/**
 * Measure once at startup. A clock off by CLOCK_CORRECT_MIN_MS or more is corrected for signaling, and the
 * relays are reconnected so their subscriptions start again from the corrected time.
 */
export async function syncSignalingClock(): Promise<void> {
  const offset = await measureClockOffset()
  if (offset === null) {
    L.debug('could not measure the clock; signaling uses it as is')
    return
  }
  const seconds = Math.abs(offset / 1000).toFixed(1)
  if (Math.abs(offset) < CLOCK_CORRECT_MIN_MS) {
    L.info(`clock is within ${seconds} s of the server`)
    return
  }
  ;(globalThis as ClockGlobal).__fastbeamClockOffsetMs = offset
  // A positive offset means the server is later than us, i.e. this device's clock is behind.
  L.warn(`this device's clock is ${seconds} s ${offset > 0 ? 'behind' : 'ahead'}; signaling uses corrected time`)
  reconnectRelays('clock corrected')
}
