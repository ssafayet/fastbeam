import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupBdixIp, roomKey } from './bdix'

afterEach(() => vi.unstubAllGlobals())

describe('lookupBdixIp', () => {
  it('returns the ip the host reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ip: '203.0.113.9' }) })))
    expect(await lookupBdixIp()).toBe('203.0.113.9')
  })
  it('is undefined on a bad payload or a network error, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ip: 5 }) })))
    expect(await lookupBdixIp()).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await lookupBdixIp()).toBeUndefined()
  })
  it('sends no cookies or referrer', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => ({ json: async () => ({}) }))
    vi.stubGlobal('fetch', f)
    await lookupBdixIp()
    expect(f.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
  })
})

describe('roomKey', () => {
  it('keeps an IPv4 address whole', () => expect(roomKey('27.147.169.34')).toBe('27.147.169.34'))
  it('reduces IPv6 to its /64 so two devices on one LAN match', () => {
    expect(roomKey('2001:db8:abcd:12::1')).toBe(roomKey('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd'))
    expect(roomKey('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:abcd:12')
  })
  it('rejects junk', () => expect(roomKey('not an ip')).toBeUndefined())
})
