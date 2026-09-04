import { IdMute, IdMutex } from '../../../utils/mutex'

const mutex = new IdMutex()

/**
 * WhiteBit REST API rate limits — spec 002 §2.6.
 *
 * Confirmed from WhiteBit's rate-limits page, and all three are enforced
 * **per IP address**, not per API key:
 *
 *   | bucket                     | limit          |
 *   |----------------------------|----------------|
 *   | public `/api/v1/*`         |  1,000 / 10s   |
 *   | private trade-account      | 12,000 / 10s   |
 *   | private main-account       |  1,000 / 10s   |
 *
 * Per-IP is why these counters are process-wide rather than per-account: unlike
 * Kraken (whose private budget is per API key, hence `kraken/limit.ts`'s
 * per-account map), every account served by this connector process shares one
 * WhiteBit budget, because they share one egress IP. A per-account counter here
 * would model the wrong thing and under-count the real constraint.
 *
 * ⚠️ TODO §2.6 — per-endpoint overrides. WhiteBit's rate-limits page states
 * that "scope-specific limits override the default where listed", and every
 * other venue in this repo has a tighter matching-engine budget than its general
 * REST budget. Order placement (`/api/v4/order/*`, `/api/v4/order/collateral/*`)
 * is the likely candidate for such an override, and the blanket 12,000/10s
 * trade-account figure below is therefore an UPPER bound for those endpoints,
 * not a confirmed one. This is deliberately not guessed at a tighter number —
 * a made-up ceiling is not safer than a documented one, it is just wrong in a
 * different direction. Resolve by reading the per-endpoint documentation for
 * the order endpoints, then split `order` out of `privateTrade` below.
 *
 * A single process-wide bucket per family, drained at `capacity / window` per
 * millisecond (a leaky bucket), which is the same shape as Kraken's decaying
 * counter and produces the same "how long until this call is admitted" answer.
 */

const WINDOW_MS = 10_000

type BucketName = 'public' | 'privateTrade' | 'privateMain'

const CAPACITY: Record<BucketName, number> = {
  public: 1000,
  privateTrade: 12000,
  privateMain: 1000,
}

/**
 * Headroom kept back from each published ceiling. Per-IP means the whole
 * connector process — and any sibling process on the same egress node — shares
 * these numbers, so running the counter to exactly 100% of the documented limit
 * is running it over.
 */
const SAFETY = 0.9

type BucketState = { counter: number; lastUpdate: number }

const buckets: Record<BucketName, BucketState> = {
  public: { counter: 0, lastUpdate: Date.now() },
  privateTrade: { counter: 0, lastUpdate: Date.now() },
  privateMain: { counter: 0, lastUpdate: Date.now() },
}

function effectiveMax(bucket: BucketName): number {
  return CAPACITY[bucket] * SAFETY
}

/** Requests the bucket recovers per millisecond. */
function decayPerMs(bucket: BucketName): number {
  return CAPACITY[bucket] / WINDOW_MS
}

function applyDecay(bucket: BucketName) {
  const state = buckets[bucket]
  const now = Date.now()
  const elapsed = now - state.lastUpdate
  if (elapsed > 0) {
    state.counter = Math.max(0, state.counter - elapsed * decayPerMs(bucket))
    state.lastUpdate = now
  }
}

class WhitebitLimits {
  static instance: WhitebitLimits

  static getInstance() {
    if (!WhitebitLimits.instance) {
      WhitebitLimits.instance = new WhitebitLimits()
    }
    return WhitebitLimits.instance
  }

  /**
   * Charge `cost` against `bucket`, or report how long to wait.
   *
   * Returns `0` when the call was admitted (and charged), or the number of
   * milliseconds after which the bucket will have room. A refused call is NOT
   * charged — the caller is expected to wait and re-ask, exactly as
   * `WhitebitExchange.checkLimits` does.
   */
  @IdMute(mutex, (bucket: BucketName) => `whitebit:${bucket}`)
  async check(bucket: BucketName, cost = 1): Promise<number> {
    applyDecay(bucket)
    const state = buckets[bucket]
    const max = effectiveMax(bucket)
    const predicted = state.counter + cost
    if (predicted > max) {
      const excess = predicted - max
      // +50ms buffer so the retry lands after the bucket has actually recovered
      // rather than exactly on the boundary.
      return Math.ceil(excess / decayPerMs(bucket)) + 50
    }
    state.counter = predicted
    return 0
  }

  /** An unauthenticated call (markets, tickers, candles, trades, funding). */
  async addPublicCall(cost = 1): Promise<number> {
    return this.check('public', cost)
  }

  /**
   * A signed trade-account call — balances, orders, order history, and the
   * whole `collateral-account` family.
   *
   * ⚠️ See the TODO §2.6 above: order placement may carry a tighter documented
   * override that this bucket does not yet model.
   */
  async addPrivateTradeCall(cost = 1): Promise<number> {
    return this.check('privateTrade', cost)
  }

  /** A signed main-account call — the fee-rate endpoints live here. */
  async addPrivateMainCall(cost = 1): Promise<number> {
    return this.check('privateMain', cost)
  }

  /**
   * Current usage for the `exchangeLimits` contract the balancer reads: one
   * `{type, value}` entry per bucket, each a ratio in [0,1] against that
   * bucket's effective ceiling.
   */
  getUsage() {
    const out: { type: string; value: number }[] = []
    for (const bucket of Object.keys(buckets) as BucketName[]) {
      applyDecay(bucket)
      out.push({
        type: bucket,
        value: buckets[bucket].counter / effectiveMax(bucket),
      })
    }
    return out
  }
}

const limits = WhitebitLimits.getInstance()

export default {
  addPublicCall: limits.addPublicCall.bind(limits),
  addPrivateTradeCall: limits.addPrivateTradeCall.bind(limits),
  addPrivateMainCall: limits.addPrivateMainCall.bind(limits),
  getUsage: limits.getUsage.bind(limits),
}

export { WINDOW_MS, CAPACITY, SAFETY }
