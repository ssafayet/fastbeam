import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupBdixIp } from './bdix'

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
