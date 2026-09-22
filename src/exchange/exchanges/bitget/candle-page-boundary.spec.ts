process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #918 — Bitget candle pages lose the first bar of
 * every page but the first, because the cursor advances past the end of the
 * page it just read (spec 021).
 *
 * The cursor assumes the venue's window is closed at `endTime`. It is not, and
 * the three endpoints do not even agree with each other (spec 021 §2.1,
 * measured against the live venue 2026-09-23):
 *
 *   mix/history-candles   [start, end)   first open == start,        last == end - width
 *   spot/history-candles  (..., end)     `end`-only, 200 bars back,  last == end - width
 *   spot/candles          (start, end]   first open == start + width, last == end
 *
 * Run: `npm test` (mocha). No network / auth — the REST clients are stubbed
 * with venues that reproduce exactly those three shapes, plus the #914 span
 * cap on the futures one so the two fixes are exercised together.
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

const row = (t: number): string[] => [`${t}`, '1', '2', '0', '1', '1', '1', '1']

/** `detail` is a thunk so an assertion that passes never formats its message. */
function ok(label: string, cond: boolean, detail: () => string) {
  if (!cond) {
    throw new Error(`${label}: ${detail()}`)
  }
}

const at = (t: number) => new Date(t).toISOString()

/**
 * A futures venue: bars epoch-anchored at the requested granularity, served
 * half-open over `[startTime, endTime)`, `limit`-capped, and refusing any
 * window wider than the span cap exactly as the live one does.
 */
function futuresStub() {
  const ex: any = new BitgetExchange(Futures.usdm, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.client = {
    getFuturesHistoricCandles: async (p: any) => {
      const start = +p.startTime
      const end = +p.endTime
      if (end - start > VENUE_SPAN_CAP) {
        return {
          code: '40017',
          msg: 'Parameter verification failed startTime || endTime',
          data: null,
        }
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
 * A spot venue with both endpoints and their opposite `endTime` conventions:
 * `/spot/market/candles` serves `(startTime, endTime]`, and
 * `/spot/market/history-candles` is `endTime`-only, 200 bars back, exclusive
 * of `endTime`. `recentFloorMs` is the drifting lookback past which the recent
 * endpoint answers `00000` with nothing.
 */
function spotStub(recentFloorMs: number) {
  const ex: any = new BitgetExchange(undefined, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.isRealitySymbol = async () => false
  ex.client = {
    getSpotCandles: async (p: any) => {
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

/** Ask for `days` of `interval` and describe the series that came back. */
async function read(
  ex: any,
  method: 'futures_getCandles' | 'spot_getCandles',
  interval: ExchangeIntervals,
  days: number,
) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex[method]('BTCUSDT', interval, from, to)
  if (res.status === StatusEnum.notok) {
    throw new Error(`NOTOK: ${res.reason?.message ?? res.reason}`)
  }
  const raw: number[] = res.data.map((c: any) => c.time)
  const times = [...new Set(raw)].sort((a, b) => a - b)
  // Bars that open inside the requested window — the overhang past `to` that
  // carries the in-progress candle is deliberate (spec 019 §1.6) and is not
  // part of what must be contiguous.
  const inWindow = times.filter((t) => t >= from && t < to)
  const missing: number[] = []
  for (let t = inWindow[0]; t < inWindow[inWindow.length - 1]; t += width) {
    if (!inWindow.includes(t)) {
      missing.push(t)
    }
  }
  return { from, to, width, raw, times, inWindow, missing }
}

describe('bitget candles — pages tile with no hole at the boundary (#918)', () => {
  const WINDOW = 730

  for (const [interval, label] of [
    [ExchangeIntervals.oneH, '1h'],
    [ExchangeIntervals.fourH, '4h'],
    [ExchangeIntervals.oneD, '1d'],
    [ExchangeIntervals.oneW, '1w'],
  ] as [ExchangeIntervals, string][]) {
    it(`futures ${label} over ${WINDOW}d has every bar of the window`, async () => {
      // spec 021 §1.1/§1.2 — the page served opens up to `to - width`, so the
      // bar at `to` is the first of the next page; advancing to `to + width`
      // meant no page ever asked for it.
      const r = await read(
        futuresStub(),
        'futures_getCandles',
        interval,
        WINDOW,
      )
      ok(
        `futures ${label} holes`,
        r.missing.length === 0,
        () =>
          `${r.missing.length} bar(s) missing, first at ${at(r.missing[0])}`,
      )
      ok(
        `futures ${label} count`,
        r.inWindow.length === Math.round((r.to - r.from) / r.width),
        () =>
          `${r.inWindow.length} bars for a window of ${Math.round(
            (r.to - r.from) / r.width,
          )}`,
      )
    })
  }

  it('the futures cursor makes consecutive pages disjoint', async () => {
    // spec 021 §3 — futures returns `allCandles` as accumulated, with no dedup
    // of its own, so a cursor that overlapped would double-book bars into every
    // chart and backtest. Starting the next page at the previous page's end is
    // safe because that window is half-open.
    //
    // Scope note: this asserts the CURSOR introduces no overlap. Against the
    // live venue the reply to the final, deliberately overhanging page (spec
    // 019 §1.6) whose `endTime` is in the future is back-filled from the last
    // closed bar, so it re-serves bars earlier pages already returned. That is
    // a separate, pre-existing defect of the overhang — not of the cursor — and
    // it is filed on its own; the merged widths are immune to it because
    // `aggregateCandles` deduplicates its input.
    const r = await read(
      futuresStub(),
      'futures_getCandles',
      ExchangeIntervals.fourH,
      WINDOW,
    )
    ok(
      'futures dupes',
      r.raw.length === r.times.length,
      () => `${r.raw.length - r.times.length} duplicate bar(s)`,
    )
  })

  it('futures 8h merges a complete 4h base, not one with holes', async () => {
    // spec 021 §1.4 — a merged width has no gap to see; a missing base bar
    // silently changes the merged bar's OHLC and volume instead. Every 8h bar
    // must therefore carry the volume of both of its 4h halves.
    const r = await read(
      futuresStub(),
      'futures_getCandles',
      ExchangeIntervals.eightH,
      WINDOW,
    )
    ok(
      '8h holes',
      r.missing.length === 0,
      () => `${r.missing.length} bar(s) missing from the 8h series`,
    )
    const ex = futuresStub()
    const res = await ex.futures_getCandles(
      'BTCUSDT',
      ExchangeIntervals.eightH,
      r.from,
      r.to,
    )
    const short = res.data.filter(
      (c: any) => c.time >= r.from && c.time < r.to && +c.volume !== 2,
    )
    ok(
      '8h merge completeness',
      short.length === 0,
      () =>
        `${short.length} 8h bar(s) built from a single 4h half, first at ${at(
          short[0].time,
        )}`,
    )
  })

  it('futures still overhangs the requested end and stays inside the span cap', async () => {
    // spec 021 §1.5 — the two behaviours this fix must leave alone: the final
    // page runs past `to` so the in-progress candle survives (spec 019 §1.6),
    // and no page is ever wider than the venue accepts (spec 019 §1.3).
    for (const interval of [
      ExchangeIntervals.fourH,
      ExchangeIntervals.oneD,
      ExchangeIntervals.oneW,
    ]) {
      const ex = futuresStub()
      const spans: number[] = []
      const inner = ex.client.getFuturesHistoricCandles
      ex.client.getFuturesHistoricCandles = async (p: any) => {
        spans.push(+p.endTime - +p.startTime)
        return inner(p)
      }
      const r = await read(ex, 'futures_getCandles', interval, WINDOW)
      ok(
        `${interval} span cap`,
        Math.max(...spans) <= VENUE_SPAN_CAP,
        () => `widest page was ${Math.max(...spans) / DAY}d`,
      )
      ok(
        `${interval} overhang`,
        r.times[r.times.length - 1] >= r.to - r.width,
        () =>
          `series stops ${
            (r.to - r.times[r.times.length - 1]) / r.width
          } bars short of the end`,
      )
    }
  })

  for (const [interval, label, days] of [
    [ExchangeIntervals.oneH, '1h', 60],
    [ExchangeIntervals.fourH, '4h', 730],
    [ExchangeIntervals.oneD, '1d', 730],
  ] as [ExchangeIntervals, string, number][]) {
    it(`spot ${label} over ${days}d has every bar of the window`, async () => {
      // spec 021 §2.1 — spot's two endpoints are opposite at `endTime`, so the
      // old cursor lost one bar at each historic boundary and two across the
      // historic -> recent switch.
      const floor = interval === ExchangeIntervals.oneD ? 355 * DAY : 59 * DAY
      const r = await read(spotStub(floor), 'spot_getCandles', interval, days)
      ok(
        `spot ${label} holes`,
        r.missing.length === 0,
        () =>
          `${r.missing.length} bar(s) missing, first at ${at(r.missing[0])}`,
      )
    })
  }

  it('spot terminates on the chunk that reaches the requested end', async () => {
    // spec 021 §3 — `chunkEnd` is clamped to `to`, so a cursor that no longer
    // jumps past it would re-ask the final window until the safety cap.
    const ex = spotStub(59 * DAY)
    let calls = 0
    const recent = ex.client.getSpotCandles
    ex.client.getSpotCandles = async (p: any) => {
      calls++
      return recent(p)
    }
    const historic = ex.client.getSpotHistoricCandles
    ex.client.getSpotHistoricCandles = async (p: any) => {
      calls++
      return historic(p)
    }
    const r = await read(ex, 'spot_getCandles', ExchangeIntervals.oneH, 60)
    // 60d of 1h is 1440 bars; the recent endpoint pages 1000 at a time and the
    // historic one 200, so two or three calls cover it. Anything approaching
    // the `totalChunks + 5` safety cap means the loop stopped spinning rather
    // than finishing.
    ok(
      'spot call count',
      calls <= 6,
      () => `${calls} venue calls for 60d of 1h`,
    )
    ok('spot coverage', r.missing.length === 0, () => 'holes in the series')
  })
})
