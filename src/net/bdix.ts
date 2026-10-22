import { BDIX_IP_URL, BDIX_LOOKUP_MS } from '../config'
import { logger } from '../state/log'
import { ipv6Prefix64 } from './stunProbe'

const L = logger('bdix')

/**
 * What two devices on one network have in common: the IPv4 address, or an IPv6 /64 (the rest of an IPv6
 * address is per device, so keying on all of it would never match). Undefined if it is neither.
 */
export function roomKey(ip: string): string | undefined {
  const a = ip.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a
  return ipv6Prefix64(a)
}

/** The public IP the BDIX host sees us from, or undefined (timeout, offline, blocked). Never throws. */
export async function lookupBdixIp(ms = BDIX_LOOKUP_MS): Promise<string | undefined> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(BDIX_IP_URL, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    const json = (await res.json()) as { ip?: unknown }
    return typeof json.ip === 'string' ? roomKey(json.ip) : undefined
  } catch (err) {
    L.debug('BDIX lookup failed', err instanceof Error ? err.message : String(err))
    return undefined
  } finally {
    clearTimeout(t)
  }
}
