process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #921 — a Bitget SPOT candle range collapses to a
 * single venue page when `from`/`to` arrive as strings (spec 023).
 *
 * They always do arrive as strings in production: the connector's own
 * `@Get('/candles')` binds them with `@Query` and no transforming pipe is
 * installed anywhere, so the `: number` annotation is erased and the pager's
 * `cursor + size * step` concatenates (spec 023 §2.1/§2.2). Every case below is
 * therefore run TWICE — once with numbers, once with the strings the HTTP layer
 * really delivers — and the two must agree.
 *
 * The stub venue is the one `candle-page-boundary.spec.ts` models: both spot
 * endpoints with their opposite `endTime` conventions
 * (`/spot/market/candles` = `(start, end]`, `/spot/market/history-candles` =
 * `end`-only and exclusive), plus the drifting recent lookback past which the
 * recent endpoint answers `00000` with nothing. Repeated here rather than
 * shared because each bitget candle spec models the venue at the fidelity its
 * own defect needs, and this one additionally has to count calls.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { timeIntervalMap } from '../okx'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Spec 019 §2.1 — the futures window-span cap the pager must stay inside. */
const VENUE_SPAN_CAP = 90 * DAY

const FUTURES_WIDTHS: Record<string, number> = {
  '1m': MIN,
  '3m': 3 * MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1H': HOUR,
  '2H': 2 * HOUR,
  '4H': 4 * HOUR,
  '6H': 6 * HOUR,
  '1Dutc': DAY,
  '1Wutc': 7 * DAY,
}

const SPOT_WIDTHS: Record<string, number> = {
  '1min': MIN,
  '3min': 3 * MIN,
  '5min': 5 * MIN,
  '15min': 15 * MIN,
  '30min': 30 * MIN,
  '1h': HOUR,
  '2h': 2 * HOUR,
  '4h': 4 * HOUR,
  '6h': 6 * HOUR,
  '1day': DAY,
  '1week': 7 * DAY,
  '1Dutc': DAY,
  '1Wutc': 7 * DAY,
}

/** `volume` is column 7 on spot rows, 6 on futures rows. */
const row = (t: number): string[] => [`${t}`, '1', '2', '0', '1', '1', '1', '1']

/** `detail` is a thunk so an assertion that passes never formats its message. */
function ok(label: string, cond: boolean, detail: () => string) {
  if (!cond) {
    throw new Error(`${label}: ${detail()}`)
  }
}

const at = (t: number) => new Date(t).toISOString()

/**
 * A spot venue with both endpoints, counting every candle call it serves.
 * `recentFloorMs` is the drifting lookback past which `/spot/market/candles`
 * answers `00000` with nothing.
 */
function spotStub(recentFloorMs: number) {
  const ex: any = new BitgetExchange(undefined, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.isRealitySymbol = async () => false
  ex.calls = 0
  ex.client = {
    getSpotCandles: async (p: any) => {
      ex.calls++
      const width = SPOT_WIDTHS[p.granularity]
      const limit = +p.limit
      const end = +p.endTime
      const floor = Date.now() - recentFloorMs
      const rows: string[][] = []
      // (startTime, endTime] — the open at `startTime` is NOT served, the one
      // at `endTime` is.
      for (
        let t = Math.floor(+p.startTime / width) * width + width;
        t <= end && rows.length < limit;
        t += width
      ) {
        if (t >= floor) {
          rows.push(row(t))
        }
      }
      return { code: '00000', msg: 'success', data: rows }
    },
    getSpotHistoricCandles: async (p: any) => {
      ex.calls++
      const width = SPOT_WIDTHS[p.granularity]
      const limit = +p.limit
      const rows: string[][] = []
      // `endTime`-only, walking back, exclusive of the open at `endTime`.
      for (
        let t = Math.ceil(+p.endTime / width) * width - width;
        rows.length < limit;
        t -= width
      ) {
        rows.push(row(t))
      }
      return { code: '00000', msg: 'success', data: rows.reverse() }
    },
  }
  return ex
}

/** The futures venue of spec 019/021 — the control: it already coerces. */
function futuresStub() {
  const ex: any = new BitgetExchange(Futures.usdm, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.calls = 0
  ex.client = {
    getFuturesHistoricCandles: async (p: any) => {
      ex.calls++
      const start = +p.startTime
      const end = +p.endTime
      if (end - start > VENUE_SPAN_CAP) {
        return { code: '40017', msg: 'Parameter verification failed', data: null }
      }
      const width = FUTURES_WIDTHS[p.granularity]
      if (!width) {
        return { code: '400171', msg: `Parameter ${p.granularity}`, data: null }
      }
      const rows: string[][] = []
      for (
        let t = Math.ceil(start / width) * width;
        t < end && rows.length < +p.limit;
        t += width
      ) {
        rows.push(row(t))
      }
      return { code: '00000', msg: 'success', data: rows }
    },
  }
  return ex
}

/**
 * Ask `ex` for `days` of `interval`, passing the window as numbers or as the
 * strings an HTTP query really delivers, and describe what came back.
 */
async function read(
  ex: any,
  method: 'futures_getCandles' | 'spot_getCandles',
  interval: ExchangeIntervals,
  days: number,
  as: 'number' | 'string',
) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex[method](
    'BTCUSDT',
    interval,
    as === 'number' ? from : (`${from}` as any),
    as === 'number' ? to : (`${to}` as any),
  )
  if (res.status === StatusEnum.notok) {
    throw new Error(`NOTOK: ${res.reason?.message ?? res.reason}`)
  }
  const raw: number[] = res.data.map((c: any) => c.time)
  const times = [...new Set(raw)].sort((a, b) => a - b)
  const inWindow = times.filter((t) => t >= from && t < to)
  const missing: number[] = []
  for (let t = inWindow[0]; t < inWindow[inWindow.length - 1]; t += width) {
    if (!inWindow.includes(t)) {
      missing.push(t)
    }
  }
  return {
    from,
    to,
    width,
    raw,
    times,
    inWindow,
    missing,
    calls: ex.calls as number,
    volumes: res.data as any[],
  }
}

/**
 * Widths whose window needs more than one page. `1w` is deliberately absent:
 * one 200-bar historic page is 1400 days, so it covers any range a caller asks
 * for and the collapse is invisible there (spec 023 §1.2).
 */
const CASES: [ExchangeIntervals, string, number, number][] = [
  // interval, label, days, the recent-endpoint lookback floor for that width
  [ExchangeIntervals.oneH, '1h', 200, 59 * DAY],
  [ExchangeIntervals.twoH, '2h', 200, 59 * DAY],
  [ExchangeIntervals.threeM, '3m', 10, 30 * DAY],
  [ExchangeIntervals.fourH, '4h', 730, 239 * DAY],
  [ExchangeIntervals.oneD, '1d', 700, 355 * DAY],
]

describe('bitget spot candles — a string range still pages the venue (#921)', () => {
  for (const [interval, label, days, floor] of CASES) {
    it(`spot ${label} over ${days}d returns the same series for numeric and string from/to`, async () => {
      // spec 023 §1.1/§1.2 — `@Query` hands the pager strings, and
      // `cursor + size * step` concatenates rather than adds, so every chunk
      // clamps to `to` and one page is all the caller ever gets.
      const asNumber = await read(
        spotStub(floor),
        'spot_getCandles',
        interval,
        days,
        'number',
      )
      const asString = await read(
        spotStub(floor),
        'spot_getCandles',
        interval,
        days,
        'string',
      )
      const expected = Math.round((asNumber.to - asNumber.from) / asNumber.width)
      // The numeric path is the oracle, and it is allowed to be one bar short
      // at the leading edge: a range whose FIRST chunk is served by
      // `/spot/market/candles` loses the bar opening exactly at `from`, because
      // that endpoint's window is `(startTime, endTime]`. Measured on the live
      // venue for both `3m`/10d and `1h`/20d (spec 023 §3.1) — pre-existing,
      // identical for both input types, and not what this fix is about.
      ok(
        `spot ${label} numeric baseline`,
        asNumber.inWindow.length >= expected - 1,
        () => `${asNumber.inWindow.length} bars for a window of ${expected}`,
      )
      ok(
        `spot ${label} string count`,
        asString.inWindow.length === asNumber.inWindow.length,
        () =>
          `${asString.inWindow.length} bars against the numeric path's ` +
          `${asNumber.inWindow.length} (window of ${expected}) — ` +
          `series starts at ${at(asString.inWindow[0])}`,
      )
      ok(
        `spot ${label} string series`,
        asString.inWindow.every((t, i) => t === asNumber.inWindow[i]),
        () =>
          `string series diverges from the numeric one at ${at(
            asString.inWindow.find((t, i) => t !== asNumber.inWindow[i]),
          )}`,
      )
      ok(
        `spot ${label} string holes`,
        asString.missing.length === 0,
        () =>
          `${asString.missing.length} bar(s) missing, first at ${at(
            asString.missing[0],
          )}`,
      )
    })
  }

  it('a string range pages the venue instead of collapsing to one call', async () => {
    // spec 023 §1.2 — "one call" is the defect's signature. Asserting coverage
    // alone would pass on a fix that merely widened the single page.
    const ex = spotStub(59 * DAY)
    const r = await read(ex, 'spot_getCandles', ExchangeIntervals.oneH, 200, 'string')
    ok('spot 1h string calls', r.calls > 1, () => `${r.calls} venue call(s) for 200d of 1h`)
    // …and no more than the numeric path already takes: 200d of 1h is 4800
    // bars, paged 1000 (recent) / 200 (historic), so ~20 calls cover it. The
    // safety cap is `totalChunks + 5` = 29; approaching it means spinning.
    ok('spot 1h call ceiling', r.calls <= 25, () => `${r.calls} venue calls for 200d of 1h`)
  })

  it('the half-open cursor, the dedup and the 2h merge survive a string range', async () => {
    // spec 023 §1.5 — the three behaviours this fix must leave alone.
    const r = await read(
      spotStub(59 * DAY),
      'spot_getCandles',
      ExchangeIntervals.twoH,
      200,
      'string',
    )
    ok('2h dedup', r.raw.length === r.times.length, () =>
      `${r.raw.length - r.times.length} duplicate bar(s) reached the caller`,
    )
    // Every 2h bar is merged from two 1h bars of volume 1 (bug #913's merge);
    // a hole in the base would show up here as a half-built bar, not a gap.
    const short = r.volumes.filter(
      (c: any) => c.time >= r.from && c.time < r.to && +c.volume !== 2,
    )
    ok(
      '2h merge completeness',
      short.length === 0,
      () =>
        `${short.length} 2h bar(s) built from a single 1h half, first at ${at(
          short[0].time,
        )}`,
    )
  })

  it('futures is unaffected by the input type', async () => {
    // spec 023 §1.5/§2.2 — `futures_getCandles` coerces with unary `+` at every
    // arithmetic use already. This is the control that says so, and the guard
    // that the spot-side fix did not reach across.
    const asNumber = await read(
      futuresStub(),
      'futures_getCandles',
      ExchangeIntervals.fourH,
      730,
      'number',
    )
    const asString = await read(
      futuresStub(),
      'futures_getCandles',
      ExchangeIntervals.fourH,
      730,
      'string',
    )
    ok(
      'futures parity',
      asString.inWindow.length === asNumber.inWindow.length &&
        asString.calls === asNumber.calls,
      () =>
        `number: ${asNumber.inWindow.length} bars / ${asNumber.calls} calls, ` +
        `string: ${asString.inWindow.length} bars / ${asString.calls} calls`,
    )
  })
})
