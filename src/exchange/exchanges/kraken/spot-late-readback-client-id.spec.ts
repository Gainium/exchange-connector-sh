process.env.NODE_ENV = 'testing'

/**
 * Spec 039: when QueryOrders lags a just-placed spot order past the three
 * read-back tries, `openOrder` falls back to `getOrder` by txid. That answer
 * must still carry the client order id the caller sent, not the txid.
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const TXID = 'OZZZZZ-11111-ZZZZZZ'
const CLIENT_ID = 'CMB-GR-aBcDeF12345'

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

const resting = {
  status: 'open',
  userref: 0,
  vol: '1',
  vol_exec: '0',
  price: '0',
  fee: '0',
  descr: { pair: 'SOLUSD', price: '150', ordertype: 'limit', type: 'buy' },
}

/**
 * QueryOrders misses the first `misses` asks, then sees the order. Three
 * misses exhaust `openOrder`'s own read-back, so the fourth ask is the
 * last-resort `getOrder`.
 */
function makeExchange(
  misses: number,
  lastResort: () => unknown = () => ({
    error: [],
    result: { [TXID]: resting },
  }),
  txids: string[] = [TXID],
) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const calls = { getOrders: 0, getOpenOrders: 0, getClosedOrders: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async (s: string) => s
  ex.retry = 0
  ex.spotClient = {
    submitOrder: async () => ({ error: [], result: { txid: txids } }),
    getOrders: async () => {
      calls.getOrders++
      return calls.getOrders <= misses
        ? { error: [], result: {} }
        : lastResort()
    },
    getOpenOrders: async () => {
      calls.getOpenOrders++
      return { error: [], result: { open: {} } }
    },
    getClosedOrders: async () => {
      calls.getClosedOrders++
      return { error: [], result: { closed: {} } }
    },
  }
  return { ex, calls }
}

const place = (ex: any, newClientOrderId?: string) =>
  ex.openOrder({
    symbol: 'SOLUSD',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 1,
    price: 150,
    newClientOrderId,
  })

describe('kraken spot openOrder: late read-back keeps the client id (039)', () => {
  describe('read back on the first try (control)', () => {
    const { ex } = makeExchange(0)
    let res: any
    before(async () => {
      res = await place(ex, CLIENT_ID)
    })
    check(
      'answers with the client id sent',
      () => res.data?.clientOrderId,
      CLIENT_ID,
    )
    check('and the txid as order id', () => res.data?.orderId, TXID)
  })

  describe('QueryOrders lags past all three read-back tries (§1.1)', () => {
    const { ex, calls } = makeExchange(3)
    let res: any
    before(async () => {
      res = await place(ex, CLIENT_ID)
    })
    check('succeeds', () => res.status, StatusEnum.ok)
    check(
      'answers with the client id sent, not the txid',
      () => res.data?.clientOrderId,
      CLIENT_ID,
    )
    check('and the txid as order id', () => res.data?.orderId, TXID)
    check(
      'the last resort still reads by txid (§1.3)',
      () => calls.getOrders,
      4,
    )
    check(
      'never scans the open/closed lists (§1.3)',
      () => calls.getOpenOrders + calls.getClosedOrders,
      0,
    )
  })

  describe('the last-resort read fails (§1.3)', () => {
    const { ex } = makeExchange(3, () => ({ error: [], result: null }))
    let res: any
    before(async () => {
      res = await place(ex, CLIENT_ID)
    })
    check('is returned as a failure', () => res.status, StatusEnum.notok)
    check('with no order data invented', () => res.data ?? null, null)
  })

  describe('no client id sent (§1.3)', () => {
    const { ex } = makeExchange(3)
    let res: any
    before(async () => {
      res = await place(ex, undefined)
    })
    check('keeps the txid as client id', () => res.data?.clientOrderId, TXID)
  })
})
