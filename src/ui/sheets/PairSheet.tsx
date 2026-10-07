import { useEffect, useState } from 'preact/hooks'
import { PASSWORD_MIN } from '../../config'
import {
  codeFromText,
  formatCode,
  host,
  joinWithCode,
  newHostPassword,
  pairLink,
  setHostLocked,
  setHostPassword,
  startHosting,
  stopHosting,
} from '../../net/pairing'
import { toast } from '../../state/toast'
import { closeSheet, hasPending, openSendSheet, type PairTab } from '../../state/ui'
import type { Peer } from '../../state/peers'
import { Button, IconButton, Switch } from '../components/Controls'
import { CodeBoxes } from '../components/CodeBoxes'
import { BackIcon, CopyIcon, LockIcon, PasteIcon, ShareIcon } from '../components/Icons'
import { QrCode } from '../components/QrCode'
import { Scanner } from '../components/Scanner'
import { Tabs } from '../components/Sheet'
import { Sheet } from '../components/Sheet'

const TABS = [
  { value: 'show', label: 'Show my code' },
  { value: 'scan', label: 'Scan or enter' },
] as const

/** What happens after a successful pairing from anywhere (sheet, panel, link, scanner). */
export function onPairedDefault(peer: Peer): void {
  if (hasPending()) openSendSheet(peer.deviceId)
}

/** Keeps hosting alive while any Show-my-code UI is mounted (sheet tab or desktop panel). */
let hostUsers = 0
export function useHosting(): void {
  useEffect(() => {
    hostUsers++
    startHosting()
    return () => {
      hostUsers--
      if (hostUsers === 0) stopHosting()
    }
  }, [])
}

function useCountdown(expiresAt: number | null | undefined): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  if (expiresAt === null) return 'paused'
  if (!expiresAt) return '--:--'
  const s = Math.max(0, Math.round((expiresAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    toast(`Code ${formatCode(code)} copied`)
  } catch {
    toast('Couldn\u2019t copy the code')
  }
}

export async function copyLink(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(pairLink(code))
    toast('Link copied')
  } catch {
    toast('Couldn’t copy the link')
  }
}

export async function shareLink(code: string): Promise<void> {
  try {
    await navigator.share({ title: 'fastbeam', text: 'Connect to my device on fastbeam', url: pairLink(code) })
  } catch {
    /* dismissed */
  }
}

/** Screen 7. */
export function ShowCode() {
  useHosting()
  const h = host.value
  const countdown = useCountdown(h?.expiresAt)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  if (!h) return <div class="muted">Getting a code…</div>
  const tooShort = h.locked && h.password.length < PASSWORD_MIN
  return (
    <>
      <section class="card showcode">
        <QrCode value={pairLink(h.code)} />
        <div class="code-row">
          <button
            type="button"
            class="bigcode bigcode--btn mono"
            aria-label={`Code ${h.code.split('').join(' ')}`}
            title="Tap to copy the code"
            onClick={() => void copyCode(h.code)}
          >
            {h.code.slice(0, 3)}
            <span class="bigcode-dot">·</span>
            {h.code.slice(3)}
          </button>
          <IconButton label="Copy code" class="code-copy" onClick={() => void copyCode(h.code)}>
            <CopyIcon size={20} />
          </IconButton>
        </div>
        <div class="row-sub">fastbeam.app/#{h.code}</div>
        <div class="two-up">
          <Button variant="secondary" class="btn--md" onClick={() => void copyLink(h.code)}>
            <CopyIcon /> Copy link
          </Button>
          {canShare ? (
            <Button variant="primary" class="btn--md" onClick={() => void shareLink(h.code)}>
              <ShareIcon /> Share
            </Button>
          ) : (
            <Button variant="primary" class="btn--md" onClick={() => void copyLink(h.code)}>
              <ShareIcon /> Copy
            </Button>
          )}
        </div>
      </section>

      <section class="card card--pad lockcard">
        <div class="row" style={{ minHeight: 44, borderBottom: 0 }}>
          <span class="lockcard-icon">
            <LockIcon />
          </span>
          <span class="row-text">
            <span class="row-title">Protect with a password</span>
            <span class="row-sub">Tell it to them separately</span>
          </span>
          <Switch checked={h.locked} onChange={setHostLocked} label="Protect with a password" />
        </div>
        {h.locked && (
          <div class={`input-row input-row--accent${tooShort ? ' input-row--warn' : ''}`}>
            <label class="visually-hidden" for="host-pw">
              Password
            </label>
            <input
              id="host-pw"
              class="mono-input"
              type="text"
              value={h.password}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-describedby="host-pw-help"
              onInput={(e) => setHostPassword((e.currentTarget as HTMLInputElement).value)}
            />
            <Button variant="link" onClick={newHostPassword}>
              New
            </Button>
          </div>
        )}
        {h.locked && (
          <div id="host-pw-help" class="row-sub">
            {tooShort ? `At least ${PASSWORD_MIN} characters.` : h.deriving ? 'Preparing…' : 'Never stored, never in the link or QR.'}
          </div>
        )}
      </section>

      <div class="waiting muted">
        <span class="dot-live" aria-hidden="true" />
        {h.expiresAt === null ? 'Someone is connecting… the code stays until they finish' : `Waiting for the other device · expires in ${countdown}`}
      </div>
    </>
  )
}

/** Screen 8. */
export function ScanEnter({ prefill = '' }: { prefill?: string }) {
  const [code, setCode] = useState(prefill)
  const [chip, setChip] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const submit = (c: string) => {
    if (submitted) return
    setSubmitted(true)
    closeSheet()
    joinWithCode(c, { intent: hasPending(), onPaired: onPairedDefault })
  }

  useEffect(() => {
    let alive = true
    const perms = navigator.permissions?.query?.bind(navigator.permissions)
    if (!perms || !navigator.clipboard?.readText) return
    perms({ name: 'clipboard-read' as PermissionName })
      .then(async (st) => {
        if (!alive || st.state !== 'granted') return
        const text = await navigator.clipboard.readText().catch(() => '')
        const c = codeFromText(text)
        if (alive && c) setChip(c)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const paste = async () => {
    if (chip) {
      setCode(chip)
      submit(chip)
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      const c = codeFromText(text)
      if (c) {
        setCode(c)
        submit(c)
      } else toast('No fastbeam code on the clipboard')
    } catch {
      toast('Clipboard access was blocked. Type the code instead.')
    }
  }

  return (
    <>
      <Scanner onCode={submit} paused={submitted} />
      <div class="or-rule">
        <span />
        or type the code
        <span />
      </div>
      <CodeBoxes value={code} onChange={setCode} onSubmit={submit} autoFocus={!!prefill} disabled={submitted} />
      {typeof navigator.clipboard?.readText === 'function' && (
        <button type="button" class="chip" onClick={() => void paste()}>
          <PasteIcon /> {chip ? `Paste ${chip}` : 'Paste'}
        </button>
      )}
    </>
  )
}

export function PairSheet({ tab: initialTab, prefill }: { tab: PairTab; prefill?: string }) {
  const [tab, setTab] = useState<PairTab>(initialTab)
  return (
    <Sheet label="Connect a device" onClose={closeSheet}>
      <div class="sheet-head sheet-head--plain">
        <IconButton label="Back" onClick={closeSheet}>
          <BackIcon />
        </IconButton>
        <h2 class="sheet-title">Connect a device</h2>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Pairing method" tone="chip" />
      <div class="sheet-scroll">{tab === 'show' ? <ShowCode /> : <ScanEnter {...(prefill ? { prefill } : {})} />}</div>
    </Sheet>
  )
}
