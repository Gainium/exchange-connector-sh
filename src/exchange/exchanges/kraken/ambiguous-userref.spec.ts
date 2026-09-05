process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for the Kraken spot shared-userref collision.
 *
 * Kraken spot has no client-order-id lookup, so `getOrder` encodes the client
 * id as `userref = parseInt(clientOrderId.substring(0, 8), 16)`. Every Gainium
 * client id shares a non-hex prefix, so `parseInt` stops at the first `-` and
 * ALL `D-*` ids collapse to userref 13 (all `CMB-*` to 12). Both userref scans
 * then returned the FIRST entry that matched — i.e. whichever Gainium order the
 * account happened to list first, presented as an exact resolution. `getOrder`
 * feeds `cancelOrder`, so a cancel aimed at order A cancelled order B, and the
 * bot engine copied B's txid onto A's row: 163 Kraken txids in prod are each
 * claimed by 2+ order rows, 117 of them across more than one bot.
 *
 * A userref match is not evidence of identity. With more than one candidate the
 * only correct answers are "exactly one, here it is" or "ambiguous, I refuse" —
 * Kraken's open/closed payloads carry no client order id, so there is nothing
 * left to disambiguate with.
 *
 * Spec: `specs/002.kraken-spot-ambiguous-userref-lookup.md`.
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

/** Any `D-*` id. `parseInt('D-RO-o54'.substring(0,8), 16)` === 13. */
const CLIENT_ID = 'D-RO-o54rqRLIW9rTGgeSaVaepKlstZBZpY'
const USERREF = 13

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

function open(userref: number, price: string) {
  return {
    status: 'open',
    userref,
    vol: '1.0',
    vol_exec: '0',
    fee: '0',
    descr: { pair: 'ETHEUR', price, ordertype: 'limit', type: 'buy' },
  }
}

function closed(userref: number, price: string) {
  return {
    status: 'closed',
    userref,
    vol: '1.0',
    vol_exec: '1.0',
    price,
    fee: '2.6',
    descr: { pair: 'ETHEUR', price, ordertype: 'limit', type: 'buy' },
  }
}

/**
 * A spot connector wired to a stubbed Kraken. The client-id path never reaches
 * QueryOrders, so `getOrders` is only here to assert that.
 */
function makeExchange(
  openOrders: Record<string, unknown>,
  closedOrders: Record<string, unknown> = {},
) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const calls = { getOrders: 0, getOpenOrders: 0, getClosedOrders: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  // No connector-side retry ladder: the property under test is what the FIRST
  // answer is, not how many times it is re-asked.
  ex.retry = 0
  ex.spotClient = {
    getOrders: async () => {
      calls.getOrders++
      return { error: [], result: {} }
    },
    getOpenOrders: async () => {
      calls.getOpenOrders++
      return { error: [], result: { open: openOrders } }
    },
    getClosedOrders: async () => {
      calls.getClosedOrders++
      return { error: [], result: { closed: closedOrders } }
    },
  }
  return { ex, calls }
}

const ask = (ex: any) =>
  ex.getOrder({ symbol: 'ETHEUR', newClientOrderId: CLIENT_ID })

describe('kraken spot getOrder by client order id (userref)', () => {
  describe('a userref matched by exactly one open order', () => {
    const { ex } = makeExchange({
      'OAAAAA-11111-AAAAAA': open(USERREF, '2403.51'),
      // A different bot family — CMB-* is userref 12, so not a candidate.
      'OBBBBB-22222-BBBBBB': open(12, '9999.99'),
    })
    let res: any
    before(async () => {
      res = await ask(ex)
    })
    check('resolves', () => res.status, StatusEnum.ok)
    check(
      'to that order, unchanged',
      () => res.data?.orderId,
      'OAAAAA-11111-AAAAAA',
    )
  })

  describe('a userref matched by SEVERAL open orders', () => {
    // The production shape: one Kraken spot account running a DCA bot, so a
    // base order and two safety orders are resting at once. All three are
    // `D-*`, all three are userref 13, and only one of them was asked about.
    const { ex, calls } = makeExchange({
      'OZZZZZ-99999-ZZZZZZ': open(USERREF, '2500.00'),
      'ONK6O3-BF63X-24VAON': open(USERREF, '2403.51'),
      'OYYYYY-88888-YYYYYY': open(USERREF, '2300.00'),
    })
    let res: any
    before(async () => {
      res = await ask(ex)
    })
    check(
      'does NOT resolve to whichever order Kraken listed first',
      () => res.data?.orderId,
      undefined,
    )
    check('is reported as a failure', () => res.status, StatusEnum.notok)
    check(
      'names the collision so the log says why',
      () =>
        /ambiguous/i.test(`${res.reason}`) &&
        `${res.reason}`.includes(CLIENT_ID) &&
        `${res.reason}`.includes(`${USERREF}`),
      true,
    )
    check(
      'does not re-ask the closed list, which collides the same way',
      () => calls.getClosedOrders,
      0,
    )
  })

  describe('the refusal is not readable as a venue not-found', () => {
    // main-app `core/src/bot/main.ts`: `unknownOrderMessages` (:200) routes a
    // cancel to `_handleUnknownOrder`, and `isDefinitiveOrderNotFound` (:403)
    // lets the reconcile path retire an order as a phantom. An ambiguity is
    // "the call did not succeed", not "the venue says it does not exist" —
    // matching either list here would trade a wrong cancel for a wrong
    // phantom, which is the sibling bug this one was split from.
    const unknownOrderMessages = [
      'Unknown order',
      'order_not_exist_or_not_allow_to_cancel',
      'order_status_not_allow_to_cancel',
      'Order does not exist',
      'Order not found',
      'Order already closed',
      'Order cannot be canceled',
      'Order has been filled',
      'Order has been canceled',
      'Order being cancelled. Operation not supported',
      "Data sent for paramter 'qty' is not valid",
      'order not exists or too late to cancel',
      'Order cancellation failed as the order has been filled, canceled or does not exist',
      'validation.queryOrder.orderNotExist',
      'error.getOrder.orderNotExist',
      'Cannot find order to cancel',
      'UNKNOWN_CANCEL_ORDER',
      'UNKNOWN_CANCEL_FAILURE_REASON',
      'ORDER_IS_FULLY_FILLED',
      'Cannot cancel processing order',
      '订单不存在',
      'The order does not exist',
      'Order filled.',
      'Order cancelled.',
      'unknownOid',
      'order was never placed, already canceled, or filled',
      'EOrder:Unknown order',
      'EOrder:Order not found',
      'EOrder:Order already canceled',
      'EOrder:Order already closed',
      'EOrder:Cannot cancel order',
    ]
    const { ex } = makeExchange({
      'OZZZZZ-99999-ZZZZZZ': open(USERREF, '2500.00'),
      'ONK6O3-BF63X-24VAON': open(USERREF, '2403.51'),
    })
    let reason = ''
    before(async () => {
      reason = `${(await ask(ex)).reason}`
    })
    check(
      'matches none of main-app unknownOrderMessages',
      () =>
        unknownOrderMessages.filter((m) =>
          reason.toLowerCase().includes(m.toLowerCase()),
        ),
      [],
    )
    check(
      'and fails isDefinitiveOrderNotFound',
      () =>
        /\border not found\b/.test(reason.toLowerCase()) ||
        /\border does not exist\b/.test(reason.toLowerCase()) ||
        reason.toLowerCase() === 'unknownoid',
      false,
    )
  })

  describe('a userref matched by exactly one closed order', () => {
    const { ex } = makeExchange({}, { 'OCCCCC-33333-CCCCCC': closed(USERREF, '2403.51') })
    let res: any
    before(async () => {
      res = await ask(ex)
    })
    check('resolves', () => res.status, StatusEnum.ok)
    check(
      'to that order, unchanged',
      () => res.data?.orderId,
      'OCCCCC-33333-CCCCCC',
    )
    check('with its fill', () => res.data?.executedQty, '1.0')
  })

  describe('a userref matched by SEVERAL closed orders', () => {
    const { ex } = makeExchange(
      {},
      {
        'OCCCCC-33333-CCCCCC': closed(USERREF, '2403.51'),
        'ODDDDD-44444-DDDDDD': closed(USERREF, '2500.00'),
      },
    )
    let res: any
    before(async () => {
      res = await ask(ex)
    })
    check(
      'does NOT resolve to whichever order Kraken listed first',
      () => res.data?.orderId,
      undefined,
    )
    check('is reported as a failure', () => res.status, StatusEnum.notok)
    check('naming the collision', () => /ambiguous/i.test(`${res.reason}`), true)
  })

  describe('a userref matched by nothing', () => {
    const { ex, calls } = makeExchange({ 'OBBBBB-22222-BBBBBB': open(12, '1') })
    let res: any
    before(async () => {
      res = await ask(ex)
    })
    check(
      'still falls through open -> closed, unchanged',
      () => calls.getOpenOrders + calls.getClosedOrders,
      2,
    )
    check('and reports not found', () => res.status, StatusEnum.notok)
    check('never QueryOrders', () => calls.getOrders, 0)
  })
})
