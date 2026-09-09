process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for spec 007 — Coinbase `getAllOpenOrders` returned only the
 * first page of the account's resting orders.
 *
 * The ceiling does not live in our file, it lives in the vendored SDK:
 * `coinbase-advanced-node`'s `OrderAPI.getOrders` substitutes `limit = 25`
 * whenever the caller omits one, and our caller omitted one. So a test that
 * stubbed `client.rest.order.getOrders` would stub away the defect and pass
 * with the bug present.
 *
 * This spec therefore drives the REAL `OrderAPI` — `new OrderAPI(fakeAxios)`,
 * handed to the exchange as `client.rest.order` — over a fake HTTP client. The
 * SDK's limit-defaulting and its `formatPaginationFromResponse` both run for
 * real; only the socket is fake. The fake venue holds 300 open orders and
 * serves them in `has_next` / `cursor` pages honouring whatever `limit` it is
 * asked for, recording every request it sees.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed.
 */
import { describe, it, before } from 'mocha'
import { AxiosInstance } from 'axios'
import {
  OrderAPI,
  OrderStatus,
  OrderType,
  OrderSide,
} from 'coinbase-advanced-node'
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

/** The size of the fake venue's open-order book. */
const BOOK = 300
/** How the SDK behaves when the caller sets no `limit` — the whole defect. */
const SDK_DEFAULT_LIMIT = 25

type Params = Record<string, unknown>

/** One resting limit order, in the shape Coinbase Advanced Trade returns. */
function venueOrder(i: number) {
  return {
    order_id: `ord-${i}`,
    client_order_id: `D-${i}`,
    product_id: `P${i % 50}-USDC`,
    status: OrderStatus.OPEN,
    completion_percentage: '0',
    order_type: OrderType.LIMIT,
    side: i % 7 === 0 ? OrderSide.SELL : OrderSide.BUY,
    order_configuration: {
      limit_limit_gtc: { limit_price: `${1 + i}`, base_size: '1' },
    },
    average_filled_price: '0',
    filled_size: '0',
    filled_value: '0',
    total_fees: '0.12',
    created_time: new Date(1757000000000 + i * 1000).toISOString(),
  }
}

/**
 * A fake Coinbase over which a REAL `OrderAPI` is built.
 *
 * `pages` describes what the venue does with pagination; the default is honest
 * cursor paging over `book`. Every request's `params` is recorded.
 */
function venue(
  book: ReturnType<typeof venueOrder>[],
  overrides: {
    /** Return this pagination block instead of the honest one. */
    hostile?: (offset: number, limit: number) => Record<string, unknown>
  } = {},
) {
  const seen: Params[] = []
  const apiClient = {
    get: async (_resource: string, config?: { params?: Params }) => {
      const params = (config?.params ?? {}) as Params
      seen.push({ ...params })
      const limit = Number(params.limit)
      const offset = params.cursor ? Number(`${params.cursor}`.slice(2)) : 0
      const slice = book.slice(offset, offset + limit)
      const next = offset + slice.length
      const honest = {
        has_next: next < book.length,
        cursor: next < book.length ? `c-${next}` : '',
      }
      return {
        data: {
          orders: slice,
          ...(overrides.hostile ? overrides.hostile(offset, limit) : honest),
        },
      }
    },
  }
  return { apiClient, seen }
}

/** A CoinbaseExchange wired to a real `OrderAPI` over the fake venue. */
function connector(v: ReturnType<typeof venue>) {
  const ex = new CoinbaseExchange(
    Futures.null,
    'test-key',
    'test-secret',
  ) as unknown as {
    client: unknown
    checkLimits: (...a: unknown[]) => Promise<unknown>
    getAllOpenOrders: (
      symbol?: string,
      returnOrders?: boolean,
    ) => Promise<{ status: string; reason: string; data: any }>
  }
  // The real SDK class over the fake socket — `OrderAPI` wants a full
  // AxiosInstance and only ever calls `.get` on it.
  ex.client = {
    rest: { order: new OrderAPI(v.apiClient as unknown as AxiosInstance) },
  }
  let limitChecks = 0
  const realCheckLimits = ex.checkLimits.bind(ex)
  ex.checkLimits = async (...args: unknown[]) => {
    limitChecks++
    return realCheckLimits(...args)
  }
  return { ex, limitChecks: () => limitChecks }
}

describe('coinbase open-orders pagination', () => {
  const book = Array.from({ length: BOOK }, (_v, i) => venueOrder(i))

  // §1.1 / §4.2 — the list shape must be the whole book, not the first page.
  // Before the fix this is 25: the SDK's default limit, one page, no loop.
  describe('list shape', () => {
    let res: { status: string; data: any }
    let seen: Params[]

    before(async () => {
      const v = venue(book)
      seen = v.seen
      res = await connector(v).ex.getAllOpenOrders(undefined, true)
    })

    check('list shape | status', () => res.status, 'OK')
    check('list shape | rows', () => res.data.length, BOOK)
    check(
      'list shape | distinct order ids',
      () => new Set(res.data.map((o: any) => o.orderId)).size,
      BOOK,
    )
    check(
      'list shape | last order of the book is present',
      () => res.data.some((o: any) => o.orderId === `ord-${BOOK - 1}`),
      true,
    )
    check(
      'list shape | more than one venue request',
      () => seen.length > 1,
      true,
    )
  })

  // §1.2 / §4.3 — the count shape feeds main-app's max-orders guard. It must
  // count the accumulated rows, not the first page's length.
  describe('count shape', () => {
    let res: { status: string; data: any }

    before(async () => {
      res = await connector(venue(book)).ex.getAllOpenOrders('P1-USDC', false)
    })

    check('count shape | status', () => res.status, 'OK')
    check('count shape | count', () => res.data, BOOK)
  })

  // §2.3 / §4.1 — the SDK only substitutes 25 when the caller sends no limit.
  // Assert on what actually reached the wire.
  describe('request params', () => {
    let seen: Params[]

    before(async () => {
      const v = venue(book)
      seen = v.seen
      await connector(v).ex.getAllOpenOrders(undefined, true)
    })

    check(
      'request params | every request carried a limit',
      () => seen.every((p) => typeof p.limit === 'number'),
      true,
    )
    check(
      'request params | none fell back to the SDK default',
      () => seen.some((p) => p.limit === SDK_DEFAULT_LIMIT),
      false,
    )
    check(
      'request params | the order filter is preserved on every page',
      () =>
        seen.every(
          (p) =>
            JSON.stringify(p.order_status) ===
            JSON.stringify([OrderStatus.OPEN]),
        ),
      true,
    )
    check(
      'request params | only the first request has no cursor',
      () => seen.filter((p) => p.cursor === undefined).length,
      1,
    )
  })

  // §4.4 — paging must not outrun the connector's own Coinbase budget: every
  // extra venue request goes through the same rate-limit gate as the first.
  describe('rate limiting', () => {
    let limitChecks: () => number
    let seen: Params[]

    before(async () => {
      const v = venue(book)
      seen = v.seen
      const c = connector(v)
      limitChecks = c.limitChecks
      await c.ex.getAllOpenOrders(undefined, true)
    })

    check(
      'rate limiting | one gate per venue request',
      () => limitChecks() >= seen.length,
      true,
    )
  })

  // §4.5 — a venue that lies about pagination must not spin us. Each of these
  // says `has_next: true` forever; the loop has to stop anyway.
  describe('malformed pagination', () => {
    const settle = async (
      hostile: (offset: number, limit: number) => Record<string, unknown>,
    ) => {
      const v = venue(book, { hostile })
      const c = connector(v)
      const out = await Promise.race([
        c.ex
          .getAllOpenOrders(undefined, true)
          .then((r) => ({ done: true, status: r.status, data: r.data })),
        new Promise((r) => setTimeout(() => r({ done: false }), 8000)),
      ])
      return {
        out: out as { done: boolean; status?: string; data?: any[] },
        seen: v.seen,
      }
    }

    let noCursor: Awaited<ReturnType<typeof settle>>
    let sameCursor: Awaited<ReturnType<typeof settle>>
    let emptyPage: Awaited<ReturnType<typeof settle>>

    before(async () => {
      // has_next, but no cursor to follow it with.
      noCursor = await settle(() => ({ has_next: true }))
      // has_next with a cursor that never advances.
      sameCursor = await settle(() => ({ has_next: true, cursor: 'c-0' }))
      // has_next forever, past the end of the book, so pages come back empty.
      emptyPage = await settle((offset) => ({
        has_next: true,
        cursor: `c-${offset + 250}`,
      }))
    })

    check(
      'malformed | missing cursor terminates',
      () => noCursor.out.done,
      true,
    )
    check(
      'malformed | missing cursor still OK',
      () => noCursor.out.status,
      'OK',
    )
    check(
      'malformed | repeated cursor terminates',
      () => sameCursor.out.done,
      true,
    )
    check(
      'malformed | repeated cursor does not loop',
      () => sameCursor.seen.length <= 2,
      true,
    )
    check(
      'malformed | repeated cursor does not double-count',
      () => {
        const ids = (sameCursor.out.data ?? []).map((o: any) => o.orderId)
        return ids.length === new Set(ids).size
      },
      true,
    )
    check(
      'malformed | runaway has_next terminates',
      () => emptyPage.out.done,
      true,
    )
    check(
      'malformed | runaway has_next is bounded',
      () => emptyPage.seen.length < 30,
      true,
    )
  })

  // §4.6 — the ordinary case is unchanged: one page in, one request out.
  describe('single page', () => {
    let res: { status: string; data: any }
    let seen: Params[]

    before(async () => {
      const v = venue(book.slice(0, 3))
      seen = v.seen
      res = await connector(v).ex.getAllOpenOrders('P1-USDC', true)
    })

    check('single page | status', () => res.status, 'OK')
    check('single page | rows', () => res.data.length, 3)
    check('single page | one venue request', () => seen.length, 1)
    check(
      'single page | product filter forwarded',
      () => seen[0].product_id,
      'P1-USDC',
    )
    check('single page | converted shape', () => res.data[0], {
      feePaid: '0.12',
      feeSide: 'quote',
      symbol: 'P0-USDC',
      orderId: 'ord-0',
      clientOrderId: 'D-0',
      transactTime: 1757000000000,
      updateTime: 1757000000000,
      price: '1',
      origQty: '1',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      status: 'NEW',
      type: 'LIMIT',
      side: 'SELL',
      fills: [],
    })
  })
})
