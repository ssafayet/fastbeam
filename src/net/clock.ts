/**
 * Signaling clock.
 *
 * Nostr relays forward an event to a subscription only if the event's timestamp (the sender's clock) is
 * not older than the subscription's "since" (the listener's clock). A device whose clock runs ahead never
 * hears the replies to its own first announces and only meets others at Trystero's next one-minute
 * announce; one that lags is not heard right after others subscribe. Windows clocks drift by tens of
 * seconds. We measure this device's offset against our own server's Date header and hand it to the patched
 * Trystero (patches/@trystero-p2p+nostr+*.patch), which stamps and filters with the corrected time.
 * The time comes from Akamai's time service; our own server's Date header is the fallback.
 *
 * The offset is measured at startup and again when the clock may have changed under us: a skewed clock is
 * exactly the kind that gets snapped back, often on wake from sleep, and a stale correction would then put
 * it just as far out the other way.
 */
import {
  CLOCK_CHECK_MS,
  CLOCK_CORRECT_MIN_MS,
  CLOCK_MAX_RTT_MS,
  CLOCK_RETRIES,
  CLOCK_RETRY_MS,
  CLOCK_TIME_TIMEOUT_MS,
  CLOCK_TIME_URL,
} from '../config'
import { logger } from '../state/log'
import { reconnectRelays } from './relays'

const L = logger('clock')

type ClockGlobal = typeof globalThis & { __fastbeamClockOffsetMs?: number }

/** The correction Trystero is using now (0 = none). */
let applied = 0
let measured = false
let running: Promise<void> | null = null

export interface ClockReading {
  /** True time minus this device's time, in ms. */
  offsetMs: number
  source: 'akamai' | 'server'
}

/** Anything before this is not a real answer from a time source. */
const EARLIEST_PLAUSIBLE = Date.UTC(2026, 0, 1)

/** Time a request; null unless it completed within CLOCK_MAX_RTT_MS. */
async function timed<T>(request: () => Promise<T>): Promise<{ value: T; sent: number; received: number } | null> {
  const sent = Date.now()
  const value = await request()
  const received = Date.now()
  return received - sent > CLOCK_MAX_RTT_MS ? null : { value, sent, received }
}

/** Akamai answers with an ISO timestamp in milliseconds, made for this request. */
async function fromAkamai(): Promise<ClockReading | null> {
  try {
    const r = await timed(async () => {
      const res = await fetch(CLOCK_TIME_URL, { cache: 'no-store', signal: AbortSignal.timeout(CLOCK_TIME_TIMEOUT_MS) })
      return res.ok ? (await res.text()).trim() : ''
    })
    const server = r && /^\d{4}-\d\d-\d\dT/.test(r.value) ? Date.parse(r.value) : NaN
    if (!r || !Number.isFinite(server) || server < EARLIEST_PLAUSIBLE) return null
    return { offsetMs: Math.round(server - (r.sent + r.received) / 2), source: 'akamai' }
  } catch {
    return null
  }
}

/** Our own server's Date header: whole seconds, from the CDN in front of GitHub Pages (or Vite in dev). */
async function fromServer(): Promise<ClockReading | null> {
  try {
    // Not precached by the service worker, and no-store keeps the browser cache out of it. The CDN may
    // answer from its cache, but stamps Date when it delivers, so the time is fresh.
    const r = await timed(() => fetch(`/robots.txt?clock=${Date.now()}`, { method: 'HEAD', cache: 'no-store' }))
    const header = r?.value.headers.get('date')
    const server = header ? Date.parse(header) : NaN
    if (!r || !Number.isFinite(server) || server < EARLIEST_PLAUSIBLE) return null
    // The header has whole seconds, so the server's time was somewhere in [server, server + 1 s).
    return { offsetMs: Math.round(server + 500 - (r.sent + r.received) / 2), source: 'server' }
  } catch {
    return null
  }
}

/** This device's clock error from Akamai, or from our own server when Akamai cannot be reached. */
export async function measureClockOffset(): Promise<ClockReading | null> {
  return (await fromAkamai()) ?? (await fromServer())
}

/** Measure and, if the correction moved by CLOCK_CORRECT_MIN_MS or more, apply it. False if unmeasurable. */
export async function syncClock(reason: string): Promise<boolean> {
  const reading = await measureClockOffset()
  if (reading === null) {
    L.debug(`could not measure the clock (${reason})`)
    return false
  }
  const offset = reading.offsetMs
  const via = `via ${reading.source === 'akamai' ? 'time.akamai.com' : 'our server'}`
  const first = !measured
  measured = true
  const next = Math.abs(offset) >= CLOCK_CORRECT_MIN_MS ? offset : 0
  const seconds = Math.abs(offset / 1000).toFixed(1)
  if (Math.abs(next - applied) < CLOCK_CORRECT_MIN_MS) {
    if (first) L.info(`clock is within ${seconds} s of true time (${via})`)
    return true
  }
  applied = next
  const g = globalThis as ClockGlobal
  if (next === 0) {
    delete g.__fastbeamClockOffsetMs
    L.info(`clock is right again (within ${seconds} s, ${via}); correction removed (${reason})`)
  } else {
    g.__fastbeamClockOffsetMs = next
    // A positive offset means true time is later than ours, i.e. this device's clock is behind.
    L.warn(`this device's clock is ${seconds} s ${next > 0 ? 'behind' : 'ahead'}; signaling uses corrected time (${via}; ${reason})`)
  }
  // Subscriptions carry the old "since"; reconnecting makes Trystero resubscribe and re-announce.
  reconnectRelays('clock correction changed')
  return true
}

/** syncClock with a few retries; concurrent callers share one run. */
function syncSoon(reason: string): Promise<void> {
  running ??= (async () => {
    for (let attempt = 0; attempt <= CLOCK_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => window.setTimeout(r, CLOCK_RETRY_MS))
      if (await syncClock(attempt > 0 ? `${reason}, retry ${attempt}` : reason)) return
    }
    L.warn(`could not measure the clock after ${CLOCK_RETRIES + 1} tries; signaling uses it as is`)
  })().finally(() => {
    running = null
  })
  return running
}

/**
 * Measure now, and again when the wall clock moves against the monotonic one (the clock was changed, or
 * the machine slept) or the browser comes back online. The check itself is local; only a detected change
 * costs a request.
 */
export function initClockSync(): void {
  const drift = () => Date.now() - performance.now()
  let last = drift()
  void syncSoon('startup')
  window.setInterval(() => {
    const now = drift()
    if (Math.abs(now - last) < CLOCK_CORRECT_MIN_MS) return
    L.debug(`wall clock moved ${Math.round((now - last) / 1000)} s against the monotonic clock`)
    last = now
    void syncSoon('clock changed or machine slept')
  }, CLOCK_CHECK_MS)
  window.addEventListener('online', () => void syncSoon('back online'))
}
