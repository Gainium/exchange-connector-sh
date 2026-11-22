process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for spec 050 — Bybit's list endpoints return one page per
 * request (`/v5/order/realtime` defaults to 20 rows, max 50; `/v5/position/list`
 * max 200) and hand back `nextPageCursor` for the rest. Every case drives the
 * real `BybitExchange.getAllOpenOrders` / `futures_getPositions`; only the venue
 * REST client (and the account-shape lookups `convertPosition` makes) is
 * stubbed. No network, no keys.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'

type Ask = {
  settleCoin?: string
  symbol?: string
  limit?: number
  cursor?: string
  hasCursorKey: boolean
}

const orderRow = (i: number, symbol = 'BTCUSDT') => ({
  symbol,
  orderId: `o${i}`,
  orderLinkId: `c${i}`,
  createdTime: '1757000000000',
  updatedTime: '1757000000000',
  price: '100',
  avgPrice: '',
  qty: '1',
  cumExecQty: '0',
  cumExecFee: '0',
  orderStatus: 'New',
  orderType: 'Limit',
  side: 'Buy',
  timeInForce: 'GTC',
  reduceOnly: false,
})

const positionRow = (symbol: string) => ({
  symbol,
  positionStatus: 'Normal',
  positionIM: '10',
  positionMM: '1',
  unrealisedPnl: '0',
  leverage: '5',
  avgPrice: '100',
  side: 'Buy',
  size: '3',
  tradeMode: 0,
  updatedTime: '1757000000000',
})

const ok = (list: unknown[], nextPageCursor = '') => ({
  retCode: 0,
  retMsg: 'OK',
  result: { list, nextPageCursor },
})

const range = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => from + k)

/**
 * `pages` maps the cursor a request carries ('' for none) to what the venue
 * answers; a function value is called (and may throw like bybit-api's
 * `parseException`).
 */
function stub(
  futures: Futures | null,
  pages: (ask: Ask) => unknown,
  method: 'getActiveOrders' | 'getPositionInfo' = 'getActiveOrders',
) {
  const ex = new BybitExchange(futures as Futures, 'k', 's') as any
  const asks: Ask[] = []
  ex.getAllExchangeInfo = async () => ({
    status: StatusEnum.ok,
    data: [{ quoteAsset: { name: 'USDT' } }],
  })
  ex.getAccountType = async () => ({ status: StatusEnum.ok, data: 1 })
  ex.getAccountMargin = async () => ({
    status: StatusEnum.ok,
    data: 'REGULAR_MARGIN',
  })
  ex.client = {
    [method]: async (params: Record<string, unknown>) => {
      const ask: Ask = {
        settleCoin: params.settleCoin as string,
        symbol: params.symbol as string,
        limit: params.limit as number,
        cursor: params.cursor as string,
        hasCursorKey: 'cursor' in params,
      }
      asks.push(ask)
      return pages(ask)
    },
  }
  return { ex, asks }
}

/** Two pages: 20 rows behind no cursor, 6 more behind cursor `p2`. */
const twoOrderPages = (ask: Ask) =>
  !ask.cursor
    ? ok(
        range(1, 20).map((i) => orderRow(i)),
        'p2',
      )
    : ask.cursor === 'p2'
      ? ok(range(21, 6).map((i) => orderRow(i)))
      : ok([])

async function settle(p: () => Promise<unknown>) {
  try {
    return { value: (await p()) as any, threw: null as unknown }
  } catch (e) {
    return { value: null as any, threw: e }
  }
}

function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const ids = (res: any) =>
  res.value?.data?.map((o: { orderId: string }) => o.orderId)

describe('bybit list reads follow nextPageCursor (spec 050)', () => {
  describe('linear settle-coin loop, two pages (20 + 6)', () => {
    let res: { value: any; threw: unknown }
    let count: { value: any; threw: unknown }
    let asks: Ask[]
    before(async () => {
      const s = stub(Futures.usdm, twoOrderPages)
      asks = s.asks
      res = await settle(() => s.ex.getAllOpenOrders(undefined, true))
      count = await settle(() =>
        stub(Futures.usdm, twoOrderPages).ex.getAllOpenOrders(undefined, false),
      )
    })
    expect('status', () => res.value?.status, StatusEnum.ok)
    expect(
      'all 26 orders',
      () => ids(res),
      range(1, 26).map((i) => `o${i}`),
    )
    expect('count overload counts every page', () => count.value?.data, 26)
    expect('asks the max page size', () => asks.map((a) => a.limit), [50, 50])
    expect(
      'second request carries the first cursor',
      () => asks.map((a) => a.cursor ?? null),
      [null, 'p2'],
    )
    expect(
      'first request sends no cursor key',
      () => asks[0]?.hasCursorKey,
      false,
    )
    expect(
      'stays on settle coin',
      () => asks.every((a) => a.settleCoin === 'USDT'),
      true,
    )
  })

  describe('single-request branch (spot), two pages (20 + 6)', () => {
    let res: { value: any; threw: unknown }
    let asks: Ask[]
    before(async () => {
      const s = stub(null, twoOrderPages)
      asks = s.asks
      res = await settle(() => s.ex.getAllOpenOrders(undefined, true))
    })
    expect('status', () => res.value?.status, StatusEnum.ok)
    expect(
      'all 26 orders',
      () => ids(res),
      range(1, 26).map((i) => `o${i}`),
    )
    expect('asks the max page size', () => asks.map((a) => a.limit), [50, 50])
  })

  describe('page two answers a non-OK retMsg', () => {
    for (const [label, futures] of [
      ['linear loop', Futures.usdm],
      ['single request', null],
    ] as const) {
      describe(label, () => {
        let res: { value: any; threw: unknown }
        before(async () => {
          const s = stub(futures, (ask) =>
            ask.cursor === 'p2'
              ? {
                  retCode: 10003,
                  retMsg: 'API key is invalid.',
                  result: { list: [] },
                }
              : twoOrderPages(ask),
          )
          res = await settle(() => s.ex.getAllOpenOrders(undefined, true))
        })
        expect('does not reject', () => res.threw === null, true)
        expect('status', () => res.value?.status, StatusEnum.notok)
        expect('no partial data', () => res.value?.data ?? null, null)
      })
    }
  })

  describe('page two rejects', () => {
    for (const [label, futures] of [
      ['linear loop', Futures.usdm],
      ['single request', null],
    ] as const) {
      describe(label, () => {
        let res: { value: any; threw: unknown }
        before(async () => {
          const s = stub(futures, (ask) => {
            if (ask.cursor === 'p2') {
              throw {
                code: 401,
                message: 'API key is invalid.',
                body: { retCode: 401, retMsg: 'API key is invalid.' },
              }
            }
            return twoOrderPages(ask)
          })
          res = await settle(() => s.ex.getAllOpenOrders(undefined, true))
        })
        expect('does not reject', () => res.threw === null, true)
        expect('status', () => res.value?.status, StatusEnum.notok)
        expect('no partial data', () => res.value?.data ?? null, null)
      })
    }
  })

  describe('a cursor that repeats', () => {
    let res: { value: any; threw: unknown }
    let asks: Ask[]
    before(async () => {
      const s = stub(Futures.usdm, () => ok([orderRow(1)], 'same'))
      asks = s.asks
      res = await settle(() => s.ex.getAllOpenOrders(undefined, true))
    })
    expect('does not reject', () => res.threw === null, true)
    expect('status', () => res.value?.status, StatusEnum.notok)
    expect('stopped after the repeat', () => asks.length, 2)
  })

  describe('positions, linear settle-coin loop, two pages', () => {
    let res: { value: any; threw: unknown }
    let asks: Ask[]
    before(async () => {
      const s = stub(
        Futures.usdm,
        (ask) =>
          !ask.cursor
            ? ok([positionRow('BTCUSDT')], 'p2')
            : ok([positionRow('ETHUSDT')]),
        'getPositionInfo',
      )
      asks = s.asks
      res = await settle(() => s.ex.futures_getPositions())
    })
    expect('status', () => res.value?.status, StatusEnum.ok)
    expect(
      'both pages',
      () => res.value?.data?.map((p: { symbol: string }) => p.symbol),
      ['BTCUSDT', 'ETHUSDT'],
    )
    expect('asks the max page size', () => asks.map((a) => a.limit), [200, 200])
  })
})

describe('bybit positions single-symbol retry keeps its symbol (spec 050)', () => {
  let res: { value: any; threw: unknown }
  let asks: Ask[]
  before(async () => {
    let n = 0
    const s = stub(
      Futures.usdm,
      () =>
        n++ === 0
          ? { retCode: 10006, retMsg: 'Too many visits.', result: { list: [] } }
          : ok([positionRow('BTCUSDT')]),
      'getPositionInfo',
    )
    asks = s.asks
    res = await settle(() => s.ex.futures_getPositions('BTCUSDT'))
  })
  expect('status', () => res.value?.status, StatusEnum.ok)
  expect('retry asked for the same symbol', () => asks.map((a) => a.symbol), [
    'BTCUSDT',
    'BTCUSDT',
  ])
})
