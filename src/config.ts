/** Constants shared by discovery, pairing and transfer. Bump APP_SALT / PROTOCOL on breaking wire changes. */

export const APP_SALT = 'fastbeam/v1'
export const APP_ID = 'fastbeam.app'
export const PROTOCOL = 1
export const CANONICAL_ORIGIN = 'https://fastbeam.app'
export const REPO_URL = 'https://github.com/theanam/fastbeam'
export const ISSUES_URL = 'https://github.com/theanam/fastbeam/issues'
export const FEEDBACK_EMAIL = 'anam.ahmed.a@gmail.com'

/** Exactly two STUN servers and no TURN: fastbeam never relays traffic. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/** Leave undefined to use Trystero's default Nostr relay set; override here if relays misbehave. */
export const RELAY_URLS: string[] | undefined = undefined
export const RELAY_REDUNDANCY = 4

/** CORS-enabled public IP lookup used only when STUN yields no reflexive candidate (UDP blocked). */
export const IP_LOOKUP_URL = 'https://api64.ipify.org?format=json'

/** Pairing codes never use 0, O, 1, I or L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6

export const CHUNK_SIZE = 64 * 1024
export const CHUNK_HEADER = 5
export const BUFFER_HIGH = 4 * 1024 * 1024
export const BUFFER_LOW = 1 * 1024 * 1024
/** Bytes the sender may have in flight beyond the receiver's last acknowledged progress. */
export const SEND_WINDOW = 32 * 1024 * 1024
export const PROGRESS_EVERY = 1024 * 1024
export const TEXT_MAX = 64 * 1024

export const OFFER_TIMEOUT_MS = 60_000
export const PING_INTERVAL_MS = 5_000
/** No ping for this long marks a peer "reconnecting" (greyed, not removed). */
export const PEER_TIMEOUT_MS = 15_000
/** No traffic at all for this long closes the link; the peer then enters the grace period below. */
export const LINK_SILENCE_CLOSE_MS = 60_000
/** A peer whose last link closed stays listed as reconnecting for this long before it is removed. */
export const PEER_GRACE_MS = 90_000
/** How long ICE may sit in "disconnected" before we ask for an ICE restart. */
export const ICE_RESTART_AFTER_MS = 3_000
/** How long we hide a "disconnected" state from Trystero (and ourselves) before giving up on the link. */
export const DISCONNECT_MASK_MS = 30_000
export const STUN_PROBE_MS = 3_000
export const PAIR_TIMEOUT_MS = 20_000
export const PAIR_RETRY_MS = 10_000
/** After a join error, how long a channel has to open before the join is given up. */
export const JOIN_ERROR_GRACE_MS = 3_000
export const CODE_TTL_MS = 10 * 60_000
export const STILL_LOOKING_MS = 8_000
export const REDISCOVER_HIDDEN_MS = 60_000

export const SHARED_NETWORK_PEERS = 12
export const BLOB_WARN_BYTES = 1024 * 1024 * 1024

export const AUTH_MIN_INTERVAL_MS = 2_000
export const AUTH_MAX_FAILURES = 5
export const PASSWORD_MIN = 4
