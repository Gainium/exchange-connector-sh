process.env.NODE_ENV = 'testing'

/**
 * Kraken Futures calls are charged against Kraken Futures' own budget, not the
 * spot model (spec 033).
 *
 * Kraken Futures publishes one private cost budget — "up to 500 every 10
 * seconds" — with a cost per endpoint (sendorder/cancelorder/editorder 10,
 * orders/status 1, openorders/accounts/openpositions/fills 2, fills with
 * lastFillTime 25), and public endpoints cost nothing
 * (https://docs.kraken.com/api/docs/guides/futures-rate-limits). Futures calls
 * were charged through the SPOT model — a 20-token REST bucket refilling at
 * 0.5/s plus the per-pair matching-engine counter — so a burst of order-status
 * reads queued at one call every ~2s per account with Kraken's budget nearly
 * untouched.
 *
 * Driven against the real `limit.ts` under a virtual clock, and through the
 * real `checkLimits` of a futures and a spot `KrakenExchange` with `sleep`
 * stubbed and recorded. No network.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { Futures } from '../../types'
import KrakenExchange from './index'
import limitHelper, {
  krakenFuturesCost,
  FUTURES_BUDGET,
  FUTURES_WINDOW_MS,
  REST_MAX_COUNTER,
} from './limit'

let VNOW = 0
let previousDateNow: () => number
let previousMode: string | undefined
const SETTLE_MS = 5 * 60 * 1000

let seq = 0
const freshKey = () => `futures-limit-acct-${++seq}`

const restUsage = () =>
  limitHelper.getUsage().find((x) => x.type === 'rest')?.value ?? 0
const futuresUsage = () =>
  limitHelper.getUsage().find((x) => x.type === 'krakenFutures')?.value ?? 0

/** Admit calls of `method` until one is refused; return how many went. */
async function admitted(method: string, accountKey: string, cap = 1000) {
  for (let n = 0; n < cap; n++) {
    if ((await limitHelper.addFuturesCall(method, accountKey)) > 0) return n
  }
  return cap
}

describe('Kraken Futures rate limit (spec 033)', () => {
  before(() => {
    previousDateNow = Date.now
    previousMode = process.env.KRAKEN_PER_ACCOUNT_LIMITS
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'true'
    VNOW = previousDateNow() + SETTLE_MS
    Date.now = () => VNOW
  })
  after(() => {
    VNOW += SETTLE_MS
    limitHelper.getUsage()
    Date.now = previousDateNow
    if (previousMode === undefined) delete process.env.KRAKEN_PER_ACCOUNT_LIMITS
    else process.env.KRAKEN_PER_ACCOUNT_LIMITS = previousMode
  })

  describe('§1.1.2 published per-endpoint costs', () => {
    it('charges the documented cost for each private endpoint', () => {
      assert.strictEqual(krakenFuturesCost('submitOrder'), 10)
      assert.strictEqual(krakenFuturesCost('cancelOrder'), 10)
      assert.strictEqual(krakenFuturesCost('amendOrder'), 10)
      assert.strictEqual(krakenFuturesCost('getOrders'), 1)
      assert.strictEqual(krakenFuturesCost('getOpenOrders'), 2)
      assert.strictEqual(krakenFuturesCost('getAccountBalance'), 2)
      assert.strictEqual(krakenFuturesCost('getOpenPositions'), 2)
      assert.strictEqual(krakenFuturesCost('getFills'), 2)
      assert.strictEqual(krakenFuturesCost('getFillsSince'), 25)
      assert.strictEqual(krakenFuturesCost('setLeverageSettings'), 10)
    })
    it('§1.1.3 public endpoints are free', () => {
      for (const m of ['getTicker', 'getTickers', 'getCandles']) {
        assert.strictEqual(krakenFuturesCost(m), 0, m)
      }
    })
    it('§1.1.4 an unlisted method is never free', () => {
      assert.strictEqual(krakenFuturesCost('someNewPrivateCall'), 10)
    })
  })

  describe('§1.1.1 500 per 10 seconds, per account', () => {
    it('admits 500 order-status reads in one burst, then refuses', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      assert.strictEqual(await admitted('getOrders', key), FUTURES_BUDGET)
    })

    it('admits 50 order placements in one burst (cost 10 each)', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      assert.strictEqual(await admitted('submitOrder', key), 50)
    })

    it('a refused call waits until enough of the window expires, then goes', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      const t0 = VNOW
      for (let i = 0; i < 25; i++) {
        assert.strictEqual(
          await limitHelper.addFuturesCall('submitOrder', key),
          0,
        )
        VNOW += 100
      }
      for (let i = 0; i < 25; i++) {
        assert.strictEqual(
          await limitHelper.addFuturesCall('submitOrder', key),
          0,
        )
      }
      const wait = await limitHelper.addFuturesCall('submitOrder', key)
      // Oldest spend (t0) expires at t0 + 10s; nothing earlier frees 10 units.
      assert.ok(wait > 0, 'refused once the window is full')
      assert.strictEqual(VNOW + wait, t0 + FUTURES_WINDOW_MS + 50)
      VNOW += wait
      assert.strictEqual(
        await limitHelper.addFuturesCall('submitOrder', key),
        0,
      )
    })

    it('a refused call spends nothing', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      await admitted('submitOrder', key)
      for (let i = 0; i < 10; i++) {
        assert.ok((await limitHelper.addFuturesCall('submitOrder', key)) > 0)
      }
      VNOW += FUTURES_WINDOW_MS
      assert.strictEqual(await admitted('submitOrder', key), 50)
    })

    it('accounts do not share a window', async () => {
      VNOW += SETTLE_MS
      const a = freshKey()
      const b = freshKey()
      await admitted('submitOrder', a)
      assert.strictEqual(await admitted('submitOrder', b), 50)
    })

    it('public calls are admitted on a full window', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      await admitted('submitOrder', key)
      assert.strictEqual(await limitHelper.addFuturesCall('getTicker', key), 0)
    })

    it('publishes the hottest window as krakenFutures usage', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      for (let i = 0; i < 25; i++) {
        await limitHelper.addFuturesCall('submitOrder', key)
      }
      assert.strictEqual(futuresUsage(), 0.5)
    })
  })

  describe('§1.1.5 a real apiLimitExceeded fills the window', () => {
    it('the next call waits a whole window', async () => {
      VNOW += SETTLE_MS
      const key = freshKey()
      limitHelper.noteFuturesRateLimited(key)
      const wait = await limitHelper.addFuturesCall('getOrders', key)
      assert.strictEqual(wait, FUTURES_WINDOW_MS + 50)
    })
  })

  describe('§1.1.6 checkLimits routes by product', () => {
    const sleeps: number[] = []
    let origSleep: (ms: number) => Promise<void>
    const sleepMod = require('../../../utils/sleepUtils')
    before(() => {
      origSleep = sleepMod.sleep
      sleepMod.sleep = async (ms: number) => {
        sleeps.push(ms)
        VNOW += ms
      }
    })
    after(() => {
      sleepMod.sleep = origSleep
    })

    it('a futures order-status burst neither waits nor touches the spot REST bucket', async () => {
      VNOW += SETTLE_MS
      sleeps.length = 0
      const ex: any = new KrakenExchange(Futures.usdm, freshKey(), 'c2VjcmV0')
      const restBefore = restUsage()
      for (let i = 0; i < 100; i++) {
        await ex.checkLimits('getOrders', 'BTC-USD')
      }
      assert.deepStrictEqual(sleeps, [])
      assert.strictEqual(restUsage(), restBefore)
    })

    it('a futures place+cancel storm of 25 pairs does not wait', async () => {
      VNOW += SETTLE_MS
      sleeps.length = 0
      const ex: any = new KrakenExchange(Futures.usdm, freshKey(), 'c2VjcmV0')
      for (let i = 0; i < 25; i++) {
        await ex.checkLimits('cancelOrder', 'BTC-USD')
        await ex.checkLimits('submitOrder', 'BTC-USD')
      }
      assert.deepStrictEqual(sleeps, [])
    })

    it('§1.1.7 spot keeps the spot model', async () => {
      VNOW += SETTLE_MS
      sleeps.length = 0
      const ex: any = new KrakenExchange(Futures.null, freshKey(), 'c2VjcmV0')
      const waitedAt: number[] = []
      for (let i = 0; i < REST_MAX_COUNTER + 1; i++) {
        const before = sleeps.length
        await ex.checkLimits('getOrders', 'BTC/USD')
        if (sleeps.length > before) waitedAt.push(i)
      }
      // The spot REST bucket holds REST_MAX_COUNTER tokens refilling at
      // 0.5/s; a burst one larger than that must wait.
      assert.ok(waitedAt.length > 0, 'a spot burst past the bucket waits')
      assert.ok(waitedAt[0] >= REST_MAX_COUNTER - 1, JSON.stringify(waitedAt))
    })
  })
})
