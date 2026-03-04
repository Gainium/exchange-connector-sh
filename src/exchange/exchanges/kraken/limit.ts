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
 */

// REST API rate limiting
let restCounter = 0
let lastRestTime = Date.now()

// Using Intermediate tier as default (most common)
const REST_MAX_COUNTER = 20 // Intermediate/Pro tier
const REST_DECAY_RATE = 0.5 // Intermediate tier: -0.5 per second
const REST_CALL_COST = 1
const REST_HEAVY_CALL_COST = 2 // For ledger/history calls

// Matching engine limits per pair (simplified tracking)
const pairCounters = new Map<string, { counter: number; lastUpdate: number }>()
const MATCHING_ENGINE_THRESHOLD = 125 // Intermediate tier
const MATCHING_ENGINE_DECAY_RATE = 2.34 // Intermediate tier: -2.34 per second

// Cost estimates for matching engine (conservative approach)
const ADD_ORDER_COST = 1
const CANCEL_ORDER_COST = 8 // Worst case for fresh orders
const AMEND_ORDER_COST = 4 // Average case

class KrakenLimits {
  static instance: KrakenLimits

  static getInstance() {
    if (!KrakenLimits.instance) {
      KrakenLimits.instance = new KrakenLimits()
    }
    return KrakenLimits.instance
  }

  /**
   * Apply decay to REST counter based on elapsed time
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
   * Apply decay to matching engine counter for a specific pair
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
   * Check and wait for REST API rate limit
   */
  @IdMute(mutex, () => 'krakenRest')
  async checkRestLimit(cost: number = REST_CALL_COST): Promise<number> {
    this.applyRestDecay()

    const predictedCounter = restCounter + cost

    if (predictedCounter > REST_MAX_COUNTER) {
      // Calculate wait time needed
      const excess = predictedCounter - REST_MAX_COUNTER
      const waitTime = Math.ceil((excess / REST_DECAY_RATE) * 1000) + 100 // +100ms buffer
      return waitTime
    }

    restCounter = predictedCounter
    return 0
  }

  /**
   * Check and wait for matching engine rate limit (per pair)
   */
  @IdMute(mutex, (pair: string) => `krakenPair:${pair}`)
  async checkMatchingEngineLimit(
    pair: string,
    cost: number = ADD_ORDER_COST,
  ): Promise<number> {
    this.applyMatchingEngineDecay(pair)

    const pairData = pairCounters.get(pair) || {
      counter: 0,
      lastUpdate: Date.now(),
    }
    const predictedCounter = pairData.counter + cost

    if (predictedCounter > MATCHING_ENGINE_THRESHOLD) {
      // Calculate wait time needed
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
   * Add a standard REST API call
   */
  async addRestCall(isHeavy: boolean = false): Promise<number> {
    const cost = isHeavy ? REST_HEAVY_CALL_COST : REST_CALL_COST
    return this.checkRestLimit(cost)
  }

  /**
   * Add an order-related call (matching engine)
   */
  async addOrderCall(
    pair: string,
    type: 'add' | 'cancel' | 'amend',
  ): Promise<number> {
    const cost =
      type === 'add'
        ? ADD_ORDER_COST
        : type === 'cancel'
          ? CANCEL_ORDER_COST
          : AMEND_ORDER_COST

    // Check both REST and matching engine limits
    const restWait = await this.checkRestLimit(REST_CALL_COST)
    const engineWait = await this.checkMatchingEngineLimit(pair, cost)

    return Math.max(restWait, engineWait)
  }

  /**
   * Get current usage metrics
   */
  getUsage() {
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
}

export { ADD_ORDER_COST, CANCEL_ORDER_COST, AMEND_ORDER_COST }
