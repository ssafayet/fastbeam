import { effect } from '@preact/signals'
import { NAME_MAX, normalizeName, randomName } from './names'
import { isBoolean, isNonEmptyString, persisted } from './storage'

export type Theme = 'system' | 'light' | 'dark'
const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark'

/** The name other devices see. Generated on first load, editable, never empty. */
export const deviceName = persisted<string>('name', randomName, isNonEmptyString)

/** When false this device still answers code pairing but hides from nearby lists. */
export const discoverable = persisted<boolean>('discoverable', () => true, isBoolean)

/** Opt-in: ask the BDIX host which IP it sees us from and meet devices under that address too. Off sends nothing. */
export const bdixDiscovery = persisted<boolean>('bdix', () => false, isBoolean)

export const theme = persisted<Theme>('theme', () => 'system', isTheme)

export { NAME_MAX }

/** Set the device name from user input. Returns false (and leaves the name alone) when nothing usable was typed. */
export function setDeviceName(raw: string): boolean {
  const next = normalizeName(raw)
  if (!next) return false
  deviceName.value = next
  return true
}

export function shuffleName(): void {
  let next = randomName()
  // Avoid handing back the same name twice in a row.
  for (let i = 0; i < 5 && next === deviceName.value; i++) next = randomName()
  deviceName.value = next
}

const THEME_COLOR = { light: '#0B7F80', dark: '#0A1415' } as const

/** Mirror the theme setting onto <html data-theme> and the browser chrome colour. Call once at startup. */
export function initTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  const apply = () => {
    const t = theme.value
    const root = document.documentElement
    if (t === 'system') delete root.dataset.theme
    else root.dataset.theme = t
    const dark = t === 'dark' || (t === 'system' && mq.matches)
    meta?.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light)
  }
  const dispose = effect(apply)
  mq.addEventListener('change', apply)
  return () => {
    dispose()
    mq.removeEventListener('change', apply)
  }
}
