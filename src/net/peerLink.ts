import { BUFFER_LOW, CHUNK_SIZE, CHUNK_HEADER, DISCONNECT_MASK_MS, ICE_RESTART_AFTER_MS } from '../config'
import { realStates } from './patientPc'

/** Dedicated, negotiated channel beside Trystero's own "data" channel. Both sides create it with the same id. */
const CHANNEL_ID = 42
const CHANNEL_LABEL = 'fastbeam'

export interface ControlMessage {
  type: string
  [k: string]: unknown
}

export interface Fingerprints {
  local: string
  remote: string
}

export type LinkHealth = 'open' | 'degraded' | 'closed'

export interface PeerLink {
  readonly pc: RTCPeerConnection
  /** Resolves when the channel is open; rejects if it closes first. */
  readonly ready: Promise<void>
  readonly open: boolean
  /** 'degraded' while ICE is disconnected and a restart is being attempted. */
  readonly health: LinkHealth
  readonly bufferedAmount: number
  /** Largest safe chunk payload for this connection. */
  readonly chunkSize: number
  /** When true this side issues ICE restarts; set by the session once both device IDs are known. */
  restartsIce: boolean
  sendControl(msg: ControlMessage): void
  sendChunk(frame: ArrayBuffer): void
  onControl: ((msg: ControlMessage) => void) | null
  onChunk: ((frame: ArrayBuffer) => void) | null
  onBufferedAmountLow: (() => void) | null
  onHealth: ((health: LinkHealth) => void) | null
  onClose: (() => void) | null
  fingerprints(): Fingerprints | null
  /**
   * End the link. The RTCPeerConnection is closed too once no other link uses it, so Trystero drops it and
   * re-handshakes; otherwise it never offers that peer again. `keepTransport` leaves the connection idle.
   */
  close(opts?: { keepTransport?: boolean }): void
}

/** Live links per connection: Trystero shares one connection across rooms (v4 and v6 discovery). */
const linksByPc = new WeakMap<RTCPeerConnection, Set<PeerLink>>()

export function sdpFingerprint(sdp: string | undefined | null): string | null {
  if (!sdp) return null
  const m = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp)
  return m?.[1]?.toUpperCase() ?? null
}

export function createPeerLink(pc: RTCPeerConnection): PeerLink {
  const dc = pc.createDataChannel(CHANNEL_LABEL, { negotiated: true, id: CHANNEL_ID, ordered: true })
  dc.binaryType = 'arraybuffer'
  dc.bufferedAmountLowThreshold = BUFFER_LOW

  let closed = false
  let health: LinkHealth = 'open'
  let resolveReady: (() => void) | undefined
  let rejectReady: ((e: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // Avoid unhandled-rejection noise when nobody awaits a link that never opened.
  ready.catch(() => {})

  // Control frames can arrive before anyone has attached a handler (Chrome delivers data that was queued
  // for a late-created negotiated channel ahead of its "open" event). Hold them until a handler exists.
  let controlHandler: ((msg: ControlMessage) => void) | null = null
  const pendingControl: ControlMessage[] = []
  const MAX_PENDING = 64

  const link: PeerLink = {
    pc,
    ready,
    restartsIce: false,
    get onControl() {
      return controlHandler
    },
    set onControl(fn) {
      controlHandler = fn
      if (fn && pendingControl.length) {
        const queued = pendingControl.splice(0)
        for (const m of queued) fn(m)
      }
    },
    get open() {
      return dc.readyState === 'open'
    },
    get health() {
      return closed ? 'closed' : health
    },
    get bufferedAmount() {
      return dc.bufferedAmount
    },
    get chunkSize() {
      const max = pc.sctp?.maxMessageSize
      if (!max || !Number.isFinite(max) || max <= 0) return CHUNK_SIZE
      return Math.min(CHUNK_SIZE, max - CHUNK_HEADER)
    },
    sendControl(msg) {
      if (dc.readyState !== 'open') return
      try {
        dc.send(JSON.stringify(msg))
      } catch {
        /* channel closing under us */
      }
    },
    sendChunk(frame) {
      if (dc.readyState !== 'open') throw new Error('link closed')
      dc.send(frame)
    },
    onChunk: null,
    onBufferedAmountLow: null,
    onHealth: null,
    onClose: null,
    fingerprints() {
      const local = sdpFingerprint(pc.localDescription?.sdp)
      const remote = sdpFingerprint(pc.remoteDescription?.sdp)
      return local && remote ? { local, remote } : null
    },
    close(opts) {
      end(!opts?.keepTransport)
    },
  }

  const setHealth = (h: LinkHealth) => {
    if (closed || health === h) return
    health = h
    link.onHealth?.(h)
  }

  if (dc.readyState === 'open') resolveReady?.()
  dc.onopen = () => resolveReady?.()
  dc.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data) as unknown
        if (msg && typeof msg === 'object' && typeof (msg as ControlMessage).type === 'string') {
          if (controlHandler) controlHandler(msg as ControlMessage)
          else if (pendingControl.length < MAX_PENDING) pendingControl.push(msg as ControlMessage)
        }
      } catch {
        /* ignore malformed control frames */
      }
    } else if (e.data instanceof ArrayBuffer) {
      link.onChunk?.(e.data)
    }
  }
  dc.onbufferedamountlow = () => link.onBufferedAmountLow?.()
  const live = linksByPc.get(pc) ?? new Set<PeerLink>()
  linksByPc.set(pc, live)
  live.add(link)

  const end = (releasePc: boolean) => {
    rejectReady?.(new Error('link closed'))
    if (closed) return
    closed = true
    clearIceTimers()
    live.delete(link)
    if (releasePc) {
      try {
        dc.close()
      } catch {
        /* already closed */
      }
      if (live.size === 0 && pc.signalingState !== 'closed') {
        pc.close()
        // pc.close() fires no event, and Trystero only re-reads the state on one.
        pc.dispatchEvent(new Event('connectionstatechange'))
      }
    }
    link.onClose?.()
  }
  const onGone = () => end(true)
  dc.onclose = onGone
  dc.onerror = () => {
    if (dc.readyState === 'closed' || dc.readyState === 'closing') onGone()
  }

  // ---- ICE babysitting: restart on a lingering "disconnected", give up only after the mask window ----
  let restartTimer = 0
  let giveUpTimer = 0
  const clearIceTimers = () => {
    window.clearTimeout(restartTimer)
    window.clearTimeout(giveUpTimer)
    restartTimer = 0
    giveUpTimer = 0
  }
  const onIceChange = () => {
    const { connection, ice } = realStates(pc)
    if (connection === 'failed' || connection === 'closed' || ice === 'failed' || ice === 'closed') {
      onGone()
      return
    }
    if (connection === 'disconnected' || ice === 'disconnected') {
      setHealth('degraded')
      if (!restartTimer) {
        restartTimer = window.setTimeout(() => {
          restartTimer = 0
          const now = realStates(pc)
          if (closed || (now.connection !== 'disconnected' && now.ice !== 'disconnected')) return
          if (link.restartsIce && typeof pc.restartIce === 'function') {
            try {
              // Trystero's negotiationneeded handler ships the restart offer through the relays.
              pc.restartIce()
            } catch {
              /* not restartable right now */
            }
          }
        }, ICE_RESTART_AFTER_MS)
      }
      if (!giveUpTimer) {
        giveUpTimer = window.setTimeout(() => {
          giveUpTimer = 0
          const now = realStates(pc)
          if (!closed && (now.connection === 'disconnected' || now.ice === 'disconnected')) onGone()
        }, DISCONNECT_MASK_MS)
      }
      return
    }
    if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
      clearIceTimers()
      setHealth('open')
    }
  }
  pc.addEventListener('connectionstatechange', onIceChange)
  pc.addEventListener('iceconnectionstatechange', onIceChange)

  if (import.meta.env.DEV) {
    const w = window as unknown as { __fbLinks?: PeerLink[] }
    ;(w.__fbLinks ??= []).push(link)
  }
  return link
}
