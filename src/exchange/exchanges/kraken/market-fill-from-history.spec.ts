process.env.NODE_ENV = 'testing'

/**
 * Kraken Futures `getOrder` history fallback must report what an order
 * finally executed, not its placement snapshot.
 *
 * `getOrderStatus` only knows orders that are open or finished in the last
 * five seconds, so a MARKET order is read back from `getOrderEvents`. The
 * fallback used to take the first `OrderPlaced` event — the instant of
 * acceptance — so a MARKET order that executed 0.0042 on placement and the
 * remaining 0.132 a moment later was reported PARTIALLY_FILLED at 0.0042, on
 * every lookup, for as long as anyone asked. With the user stream down that
 * was the only answer the bot ever got: the deal stayed in start and the real
 * position was left on the venue untracked.
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import KrakenExchange, { krakenLatestHistoryState } from './index'

function check(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const CLI_ORD_ID = 'D-BO-QLSGvQo264Fj9KZlmNpVX7ZnCat0NR'
const ORDER_ID = 'a31b327f-c7bb-479d-8f26-004cdfbb4849'
const T0 = Date.now() - 10 * 60 * 1000

const historyOrder = (over: Record<string, unknown> = {}) => ({
  uid: ORDER_ID,
  clientId: CLI_ORD_ID,
  tradeable: 'PF_XBTUSD',
  direction: 'Buy',
  quantity: '0.1362',
  filled: '0.0042',
  limitPrice: '77100',
  orderType: 'IoC',
  reduceOnly: false,
  ...over,
})

const placed = (over: Record<string, unknown> = {}) => ({
  uid: 'ev-placed',
  timestamp: T0,
  event: {
    OrderPlaced: { order: historyOrder(over), reason: 'new_user_order' },
  },
})
const updated = (over: Record<string, unknown>, dt = 5) => ({
  uid: 'ev-updated',
  timestamp: T0 + dt,
  event: {
    OrderUpdated: {
      oldOrder: historyOrder(),
      newOrder: historyOrder(over),
      reason: 'full_fill',
    },
  },
})
const cancelled = (over: Record<string, unknown>, dt = 10) => ({
  uid: 'ev-cancelled',
  timestamp: T0 + dt,
  event: { OrderCancelled: { order: historyOrder(over), reason: 'ioc' } },
})

/** A connector whose live view no longer knows the order. */
function makeExchange(historyElements: unknown[], fills: unknown[] = []) {
  const ex: any = new KrakenExchange(Futures.usdm, '', '')
  const calls = { getFills: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async () => 'PF_XBTUSD'
  ex.derivativesClient = {
    getOrderStatus: async () => ({ result: 'success', orders: [] }),
    getOrderEvents: async () => ({ elements: historyElements }),
    getFills: async () => {
      calls.getFills++
      return { result: 'success', fills }
    },
  }
  return { ex, calls }
}

const read = (ex: any) =>
  ex.getOrder({ symbol: 'BTC-USD', newClientOrderId: CLI_ORD_ID })

describe('kraken market-fill-from-history', () => {
  // --- the bug: a later fill update was ignored --------------------------------
  describe('placement snapshot followed by a full-fill update', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange([placed(), updated({ filled: '0.1362' })]).ex,
      )
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check('reports the full size', () => res.data?.executedQty, '0.1362')
  })

  // Kraken returns the newest event first; order of elements must not matter.
  describe('update listed before the placement', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange([updated({ filled: '0.1362' }), placed()]).ex,
      )
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
  })

  // --- history trails the venue: the account fills settle it -------------------
  describe('only the placement snapshot, fills show the rest', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange(
          [placed()],
          [
            {
              cliOrdId: CLI_ORD_ID,
              order_id: ORDER_ID,
              price: 77050,
              size: 0.0042,
            },
            {
              cliOrdId: CLI_ORD_ID,
              order_id: ORDER_ID,
              price: 77056.2,
              size: 0.132,
            },
            { cliOrdId: 'someone-else', order_id: 'x', price: 1, size: 9 },
          ],
        ).ex,
      )
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check(
      'reports the size the fills add up to',
      () => res.data?.executedQty,
      '0.1362',
    )
    check(
      'prices it from the fills',
      () => Math.round(+res.data?.avgPrice * 100) / 100,
      77056.01,
    )
  })

  // --- no regression ------------------------------------------------------------
  describe('a genuine partial with no further fills', () => {
    let res: any
    before(async () => {
      res = await read(makeExchange([placed()]).ex)
    })
    check('still PARTIALLY_FILLED', () => res.data?.status, 'PARTIALLY_FILLED')
    check('at what really executed', () => res.data?.executedQty, '0.0042')
  })

  describe('cancelled after a partial', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange([placed(), cancelled({ filled: '0.05' })]).ex,
      )
    })
    check('reports CANCELED', () => res.data?.status, 'CANCELED')
    check('keeps the executed part', () => res.data?.executedQty, '0.05')
  })

  describe('fully filled per history', () => {
    let calls: { getFills: number }
    before(async () => {
      const m = makeExchange([updated({ filled: '0.1362' })])
      calls = m.calls
      await read(m.ex)
    })
    // One fills read for the price, none for the size.
    check('reads fills once', () => calls.getFills, 1)
  })

  describe('krakenLatestHistoryState', () => {
    check(
      'ignores other client ids',
      () =>
        krakenLatestHistoryState([placed({ clientId: 'other' })], CLI_ORD_ID),
      null,
    )
    check(
      'terminal beats update at the same timestamp',
      () =>
        krakenLatestHistoryState(
          [updated({ filled: '0.1' }, 7), cancelled({ filled: '0.1' }, 7)],
          CLI_ORD_ID,
        )?.kind,
      'cancelled',
    )
  })
})
