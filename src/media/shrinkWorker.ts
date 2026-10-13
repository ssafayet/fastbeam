import { logger } from '../state/log'
import type { ThumbJob, ThumbReply, WorkerMessage } from './thumb.worker'

const L = logger('thumb')

/**
 * No word from the worker for this long with a job pending means it hung, never booted, or was killed
 * (iOS does that silently, between jobs too). Counted from its last message, since jobs queue inside it:
 * one waiting behind a 15 s decode is not hung.
 */
export const WORKER_TIMEOUT_MS = 20_000
/**
 * After this many deaths in a row the worker rests: photos get an icon for a while, never a full-size
 * decode on the main thread, which is what would have run out of memory next. If no worker has ever
 * started a job in this tab, it never will, and photos are shrunk on the main thread from then on.
 */
export const MAX_WORKER_DEATHS = 3
/** How long that rest lasts: a worker that kept dying may be fine once memory pressure has passed. */
export const WORKER_PAUSE_MS = 60_000

/** Why there is no worker to ask: this browser can't run one, or it kept dying and is resting. */
export type NoWorker = 'none' | 'resting'

/** The worker went away mid-job: the job is worth retrying. */
export class WorkerStopped extends Error {
  /** True for the job the worker said it was decoding when it went: the one that may have killed it. */
  readonly culprit: boolean
  constructor(culprit: boolean) {
    super(culprit ? 'thumbnail worker died on this photo' : 'thumbnail worker died')
    this.culprit = culprit
  }
}

let worker: Worker | null = null
/** The job the current worker said it started and hasn't answered: the only one its death is blamed on. */
let decoding: number | null = null
/** Some worker started a job in this tab, so a failed start is bad luck rather than "this browser can't". */
let everStarted = false
/** No worker before this time: it kept dying, or (Infinity) this browser can't run one. */
let pausedUntil = 0
let deaths = 0
let seq = 0
/**
 * Jobs posted to the worker. A null reply means it went away; `culprit` then says whether this job was
 * the one it was decoding.
 */
const waiting = new Map<number, (reply: ThumbReply | null, culprit?: boolean) => void>()
let watchdog: ReturnType<typeof setTimeout> | undefined

/** The worker just said something: give it another timeout to say the next thing, if it owes one. */
function heard() {
  clearTimeout(watchdog)
  watchdog = undefined
  if (!waiting.size) return
  const armed = Date.now()
  watchdog = setTimeout(() => {
    // Firing this late means the tab was asleep (phone locked), and the worker with it: not hung, so
    // its photo takes no blame. It gets a full timeout of awake time instead.
    if (Date.now() - armed > WORKER_TIMEOUT_MS * 1.5) heard()
    else stopWorker('went quiet')
  }, WORKER_TIMEOUT_MS)
}

function getWorker(): Worker | NoWorker {
  if (worker) return worker
  if (Date.now() < pausedUntil) return pausedUntil === Infinity ? 'none' : 'resting'
  if (typeof Worker === 'undefined') {
    pausedUntil = Infinity
    return 'none'
  }
  try {
    const w = new Worker(new URL('./thumb.worker.ts', import.meta.url), { type: 'module' })
    // A replaced worker's late events must not touch its successor.
    w.onmessage = (e: MessageEvent<WorkerMessage>) => {
      if (worker !== w) return
      if ('started' in e.data) {
        decoding = e.data.started
        everStarted = true
        heard()
        return
      }
      const settle = waiting.get(e.data.id)
      if (!settle) return
      waiting.delete(e.data.id)
      if (decoding === e.data.id) decoding = null
      heard()
      deaths = 0
      settle(e.data)
    }
    w.onerror = () => worker === w && stopWorker('crashed')
    worker = w
    decoding = null
    return w
  } catch (err) {
    L.debug('no thumbnail worker, shrinking photos on the main thread', err)
    pausedUntil = Infinity
    return 'none'
  }
}

/** Throw away a dead or hung worker and fail its jobs; the next job starts a fresh one. */
function stopWorker(why: string) {
  worker?.terminate()
  worker = null
  clearTimeout(watchdog)
  watchdog = undefined
  if (++deaths >= MAX_WORKER_DEATHS) {
    pausedUntil = everStarted ? Date.now() + WORKER_PAUSE_MS : Infinity
    deaths = 0
  }
  L.warn(`thumbnail worker ${why}`, { jobs: waiting.size, decoding, deaths, pausedUntil })
  const jobs = [...waiting]
  const culprit = decoding
  waiting.clear()
  decoding = null
  // Killed idle (iOS does that between jobs) or before it started: nobody's photo is to blame.
  for (const [id, settle] of jobs) settle(null, id === culprit)
}

/**
 * Ask the worker for a small copy of an image. Resolves with why there is no worker to ask instead;
 * rejects with WorkerStopped when the worker died on the job.
 */
export function shrinkInWorker(job: Omit<ThumbJob, 'id'>): Promise<ThumbReply | NoWorker> {
  const w = getWorker()
  if (typeof w === 'string') return Promise.resolve(w)
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, (reply, culprit = false) => (reply ? resolve(reply) : reject(new WorkerStopped(culprit))))
    // Only start the clock: restarting it on every post would let a hung worker live while work arrives.
    if (watchdog === undefined) heard()
    w.postMessage({ id, ...job } satisfies ThumbJob)
  })
}
