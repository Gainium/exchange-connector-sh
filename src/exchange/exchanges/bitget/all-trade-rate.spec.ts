process.env.NODE_ENV = 'testing'

/**
 * Spec 048 — a classic Bitget fee sweep asks `all-trade-rate` once per
 * business line instead of `trade-rate` once per listed pair (10 req/s/UID ×
 * ~3,660 spot pairs can never finish inside the balancer's 5-minute deadline).
 *
 * Spec 049 — pairs the batch leaves out (USDC-M on `mix`) are asked per
 * symbol; the `049 §…` cases below.
 *
 * Run: `npm test` (mocha). No network — the REST clients are stubbed.
 */
import { beforeEach, describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { clearAccountModeCache } from './uta'

const bitgetError = (code: string, msg: string) => ({
  code: 400,
  message: 'Bad Request',
  body: { code, msg },
})

function eq(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

const PAIRS = 3666

function harness(
  futures: Futures,
  opts: {
    allTradeRate?: (p: { businessType: string }) => unknown
    tradeRate?: (p: { symbol: string; businessType: string }) => unknown
    omit?: string[]
    v3?: Record<string, (...a: any[]) => any>
  } = {},
) {
  const listing = Array.from({ length: PAIRS }, (_, i) => ({
    pair: `C${i}USDT`,
    makerFee: 0.001,
    takerFee: 0.001,
  }))
  const calls = { all: [] as string[], one: [] as string[] }
  const rows = listing
    .filter((l) => !(opts.omit ?? []).includes(l.pair))
    .map((l) => ({
      symbol: l.pair,
      makerFeeRate: '0.0008',
      takerFeeRate: '0.0009',
    }))
  const ex = new BitgetExchange(futures, 'key', 's', 'p') as any
  ex.checkLimits = async () => undefined
  ex.orderClient = {
    // a venue answer with a body code: the key is classic
    getAccountSettingsV3: async () => {
      throw bitgetError('40084', 'some classic answer')
    },
    getAllTradeRate: async (p: { businessType: string }) => {
      calls.all.push(p.businessType)
      return opts.allTradeRate
        ? opts.allTradeRate(p)
        : { code: '00000', data: rows }
    },
    ...(opts.v3 ?? {}),
  }
  ex.client = {
    getTradeRate: async (p: { symbol: string; businessType: string }) => {
      calls.one.push(p.symbol)
      return opts.tradeRate
        ? opts.tradeRate(p)
        : {
            code: '00000',
            data: { makerFeeRate: '0.0008', takerFeeRate: '0.0009' },
          }
    },
  }
  const listed = async () => ex.returnGood(ex.getEmptyTimeProfile())(listing)
  ex.spot_getAllExchangeInfo = listed
  ex.futures_getAllExchangeInfo = listed
  return { ex, calls, listing }
}

describe('bitget classic fee sweep — all-trade-rate (spec 048)', () => {
  beforeEach(() => clearAccountModeCache())

  it('§3.1 spot: one batch call prices every pair, at most one per-pair call', async () => {
    const { ex, calls } = harness(Futures.null)
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('batch calls', calls.all, ['spot'])
    if (calls.one.length > 1) {
      throw new Error(`per-pair fan-out ran: ${calls.one.length} calls`)
    }
    eq('pairs priced', res.data.length, PAIRS)
    eq('account rate', res.data[17], {
      pair: 'C17USDT',
      maker: 0.0008,
      taker: 0.0009,
    })
  })

  it('§3.2 futures asks the mix business line', async () => {
    const { ex, calls } = harness(Futures.usdm)
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('batch calls', calls.all, ['mix'])
    if (calls.one.length > 1) {
      throw new Error(`per-pair fan-out ran: ${calls.one.length} calls`)
    }
    eq('pairs priced', res.data.length, PAIRS)
  })

  it('049 §3.1 a pair the batch leaves out is asked per-pair and gets the account rate', async () => {
    const omit = Array.from({ length: 50 }, (_, i) => `C${i * 7}USDT`)
    const { ex, calls } = harness(Futures.usdm, {
      omit,
      tradeRate: (p) =>
        omit.includes(p.symbol)
          ? {
              code: '00000',
              data: { makerFeeRate: '0.0001', takerFeeRate: '0.0003' },
            }
          : {
              code: '00000',
              data: { makerFeeRate: '0.0008', takerFeeRate: '0.0009' },
            },
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    // probe + only the omitted pairs: the batched pairs are not re-asked
    eq('per-pair calls', calls.one.length, 1 + omit.length)
    eq('only omitted pairs re-asked', calls.one.slice(1).sort(), [...omit].sort())
    eq('pairs priced', res.data.length, PAIRS)
    const byPair = new Map(res.data.map((f: { pair: string }) => [f.pair, f]))
    eq('omitted pair', byPair.get('C7USDT'), {
      pair: 'C7USDT',
      maker: 0.0001,
      taker: 0.0003,
    })
    eq('present pair', byPair.get('C6USDT'), {
      pair: 'C6USDT',
      maker: 0.0008,
      taker: 0.0009,
    })
    eq('listing order kept', res.data[7].pair, 'C7USDT')
  })

  it('049 §3.2 an omitted pair whose per-pair call also fails keeps the listed rate as a ladder fallback', async () => {
    const { ex } = harness(Futures.null, {
      omit: ['C5USDT', 'C9USDT'],
      tradeRate: (p) =>
        p.symbol === 'C5USDT'
          ? { code: '40034', msg: 'the symbol has been removed' }
          : {
              code: '00000',
              data: { makerFeeRate: '0.0008', takerFeeRate: '0.0009' },
            },
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    const byPair = new Map(res.data.map((f: { pair: string }) => [f.pair, f]))
    eq('failed omitted pair', byPair.get('C5USDT'), {
      pair: 'C5USDT',
      maker: 0.001,
      taker: 0.001,
      source: 'ladder',
    })
    eq('answered omitted pair', byPair.get('C9USDT'), {
      pair: 'C9USDT',
      maker: 0.0008,
      taker: 0.0009,
    })
  })

  it('049 §3.3 a key refusal while asking an omitted pair is the call result', async () => {
    const { ex } = harness(Futures.usdm, {
      omit: ['C5USDT'],
      tradeRate: (p) =>
        p.symbol === 'C5USDT'
          ? { code: '40018', msg: 'invalid ip,current request ip 1.2.3.4' }
          : {
              code: '00000',
              data: { makerFeeRate: '0.0008', takerFeeRate: '0.0009' },
            },
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, 'invalid ip,current request ip 1.2.3.4')
  })

  it('049 §3.4 more omitted pairs than the gap budget keep the listed rate without a fan-out', async () => {
    const omit = Array.from({ length: 101 }, (_, i) => `C${i + 1}USDT`)
    const { ex, calls } = harness(Futures.null, { omit })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('per-pair calls', calls.one.length, 1)
    const byPair = new Map(res.data.map((f: { pair: string }) => [f.pair, f]))
    eq('omitted pair', byPair.get('C5USDT'), {
      pair: 'C5USDT',
      maker: 0.001,
      taker: 0.001,
      source: 'ladder',
    })
  })

  it('§3.4 a probe that disagrees with the batch falls back to the per-pair fan-out', async () => {
    const { ex, calls } = harness(Futures.null, {
      tradeRate: () => ({
        code: '00000',
        data: { makerFeeRate: '0.0002', takerFeeRate: '0.0004' },
      }),
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    // probe + one per listed pair
    eq('per-pair calls', calls.one.length, PAIRS + 1)
    eq('per-pair rate wins', res.data[0], {
      pair: res.data[0].pair,
      maker: 0.0002,
      taker: 0.0004,
    })
  })

  it('§3.5 a unified refusal from the batch is routed to v3 with no fan-out', async () => {
    const { ex, calls } = harness(Futures.null, {
      allTradeRate: () => {
        throw bitgetError(
          '40084',
          'you are in unified account mode, and the classic account api is not supported at this time',
        )
      },
      v3: {
        getInstrumentsV3: async () => ({ code: '00000', data: [] }),
        getAllFeeRatesV3: async () => ({
          code: '00000',
          data: [
            { symbol: 'C0USDT', makerFeeRate: '0.0001', takerFeeRate: '0.0003' },
          ],
        }),
      },
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('per-pair calls', calls.one.length, 0)
    eq('v3 rate', res.data[0], { pair: 'C0USDT', maker: 0.0001, taker: 0.0003 })
  })

  it('§3.5 a key refusal from the batch is the call result', async () => {
    const { ex, calls } = harness(Futures.usdm, {
      allTradeRate: () => {
        throw bitgetError('40018', 'invalid ip,current request ip 1.2.3.4')
      },
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, 'invalid ip,current request ip 1.2.3.4')
    eq('per-pair calls', calls.one.length, 0)
  })

  it('§3.6 an unusable batch answer falls back to the per-pair fan-out', async () => {
    const { ex, calls } = harness(Futures.null, {
      allTradeRate: () => ({ code: '00000', data: null }),
    })
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('per-pair calls', calls.one.length, PAIRS)
    eq('pairs priced', res.data.length, PAIRS)
  })
})
