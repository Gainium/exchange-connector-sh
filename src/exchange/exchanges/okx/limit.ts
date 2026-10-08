import { IdMute, IdMutex } from '../../../utils/mutex'

const mutex = new IdMutex()

const limitsMap: Map<
  string,
  {
    frame: number
    frameCount: number
    usedCount: number
    lastTime: number
    perAccount: boolean
  }
> = new Map()

const weightQueueCounter = new Map<string, number>()

/**
 * OKX's documented limits for the private endpoints we call, per account (UID),
 * over a 2 s window. Public endpoints are limited per IP and keep the shared
 * per-process buckets their call sites pass in.
 *
 * Before these existed every private bucket was keyed by method name alone, so
 * one bucket per connector process was shared by every OKX account it served:
 * `getOrderDetails` was 25 per 3 s for all users together while OKX allows each
 * account 60 per 2 s per instrument. One account's burst of order lookups then
 * parked every other account's order placement for a full frame. Per-account buckets isolate accounts from each other and
 * track the budget OKX actually enforces.
 *
 * Order endpoints are per account AND instrument at OKX; they are kept per
 * account here, which is stricter and needs no symbol at the call site.
 */
export const OKX_PRIVATE_FRAME_MS = 2000
export const OKX_PRIVATE_LIMITS: Record<string, number> = {
  openOrder: 60,
  cancelOrder: 60,
  getOrderDetails: 60,
  getOrderList: 60,
  getBalance: 10,
  getPositions: 10,
  getAccountConfiguration: 5,
  setLeverage: 20,
  setPositionMode: 5,
  getFeeRates: 5,
}

/**
 * Connector instances one account's private calls may be spread over. The
 * balancer does not pin OKX accounts to an instance, so each process may only
 * spend its share of the account's budget. Set to 1 if OKX routing is made
 * account-sticky.
 */
const instances = () => {
  const n = Number(process.env.OKX_LIMIT_INSTANCES)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5
}

export const okxPrivateLimit = (
  method: string,
): { frame: number; frameCount: number } | null => {
  const count = OKX_PRIVATE_LIMITS[method]
  if (!count) {
    return null
  }
  return {
    frame: OKX_PRIVATE_FRAME_MS,
    frameCount: Math.max(1, Math.floor(count / instances())),
  }
}

const PRUNE_EVERY = 1000
let sincePrune = 0

/** Drop buckets idle for well over a window, so per-account keys don't accumulate. */
const prune = (time: number) => {
  for (const [id, limit] of limitsMap) {
    if (time - limit.lastTime > limit.frame * 10) {
      limitsMap.delete(id)
      weightQueueCounter.delete(id)
    }
  }
}

class Limit {
  /**
   * Count one call against bucket `id`. Returns 0 when it may go now, else how
   * long to wait: until the current window resets (plus a millisecond per
   * caller already parked, to spread the wake-ups), not a whole fresh frame.
   */
  @IdMute(mutex, () => 'okxLimit')
  async addMethod(
    id: string,
    frame: number,
    frameCount: number,
    perAccount = false,
  ) {
    const time = +new Date()
    if (++sincePrune >= PRUNE_EVERY) {
      sincePrune = 0
      prune(time)
    }
    if (!limitsMap.has(id)) {
      limitsMap.set(id, {
        frame,
        frameCount,
        usedCount: 1,
        lastTime: time,
        perAccount,
      })
      weightQueueCounter.set(id, 0)
      return 0
    } else {
      const limit = limitsMap.get(id)
      if (time - limit.lastTime > frame) {
        limit.usedCount = 1
        limit.lastTime = time
        weightQueueCounter.set(id, 0)
        return 0
      } else {
        limit.usedCount++
        if (limit.usedCount > frameCount) {
          const weight = weightQueueCounter.get(id) || 0
          weightQueueCounter.set(id, weight + 1)
          return Math.max(1, limit.lastTime + frame - time + 1) + weight
        }
      }
    }
    return 0
  }
}

/**
 * Reported to the balancer, which routes to the instance with the lowest value.
 * The shared buckets are summed as before; per-account buckets contribute only
 * the busiest one, so the figure doesn't grow with the number of accounts an
 * instance happens to serve.
 */
const getUsage = () => {
  const time = +new Date()
  let score = 0
  let account = 0
  for (const [_, limit] of limitsMap) {
    if (time - limit.lastTime > limit.frame) {
      continue
    }
    const ratio = limit.usedCount / limit.frameCount
    if (limit.perAccount) {
      account = Math.max(account, ratio)
    } else {
      score += ratio
    }
  }
  return [{ type: 'total', value: score + account }]
}

export default {
  Limit,
  getUsage,
  okxPrivateLimit,
}
