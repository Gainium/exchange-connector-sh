process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #913 — Bitget candles come back at a different bar
 * width than the caller asked for (spec 017).
 *
 * `convertInterval` / `coinmGranularity` substitute "the nearest granularity
 * Bitget has" for the one requested — `8h`→`6Hutc`, `2h`→`1H`/`1h`,
 * `3m`→`1m`/`1min` — and nothing reconciles the result with the requested
 * width, so an indicator configured at 8h is computed on 6-hour bars with no
 * error anywhere (spec 017 §1.2).
 *
 * Run: `npm test` (mocha). No network / auth — every REST client is stubbed
 * with a venue that behaves like the live one: it serves bars at exactly the
 * granularity it is handed, and refuses a granularity Bitget does not have
 * with the real `400171` body (measured 2026-09-22, spec 017 §2.1).
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { timeIntervalMap } from '../okx'

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** Bar width in ms per granularity string the venue really accepts. */
const VENUE_WIDTHS: Record<string, number> = {
  // v2 futures + v3 unified
  '1m': MIN,
  '3m': 3 * MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1H': HOUR,
  '2H': 2 * HOUR,
  '4H': 4 * HOUR,
  '6H': 6 * HOUR,
  // v2 spot
  '1min': MIN,
  '3min': 3 * MIN,
  '5min': 5 * MIN,
  '15min': 15 * MIN,
  '30min': 30 * MIN,
  '1h': HOUR,
  '4h': 4 * HOUR,
  '6h': 6 * HOUR,
  // UTC-anchored, both lines
  '6Hutc': 6 * HOUR,
  '12Hutc': 12 * HOUR,
  '1Dutc': 24 * HOUR,
  '1Wutc': 7 * 24 * HOUR,
}

/**
 * The venue's answer for one window: bars of `width`, anchored on the epoch
 * exactly as Bitget anchors them, capped at `limit`. An unknown granularity is
 * refused the way the live API refuses it.
 */
function serve(
  granularity: string,
  start: number,
  end: number,
  limit: number,
  row: (time: number, width: number) => string[],
) {
  const width = VENUE_WIDTHS[granularity]
  if (!width) {
    return {
      code: '400171',
      msg: `Parameter verification failed k-line time range (${granularity})`,
      data: null,
    }
  }
  const rows: string[][] = []
  for (
    let t = Math.ceil(start / width) * width;
    t < end && rows.length < limit;
    t += width
  ) {
    rows.push(row(t, width))
  }
  return { code: '00000', msg: 'success', data: rows }
}

/**
 * Price/volume are derived from the bar's own start time so that an aggregated
 * bar can be checked against the base bars it was built from, not just counted:
 * open = t/MIN, close = (t+width)/MIN, high = open+1, low = open-1, volume = 1.
 */
const v2FuturesRow = (t: number, w: number) => [
  `${t}`,
  `${t / MIN}`,
  `${t / MIN + 1}`,
  `${t / MIN - 1}`,
  `${(t + w) / MIN}`,
  '1',
  '1',
]

/** Spot rows carry volume in slot 7, futures in slot 6 (see the readers). */
const v2SpotRow = (t: number, w: number) => [
  `${t}`,
  `${t / MIN}`,
  `${t / MIN + 1}`,
  `${t / MIN - 1}`,
  `${(t + w) / MIN}`,
  '1',
  '1',
  '1',
]

const v3Row = (t: number, w: number) => [
  `${t}`,
  `${t / MIN}`,
  `${t / MIN + 1}`,
  `${t / MIN - 1}`,
  `${(t + w) / MIN}`,
  '1',
  '1',
]

type Call = { granularity: string; limit: number }

/**
 * A `BitgetExchange` whose REST clients are the stub venue above, with the
 * rate limiter and the Reality-symbol warm-up bypassed. Returns the exchange
 * plus the list of granularities it actually requested.
 */
function stub(futures: Futures) {
  const calls: Call[] = []
  const ex: any = new BitgetExchange(futures, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  // Reality tokens have their own (already correct) aggregation path; these
  // tests cover every OTHER symbol, which is what the bug is about.
  ex.isRealitySymbol = async () => false

  ex.client = {
    getFuturesHistoricCandles: async (p: any) => {
      calls.push({ granularity: p.granularity, limit: +p.limit })
      return serve(
        p.granularity,
        +p.startTime,
        +p.endTime,
        +p.limit,
        v2FuturesRow,
      )
    },
    getSpotCandles: async (p: any) => {
      calls.push({ granularity: p.granularity, limit: +p.limit })
      return serve(p.granularity, +p.startTime, +p.endTime, +p.limit, v2SpotRow)
    },
    getSpotHistoricCandles: async (p: any) => {
      calls.push({ granularity: p.granularity, limit: +p.limit })
      // `endTime`-only: walks backwards from endTime by `limit` bars.
      const width = VENUE_WIDTHS[p.granularity]
      const start = width ? +p.endTime - +p.limit * width : 0
      return serve(p.granularity, start, +p.endTime, +p.limit, v2SpotRow)
    },
  }
  ex.orderClient = {
    getCandlesV3: async (p: any) => {
      calls.push({ granularity: p.interval, limit: +p.limit })
      const res = serve(
        p.interval,
        +(p.startTime ?? 0),
        +(p.endTime ?? 0),
        +p.limit,
        v3Row,
      )
      if (res.code !== '00000') {
        throw { code: 400, message: 'Bad Request', body: res }
      }
      return res
    },
  }
  return { ex, calls }
}

/**
 * A window ending at the current bar, aligned to `width`.
 *
 * Anchored on `Date.now()` rather than a fixed date on purpose: the spot
 * reader picks the recent or the historic endpoint by how old the cursor is
 * (`getSpotIntervalLookbackMs`), so a hard-coded date would silently change
 * which endpoint these tests exercise as it ages — and does so immediately
 * under `npm test`, because `kraken/order-call-atomicity.spec.ts` installs a
 * virtual `Date.now()` four months in the future at module load and only
 * restores it partway through the run.
 */
const windowEndingNow = (width: number) =>
  Math.floor(Date.now() / width) * width

function eq(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

/**
 * Ask `method` for `bars` candles of `interval` and describe what came back:
 * the distinct gaps between bar starts, and whether every start is aligned to
 * the requested width. Both must equal the requested width — that is the whole
 * of spec 017 §1.1.
 */
async function widths(
  ex: any,
  method: string,
  symbol: string,
  interval: ExchangeIntervals,
  bars: number,
) {
  const want = timeIntervalMap[interval]
  const to = windowEndingNow(want)
  const from = to - bars * want
  const res = await ex[method](symbol, interval, from, to)
  if (res.status === StatusEnum.notok) {
    return { error: res.reason?.message ?? `${res.reason}` }
  }
  const times: number[] = [
    ...new Set<number>(res.data.map((c: any) => c.time)),
  ].sort((a, b) => a - b)
  return {
    deltas: [...new Set(times.slice(1).map((t, i) => t - times[i]))],
    aligned: times.every((t) => t % want === 0),
    count: times.length,
  }
}

describe('bitget candles — the bar width returned is the one asked for (#913)', () => {
  const CASES: [ExchangeIntervals, number][] = [
    [ExchangeIntervals.threeM, 3 * MIN],
    [ExchangeIntervals.thirtyM, 30 * MIN],
    [ExchangeIntervals.oneH, HOUR],
    [ExchangeIntervals.twoH, 2 * HOUR],
    [ExchangeIntervals.fourH, 4 * HOUR],
    [ExchangeIntervals.eightH, 8 * HOUR],
    [ExchangeIntervals.oneD, 24 * HOUR],
  ]

  for (const [interval, width] of CASES) {
    it(`USDT futures at ${interval} returns ${width / MIN}m bars`, async () => {
      const { ex } = stub(Futures.usdm)
      eq(
        `futures ${interval}`,
        await widths(ex, 'futures_getCandles', 'BTCUSDT', interval, 20),
        { deltas: [width], aligned: true, count: 20 },
      )
    })

    it(`spot at ${interval} returns ${width / MIN}m bars`, async () => {
      const { ex } = stub(Futures.null)
      eq(
        `spot ${interval}`,
        await widths(ex, 'spot_getCandles', 'BTCUSDT', interval, 20),
        { deltas: [width], aligned: true, count: 20 },
      )
    })

    it(`inverse futures at ${interval} returns ${width / MIN}m bars`, async () => {
      const { ex } = stub(Futures.coinm)
      eq(
        `coinm ${interval}`,
        await widths(ex, 'futures_getCandles', 'BTCUSD', interval, 20),
        { deltas: [width], aligned: true, count: 20 },
      )
    })
  }

  it('asks the venue only for granularities it has', async () => {
    // `8h` exists on no Bitget line; `2h` exists on futures but not on spot.
    const futures = stub(Futures.usdm)
    await widths(
      futures.ex,
      'futures_getCandles',
      'BTCUSDT',
      ExchangeIntervals.eightH,
      20,
    )
    eq(
      'futures 8h granularity',
      [...new Set(futures.calls.map((c) => c.granularity))],
      ['4H'],
    )

    const twoH = stub(Futures.usdm)
    await widths(
      twoH.ex,
      'futures_getCandles',
      'BTCUSDT',
      ExchangeIntervals.twoH,
      20,
    )
    eq(
      'futures 2h granularity',
      [...new Set(twoH.calls.map((c) => c.granularity))],
      ['2H'],
    )

    const spot = stub(Futures.null)
    await widths(
      spot.ex,
      'spot_getCandles',
      'BTCUSDT',
      ExchangeIntervals.twoH,
      20,
    )
    eq(
      'spot 2h granularity',
      [...new Set(spot.calls.map((c) => c.granularity))],
      ['1h'],
    )

    const spot3m = stub(Futures.null)
    await widths(
      spot3m.ex,
      'spot_getCandles',
      'BTCUSDT',
      ExchangeIntervals.threeM,
      20,
    )
    eq(
      'spot 3m granularity',
      [...new Set(spot3m.calls.map((c) => c.granularity))],
      ['3min'],
    )
  })

  it('an aggregated bar carries the OHLC of the base bars it spans', async () => {
    const { ex } = stub(Futures.usdm)
    const to = windowEndingNow(8 * HOUR)
    const from = to - 4 * 8 * HOUR
    const res = await ex.futures_getCandles(
      'BTCUSDT',
      ExchangeIntervals.eightH,
      from,
      to,
    )
    eq('status', res.status, StatusEnum.ok)
    const first = res.data[0]
    // Two 4h bars make the 8h bar opening at `from`: open comes from the
    // first, close from the second, high/low from the extremes of both.
    eq('bar open time', first.time, from)
    eq('open', first.open, `${from / MIN}`)
    eq('close', first.close, `${(from + 8 * HOUR) / MIN}`)
    eq('high', first.high, `${(from + 4 * HOUR) / MIN + 1}`)
    eq('low', first.low, `${from / MIN - 1}`)
    eq('volume', first.volume, '2')
  })

  it('pages a long window without leaving a hole', async () => {
    // 600 eight-hour bars is three 200-row pages at the base granularity;
    // the old cursor stepped by the requested width while the venue served a
    // narrower one, so every page skipped part of the range (spec 017 §1.6).
    const { ex } = stub(Futures.usdm)
    const to = windowEndingNow(8 * HOUR)
    const from = to - 600 * 8 * HOUR
    const res = await ex.futures_getCandles(
      'BTCUSDT',
      ExchangeIntervals.eightH,
      from,
      to,
    )
    eq('status', res.status, StatusEnum.ok)
    const times: number[] = [
      ...new Set<number>(res.data.map((c: any) => c.time)),
    ].sort((a, b) => a - b)
    eq(
      'no holes',
      [...new Set(times.slice(1).map((t, i) => t - times[i]))],
      [8 * HOUR],
    )
  })
})
