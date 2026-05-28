import type Redis from 'ioredis'
import { getRedis, getRedisSubscriber } from './redis'

// Self-hosted admin-config sync. Gated entirely by ADMIN_CONFIG_ENABLED:
// in cloud builds (flag absent) every export is a hard no-op — no Redis
// connection is opened, no timers are scheduled, no log lines are
// emitted. This file is identical (modulo imports) across exchange-
// connector-sh, websocket-connector-sh and app-sh.
//
// Contract (admin-sh side):
//   key   gainium:admin:enabled_exchanges  — JSON array of ExchangeEnum
//                                            values; absent ⇒ all enabled.
//   chan  gainium:admin:config             — broadcast on every change.

const ENABLED =
  process.env.ADMIN_CONFIG_ENABLED === 'true' ||
  process.env.ADMIN_CONFIG_ENABLED === '1'

const KEY = 'gainium:admin:enabled_exchanges'
const CHANNEL = 'gainium:admin:config'
const REFRESH_MS = Number(process.env.ADMIN_CONFIG_REFRESH_MS ?? '10000')

// `null` ⇒ key absent ⇒ all exchanges enabled. The post-init flag lets
// us distinguish "not yet loaded" from "loaded and empty" so we don't
// reject requests during the boot window before Redis comes online.
let cache: Set<string> | null = null
let initialized = false
let started = false

export function isAdminConfigEnabled(): boolean {
  return ENABLED
}

/**
 * Synchronous check used on every exchange-routing path. Always returns
 * true in cloud builds (flag off) AND before the first refresh completes
 * (initialized=false) so we don't reject in-flight requests during boot.
 */
export function isExchangeEnabled(exchange: string): boolean {
  if (!ENABLED) return true
  if (!initialized || cache === null) return true
  return cache.has(exchange)
}

function parseRaw(raw: string | null): Set<string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return null
  }
}

function setEquals(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

interface SyncOpts {
  /** Optional callback fired only when the enabled set actually
   *  changes — used by websocket-connector-sh to diff old vs new and
   *  start/stop workers. Receives null when the key transitions to
   *  absent (back to "all enabled"). */
  onChange?: (
    prev: Set<string> | null,
    next: Set<string> | null,
  ) => void | Promise<void>
  /** Optional log function — wired to each repo's existing logger. */
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

/**
 * One-shot bootstrap. Idempotent: calling twice is a no-op. Reads the
 * current key, then subscribes to pubsub (sub-second propagation) and
 * starts a 10s periodic refresh as a safety net for dropped messages.
 *
 * Returns once the initial read completes so callers can rely on
 * `isExchangeEnabled` reflecting Redis state immediately afterward.
 *
 * Fails silently if Redis isn't reachable yet — the periodic refresh
 * will pick up state as soon as Redis comes back, and `isExchangeEnabled`
 * keeps returning `true` (open) in the meantime.
 */
export async function startAdminConfigSync(opts: SyncOpts = {}): Promise<void> {
  if (!ENABLED || started) return
  started = true

  const log = opts.log ?? (() => {})
  const redis: Redis = getRedis()
  const sub: Redis = getRedisSubscriber()

  async function refresh() {
    try {
      const raw = await redis.get(KEY)
      const next = parseRaw(raw)
      const prev = cache
      cache = next
      initialized = true
      if (!setEquals(prev, next)) {
        log('admin-config changed', {
          prev: prev ? Array.from(prev).sort() : null,
          next: next ? Array.from(next).sort() : null,
        })
        try {
          await opts.onChange?.(prev, next)
        } catch (err) {
          log('admin-config onChange threw', {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log('admin-config refresh failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await refresh()

  // Pubsub: low-latency notification when the user toggles in the UI.
  try {
    await sub.subscribe(CHANNEL)
    sub.on('message', (channel) => {
      if (channel === CHANNEL) {
        void refresh()
      }
    })
  } catch (err) {
    log('admin-config subscribe failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Periodic refresh as a safety net for dropped pubsub messages
  // (Redis restart, transient network drop, etc.).
  setInterval(() => {
    void refresh()
  }, REFRESH_MS).unref()
}
