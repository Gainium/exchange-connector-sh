process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for spec 009 — Bybit linear `futures_getPositions()` with no
 * `symbol` loops the account's settle coins, and that loop handles no error at
 * all: a rejection escapes the method (Nest turns it into `Internal Server
 * Error`) and a non-`OK` `retMsg` is silently dropped, so the caller gets a
 * SHORT position list stamped `status: OK`.
 *
 * Every case here drives the real `BybitExchange.futures_getPositions` — only
 * the venue REST client and the two account-shape lookups `convertPosition`
 * makes are stubbed. No network, no keys.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'

type Ask = { settleCoin?: string; symbol?: string }

/** One `Normal` linear position row as Bybit v5 returns it. */
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

const okBody = (rows: ReturnType<typeof positionRow>[]) => ({
  retCode: 0,
  retMsg: 'OK',
  result: { list: rows },
})

/**
 * A linear account whose instruments settle in USDT and USDC, so the loop makes
 * exactly two calls. `reply` decides what each settle coin answers; anything it
 * throws is thrown out of the client exactly as `bybit-api`'s `parseException`
 * would.
 */
function stubAccount(reply: (coin: string, attempt: number) => unknown) {
  const ex = new BybitExchange(Futures.usdm, 'k', 's') as any
  const asks: Ask[] = []
  let attempt = 0
  ex.getAllExchangeInfo = async () => ({
    status: StatusEnum.ok,
    data: [
      { quoteAsset: { name: 'USDT' } },
      { quoteAsset: { name: 'USDC' } },
      { quoteAsset: { name: 'USDT' } },
    ],
  })
  // convertPosition asks the venue for the account shape; pin it so the test
  // exercises the loop, not the account-type lookups.
  ex.getAccountType = async () => ({ status: StatusEnum.ok, data: 1 })
  ex.getAccountMargin = async () => ({
    status: StatusEnum.ok,
    data: 'REGULAR_MARGIN',
  })
  ex.client = {
    getPositionInfo: async (params: Ask) => {
      asks.push({ settleCoin: params.settleCoin, symbol: params.symbol })
      if (params.settleCoin === 'USDT') attempt++
      return reply(params.settleCoin ?? '', attempt)
    },
  }
  return { ex, asks }
}

/** Runs the call and records either its value or the error it rejected with. */
async function settle(ex: any) {
  try {
    return { value: await ex.futures_getPositions(), threw: null as unknown }
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

describe('bybit linear positions — settle-coin loop errors (spec 009)', () => {
  // §1.1/§1.2 — the reported incident: an HTTP-level rejection on one settle
  // coin. It must come back as NOTOK, never as a rejected promise (which Nest
  // renders as `Internal Server Error`).
  describe('a settle coin rejects (401 API key is invalid)', () => {
    let res: { value: any; threw: unknown }

    before(async () => {
      const { ex } = stubAccount((coin) => {
        if (coin === 'USDC') {
          throw {
            code: 401,
            message: 'API key is invalid.',
            body: { retCode: 401, retMsg: 'API key is invalid.' },
          }
        }
        return okBody([positionRow('BTCUSDT')])
      })
      res = await settle(ex)
    })

    expect('does not reject', () => res.threw === null, true)
    expect('status', () => res.value?.status, StatusEnum.notok)
    expect(
      'reason names the venue failure',
      () => res.value?.reason,
      'API key is invalid.',
    )
    // A partial list would read as "the USDC positions were closed".
    expect('no partial data', () => res.value?.data, null)
  })

  // §1.1 — the non-throwing shape of the same failure: the venue answers with a
  // body whose retMsg is not OK. Today that coin is silently skipped.
  describe('a settle coin answers a non-OK retMsg', () => {
    let res: { value: any; threw: unknown }

    before(async () => {
      const { ex } = stubAccount((coin) =>
        coin === 'USDC'
          ? {
              retCode: 10003,
              retMsg: 'API key is invalid.',
              result: { list: [] },
            }
          : okBody([positionRow('BTCUSDT')]),
      )
      res = await settle(ex)
    })

    expect('does not reject', () => res.threw === null, true)
    expect('status', () => res.value?.status, StatusEnum.notok)
    expect('reason', () => res.value?.reason, 'API key is invalid.')
    expect('no partial data', () => res.value?.data, null)
  })

  // §1.1 — a retryable code retries the WHOLE read, and the retry must go back
  // through the settle-coin branch. If `symbol` were not handed to the error
  // handler the retry would receive the TimeProfile as its symbol and ask the
  // venue for a per-symbol position instead.
  describe('a retryable venue error', () => {
    let res: { value: any; threw: unknown }
    let asks: Ask[]

    before(async () => {
      const stub = stubAccount((coin, attempt) =>
        coin === 'USDT' && attempt === 1
          ? { retCode: 10006, retMsg: 'Too many visits.', result: { list: [] } }
          : okBody([positionRow(`BTC${coin}`)]),
      )
      asks = stub.asks
      res = await settle(stub.ex)
    })

    expect('does not reject', () => res.threw === null, true)
    expect('status', () => res.value?.status, StatusEnum.ok)
    expect(
      'retry stayed on the settle-coin branch',
      () => asks.every((a) => !!a.settleCoin && !a.symbol),
      true,
    )
    expect('retry re-read every coin', () => asks.map((a) => a.settleCoin), [
      'USDT',
      'USDT',
      'USDC',
    ])
    expect(
      'positions returned',
      () => res.value?.data?.map((p: { symbol: string }) => p.symbol),
      ['BTCUSDT', 'BTCUSDC'],
    )
  })

  // §1.1 — no regression on the healthy path.
  describe('every settle coin answers OK', () => {
    let res: { value: any; threw: unknown }
    let asks: Ask[]

    before(async () => {
      const stub = stubAccount((coin) => okBody([positionRow(`BTC${coin}`)]))
      asks = stub.asks
      res = await settle(stub.ex)
    })

    expect('status', () => res.value?.status, StatusEnum.ok)
    expect('one call per distinct settle coin', () => asks.length, 2)
    expect(
      'both coins present',
      () => res.value?.data?.map((p: { symbol: string }) => p.symbol),
      ['BTCUSDT', 'BTCUSDC'],
    )
  })

  // §1.1 — a `Normal`-only filter still applies; closed rows never surface.
  describe('non-Normal rows are excluded', () => {
    let res: { value: any; threw: unknown }

    before(async () => {
      const stub = stubAccount((coin) =>
        okBody([
          positionRow(`BTC${coin}`),
          { ...positionRow(`ETH${coin}`), positionStatus: 'Liq' },
        ]),
      )
      res = await settle(stub.ex)
    })

    expect('status', () => res.value?.status, StatusEnum.ok)
    expect(
      'only Normal rows',
      () => res.value?.data?.map((p: { symbol: string }) => p.symbol),
      ['BTCUSDT', 'BTCUSDC'],
    )
  })
})
