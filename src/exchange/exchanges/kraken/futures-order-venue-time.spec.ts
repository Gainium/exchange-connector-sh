process.env.NODE_ENV = 'testing'

/**
 * Spec 046 — Kraken Futures `getOrder` reports the time KRAKEN last changed
 * the order, not the time we asked.
 *
 * `futures_convertOrder` falls back to `Date.now()` for `updateTime` when the
 * caller passes none, and neither `getOrder` path passed one, so every answer
 * said "this order last changed just now". A consumer that compares that time
 * with something else (did this fill land after its deal closed?) read every
 * old fill as brand new.
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import KrakenExchange, { krakenFuturesTimeMs } from './index'

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

const CLI_ORD_ID = 'CMB-GR-TestTestTestTestTestTestTest'
const ORDER_ID = 'a31b327f-c7bb-479d-8f26-004cdfbb4849'
// Two days ago: far enough that a `Date.now()` stand-in cannot pass for it.
const PLACED = Date.parse('2026-11-17T23:15:35.000Z')
const FILLED = Date.parse('2026-11-18T07:09:01.000Z')

const historyOrder = (over: Record<string, unknown> = {}) => ({
  uid: ORDER_ID,
  clientId: CLI_ORD_ID,
  tradeable: 'PF_XRPUSD',
  direction: 'Sell',
  quantity: '37',
  filled: '0',
  limitPrice: '0.9896',
  orderType: 'lmt',
  reduceOnly: false,
  ...over,
})

function makeExchange(derivativesClient: Record<string, unknown>) {
  const ex: any = new KrakenExchange(Futures.usdm, '', '')
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async () => 'PF_XRPUSD'
  ex.futures_getAvgFillPrice = async () => 0.9896
  ex.futures_getFillTotals = async () => null
  ex.derivativesClient = {
    getOrderStatus: async () => ({ result: 'success', orders: [] }),
    getOrderEvents: async () => ({ elements: [] }),
    getFills: async () => ({ result: 'success', fills: [] }),
    ...derivativesClient,
  }
  return ex
}

const read = (ex: any) =>
  ex.getOrder({ symbol: 'XRP-USD', newClientOrderId: CLI_ORD_ID })

describe('spec 046 kraken futures getOrder venue time', () => {
  describe('§2.1 history path: the latest event time', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange({
          getOrderEvents: async () => ({
            elements: [
              {
                uid: 'ev-placed',
                timestamp: PLACED,
                event: {
                  OrderPlaced: { order: historyOrder(), reason: 'new' },
                },
              },
              {
                uid: 'ev-updated',
                timestamp: FILLED,
                event: {
                  OrderUpdated: {
                    oldOrder: historyOrder(),
                    newOrder: historyOrder({ filled: '37' }),
                    reason: 'full_fill',
                  },
                },
              },
            ],
          }),
        }),
      )
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check(
      'updateTime is the fill event time',
      () => res.data?.updateTime,
      FILLED,
    )
  })

  describe('§2.2 open-orders path: lastUpdateTimestamp', () => {
    let res: any
    before(async () => {
      res = await read(
        makeExchange({
          getOrderStatus: async () => ({
            result: 'success',
            orders: [
              {
                status: 'FULLY_EXECUTED',
                order: {
                  type: 'ORDER',
                  orderId: ORDER_ID,
                  cliOrdId: CLI_ORD_ID,
                  symbol: 'PF_XRPUSD',
                  side: 'sell',
                  quantity: 37,
                  filled: 37,
                  limitPrice: 0.9896,
                  reduceOnly: false,
                  timestamp: '2026-11-17T23:15:35.000Z',
                  lastUpdateTimestamp: '2026-11-18T07:09:01.000Z',
                },
              },
            ],
          }),
        }),
      )
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check(
      'updateTime is lastUpdateTimestamp',
      () => res.data?.updateTime,
      FILLED,
    )
    check(
      'transactTime is the placement time',
      () => res.data?.transactTime,
      PLACED,
    )
  })

  describe('§2.3 no time from Kraken: falls back to now', () => {
    let res: any
    let t0 = 0
    before(async () => {
      t0 = Date.now()
      res = await read(
        makeExchange({
          getOrderEvents: async () => ({
            elements: [
              {
                uid: 'ev-updated',
                event: {
                  OrderUpdated: {
                    oldOrder: historyOrder(),
                    newOrder: historyOrder({ filled: '37' }),
                    reason: 'full_fill',
                  },
                },
              },
            ],
          }),
        }),
      )
    })
    check(
      'updateTime is not before the call',
      () => res.data?.updateTime >= t0,
      true,
    )
  })

  describe('§2.4 krakenFuturesTimeMs', () => {
    check('epoch ms number', () => krakenFuturesTimeMs(FILLED), FILLED)
    check('epoch ms string', () => krakenFuturesTimeMs(String(FILLED)), FILLED)
    check(
      'ISO string',
      () => krakenFuturesTimeMs('2026-11-18T07:09:01.000Z'),
      FILLED,
    )
    check('missing', () => krakenFuturesTimeMs(undefined), undefined)
    check('null', () => krakenFuturesTimeMs(null), undefined)
    check('zero', () => krakenFuturesTimeMs(0), undefined)
    check('garbage', () => krakenFuturesTimeMs('nope'), undefined)
  })
})
