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

/**
 * Kraken's published matching-engine penalty for cancelling ONE order, by how
 * long that order has been resting
 * (https://docs.kraken.com/api/docs/guides/spot-ratelimits): `< 5s` +8,
 * `< 10s` +6, `< 15s` +5, `< 45s` +4, `< 90s` +2, `< 300s` +1, and **0** at or
 * above 300s. `[maxAgeSeconds, cost]`, first match wins.
 *
 * The flat {@link CANCEL_ORDER_COST} above is the `< 5s` worst case, which is
 * the only honest answer when the call site does not know the order's age. A
 * batch cancel DOES know it — it reads every order in the batch before
 * cancelling, and Kraken's `opentm` is on that row — so it can charge what
 * Kraken actually charges instead of the worst case for all of them.
 */
const CANCEL_COST_BY_AGE: ReadonlyArray<readonly [number, number]> = [
  [5, 8],
  [10, 6],
  [15, 5],
  [45, 4],
  [90, 2],
  [300, 1],
]

/**
 * The matching-engine cost of cancelling one order that has rested
 * `ageSeconds`. An age that is not a finite, non-negative number is charged the
 * worst case: an unknown age must never be cheaper than a known one, or an
 * unreadable `opentm` becomes a way to under-charge the budget.
 */
export function krakenCancelCostForAge(ageSeconds: number): number {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return CANCEL_ORDER_COST
  }
  for (const [maxAge, cost] of CANCEL_COST_BY_AGE) {
    if (ageSeconds < maxAge) {
      return cost
    }
  }
  return 0
}

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
   * The REST budget's verdict for one call: 0 if it may go now, else how long to
   * wait. `commit` decides whether the cost is actually spent — a probe reads
   * the same arithmetic without taking a token. Decay is applied either way;
   * decay is clock accounting, not spending.
   *
   * Synchronous and un-decorated on purpose: `addOrderCall` has to decide across
   * BOTH budgets without yielding, and the mutex is not reentrant.
   */
  private restVerdict(
    accountKey: string | undefined,
    cost: number,
    commit: boolean,
  ): number {
    if (perAccountEnabled() && accountKey) {
      const s = getRestState(accountKey)
      applyRestDecayState(s)
      const tier = TIERS[effectiveTier(s)]
      const predictedCounter = s.restCounter + cost
      if (predictedCounter > tier.max) {
        const excess = predictedCounter - tier.max
        return Math.ceil((excess / tier.decay) * 1000) + 100 // +100ms buffer
      }
      if (commit) s.restCounter = predictedCounter
      return 0
    }

    this.applyRestDecay()
    const predictedCounter = restCounter + cost
    if (predictedCounter > REST_MAX_COUNTER) {
      const excess = predictedCounter - REST_MAX_COUNTER
      return Math.ceil((excess / REST_DECAY_RATE) * 1000) + 100 // +100ms buffer
    }
    if (commit) restCounter = predictedCounter
    return 0
  }

  /**
   * The matching-engine budget's verdict for one call (per pair, and per account
   * when enabled — Kraken's matching-engine limits are per pair *per account*).
   * Same `commit` semantics as `restVerdict`.
   */
  private engineVerdict(
    accountKey: string | undefined,
    pair: string,
    cost: number,
    commit: boolean,
  ): number {
    if (perAccountEnabled() && accountKey) {
      const p = getPairState(`${accountKey}|${pair}`)
      applyPairDecayState(p)
      const predictedCounter = p.counter + cost
      if (predictedCounter > MATCHING_ENGINE_THRESHOLD) {
        const excess = predictedCounter - MATCHING_ENGINE_THRESHOLD
        return Math.ceil((excess / MATCHING_ENGINE_DECAY_RATE) * 1000) + 100
      }
      if (commit) {
        p.counter = predictedCounter
        p.lastUpdate = Date.now()
      }
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

    if (commit) {
      pairData.counter = predictedCounter
      pairData.lastUpdate = Date.now()
      pairCounters.set(pair, pairData)
    }

    return 0
  }

  /**
   * Is the pair's matching-engine counter, after decay, currently BELOW the
   * threshold? 0 when it is, else how long until it is.
   *
   * Deliberately NOT `engineVerdict`'s question. That one asks "does counter +
   * cost stay under the threshold", which is the right question for a call
   * Kraken would reject over the threshold. A batch cancel is not such a call:
   * Kraken accepts it and lets the counter overshoot. Asking the predicted
   * question about it is unanswerable rather than strict — 46 fresh orders cost
   * far more than the threshold of 125 on their own, so no amount of decay ever
   * admits them and `checkLimits` gives up after its bounded wait, every time.
   *
   * Same `commit`-free, synchronous contract as the two verdict helpers: the
   * caller decides across both budgets without yielding.
   */
  private engineBelowThreshold(
    accountKey: string | undefined,
    pair: string,
  ): number {
    const waitFrom = (counter: number) =>
      counter < MATCHING_ENGINE_THRESHOLD
        ? 0
        : Math.ceil(
            ((counter - MATCHING_ENGINE_THRESHOLD) /
              MATCHING_ENGINE_DECAY_RATE) *
              1000,
          ) + 100 // +100ms buffer

    if (perAccountEnabled() && accountKey) {
      const p = getPairState(`${accountKey}|${pair}`)
      applyPairDecayState(p)
      return waitFrom(p.counter)
    }

    this.applyMatchingEngineDecay(pair)
    return waitFrom(pairCounters.get(pair)?.counter ?? 0)
  }

  /**
   * Spend `cost` on the pair's matching-engine counter unconditionally — the
   * commit half of {@link engineBelowThreshold}. The counter may end up ABOVE
   * the threshold, which is correct and is the whole point: Kraken's own
   * counter does exactly that, and carrying the overshoot is what delays the
   * following calls on this pair by as long as Kraken will delay them.
   */
  private engineCharge(
    accountKey: string | undefined,
    pair: string,
    cost: number,
  ) {
    if (perAccountEnabled() && accountKey) {
      const p = getPairState(`${accountKey}|${pair}`)
      applyPairDecayState(p)
      p.counter += cost
      p.lastUpdate = Date.now()
      return
    }

    this.applyMatchingEngineDecay(pair)
    const pairData = pairCounters.get(pair) || {
      counter: 0,
      lastUpdate: Date.now(),
    }
    pairData.counter += cost
    pairData.lastUpdate = Date.now()
    pairCounters.set(pair, pairData)
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
    return this.restVerdict(accountKey, cost, true)
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
   * Add an order-related call. Kraken meters it against TWO budgets — the
   * per-key REST counter and the per-pair matching-engine counter — and the
   * call only reaches the venue when both admit.
   *
   * So the two are spent together or not at all. Asking each in turn and
   * letting whichever admits charge itself meant a call the caller was told to
   * DEFER still took a token in the other bucket; `checkLimits` re-asks until
   * the budget admits it (index.ts), so that token was taken again on every
   * attempt. Measured on the shipped module, one sent call cost 1.70 REST
   * tokens on the cancel path and 2.00 matching-engine charges on the add path
   * — surplus load Kraken never saw, paced against a bucket that refills at
   * 0.33-0.5/s.
   *
   * Probe, then commit, with no `await` in between: the decision is atomic
   * under this method's own mutex, so nothing can take the last token between
   * the two. The mutex key is the account's REST key — plain REST calls share
   * that bucket and must serialise against this.
   */
  @IdMute(
    mutex,
    (_pair: string, _type: string, accountKey?: string) =>
      `krakenRest:${accountKey ?? 'global'}`,
  )
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

    const restWait = this.restVerdict(accountKey, REST_CALL_COST, false)
    const engineWait = this.engineVerdict(accountKey, pair, cost, false)
    if (restWait > 0 || engineWait > 0) {
      return Math.max(restWait, engineWait)
    }

    this.restVerdict(accountKey, REST_CALL_COST, true)
    this.engineVerdict(accountKey, pair, cost, true)
    return 0
  }

  /**
   * One BATCH order call — `AddOrderBatch` or `CancelOrderBatch`. Same two
   * budgets and the same probe-then-commit atomicity as {@link addOrderCall}
   * (both spent together or not at all, no `await` between the probe and the
   * commit, under the same account-scoped mutex), with two differences that are
   * Kraken's, not ours:
   *
   * - **REST is ONE call.** A batch carrying 50 ids costs the per-key counter
   *   the same +1 as a batch carrying 2. Not spending 50 tokens out of a
   *   20-token bucket refilling at 0.5/s is the entire reason batching exists.
   * - **The matching-engine cost is the caller's**, because only the caller
   *   knows it: one per order for an add, and the sum of the per-order
   *   age-scaled cancel costs ({@link krakenCancelCostForAge}) for a cancel.
   *
   * An `add` is admitted on the ordinary predicted-counter check — Kraken caps
   * a batch at 15 orders (+1 each) against a threshold of 125, so it always
   * fits once the counter has decayed far enough. A `cancel` is admitted
   * whenever the counter is currently below the threshold, and then charged in
   * full: see {@link engineBelowThreshold} for why the predicted check cannot
   * be used for it.
   */
  @IdMute(
    mutex,
    (_pair: string, _type: string, _engineCost: number, accountKey?: string) =>
      `krakenRest:${accountKey ?? 'global'}`,
  )
  async addOrderBatchCall(
    pair: string,
    type: 'add' | 'cancel',
    engineCost: number,
    accountKey?: string,
  ): Promise<number> {
    const restWait = this.restVerdict(accountKey, REST_CALL_COST, false)
    const engineWait =
      type === 'add'
        ? this.engineVerdict(accountKey, pair, engineCost, false)
        : this.engineBelowThreshold(accountKey, pair)
    if (restWait > 0 || engineWait > 0) {
      return Math.max(restWait, engineWait)
    }

    this.restVerdict(accountKey, REST_CALL_COST, true)
    this.engineCharge(accountKey, pair, engineCost)
    return 0
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
  addOrderBatchCall: limits.addOrderBatchCall.bind(limits),
  getUsage: limits.getUsage.bind(limits),
  noteRateLimited: limits.noteRateLimited.bind(limits),
}

export {
  ADD_ORDER_COST,
  CANCEL_ORDER_COST,
  AMEND_ORDER_COST,
  REST_MAX_COUNTER,
  MATCHING_ENGINE_THRESHOLD,
}
