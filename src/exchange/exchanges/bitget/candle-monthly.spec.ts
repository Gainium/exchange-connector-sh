process.env.NODE_ENV = 'testing'

/**
 * Monthly (`1M`) candles on Bitget. `ExchangeIntervals` has no monthly member
 * and every Bitget reader priced its pages with `timeIntervalMap[interval]`,
 * undefined for `1M`, so the window came out NaN and every Bitget market —
 * spot, USDT-M and inverse — answered OK with no bars while Binance served its
 * monthly history (measured on the prod API, 2026-09-24).
 *
 * The stubs below behave like the live endpoints as measured that day:
 * - v2 mix `history-candles`: anchored on `endTime` — up to `limit` CLOSED
 *   months opening before it, whatever `startTime` says — and a refusal for a
 *   window wider than 90 days. A second variant honours the window instead,
 *   so the reader is pinned to work either way.
 * - v2 mix `candles` (recent): the last four months, the forming one included.
 * - v3 `market/candles`: exactly the months opening inside `[start, end]`,
 *   the forming one included, 90-day cap.
 * - v2 spot `candles` (recent): every month, the forming one included.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'

const DAY = 24 * 60 * 60 * 1000
const SPAN_CAP = 90 * DAY
const MONTH = '1M' as any

const monthStart = (t: number) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
const nextMonth = (t: number) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
/** Every month opening from `listed`'s month up to the current one. */
const months = (listed: number) => {
  const out: number[] = []
  for (let t = monthStart(listed); t <= Date.now(); t = nextMonth(t)) {
    out.push(t)
  }
  return out
}
const row = (t: number) => [`${t}`, '1', '2', '0', '1', '5', '6', '7']
const closed = (t: number) => nextMonth(t) <= Date.now()

type Call = { endpoint: string; start?: number; end?: number }

function stub(futures: Futures, listed: number, anchored = true) {
  const calls: Call[] = []
  const all = months(listed)
  const ex: any = new BitgetExchange(futures, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.isRealitySymbol = async () => false
  const refuse = (start: number, end: number) =>
    end - start > SPAN_CAP
      ? { code: '40017', msg: 'Parameter verification failed', data: null }
      : null
  ex.client = {
    getFuturesHistoricCandles: async (p: any) => {
      const start = +p.startTime
      const end = +p.endTime
      calls.push({ endpoint: 'history', start, end })
      const no = refuse(start, end)
      if (no) return no
      eq('history granularity', p.granularity, '1Mutc')
      const pool = all.filter(
        (t) => closed(t) && t < end && (anchored || t >= start),
      )
      return {
        code: '00000',
        msg: 'success',
        data: pool.slice(-+p.limit).map(row),
      }
    },
    getFuturesCandles: async (p: any) => {
      calls.push({ endpoint: 'recent' })
      eq('recent granularity', p.granularity, '1Mutc')
      return { code: '00000', msg: 'success', data: all.slice(-4).map(row) }
    },
    getSpotCandles: async (p: any) => {
      calls.push({ endpoint: 'spot-recent' })
      eq('spot granularity', p.granularity, '1Mutc')
      return { code: '00000', msg: 'success', data: all.map(row) }
    },
  }
  ex.orderClient = {
    getCandlesV3: async (p: any) => {
      const start = +p.startTime
      const end = +p.endTime
      calls.push({ endpoint: 'v3', start, end })
      if (end - start > SPAN_CAP) {
        throw {
          code: 400,
          message: 'Bad Request',
          body: { code: '00001', msg: 'cannot be greater than 90 days' },
        }
      }
      eq('v3 interval', p.interval, '1Mutc')
      return {
        code: '00000',
        msg: 'success',
        data: all.filter((t) => t >= start && t <= end).map(row),
      }
    },
  }
  return { ex, calls, all }
}

function eq(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

function ok(label: string, cond: boolean, detail: string) {
  if (!cond) {
    throw new Error(`${label}: ${detail}`)
  }
}

async function read(ex: any, method: string, symbol: string, days: number) {
  const to = Date.now()
  const from = to - days * DAY
  const res = await ex[method](symbol, MONTH, from, to)
  ok(`${symbol} status`, res.status === StatusEnum.ok, `${res.reason}`)
  return { times: res.data.map((c: any) => c.time) as number[], from, to }
}

function widest(calls: Call[]) {
  return Math.max(
    0,
    ...calls.filter((c) => c.end != null).map((c) => c.end! - c.start!),
  )
}

describe('bitget monthly candles', () => {
  const listed = Date.UTC(2019, 6, 15)

  for (const anchored of [true, false]) {
    it(`USDT-M returns every month to the forming one (${anchored ? 'anchored' : 'windowed'} history)`, async () => {
      const { ex, calls, all } = stub(Futures.usdm, listed, anchored)
      const r = await read(ex, 'futures_getCandles', 'BTCUSDT', 3000)
      eq('usdm months', r.times, all)
      ok(
        'usdm span',
        widest(calls) <= SPAN_CAP,
        `${widest(calls) / DAY}d window`,
      )
    })
  }

  it('USDT-M reads anchored history in a couple of calls, not one per 90 days', async () => {
    const { ex, calls } = stub(Futures.usdm, listed, true)
    await read(ex, 'futures_getCandles', 'BTCUSDT', 3000)
    ok('usdm calls', calls.length <= 3, `${calls.length} venue calls`)
  })

  it('inverse walks v3 back from now and stops before the listing', async () => {
    const invListed = Date.UTC(2026, 0, 23)
    const { ex, calls, all } = stub(Futures.coinm, invListed)
    const r = await read(ex, 'futures_getCandles', 'BTCUSD', 3000)
    eq('coinm months', r.times, all)
    ok(
      'coinm span',
      widest(calls) <= SPAN_CAP,
      `${widest(calls) / DAY}d window`,
    )
    ok('coinm calls', calls.length <= 8, `${calls.length} venue calls`)
  })

  it('spot answers from one call', async () => {
    const { ex, calls, all } = stub(Futures.null, Date.UTC(2018, 6, 1))
    const r = await read(ex, 'spot_getCandles', 'BTCUSDT', 5000)
    eq('spot months', r.times, all)
    eq('spot calls', calls.length, 1)
  })

  it('cuts the series to the month containing `from`', async () => {
    const { ex } = stub(Futures.usdm, listed, true)
    const to = Date.now()
    const from = Date.UTC(2024, 4, 17)
    const res = await ex.futures_getCandles('BTCUSDT', MONTH, from, to)
    eq('first month', res.data[0].time, Date.UTC(2024, 4, 1))
    ok(
      'ascending, unique',
      res.data.every(
        (c: any, i: number) => !i || c.time > res.data[i - 1].time,
      ),
      'out of order or duplicated',
    )
  })
})
