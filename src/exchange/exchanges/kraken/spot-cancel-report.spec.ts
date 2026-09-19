process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for spec `013` — Kraken spot's cancel reported a fabricated
 * order.
 *
 * Kraken spot's REST cancel carries no order detail (`{count}` only), so the
 * connector synthesised the `CommonOrder` it has to return: `price: '0'`,
 * `origQty: '0'`, `executedQty: '0'`, `type: 'LIMIT'`, `side: 'BUY'`.
 * main-app's `cancelOrderOnExchange` copies every field of that answer onto the
 * order row, so a cancelled SELL limit at 565.72 was persisted as a BUY at 0,
 * and a partial fill on a cancelled order was persisted as no fill at all.
 *
 * Driven over the REAL `cancelOrder` / `cancelOrderByOrderIdAndSymbol` with the
 * Kraken client stubbed — the synthesis is the property under test, so stubbing
 * anything closer would stub out the defect.
 *
 * Quantities and prices are the production ones; the identifiers are synthetic
 * because this file is public.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed.
 */
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const TXID = 'OAAAAA-BBBBB-CCCCCC'
const SYMBOL = 'XMR-USD'

/** The QueryOrders row for the take profit in spec 013 §2.2, as Kraken sends it. */
const restingSell = (over: Record<string, unknown> = {}) => ({
  status: 'open',
  userref: 13,
  cl_ord_id: 'D-TP-0000000000013',
  vol: '0.34749118',
  vol_exec: '0',
  price: '0',
  fee: '0',
  descr: {
    pair: 'XMRUSD',
    price: '565.72',
    ordertype: 'limit',
    type: 'sell',
  },
  ...over,
})

type Calls = { getOrders: number; cancelOrder: number }

/**
 * A spot connector wired to a stubbed Kraken. `getOrders` answers the
 * QueryOrders lookup — used BEFORE the cancel by `cancelOrder` (which resolves
 * the txid) and AFTER it by the direct-by-orderId entry, which has nothing in
 * hand. `answers` is consumed in order so the two can be told apart.
 */
function makeExchange(
  answers: Array<Record<string, unknown> | 'unknown' | 'failed'>,
  cancelResult: unknown = { error: [], result: { count: 1 } },
) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const calls: Calls = { getOrders: 0, cancelOrder: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async () => SYMBOL
  // The property under test is what the FIRST answer is rendered as, not how
  // many times a failure is re-asked.
  ex.retry = 0
  ex.spotClient = {
    getOrders: async () => {
      const answer = answers[Math.min(calls.getOrders, answers.length - 1)]
      calls.getOrders++
      if (answer === 'failed') {
        throw new Error('EService:Unavailable')
      }
      if (answer === 'unknown') {
        return { error: ['EOrder:Unknown order'], result: undefined }
      }
      return { error: [], result: { [TXID]: answer } }
    },
    cancelOrder: async () => {
      calls.cancelOrder++
      return cancelResult
    },
    getOpenOrders: async () => ({ error: [], result: { open: {} } }),
    getClosedOrders: async () => ({ error: [], result: { closed: {} } }),
  }
  return { ex, calls }
}

describe('kraken spot cancel report (spec 013)', () => {
  describe('§4.1 the engine path — the order we already read', () => {
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange([restingSell()])
      calls = made.calls
      // What main-app sends for kraken: the stored txid as the client order id.
      res = await made.ex.cancelOrder({
        symbol: SYMBOL,
        newClientOrderId: TXID,
      })
    })

    it('succeeds', () => {
      assert.strictEqual(res.status, StatusEnum.ok)
    })

    it('reports the price the order rested at, not 0', () => {
      assert.strictEqual(res.data.price, '565.72')
    })

    it('reports the side it was placed on, not BUY', () => {
      assert.strictEqual(res.data.side, 'SELL')
    })

    it('reports the quantity it was placed for, not 0', () => {
      assert.strictEqual(res.data.origQty, '0.34749118')
    })

    it('reports CANCELED — the one thing we observed', () => {
      assert.strictEqual(res.data.status, 'CANCELED')
    })

    it('keeps the txid it cancelled', () => {
      assert.strictEqual(`${res.data.orderId}`, TXID)
    })

    it('spends no extra venue call beyond the txid resolve', () => {
      assert.strictEqual(calls.cancelOrder, 1, 'cancels')
      assert.strictEqual(calls.getOrders, 1, 'QueryOrders lookups')
    })
  })

  describe('§4.1 a partially filled order keeps its fill', () => {
    it('reports what it traded, not 0', async () => {
      const { ex } = makeExchange([
        restingSell({ vol_exec: '0.17', price: '565.9' }),
      ])
      const res = await ex.cancelOrder({
        symbol: SYMBOL,
        newClientOrderId: TXID,
      })
      assert.strictEqual(res.data.executedQty, '0.17')
      // `price` on a (partly) executed Kraken order is the average fill price.
      assert.strictEqual(res.data.price, '565.9')
      assert.strictEqual(res.data.status, 'CANCELED')
    })
  })

  describe('§4.1 a MARKET order is not relabelled LIMIT', () => {
    it('reports the type it was placed as', async () => {
      const { ex } = makeExchange([
        restingSell({ descr: { ...restingSell().descr, ordertype: 'market' } }),
      ])
      const res = await ex.cancelOrder({
        symbol: SYMBOL,
        newClientOrderId: TXID,
      })
      assert.strictEqual(res.data.type, 'MARKET')
    })
  })

  describe('§4.2 the direct entry re-reads after the cancel', () => {
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange([restingSell({ status: 'canceled' })])
      calls = made.calls
      res = await made.ex.cancelOrderByOrderIdAndSymbol({
        symbol: SYMBOL,
        orderId: TXID,
      })
    })

    it('succeeds', () => {
      assert.strictEqual(res.status, StatusEnum.ok)
    })

    it('reports the real order', () => {
      assert.strictEqual(res.data.price, '565.72')
      assert.strictEqual(res.data.side, 'SELL')
      assert.strictEqual(res.data.origQty, '0.34749118')
      assert.strictEqual(res.data.status, 'CANCELED')
    })

    it('reads it once, after the cancel', () => {
      assert.strictEqual(calls.cancelOrder, 1, 'cancels')
      assert.strictEqual(calls.getOrders, 1, 'QueryOrders lookups')
    })
  })

  describe('§4.3 when nothing can be established', () => {
    for (const answer of ['unknown', 'failed'] as const) {
      describe(`the re-read came back ${answer}`, () => {
        let res: any

        before(async () => {
          const made = makeExchange([answer])
          res = await made.ex.cancelOrderByOrderIdAndSymbol({
            symbol: SYMBOL,
            orderId: TXID,
          })
        })

        it('still reports the cancel as a success', () => {
          assert.strictEqual(res.status, StatusEnum.ok)
          assert.strictEqual(res.data.status, 'CANCELED')
        })

        it('asserts nothing about what the order was or traded', () => {
          // main-app copies a field only when the response HAS it
          // (`hasOwnProperty`), so an absent field leaves the row alone.
          // Asserting '0' is what corrupted 3665 production rows.
          for (const key of ['price', 'executedQty', 'type', 'side']) {
            assert.strictEqual(
              Object.prototype.hasOwnProperty.call(res.data, key),
              false,
              `${key} must be absent, got ${JSON.stringify(res.data[key])}`,
            )
          }
        })

        it('still names the order it cancelled', () => {
          assert.strictEqual(`${res.data.orderId}`, TXID)
          assert.strictEqual(res.data.symbol, SYMBOL)
        })
      })
    }
  })

  describe('§4.4 a cancel the venue refused is still a failure', () => {
    it('does not report a cancel that did not happen', async () => {
      const { ex, calls } = makeExchange([restingSell()], {
        error: ['EOrder:Unknown order'],
        result: undefined,
      })
      const res = await ex.cancelOrderByOrderIdAndSymbol({
        symbol: SYMBOL,
        orderId: TXID,
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.ok(String(res.reason).includes('Unknown order'), res.reason)
      assert.strictEqual(
        calls.getOrders,
        0,
        'no re-read after a refused cancel',
      )
    })
  })
})
