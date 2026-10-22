import { BDIX_IP_URL, BDIX_LOOKUP_MS } from '../config'
import { logger } from '../state/log'

const L = logger('bdix')

/** The public IP the BDIX host sees us from, or undefined (timeout, offline, blocked). Never throws. */
export async function lookupBdixIp(ms = BDIX_LOOKUP_MS): Promise<string | undefined> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(BDIX_IP_URL, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    const json = (await res.json()) as { ip?: unknown }
    return typeof json.ip === 'string' && json.ip ? json.ip : undefined
  } catch (err) {
    L.debug('BDIX lookup failed', err instanceof Error ? err.message : String(err))
    return undefined
  } finally {
    clearTimeout(t)
  }
}
