process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for the Kraken spot "not found in open orders" phantom.
 *
 * `getOrder` resolves a spot order by txid through QueryOrders — the one exact
 * lookup, and the only one that sees a closed order. When that lookup failed
 * for ANY reason (a nonce collision, a rate limit, a transport blip) it fell
 * through to the userref scan of the open-orders list. `parseInt('O…', 16)` is
 * NaN, so that scan cannot resolve a txid and always ended in "Order not found
 * in open orders": a definitive-looking negative manufactured from a lookup
 * that had merely failed, about the one list a FILLED order is guaranteed to
 * be absent from. main-app trusted the wording and skipped three filled
 * safety orders on a restart; nothing was logged here because the original
 * failure had been swallowed.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const TXID = 'OM2YHC-HWHJ2-ZLOW6O'

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

/**
 * A spot connector wired to a stubbed Kraken. `getOpenOrders` /
 * `getClosedOrders` record whether the userref fallthrough was reached — that
 * is the whole defect.
 */
function makeExchange(queryOrders: () => Promise<unknown>) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const calls = { getOrders: 0, getOpenOrders: 0, getClosedOrders: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  // No connector-side retry ladder in the test: the property under test is
  // what the FIRST answer is rendered as, not how many times it is re-asked.
  ex.retry = 0
  ex.spotClient = {
    getOrders: async () => {
      calls.getOrders++
      return queryOrders()
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

const closedFilled = {
  status: 'closed',
  userref: 13,
  vol: '1.04014545',
  vol_exec: '1.04014545',
  price: '2403.51',
  fee: '2.6',
  descr: { pair: 'ETHUSD', price: '2403.51', ordertype: 'limit', type: 'buy' },
}

describe('kraken spot getOrder by txid', () => {
  describe('a filled order, i.e. one absent from the open list', () => {
    const { ex, calls } = makeExchange(async () => ({
      error: [],
      result: { [TXID]: closedFilled },
    }))
    let res: any
    before(async () => {
      res = await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: TXID })
    })
    check(
      'is resolved from QueryOrders as FILLED',
      () => res.data?.status,
      'FILLED',
    )
    check(
      'with its executed quantity',
      () => res.data?.executedQty,
      '1.04014545',
    )
    check('without touching the open-orders list', () => calls.getOpenOrders, 0)
  })

  describe('a lookup that FAILED (a nonce collision here)', () => {
    const { ex, calls } = makeExchange(async () => ({
      error: ['EAPI:Invalid nonce'],
    }))
    let res: any
    before(async () => {
      res = await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: TXID })
    })
    check(
      'is reported as a failure, not a resolution',
      () => res.status,
      StatusEnum.notok,
    )
    check(
      'carries the real reason, so the caller reads it as ambiguous and retries',
      () => `${res.reason}`.includes('EAPI:Invalid nonce'),
      true,
    )
    check(
      'is NOT rendered as "Order not found"',
      () => /order not found/i.test(`${res.reason}`),
      false,
    )
    check(
      'never falls through to the userref scan',
      () => calls.getOpenOrders + calls.getClosedOrders,
      0,
    )
  })

  describe('a rejected request (transport / SDK throw)', () => {
    const { ex, calls } = makeExchange(async () => {
      throw new Error('socket hang up')
    })
    let res: any
    before(async () => {
      res = await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: TXID })
    })
    check(
      'is a failure with its own reason',
      () => res.status,
      StatusEnum.notok,
    )
    check(
      'keeps the transport reason',
      () => `${res.reason}`.includes('socket hang up'),
      true,
    )
    check(
      'never falls through to the userref scan',
      () => calls.getOpenOrders,
      0,
    )
  })

  describe('a txid the venue ANSWERED it does not know', () => {
    const { ex, calls } = makeExchange(async () => ({
      error: ['EOrder:Unknown order'],
    }))
    let res: any
    before(async () => {
      res = await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: TXID })
    })
    check(
      'is a definitive not-found the bot engine can act on',
      () => /^order not found\b/i.test(`${res.reason}`),
      true,
    )
    check(
      'names what Kraken said',
      () => `${res.reason}`.includes('EOrder:Unknown order'),
      true,
    )
    check(
      'never falls through to the userref scan',
      () => calls.getOpenOrders,
      0,
    )
  })

  describe('a QueryOrders answer with no row for the txid', () => {
    const { ex, calls } = makeExchange(async () => ({
      error: [],
      result: {},
    }))
    let res: any
    before(async () => {
      res = await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: TXID })
    })
    check(
      'is a definitive not-found',
      () => /^order not found\b/i.test(`${res.reason}`),
      true,
    )
    check(
      'never falls through to the userref scan',
      () => calls.getOpenOrders,
      0,
    )
  })

  describe('a client order id (not a txid)', () => {
    const { ex, calls } = makeExchange(async () => ({ error: [], result: {} }))
    before(async () => {
      await ex.getOrder({ symbol: 'ETHUSD', newClientOrderId: 'D-RO-abc' })
    })
    check(
      'still takes the userref path, unchanged',
      () => calls.getOpenOrders,
      1,
    )
    check('and never QueryOrders', () => calls.getOrders, 0)
  })
})
