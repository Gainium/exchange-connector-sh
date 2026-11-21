process.env.NODE_ENV = 'testing'

/**
 * Spec 047 — Kraken spot order lookups report the time KRAKEN placed / last
 * changed the order, not the time we asked.
 *
 * `convertOrder` falls back to `Date.now()` for `transactTime` / `updateTime`
 * when the caller passes none, and none of the spot lookup paths passed one,
 * although every QueryOrders / OpenOrders / ClosedOrders row carries `opentm`
 * (and a closed row `closetm`) in fractional SECONDS. Every answer said "this
 * order last changed just now", so an old fill read as brand new to anything
 * comparing that time (did this fill land after its deal closed?).
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import KrakenExchange, { krakenSpotOrderTimes } from './index'

function check(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const TXID = 'OM2YHC-HWHJ2-ZLOW6O'
const CLIENT_ID = 'CMB-GR-aBcDeF12345'
// Days ago, fractional seconds as Kraken sends them: no `Date.now()` stand-in
// can pass for these.
const OPENTM = 1763421335.1234
const CLOSETM = 1763449741.5678
const PLACED = Math.round(OPENTM * 1000)
const CLOSED = Math.round(CLOSETM * 1000)

const row = (over: Record<string, unknown> = {}) => ({
  status: 'closed',
  userref: 0,
  cl_ord_id: CLIENT_ID,
  vol: '1',
  vol_exec: '1',
  price: '150',
  fee: '0.1',
  opentm: OPENTM,
  closetm: CLOSETM,
  descr: { pair: 'SOLUSD', price: '150', ordertype: 'limit', type: 'buy' },
  ...over,
})
const openRow = () => {
  const r: any = row({ status: 'open', vol_exec: '0', price: '0' })
  delete r.closetm
  return r
}

function makeExchange(stubs: Record<string, unknown>) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async (s: string) => s
  ex.retry = 0
  ex.spotClient = {
    getOrders: async () => ({ error: [], result: {} }),
    getOpenOrders: async () => ({ error: [], result: { open: {} } }),
    getClosedOrders: async () => ({ error: [], result: { closed: {} } }),
    ...stubs,
  }
  return ex
}

describe('spec 047 kraken spot order venue time', () => {
  describe('§2.1 QueryOrders by txid, a closed row', () => {
    let res: any
    before(async () => {
      res = await makeExchange({
        getOrders: async () => ({ error: [], result: { [TXID]: row() } }),
      }).getOrder({ symbol: 'SOLUSD', newClientOrderId: TXID })
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check('updateTime is closetm', () => res.data?.updateTime, CLOSED)
    check('transactTime is opentm', () => res.data?.transactTime, PLACED)
  })

  describe('§2.2 cl_ord_id open-orders scan, an open row', () => {
    let res: any
    let t0 = 0
    before(async () => {
      t0 = Date.now()
      res = await makeExchange({
        getOpenOrders: async () => ({
          error: [],
          result: { open: { [TXID]: openRow() } },
        }),
      }).getOrder({ symbol: 'SOLUSD', newClientOrderId: CLIENT_ID })
    })
    check('reports NEW', () => res.data?.status, 'NEW')
    check('transactTime is opentm', () => res.data?.transactTime, PLACED)
    check(
      'updateTime, with no close time, falls back to now (§2.4)',
      () => res.data?.updateTime >= t0,
      true,
    )
  })

  describe('§2.1 cl_ord_id closed-orders scan, a closed row', () => {
    let res: any
    before(async () => {
      res = await makeExchange({
        getClosedOrders: async () => ({
          error: [],
          result: { closed: { [TXID]: row() } },
        }),
      }).getOrder({ symbol: 'SOLUSD', newClientOrderId: CLIENT_ID })
    })
    check('reports FILLED', () => res.data?.status, 'FILLED')
    check('updateTime is closetm', () => res.data?.updateTime, CLOSED)
    check('transactTime is opentm', () => res.data?.transactTime, PLACED)
  })

  describe('§2.3 getAllOpenOrders', () => {
    let res: any
    before(async () => {
      res = await makeExchange({
        getOpenOrders: async () => ({
          error: [],
          result: { open: { [TXID]: openRow() } },
        }),
      }).getAllOpenOrders('SOLUSD', true)
    })
    check('transactTime is opentm', () => res.data?.[0]?.transactTime, PLACED)
  })

  describe('§2.5 krakenSpotOrderTimes', () => {
    check(
      'closed row',
      () => krakenSpotOrderTimes({ opentm: OPENTM, closetm: CLOSETM }),
      { transactTime: PLACED, updateTime: CLOSED },
    )
    check(
      'open row with lastupdated',
      () => krakenSpotOrderTimes({ opentm: OPENTM, lastupdated: CLOSETM }),
      { transactTime: PLACED, updateTime: CLOSED },
    )
    check('open row', () => krakenSpotOrderTimes({ opentm: OPENTM }), {
      transactTime: PLACED,
    })
    check(
      'closetm 0 is no time',
      () => krakenSpotOrderTimes({ opentm: OPENTM, closetm: 0 }),
      { transactTime: PLACED },
    )
    check('nothing', () => krakenSpotOrderTimes({}), {})
    check('garbage', () => krakenSpotOrderTimes({ opentm: 'x' }), {})
  })
})
