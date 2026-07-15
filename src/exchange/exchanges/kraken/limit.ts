import { IdMute, IdMutex } from '../../../utils/mutex'

const mutex = new IdMutex()

/**
 * Kraken REST API Rate Limits
 * https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits
 *
 * Tiers (Starter | Intermediate | Pro):
 * - Max counter: 15 | 20 | 20
 * - Decay rate: -0.33/sec | -0.5/sec | -1/sec
 * - Most calls: +1, Ledger/History calls: +2
 *
 * Matching Engine Rate Limits (per pair):
 * https://docs.kraken.com/api/docs/guides/spot-ratelimits
 * - Decay rates: -1 | -2.34 | -3.75 per second
 * - Thresholds: 60 | 125 | 180
 *
 * Kraken's private-REST limits are enforced **per API key**, not per source IP.
 * The historical implementation used one process-wide counter shared by every
 * account served by a connector instance — too strict in aggregate (all users
 * fight over one 0.5 req/s budget → balancer "rest" bars pinned, `/order`
 * timeouts) and too lenient per account (a hot key blows its own Kraken budget
 * while the global counter still shows headroom → `EAPI:Rate limit exceeded`).
 *
 * When `KRAKEN_PER_ACCOUNT_LIMITS=true`, this module keeps a per-account counter
 * map instead (accountKey = a short hash of the API key; the key itself is never
 * stored). This is only correct when the balancer routes an account's private
 * calls to a single connector instance (`KRAKEN_STICKY_ROUTING`, Option A in
 * the scoping doc) so each process sees the whole of an account's usage. With
 * the flag off, behaviour is byte-for-byte the legacy global counter.
 */

// ── Tier definitions ────────────────────────────────────────────────────────
type TierName = 'starter' | 'intermediate'
const TIERS: Record<TierName, { max: number; decay: number }> = {
  starter: { max: 15, decay: 0.33 },
  intermediate: { max: 20, decay: 0.5 },
  // Pro (20 @ 1/s) is never auto-selected; Intermediate is the safe default and
  // we only ever *downgrade* to Starter, never assume a higher tier we can't see.
}
const DEFAULT_TIER: TierName = 'intermediate'
// After a real `EAPI:Rate limit exceeded`, drop an account to Starter for this
// long, then probe back up to the default tier. Self-heals without needing to
// know the account's true tier.
const TIER_DOWNGRADE_MS = 60 * 60 * 1000 // 1h cooldown

const REST_CALL_COST = 1
const REST_HEAVY_CALL_COST = 2 // For ledger/history calls

// Legacy global-counter constants (used only when per-account is OFF). Kept
// identical to the historical values so flag-off behaviour is unchanged.
let restCounter = 0
let lastRestTime = Date.now()
const REST_MAX_COUNTER = TIERS.intermediate.max
const REST_DECAY_RATE = TIERS.intermediate.decay

// Matching engine limits per pair (Intermediate tier).
const pairCounters = new Map<string, { counter: number; lastUpdate: number }>()
const MATCHING_ENGINE_THRESHOLD = 125 // Intermediate tier
const MATCHING_ENGINE_DECAY_RATE = 2.34 // Intermediate tier: -2.34 per second

// Cost estimates for matching engine (conservative approach)
const ADD_ORDER_COST = 1
const CANCEL_ORDER_COST = 8 // Worst case for fresh orders
const AMEND_ORDER_COST = 4 // Average case

// ── Per-account state (used only when KRAKEN_PER_ACCOUNT_LIMITS=true) ─────────
type RestState = {
  restCounter: number
  lastRestTime: number
  lastAccess: number
  tier: TierName
  // Timestamp when the Starter downgrade expires (0 = at default tier).
  tierUntil: number
}
type PairState = { counter: number; lastUpdate: number; lastAccess: number }

// LRU by Map insertion order; TTL sweep drops idle accounts so quiet keys don't
// leak memory. Bounds are generous — the working set per instance is
// (accounts hashed here) which sticky routing keeps to ~fleet/instances.
const ACCOUNT_TTL_MS = 10 * 60 * 1000 // evict account state idle > 10min
const MAX_ACCOUNTS = 5000
const MAX_ACCOUNT_PAIRS = 20000
const SWEEP_INTERVAL_MS = 30 * 1000

const accountRest = new Map<string, RestState>()
const accountPairs = new Map<string, PairState>() // key = `${accountKey}|${pair}`

function perAccountEnabled(): boolean {
  return process.env.KRAKEN_PER_ACCOUNT_LIMITS === 'true'
}

// Resolve the effective tier, auto-probing back up once the Starter cooldown
// has elapsed. Mutates `s` so the promotion sticks.
function effectiveTier(s: RestState): TierName {
  if (s.tier !== DEFAULT_TIER && s.tierUntil && Date.now() >= s.tierUntil) {
    s.tier = DEFAULT_TIER
    s.tierUntil = 0
  }
  return s.tier
}

function getRestState(accountKey: string): RestState {
  const existing = accountRest.get(accountKey)
  if (existing) {
    // Move to MRU end for LRU ordering.
    accountRest.delete(accountKey)
    accountRest.set(accountKey, existing)
    return existing
  }
  const now = Date.now()
  const state: RestState = {
    restCounter: 0,
    lastRestTime: now,
    lastAccess: now,
    tier: DEFAULT_TIER,
    tierUntil: 0,
  }
  accountRest.set(accountKey, state)
  if (accountRest.size > MAX_ACCOUNTS) {
    const oldest = accountRest.keys().next().value
    if (oldest !== undefined) accountRest.delete(oldest)
  }
  return state
}

function getPairState(key: string): PairState {
  const existing = accountPairs.get(key)
  if (existing) {
    accountPairs.delete(key)
    accountPairs.set(key, existing)
    return existing
  }
  const now = Date.now()
  const state: PairState = { counter: 0, lastUpdate: now, lastAccess: now }
  accountPairs.set(key, state)
  if (accountPairs.size > MAX_ACCOUNT_PAIRS) {
    const oldest = accountPairs.keys().next().value
    if (oldest !== undefined) accountPairs.delete(oldest)
  }
  return state
}

let lastSweep = 0
function sweepIfDue() {
  const now = Date.now()
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [k, s] of accountRest) {
    if (now - s.lastAccess > ACCOUNT_TTL_MS) accountRest.delete(k)
  }
  for (const [k, p] of accountPairs) {
    if (now - p.lastAccess > ACCOUNT_TTL_MS) accountPairs.delete(k)
  }
}

function applyRestDecayState(s: RestState) {
  const now = Date.now()
  const elapsedSeconds = (now - s.lastRestTime) / 1000
  if (elapsedSeconds > 0) {
    const decay = elapsedSeconds * TIERS[effectiveTier(s)].decay
    s.restCounter = Math.max(0, s.restCounter - decay)
    s.lastRestTime = now
  }
  s.lastAccess = now
}

function applyPairDecayState(p: PairState) {
  const now = Date.now()
  const elapsedSeconds = (now - p.lastUpdate) / 1000
  if (elapsedSeconds > 0) {
    const decay = elapsedSeconds * MATCHING_ENGINE_DECAY_RATE
    p.counter = Math.max(0, p.counter - decay)
    p.lastUpdate = now
  }
  p.lastAccess = now
}

class KrakenLimits {
  static instance: KrakenLimits

  static getInstance() {
    if (!KrakenLimits.instance) {
      KrakenLimits.instance = new KrakenLimits()
    }
    return KrakenLimits.instance
  }

  /**
   * Apply decay to the legacy global REST counter based on elapsed time.
   */
  private applyRestDecay() {
    const now = Date.now()
    const elapsedSeconds = (now - lastRestTime) / 1000

    if (elapsedSeconds > 0) {
      const decay = elapsedSeconds * REST_DECAY_RATE
      restCounter = Math.max(0, restCounter - decay)
      lastRestTime = now
    }
  }

  /**
   * Apply decay to the legacy global matching-engine counter for a pair.
   */
  private applyMatchingEngineDecay(pair: string) {
    const now = Date.now()
    const pairData = pairCounters.get(pair)

    if (pairData) {
      const elapsedSeconds = (now - pairData.lastUpdate) / 1000

      if (elapsedSeconds > 0) {
        const decay = elapsedSeconds * MATCHING_ENGINE_DECAY_RATE
        pairData.counter = Math.max(0, pairData.counter - decay)
        pairData.lastUpdate = now
      }
    }
  }

  /**
   * Check and wait for REST API rate limit. When `accountKey` is provided and
   * per-account limits are enabled, the budget is tracked for that key alone;
   * otherwise it falls back to the process-wide global counter. The mutex key
   * is scoped to the account so distinct accounts don't serialize each other.
   */
  @IdMute(
    mutex,
    (accountKey?: string) => `krakenRest:${accountKey ?? 'global'}`,
  )
  async checkRestLimit(
    accountKey?: string,
    cost: number = REST_CALL_COST,
  ): Promise<number> {
    if (perAccountEnabled() && accountKey) {
      const s = getRestState(accountKey)
      applyRestDecayState(s)
      const tier = TIERS[effectiveTier(s)]
      const predictedCounter = s.restCounter + cost
      if (predictedCounter > tier.max) {
        const excess = predictedCounter - tier.max
        return Math.ceil((excess / tier.decay) * 1000) + 100 // +100ms buffer
      }
      s.restCounter = predictedCounter
      return 0
    }

    this.applyRestDecay()
    const predictedCounter = restCounter + cost
    if (predictedCounter > REST_MAX_COUNTER) {
      const excess = predictedCounter - REST_MAX_COUNTER
      return Math.ceil((excess / REST_DECAY_RATE) * 1000) + 100 // +100ms buffer
    }
    restCounter = predictedCounter
    return 0
  }

  /**
   * Check and wait for matching engine rate limit (per pair, and per account
   * when enabled — Kraken's matching-engine limits are per pair *per account*).
   */
  @IdMute(
    mutex,
    (accountKey: string | undefined, pair: string) =>
      `krakenPair:${accountKey ?? 'global'}:${pair}`,
  )
  async checkMatchingEngineLimit(
    accountKey: string | undefined,
    pair: string,
    cost: number = ADD_ORDER_COST,
  ): Promise<number> {
    if (perAccountEnabled() && accountKey) {
      const p = getPairState(`${accountKey}|${pair}`)
      applyPairDecayState(p)
      const predictedCounter = p.counter + cost
      if (predictedCounter > MATCHING_ENGINE_THRESHOLD) {
        const excess = predictedCounter - MATCHING_ENGINE_THRESHOLD
        return Math.ceil((excess / MATCHING_ENGINE_DECAY_RATE) * 1000) + 100
      }
      p.counter = predictedCounter
      p.lastUpdate = Date.now()
      return 0
    }

    this.applyMatchingEngineDecay(pair)

    const pairData = pairCounters.get(pair) || {
      counter: 0,
      lastUpdate: Date.now(),
    }
    const predictedCounter = pairData.counter + cost

    if (predictedCounter > MATCHING_ENGINE_THRESHOLD) {
      const excess = predictedCounter - MATCHING_ENGINE_THRESHOLD
      const waitTime =
        Math.ceil((excess / MATCHING_ENGINE_DECAY_RATE) * 1000) + 100 // +100ms buffer

      pairCounters.set(pair, pairData)
      return waitTime
    }

    pairData.counter = predictedCounter
    pairData.lastUpdate = Date.now()
    pairCounters.set(pair, pairData)

    return 0
  }

  /**
   * Add a standard REST API call.
   */
  async addRestCall(
    isHeavy: boolean = false,
    accountKey?: string,
  ): Promise<number> {
    const cost = isHeavy ? REST_HEAVY_CALL_COST : REST_CALL_COST
    return this.checkRestLimit(accountKey, cost)
  }

  /**
   * Add an order-related call (matching engine).
   */
  async addOrderCall(
    pair: string,
    type: 'add' | 'cancel' | 'amend',
    accountKey?: string,
  ): Promise<number> {
    const cost =
      type === 'add'
        ? ADD_ORDER_COST
        : type === 'cancel'
          ? CANCEL_ORDER_COST
          : AMEND_ORDER_COST

    // Check both REST and matching engine limits
    const restWait = await this.checkRestLimit(accountKey, REST_CALL_COST)
    const engineWait = await this.checkMatchingEngineLimit(
      accountKey,
      pair,
      cost,
    )

    return Math.max(restWait, engineWait)
  }

  /**
   * Record a real Kraken rate-limit rejection for an account: downgrade it to
   * the Starter tier for a cooldown window, then it probes back up. No-op when
   * per-account limits are disabled or the account is unknown.
   */
  noteRateLimited(accountKey?: string) {
    if (!perAccountEnabled() || !accountKey) return
    const s = getRestState(accountKey)
    s.tier = 'starter'
    s.tierUntil = Date.now() + TIER_DOWNGRADE_MS
  }

  /**
   * Get current usage metrics for the `exchangeLimits` contract (Danger List
   * #7). The array shape is unchanged — `rest` + `matching_engine` ratios in
   * [0,1]. In per-account mode the published value is `max(perAccountUsage)`
   * (the hottest account bounding the instance), so the balancer's congestion
   * signal means "the hottest account's pressure" — which is what throttling
   * decisions actually need. A `krakenAccounts` entry carries the tracked count
   * (ignored by the balancer's type filter; visible on the admin dashboard).
   */
  getUsage() {
    if (perAccountEnabled()) {
      sweepIfDue()

      let maxRest = 0
      for (const s of accountRest.values()) {
        applyRestDecayState(s)
        maxRest = Math.max(maxRest, s.restCounter / TIERS[effectiveTier(s)].max)
      }

      let maxPair = 0
      for (const p of accountPairs.values()) {
        applyPairDecayState(p)
        maxPair = Math.max(maxPair, p.counter / MATCHING_ENGINE_THRESHOLD)
      }

      return [
        { type: 'rest', value: maxRest },
        { type: 'matching_engine', value: maxPair },
        { type: 'krakenAccounts', value: accountRest.size },
      ]
    }

    this.applyRestDecay()

    const restUsage = restCounter / REST_MAX_COUNTER

    // Calculate average matching engine usage across all pairs
    let totalPairUsage = 0
    let pairCount = 0

    for (const [pair, _] of pairCounters) {
      this.applyMatchingEngineDecay(pair)
      const pairData = pairCounters.get(pair)
      if (pairData) {
        totalPairUsage += pairData.counter / MATCHING_ENGINE_THRESHOLD
        pairCount++
      }
    }

    const avgPairUsage = pairCount > 0 ? totalPairUsage / pairCount : 0

    return [
      { type: 'rest', value: restUsage },
      { type: 'matching_engine', value: avgPairUsage },
    ]
  }
}

const limits = KrakenLimits.getInstance()

export default {
  addRestCall: limits.addRestCall.bind(limits),
  addOrderCall: limits.addOrderCall.bind(limits),
  getUsage: limits.getUsage.bind(limits),
  noteRateLimited: limits.noteRateLimited.bind(limits),
}

export { ADD_ORDER_COST, CANCEL_ORDER_COST, AMEND_ORDER_COST }
