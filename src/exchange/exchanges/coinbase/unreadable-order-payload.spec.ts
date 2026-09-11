process.env.NODE_ENV = 'testing'

/**
 * Spec `008`.
 *
 * `convertOrder` answered a Coinbase payload that described no order with a
 * fully formed one: `type MARKET`, `side BUY`, `NaN` timestamps, no price —
 * under `status: OK`. That stamp was then persisted over live order rows of
 * every deal order kind, including take-profits placed SELL LIMIT that now
 * read BUY MARKET.
 *
 * Run: `npm test` (mocha). No network / auth needed — the Coinbase REST client
 * is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import CoinbaseExchange from './index'

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

const ORDER_ID = '00000000-1111-2222-3333-444444444444'
const CLIENT_ID = 'D-RO-UnitTestSafetyOrder'

/**
 * The venue answer the production window must have produced: the order is
 * named and said to be FILLED, and the payload states nothing else about it.
 * (The persisted rows carry a real venue uuid in `orderId`, so the venue did
 * name the order.)
 */
const SKELETON = { order_id: ORDER_ID, status: 'FILLED' }

/** A normal, complete Coinbase answer for the same order. */
const COMPLETE = {
  order_id: ORDER_ID,
  client_order_id: CLIENT_ID,
  product_id: 'DOGE-USDC',
  side: 'BUY',
  order_type: 'LIMIT',
  status: 'FILLED',
  created_time: '2026-01-02T03:10:00.000Z',
  last_fill_time: '2026-01-02T03:12:00.000Z',
  filled_size: '41.9',
  filled_value: '3.517086',
  average_filled_price: '0.08394',
  total_fees: '0.0211',
  completion_percentage: '100',
  order_configuration: {
    limit_limit_gtc: { base_size: '41.9', limit_price: '0.08394' },
  },
}

/** A live resting order: identity stated, no fill facts at all (§4.2). */
const RESTING = {
  order_id: ORDER_ID,
  client_order_id: 'D-TP-UnitTestTakeProfit',
  product_id: 'DOGE-USDC',
  side: 'SELL',
  order_type: 'LIMIT',
  status: 'OPEN',
  created_time: '2026-01-02T03:10:00.000Z',
  completion_percentage: '0',
  order_configuration: {
    limit_limit_gtc: { base_size: '41.9', limit_price: '0.09' },
  },
}

type Res = { status: string; reason: string | null; data: any }

/** A connector whose order endpoints answer with `payload`. */
function connector(payload: unknown, listPayload?: unknown) {
  let calls = 0
  const ex = new CoinbaseExchange(Futures.null, 'k', 's') as unknown as {
    client: unknown
    getOrder: (
      d: { symbol: string; newClientOrderId: string },
      wait?: boolean,
    ) => Promise<Res>
    cancelOrder: (d: {
      symbol: string
      newClientOrderId: string
    }) => Promise<Res>
    getAllOpenOrders: (s?: string, r?: boolean) => Promise<Res>
  }
  ex.client = {
    rest: {
      order: {
        getOrder: () => {
          calls++
          return Promise.resolve(payload)
        },
        cancelOrder: () => Promise.resolve({ success: true }),
        getOrders: () =>
          Promise.resolve({
            data: listPayload ?? [payload],
            pagination: { has_next: false },
          }),
      },
    },
  }
  return { ex, calls: () => calls }
}

describe('coinbase unreadable order payload (spec 008 / #727)', () => {
  // §4.1 — the answer is refused, not converted.
  describe('getOrder | a payload that describes no order', () => {
    let res: Res
    let calls: () => number

    before(async () => {
      const c = connector(SKELETON)
      calls = c.calls
      res = await c.ex.getOrder(
        { symbol: 'DOGE-USDC', newClientOrderId: ORDER_ID },
        false,
      )
    })

    check('status', () => res.status, 'NOTOK')
    check('no data', () => res.data, null)
    // The stamp itself: no MARKET, no BUY, no FILLED reaches a caller.
    check('nothing fabricated', () => res.data == null, true)
    check(
      'reason names the order',
      () => `${res.reason}`.includes(ORDER_ID),
      true,
    )
    check(
      'reason names what was not stated',
      () =>
        ['side', 'order_type', 'created_time', 'product_id'].every((f) =>
          `${res.reason}`.includes(f),
        ),
      true,
    )
    // §4.4 — a payload the venue already sent does not improve on a re-ask.
    check('one venue call, no retry ladder', () => calls(), 1)
  })

  // §4.2 — a complete payload is untouched, field for field.
  describe('getOrder | a complete payload is unchanged', () => {
    let res: Res

    before(async () => {
      res = await connector(COMPLETE).ex.getOrder(
        { symbol: 'DOGE-USDC', newClientOrderId: ORDER_ID },
        false,
      )
    })

    check('status', () => res.status, 'OK')
    check('order', () => JSON.parse(JSON.stringify(res.data)), {
      feePaid: '0.0211',
      feeSide: 'quote',
      symbol: 'DOGE-USDC',
      orderId: ORDER_ID,
      clientOrderId: CLIENT_ID,
      transactTime: +new Date('2026-01-02T03:10:00.000Z'),
      updateTime: +new Date('2026-01-02T03:12:00.000Z'),
      price: '0.08394',
      origQty: '41.9',
      executedQty: '41.9',
      cummulativeQuoteQty: '3.517086',
      status: 'FILLED',
      type: 'LIMIT',
      side: 'BUY',
      fills: [],
    })
  })

  // §4.2 — fill facts are not identity facts: a resting order states none.
  describe('getOrder | a resting order with no fills is unchanged', () => {
    let res: Res

    before(async () => {
      res = await connector(RESTING).ex.getOrder(
        { symbol: 'DOGE-USDC', newClientOrderId: ORDER_ID },
        false,
      )
    })

    check('status', () => res.status, 'OK')
    check('side survives', () => res.data?.side, 'SELL')
    check('type survives', () => res.data?.type, 'LIMIT')
    check('order status', () => res.data?.status, 'NEW')
    check('price is the limit price', () => res.data?.price, '0.09')
  })

  // §4.3 — an unrecognised value is still a statement.
  describe('getOrder | a stated but unrecognised order_type still converts', () => {
    let res: Res

    before(async () => {
      res = await connector({
        ...COMPLETE,
        order_type: 'STOP_LIMIT',
      }).ex.getOrder({ symbol: 'DOGE-USDC', newClientOrderId: ORDER_ID }, false)
    })

    check('status', () => res.status, 'OK')
    check('mapped as before', () => res.data?.type, 'MARKET')
  })

  // §4.5 — the guard is on the converter, so every caller is covered.
  describe('the other two call sites', () => {
    let list: Res
    let listOk: Res
    let cancel: Res

    before(async () => {
      list = await connector(SKELETON).ex.getAllOpenOrders(undefined, true)
      listOk = await connector(RESTING).ex.getAllOpenOrders(undefined, true)
      cancel = await connector(SKELETON).ex.cancelOrder({
        symbol: 'DOGE-USDC',
        newClientOrderId: ORDER_ID,
      })
    })

    check('getAllOpenOrders refuses', () => list.status, 'NOTOK')
    check(
      'getAllOpenOrders still lists a real order',
      () => listOk.status,
      'OK',
    )
    check('… with its real side', () => listOk.data?.[0]?.side, 'SELL')
    check('cancelOrder refuses', () => cancel.status, 'NOTOK')
  })
})
