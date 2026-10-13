import { useEffect, useState } from 'preact/hooks'
import { mediaItem, openViewer, type ViewerItem } from '../../state/media'
import { getPeer } from '../../state/peers'
import { openSendSheet } from '../../state/ui'
import { clearIncoming, clearOutgoing, incoming, outgoing } from '../../transfer/manager'
import { formatBytes, formatDuration, formatEta } from '../../transfer/protocol'
import type { SavedFile } from '../../transfer/sinks'
import { AutoAcceptRow } from '../components/AutoAcceptRow'
import { Button, IconButton } from '../components/Controls'
import { CheckIcon, CloseIcon, ImageIcon, ShieldPlainIcon } from '../components/Icons'
import { Thumb } from '../components/Thumb'

/**
 * Media the receiver can still read back, as gallery items, keyed by file index. Rebuilt every render,
 * but each saved file maps to the same item every time, so thumbnails come from cache.
 */
function galleryFrom(saved: SavedFile[]): Map<number, ViewerItem> {
  const out = new Map<number, ViewerItem>()
  saved.forEach((s, i) => {
    const item = mediaItem(s)
    if (item) out.set(i, item)
  })
  return out
}

interface Row {
  key: string
  name: string
  size: number
  done: number
  complete: boolean
}

interface View {
  kind: 'send' | 'receive'
  peerName: string
  peerId: string
  total: number
  done: number
  speed: number
  eta: number | null
  startedAt: number | null
  /** Sender only: everything is queued and we are waiting for the receiver to confirm the tail. */
  finishing: boolean
  /** waiting = offer not answered yet; starting = accepted, no bytes moved yet; running = bytes flowing. */
  phase: 'waiting' | 'starting' | 'running'
  offeredAt: number | null
  rows: Row[]
  cancel: () => void
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function currentView(): View | null {
  const o = outgoing.value?.snap.value
  if (o && (o.state === 'sending' || o.state === 'offered')) {
    const done = Math.min(o.sentBytes, o.ackedBytes + 4 * 1024 * 1024)
    return {
      kind: 'send',
      peerName: o.peerName,
      peerId: o.peerId,
      total: o.totalSize,
      done,
      speed: o.speed,
      eta: o.etaSeconds,
      startedAt: o.startedAt,
      finishing: o.state === 'sending' && o.sentBytes >= o.totalSize && o.ackedBytes < o.totalSize,
      phase: o.state === 'offered' ? 'waiting' : done === 0 ? 'starting' : 'running',
      offeredAt: o.offeredAt,
      rows: o.files.map((f) => ({ key: f.fileId, name: f.name, size: f.size, done: f.sent, complete: f.sent >= f.size })),
      cancel: () => outgoing.value?.cancel(),
    }
  }
  const i = incoming.value?.snap.value
  if (i && i.state === 'receiving') {
    return {
      kind: 'receive',
      peerName: i.peerName,
      peerId: i.peerId,
      total: i.totalSize,
      done: i.receivedBytes,
      speed: i.speed,
      eta: i.etaSeconds,
      startedAt: i.startedAt,
      finishing: false,
      phase: i.receivedBytes === 0 ? 'starting' : 'running',
      offeredAt: i.offeredAt,
      rows: i.files.map((f) => ({ key: f.fileId, name: f.name, size: f.size, done: f.received, complete: f.complete })),
      cancel: () => incoming.value?.cancel(),
    }
  }
  return null
}

const R = 104
const CIRC = 2 * Math.PI * R

/** Screen 5. The file list is a polite live region refreshed at most once per second. */
export function Progress() {
  const v = currentView()
  const [liveRows, setLiveRows] = useState<Row[]>(v?.rows ?? [])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => {
      const cur = currentView()
      if (cur) setLiveRows(cur.rows)
      setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(t)
  }, [])
  if (!v) return null
  const since = v.startedAt ?? v.offeredAt
  const elapsed = since ? formatElapsed(now - since) : '0:00'
  const pct = v.total > 0 ? Math.min(100, Math.floor((v.done / v.total) * 100)) : 0
  const dash = (pct / 100) * CIRC
  const waiting = v.phase === 'waiting'
  const starting = v.phase === 'starting'
  const statusLine = waiting
    ? `Waiting for ${v.peerName} to accept…`
    : starting
      ? v.kind === 'send'
        ? `${v.peerName} accepted. Setting up the transfer…`
        : 'Setting up the transfer…'
      : v.finishing
        ? `Everything is sent. Waiting for ${v.peerName} to finish writing it to disk…`
        : null
  return (
    <div class="screen">
      <header class="screen-head">
        <span class="muted" style={{ fontWeight: 600, fontSize: 15 }}>
          {v.kind === 'send' ? 'Sending to ' : 'Receiving from '}
          <span class="ink">{v.peerName}</span>
        </span>
        <span class="secure">
          <ShieldPlainIcon /> Direct · encrypted
        </span>
      </header>

      <div
        class={`ring${waiting || starting ? ' ring--indeterminate' : ''}`}
        role="progressbar"
        aria-valuenow={waiting || starting ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={waiting ? 'Waiting for the other device to accept' : starting ? 'Setting up' : `${pct} percent`}
        aria-label="Overall progress"
      >
        <svg width="240" height="240" viewBox="0 0 240 240" aria-hidden="true">
          <circle cx="120" cy="120" r={R} class="ring-track" />
          <circle cx="120" cy="120" r={R} class="ring-fill" stroke-dasharray={waiting || starting ? `${CIRC * 0.18} ${CIRC}` : `${dash} ${CIRC}`} />
        </svg>
        <div class="ring-center">
          {waiting || starting ? (
            <>
              <div class="ring-wait display">{waiting ? 'Waiting' : 'Starting'}</div>
              <div class="muted">
                {v.rows.length === 0 ? 'text' : `${v.rows.length} ${v.rows.length === 1 ? 'file' : 'files'}`} · {formatBytes(v.total)}
              </div>
            </>
          ) : (
            <>
              <div class="ring-pct">
                {pct}
                <span>%</span>
              </div>
              <div class="muted">
                {formatBytes(v.done)} of {formatBytes(v.total)}
              </div>
            </>
          )}
        </div>
      </div>

      <div class="three-up">
        <div class="stat">
          <div class="row-sub">Speed</div>
          <div class="mono stat-value">{v.speed > 0 ? `${formatBytes(v.speed)}/s` : '—'}</div>
        </div>
        <div class="stat">
          <div class="row-sub">Elapsed</div>
          <div class="mono stat-value">{elapsed}</div>
        </div>
        <div class="stat">
          <div class="row-sub">Time left</div>
          <div class="mono stat-value">{v.finishing ? 'finishing' : v.eta !== null ? formatEta(v.eta) : '—'}</div>
        </div>
      </div>
      {statusLine && (
        <div class="status-line" role="status">
          <span class="dot-live" aria-hidden="true" />
          {statusLine}
        </div>
      )}

      <div class="card card--list filelist" aria-live="polite">
        {liveRows.map((r) => {
          const p = r.size > 0 ? Math.min(100, Math.floor((r.done / r.size) * 100)) : r.complete ? 100 : 0
          const rowWaiting = r.done === 0 && !r.complete
          return (
            <div key={r.key} class="filerow">
              <div class="filerow-head">
                <span class={rowWaiting ? 'muted' : ''} style={{ fontWeight: 600 }}>
                  {r.name}
                </span>
                <span class="muted">{r.complete ? 'Done' : rowWaiting ? (waiting ? 'Queued' : 'Waiting') : `${p}%`}</span>
              </div>
              <div class="bar">
                <div style={{ width: `${r.complete ? 100 : p}%` }} />
              </div>
            </div>
          )
        })}
      </div>

      <div class="stack-10 screen-cta">
        <div class="row-sub" style={{ textAlign: 'center' }}>
          Keep this tab open until it finishes.
        </div>
        <Button variant="secondary" onClick={v.cancel}>
          {waiting ? 'Cancel request' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}

/** Screen 6, both directions. */
export function Done() {
  const o = outgoing.value?.snap.value
  const i = incoming.value?.snap.value
  const isSend = !!o && o.state === 'done'
  const snap = isSend ? o : i
  if (!snap || snap.state !== 'done') return null
  const count = snap.files.length
  const dur = snap.startedAt && snap.finishedAt ? formatDuration(snap.finishedAt - snap.startedAt) : null
  const peer = getPeer(snap.peerId)
  const close = () => (isSend ? clearOutgoing() : clearIncoming())
  const again = () => {
    close()
    if (peer) openSendSheet(peer.deviceId)
  }
  const saved = !isSend && i ? i.saved : []
  const dest = !isSend && i ? i.destinationLabel : ''
  const gallery = galleryFrom(saved)
  const galleryItems = [...gallery.values()]
  const viewAt = (fileIdx: number) => {
    const item = gallery.get(fileIdx)
    if (item) openViewer(galleryItems, galleryItems.indexOf(item))
  }

  return (
    <div class="screen">
      <header class="screen-head">
        <span class="muted" style={{ fontWeight: 600, fontSize: 15 }}>
          {isSend ? 'To ' : 'From '}
          <span class="ink">{snap.peerName}</span>
        </span>
        <IconButton label="Close" class="iconbtn--round" onClick={close}>
          <CloseIcon />
        </IconButton>
      </header>
      <div class="done-hero">
        <span class="done-check">
          <CheckIcon size={56} strokeWidth={2.4} />
        </span>
        <div>
          <h1 class="done-title">
            {isSend ? 'Sent' : 'Got'} {count === 1 ? snap.files[0]?.name ?? '1 file' : `${count} files`}
          </h1>
          <div class="muted">
            {formatBytes(snap.totalSize)}
            {dur ? ` in ${dur}` : ''}
            {dest ? ` · ${dest}` : ''}
          </div>
        </div>
      </div>
      {galleryItems.length > 1 && (
        <Button variant="secondary" class="btn--md" onClick={() => openViewer(galleryItems, 0)}>
          <ImageIcon /> View all {galleryItems.length} {galleryItems.every((g) => g.kind === 'image') ? 'photos' : 'photos and videos'}
        </Button>
      )}
      <div class="done-list">
        {snap.files.map((f, idx) => {
          const sv = saved[idx]
          const media = gallery.get(idx)
          return (
            <div key={f.fileId} class="done-item">
              {media && (
                <button type="button" class="thumb-btn" aria-label={`View ${f.name}`} onClick={() => viewAt(idx)}>
                  <Thumb item={media} size={44} />
                </button>
              )}
              <span class="selected-text">
                <span class="selected-name">{f.name}</span>
                <span class="row-sub">{formatBytes(f.size)}</span>
              </span>
              {media && (
                <Button variant="link" onClick={() => viewAt(idx)}>
                  View
                </Button>
              )}
              {!media && sv?.open && (
                <Button variant="link" onClick={() => void sv.open?.()}>
                  Open
                </Button>
              )}
              {sv?.save && (
                <Button variant="link" onClick={() => sv.save?.()}>
                  Save
                </Button>
              )}
            </div>
          )
        })}
      </div>
      {!isSend && (
        <div class="card card--list">
          <AutoAcceptRow peerId={snap.peerId} />
        </div>
      )}
      <div class="two-up screen-cta">
        <Button variant="secondary" class="btn--lg" disabled={!peer} onClick={again}>
          {isSend ? 'Send more' : 'Send back'}
        </Button>
        <Button variant="primary" class="btn--lg" onClick={close}>
          Done
        </Button>
      </div>
    </div>
  )
}
