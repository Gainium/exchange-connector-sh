process.env.NODE_ENV = 'testing'

/**
 * Kraken spot's BULK cancel — `cancelOrdersBatch`.
 *
 * The contract it has to keep is narrow and the whole risk lives in it: the
 * answer lists the orders this call OBSERVED as cancelled, and nothing else.
 * Anything absent means "I did not cancel this / cannot vouch for it", and the
 * caller cancels it one by one the way it does today — which is also the path
 * that owns the fill/cancel race and the unknown-order ladder.
 *
 * So these specs are mostly about what is NOT in the answer, and about what is
 * never sent: Kraken's bulk cancel replies `{count}` and nothing else, so a
 * count that disagrees with what was sent is the venue telling us we do not
 * know which ones died.
 *
 * Driven over the REAL method with the Kraken client stubbed — the reporting IS
 * the property under test. Synthetic identifiers; this file is public.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const SYMBOL = 'SOL-USD'
/** Kraken spot txids: 'O' + three dash-separated uppercase groups. */
const txid = (n: number) =>
  `O${String(n).padStart(5, '0')}-AAAAA-BBBBBB`.toUpperCase()

/** A QueryOrders row as Kraken sends it, for an order resting on the book. */
const restingSell = (over: Record<string, unknown> = {}) => ({
  status: 'open',
  cl_ord_id: 'GRID-TP-aa11bb',
  // Seconds since the epoch, Kraken's unit. An hour old, so its cancel is free
  // on the matching-engine counter.
  opentm: Math.floor(Date.now() / 1000) - 3600,
  vol: '1.5',
  vol_exec: '0',
  price: '0',
  fee: '0',
  descr: {
    pair: 'SOLUSD',
    price: '184.30',
    ordertype: 'limit',
    type: 'sell',
  },
  ...over,
})

type Calls = {
  getOrders: string[][]
  cancelBatch: string[][]
}

/**
 * A spot connector wired to a stubbed Kraken.
 *
 * `rows` is the QueryOrders state; `nextRows`, when given, is what the SECOND
 * and later reads answer, which is how a cancel that raced a fill is expressed.
 * `cancelResult` is what CancelOrderBatch answers — a count, an error array, or
 * a thrown transport failure.
 */
function makeExchange(opts: {
  rows: Record<string, unknown>
  nextRows?: Record<string, unknown>
  cancelResult?: unknown | (() => never)
  futures?: boolean
}) {
  const ex: any = new KrakenExchange(
    opts.futures ? Futures.usdm : Futures.null,
    '',
    '',
  )
  const calls: Calls = { getOrders: [], cancelBatch: [] }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async () => SYMBOL
  ex.retry = 0
  const client = {
    getOrders: async ({ txid: ids }: { txid: string }) => {
      const asked = ids.split(',')
      calls.getOrders.push(asked)
      const source =
        calls.getOrders.length > 1 && opts.nextRows ? opts.nextRows : opts.rows
      const result: Record<string, unknown> = {}
      for (const id of asked) {
        if (source[id]) {
          result[id] = source[id]
        }
      }
      return { error: [], result }
    },
    cancelBatchOrders: async ({ orders }: { orders: string[] }) => {
      calls.cancelBatch.push(orders)
      if (typeof opts.cancelResult === 'function') {
        return (opts.cancelResult as () => never)()
      }
      return (
        opts.cancelResult ?? { error: [], result: { count: orders.length } }
      )
    },
  }
  // The futures case must decline before it ever reaches a client, so give the
  // futures connector the same stub and assert nothing was called.
  if (opts.futures) {
    ex.derivativesClient = client
  } else {
    ex.spotClient = client
  }
  return { ex, calls }
}

describe('kraken spot bulk cancel', () => {
  describe('the happy path — the venue cancelled what it was handed', () => {
    const ids = [txid(1), txid(2), txid(3)]
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange({
        rows: {
          [ids[0]]: restingSell(),
          [ids[1]]: restingSell({
            descr: { ...restingSell().descr, type: 'buy' },
          }),
          [ids[2]]: restingSell({ vol_exec: '0.4', price: '184.11' }),
        },
      })
      calls = made.calls
      res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
    })

    it('succeeds and reports every order it cancelled', () => {
      assert.strictEqual(res.status, StatusEnum.ok)
      assert.deepStrictEqual(
        res.data.map((o: any) => `${o.orderId}`),
        ids,
      )
    })

    it('spends one lookup and one cancel for the whole set', () => {
      assert.strictEqual(calls.getOrders.length, 1, 'QueryOrders calls')
      assert.strictEqual(calls.cancelBatch.length, 1, 'CancelOrderBatch calls')
      assert.deepStrictEqual(calls.cancelBatch[0], ids)
    })

    it('reports real orders, never synthesised zeros (spec 013)', () => {
      assert.strictEqual(res.data[0].price, '184.30')
      assert.strictEqual(res.data[0].side, 'SELL')
      assert.strictEqual(res.data[0].origQty, '1.5')
      assert.strictEqual(res.data[1].side, 'BUY')
      // A partial fill keeps the quantity and the average price it traded at.
      assert.strictEqual(res.data[2].executedQty, '0.4')
      assert.strictEqual(res.data[2].price, '184.11')
    })

    it('reports CANCELED for all of them — never promoted to FILLED', () => {
      for (const order of res.data) {
        assert.strictEqual(order.status, 'CANCELED')
      }
    })

    it('keys each order by its txid, as the caller does', () => {
      assert.strictEqual(res.data[0].clientOrderId, ids[0])
    })
  })

  describe('a count that disagrees — the venue decides, not us', () => {
    const ids = [txid(11), txid(12), txid(13)]
    let res: any
    let calls: Calls

    before(async () => {
      const made = makeExchange({
        rows: {
          [ids[0]]: restingSell(),
          [ids[1]]: restingSell(),
          [ids[2]]: restingSell(),
        },
        // One of the three filled in the race; Kraken cancelled two.
        cancelResult: { error: [], result: { count: 2 } },
        nextRows: {
          [ids[0]]: restingSell({
            status: 'canceled',
            vol_exec: '0.2',
            price: '184.05',
          }),
          [ids[1]]: restingSell({
            status: 'closed',
            vol_exec: '1.5',
            price: '184.30',
          }),
          [ids[2]]: restingSell({ status: 'canceled' }),
        },
      })
      calls = made.calls
      res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
    })

    it('re-reads the chunk before saying anything', () => {
      assert.strictEqual(calls.getOrders.length, 2, 'QueryOrders calls')
      assert.strictEqual(calls.cancelBatch.length, 1, 'cancels')
    })

    it('reports only the orders the venue now calls canceled', () => {
      assert.deepStrictEqual(
        res.data.map((o: any) => `${o.orderId}`),
        [ids[0], ids[2]],
      )
    })

    it('leaves the one that filled out of the answer entirely', () => {
      // Its fill/cancel race belongs to the caller's per-order path.
      assert.ok(!res.data.some((o: any) => `${o.orderId}` === ids[1]))
    })

    it('describes them from the FRESH read, so a late fill is not lost', () => {
      assert.strictEqual(res.data[0].executedQty, '0.2')
      assert.strictEqual(res.data[0].price, '184.05')
      assert.strictEqual(res.data[0].status, 'CANCELED')
    })
  })

  describe('a cancel whose outcome is unknown', () => {
    const ids = [txid(21), txid(22)]

    it('lets the re-read decide, and never throws out of the method', async () => {
      const made = makeExchange({
        rows: { [ids[0]]: restingSell(), [ids[1]]: restingSell() },
        cancelResult: () => {
          throw new Error('timeout of 10000ms exceeded')
        },
        nextRows: {
          [ids[0]]: restingSell({ status: 'canceled' }),
          [ids[1]]: restingSell(),
        },
      })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
      assert.strictEqual(res.status, StatusEnum.ok)
      assert.deepStrictEqual(
        res.data.map((o: any) => `${o.orderId}`),
        [ids[0]],
      )
      assert.strictEqual(made.calls.cancelBatch.length, 1, 'no resend')
    })

    it('reports nothing when the re-read cannot answer either', async () => {
      const made = makeExchange({
        rows: { [ids[0]]: restingSell(), [ids[1]]: restingSell() },
        cancelResult: () => {
          throw new Error('timeout of 10000ms exceeded')
        },
        // The second read answers about no order at all.
        nextRows: {},
      })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      // NOT the base class's "not supported": a caller that remembers that
      // answer stops asking for good, and this is a statement about these
      // orders, not about the venue.
      assert.strictEqual(res.reason, 'Batch cancel confirmed no orders')
    })
  })

  describe('what is never sent', () => {
    it('leaves out orders the venue already reports as terminal', async () => {
      const ids = [txid(31), txid(32), txid(33), txid(34)]
      const made = makeExchange({
        rows: {
          [ids[0]]: restingSell(),
          [ids[1]]: restingSell({ status: 'closed', vol_exec: '1.5' }),
          [ids[2]]: restingSell({ status: 'canceled' }),
          [ids[3]]: restingSell({ status: 'pending' }),
          // ids[4] is simply missing from the venue's answer.
        },
      })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: [...ids, txid(35)],
      })
      assert.deepStrictEqual(made.calls.cancelBatch[0], [ids[0], ids[3]])
      assert.deepStrictEqual(
        res.data.map((o: any) => `${o.orderId}`),
        [ids[0], ids[3]],
      )
    })

    it('leaves out ids that are not Kraken txids', async () => {
      const ids = [txid(41), txid(42)]
      const made = makeExchange({
        rows: { [ids[0]]: restingSell(), [ids[1]]: restingSell() },
      })
      await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: [...ids, 'GRID-TP-zz99yy', 'D-RO-legacyId'],
      })
      // A Gainium client order id resolves ambiguously on this venue, and a
      // bulk call is the worst place to resolve an ambiguity.
      assert.deepStrictEqual(made.calls.getOrders[0], ids)
      assert.deepStrictEqual(made.calls.cancelBatch[0], ids)
    })

    it('declines rather than batching a single order', async () => {
      const made = makeExchange({ rows: { [txid(51)]: restingSell() } })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: [txid(51), 'GRID-TP-zz99yy'],
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(made.calls.getOrders.length, 0)
      assert.strictEqual(made.calls.cancelBatch.length, 0)
    })

    it('declines when only one of the batch is still cancellable', async () => {
      const ids = [txid(61), txid(62)]
      const made = makeExchange({
        rows: {
          [ids[0]]: restingSell(),
          [ids[1]]: restingSell({ status: 'closed' }),
        },
      })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(made.calls.cancelBatch.length, 0)
    })

    it('declines on futures without touching the venue', async () => {
      const ids = [txid(71), txid(72)]
      const made = makeExchange({ rows: {}, futures: true })
      const res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
      assert.strictEqual(res.status, StatusEnum.notok)
      assert.strictEqual(
        res.reason,
        'Batch order cancel not supported for this exchange',
      )
      assert.strictEqual(made.calls.getOrders.length, 0)
      assert.strictEqual(made.calls.cancelBatch.length, 0)
    })
  })

  describe('more ids than one call can carry', () => {
    const ids = Array.from({ length: 63 }, (_, i) => txid(100 + i))
    let res: any
    let calls: Calls

    before(async () => {
      const rows: Record<string, unknown> = {}
      for (const id of ids) {
        rows[id] = restingSell()
      }
      const made = makeExchange({ rows })
      calls = made.calls
      res = await made.ex.cancelOrdersBatch({
        symbol: SYMBOL,
        newClientOrderIds: ids,
      })
    })

    it('chunks at the venue ceiling of 50', () => {
      assert.deepStrictEqual(
        calls.cancelBatch.map((c) => c.length),
        [50, 13],
      )
      assert.deepStrictEqual(
        calls.getOrders.map((c) => c.length),
        [50, 13],
      )
    })

    it('answers for all of them', () => {
      assert.strictEqual(res.data.length, 63)
    })
  })
})
