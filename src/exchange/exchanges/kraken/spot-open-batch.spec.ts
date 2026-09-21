process.env.NODE_ENV = 'testing'

/**
 * Kraken spot's BULK placement — `openOrdersBatch`.
 *
 * Kraken takes 2..15 orders on one pair per `AddOrderBatch`, validates the
 * whole batch before submitting any of it, and answers positionally with one
 * `{txid}` or `{error}` per order. Two properties carry all the risk:
 *
 *  - **The send is never retried.** A validation rejection placed nothing, but
 *    a TIMEOUT may have placed everything, and the two are indistinguishable
 *    from here. Resending is a duplicate batch; the reason string is passed
 *    through unchanged so the caller can classify it instead.
 *  - **An order that was placed is never reported absent.** The caller's
 *    recovery for an unanswered order is to place it again, so if the post-send
 *    read lags, the order is reported as what was SENT plus the txid Kraken
 *    issued — a real order, not an invented one.
 *
 * Driven over the REAL method with the Kraken client stubbed. Synthetic
 * identifiers; this file is public.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { createHash } from 'crypto'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const SYMBOL = 'SOL-USD'
const KRAKEN_PAIR = 'SOLUSD'

const txid = (n: number) =>
  `O${String(n).padStart(5, '0')}-AAAAA-BBBBBB`.toUpperCase()

/** Inside Kraken's 18-character free-text budget, so it is sent verbatim. */
const FREE_TEXT_ID = 'GRID-BO-aa11bb'
/** A pre-spec-010 id: none of Kraken's three forms, so it is encoded. */
const LEGACY_ID = 'D-BO-o54rqRLIW9rTGgeSaVaepKlstZBZpY'
const sha32 = (id: string) =>
  createHash('sha256').update(id).digest('hex').slice(0, 32)

const order = (over: Record<string, unknown> = {}) => ({
  side: 'BUY' as const,
  quantity: 1.5,
  price: 184.3,
  newClientOrderId: FREE_TEXT_ID,
  ...over,
})

/** A QueryOrders row for an order resting on the book. */
const resting = (over: Record<string, unknown> = {}) => ({
  status: 'open',
  opentm: Math.floor(Date.now() / 1000),
  vol: '1.5',
  vol_exec: '0',
  price: '0',
  fee: '0',
  descr: {
    pair: KRAKEN_PAIR,
    price: '184.30',
    ordertype: 'limit',
    type: 'buy',
  },
  ...over,
})

type Calls = {
  submit: any[]
  getOrders: string[][]
}

/**
 * A spot connector wired to a stubbed Kraken.
 *
 * `replies` is what AddOrderBatch answers with (positionally). `rows` is the
 * QueryOrders state; `rowsAfter`, when given, is what reads from the Nth
 * onwards answer — that is how the post-submit read lag is expressed.
 */
function makeExchange(opts: {
  replies?: unknown
  rows?: Record<string, unknown>
  rowsAfter?: { from: number; rows: Record<string, unknown> }
  futures?: boolean
}) {
  const ex: any = new KrakenExchange(
    opts.futures ? Futures.usdm : Futures.null,
    '',
    '',
  )
  const calls: Calls = { submit: [], getOrders: [] }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async () => SYMBOL
  ex.toKrakenSymbol = async () => KRAKEN_PAIR
  ex.retry = 0
  const client = {
    submitBatchOrders: async (params: any) => {
      calls.submit.push(params)
      if (typeof opts.replies === 'function') {
        return (opts.replies as () => never)()
      }
      return opts.replies ?? { error: [], result: { orders: [] } }
    },
    getOrders: async ({ txid: ids }: { txid: string }) => {
      const asked = ids.split(',')
      calls.getOrders.push(asked)
      const source =
        opts.rowsAfter && calls.getOrders.length >= opts.rowsAfter.from
          ? opts.rowsAfter.rows
          : (opts.rows ?? {})
      const result: Record<string, unknown> = {}
      for (const id of asked) {
        if (source[id]) {
          result[id] = source[id]
        }
      }
      return { error: [], result }
    },
  }
  if (opts.futures) {
    ex.derivativesClient = client
  } else {
    ex.spotClient = client
  }
  return { ex, calls }
}

describe('kraken spot bulk placement', () => {
  describe('the happy path', () => {
    const ids = [txid(1), txid(2), txid(3)]
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange({
        replies: {
          error: [],
          result: { orders: ids.map((id) => ({ txid: id })) },
        },
        rows: {
          [ids[0]]: resting(),
          [ids[1]]: resting({
            vol: '2',
            descr: { ...resting().descr, price: '180.00' },
          }),
          [ids[2]]: resting({ descr: { ...resting().descr, type: 'sell' } }),
        },
      })
      calls = made.calls
      res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({
            newClientOrderId: 'GRID-BO-cc22dd',
            quantity: 2,
            price: 180,
          }),
          order({ newClientOrderId: LEGACY_ID, side: 'SELL' }),
        ],
      })
    })

    it('sends one AddOrderBatch and reads the result back once', () => {
      assert.strictEqual(calls.submit.length, 1, 'AddOrderBatch calls')
      assert.strictEqual(calls.getOrders.length, 1, 'QueryOrders calls')
      assert.deepStrictEqual(calls.getOrders[0], ids)
    })

    it('sends what the single-order path sends, field for field', () => {
      const sent = calls.submit[0]
      assert.strictEqual(sent.pair, KRAKEN_PAIR)
      assert.deepStrictEqual(sent.orders[0], {
        ordertype: 'limit',
        type: 'buy',
        volume: '1.5',
        price: '184.3',
        cl_ord_id: 'GRID-BO-aa11bb',
      })
      assert.strictEqual(sent.orders[2].type, 'sell')
    })

    it('encodes a legacy client order id exactly as the single path does', () => {
      // Free-text ids go verbatim; a pre-spec-010 id is none of Kraken's three
      // accepted forms, so it becomes the short-UUID (sha256/32hex) encoding.
      assert.strictEqual(calls.submit[0].orders[1].cl_ord_id, 'GRID-BO-cc22dd')
      assert.strictEqual(calls.submit[0].orders[2].cl_ord_id, sha32(LEGACY_ID))
    })

    it('answers positionally, keyed by the id the CALLER gave', () => {
      assert.strictEqual(res.status, StatusEnum.ok)
      assert.deepStrictEqual(
        res.data.map((r: any) => r.newClientOrderId),
        ['GRID-BO-aa11bb', 'GRID-BO-cc22dd', LEGACY_ID],
      )
    })

    it('reports the real orders it read back', () => {
      assert.strictEqual(`${res.data[0].order.orderId}`, ids[0])
      assert.strictEqual(res.data[0].order.price, '184.30')
      assert.strictEqual(res.data[0].order.status, 'NEW')
      assert.strictEqual(res.data[1].order.origQty, '2')
      assert.strictEqual(res.data[2].order.side, 'SELL')
      // The caller's own id travels back on the order, not Kraken's encoding.
      assert.strictEqual(res.data[2].order.clientOrderId, LEGACY_ID)
    })

    it('never sets both an order and a reason', () => {
      for (const result of res.data) {
        assert.ok(result.order && result.reason === undefined)
      }
    })
  })

  describe('one order the venue refused', () => {
    const ids = [txid(11), txid(13)]
    let res: any

    before(async () => {
      const made = makeExchange({
        replies: {
          error: [],
          result: {
            orders: [
              { txid: ids[0] },
              { error: 'EOrder:Insufficient funds' },
              { txid: ids[1] },
            ],
          },
        },
        rows: { [ids[0]]: resting(), [ids[1]]: resting() },
      })
      res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
          order({ newClientOrderId: 'GRID-BO-ee33ff' }),
        ],
      })
    })

    it('passes the venue rejection through verbatim for that one order', () => {
      assert.strictEqual(res.data[1].reason, 'EOrder:Insufficient funds')
      assert.strictEqual(res.data[1].order, undefined)
    })

    it('still reports the two that were placed', () => {
      assert.strictEqual(`${res.data[0].order.orderId}`, ids[0])
      assert.strictEqual(`${res.data[2].order.orderId}`, ids[1])
    })

    it('answers an item that describes nothing at all, rather than staying silent', async () => {
      const made = makeExchange({
        replies: { error: [], result: { orders: [{ txid: txid(21) }, {}] } },
        rows: { [txid(21)]: resting() },
      })
      const answer = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(
        answer.data[1].reason,
        'No result for this order in the batch reply',
      )
    })
  })

  describe('the batch never reached the venue', () => {
    it('reports a top-level rejection unchanged, and sends once', async () => {
      const made = makeExchange({
        replies: { error: ['EOrder:Invalid price'], result: undefined },
      })
      const res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(res.reason, 'EOrder:Invalid price')
      assert.strictEqual(made.calls.submit.length, 1, 'AddOrderBatch calls')
    })

    it('says outright that a bare HTTP failure left the outcome unknown', async () => {
      // Worded by the HTTP stack, not by Kraken and not by us — and it names
      // none of the shapes a caller's classifier looks for. Read as a refusal,
      // it would send every order in the batch again, one by one.
      const made = makeExchange({
        replies: () => {
          throw new Error('Request failed with status code 502')
        },
      })
      const res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(
        res.reason,
        'Server error, batch outcome unknown: Request failed with status code 502',
      )
      assert.strictEqual(made.calls.submit.length, 1, 'AddOrderBatch calls')
    })

    it('does the same for the one Kraken error that is not a refusal', async () => {
      const made = makeExchange({
        replies: { error: ['EGeneral:Internal error'], result: undefined },
      })
      const res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(
        res.reason,
        'Server error, batch outcome unknown: EGeneral:Internal error',
      )
    })

    it('reports a transport failure with its own words kept, and sends once', async () => {
      // A resend after a lost response is a duplicate batch — the one outcome
      // this method must never produce. The wording is the caller's only way to
      // tell an ambiguous failure from a definitive one.
      const made = makeExchange({
        replies: () => {
          throw new Error('timeout of 10000ms exceeded')
        },
      })
      const res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(
        res.reason,
        'Server error, batch outcome unknown: timeout of 10000ms exceeded',
      )
      assert.strictEqual(made.calls.submit.length, 1, 'AddOrderBatch calls')
      assert.strictEqual(made.calls.getOrders.length, 0)
    })
  })

  describe('the read lags behind the submit', () => {
    const ids = [txid(31), txid(32)]
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange({
        replies: {
          error: [],
          result: { orders: ids.map((id) => ({ txid: id })) },
        },
        // Neither order is visible yet; the second one surfaces on the third
        // read, the first one never does.
        rows: {},
        rowsAfter: { from: 3, rows: { [ids[1]]: resting({ vol: '2' }) } },
      })
      calls = made.calls
      res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd', quantity: 2 }),
        ],
      })
    })

    it('retries the read for whatever is still missing', () => {
      assert.strictEqual(calls.getOrders.length, 3)
      // Each read asks only about what is still unaccounted for; here that is
      // both of them until the third read answers about one.
      assert.deepStrictEqual(calls.getOrders[2], ids)
    })

    it('reports the order that surfaced from the venue', () => {
      assert.strictEqual(res.data[1].order.origQty, '2')
    })

    it('reports the one that never surfaced as what was SENT', () => {
      // Absent would mean the caller places it again — a duplicate live order.
      const built = res.data[0].order
      assert.strictEqual(`${built.orderId}`, ids[0])
      assert.strictEqual(built.clientOrderId, 'GRID-BO-aa11bb')
      assert.strictEqual(built.price, '184.3')
      assert.strictEqual(built.origQty, '1.5')
      assert.strictEqual(built.executedQty, '0')
      assert.strictEqual(built.status, 'NEW')
      assert.strictEqual(built.type, 'LIMIT')
      assert.strictEqual(built.side, 'BUY')
      assert.strictEqual(built.symbol, SYMBOL)
    })

    it('never leaves a placed order out of the answer', () => {
      assert.strictEqual(res.status, StatusEnum.ok)
      assert.strictEqual(res.data.length, 2)
      for (const result of res.data) {
        assert.ok(
          result.order,
          `${result.newClientOrderId} was reported absent`,
        )
      }
    })
  })

  describe('what is declined, and sends nothing', () => {
    const cases: Array<[string, any]> = [
      ['a single order', { orders: [order()] }],
      [
        'more orders than the venue accepts',
        {
          orders: Array.from({ length: 16 }, (_, i) =>
            order({ newClientOrderId: `GRID-BO-${i}` }),
          ),
        },
      ],
      [
        'a MARKET order',
        {
          orders: [
            order({ newClientOrderId: 'GRID-BO-aa11bb' }),
            order({ newClientOrderId: 'GRID-BO-cc22dd', type: 'MARKET' }),
          ],
        },
      ],
      [
        'an order with no client order id',
        {
          orders: [
            order({ newClientOrderId: 'GRID-BO-aa11bb' }),
            order({ newClientOrderId: '' }),
          ],
        },
      ],
      [
        'an order with no usable quantity',
        {
          orders: [
            order({ newClientOrderId: 'GRID-BO-aa11bb' }),
            order({ newClientOrderId: 'GRID-BO-cc22dd', quantity: 0 }),
          ],
        },
      ],
      [
        'an order with no usable price',
        {
          orders: [
            order({ newClientOrderId: 'GRID-BO-aa11bb' }),
            order({ newClientOrderId: 'GRID-BO-cc22dd', price: NaN }),
          ],
        },
      ],
    ]

    for (const [label, body] of cases) {
      it(`${label}`, async () => {
        const made = makeExchange({})
        const res = await made.ex.openOrdersBatch({ symbol: SYMBOL, ...body })
        assert.strictEqual(res.status, StatusEnum.notok)
        assert.strictEqual(
          res.reason,
          'Batch order placement not supported for this exchange',
        )
        assert.strictEqual(made.calls.submit.length, 0, 'AddOrderBatch calls')
      })
    }

    it('futures', async () => {
      const made = makeExchange({ futures: true })
      const res = await made.ex.openOrdersBatch({
        symbol: SYMBOL,
        orders: [
          order({ newClientOrderId: 'GRID-BO-aa11bb' }),
          order({ newClientOrderId: 'GRID-BO-cc22dd' }),
        ],
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(
        res.reason,
        'Batch order placement not supported for this exchange',
      )
      assert.strictEqual(made.calls.submit.length, 0)
    })
  })
})
