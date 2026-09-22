process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #914 — Bitget futures candles come back empty at
 * `1d` and `1w` over any window wider than the venue's window-span cap
 * (spec 019).
 *
 * `futures_getCandles` sizes a page by BAR COUNT only (200 × the interval), so
 * a `1d` page asks for 200 days and a `1w` page for 1400 days. Bitget's
 * `/api/v2/mix/market/history-candles` also caps the WINDOW SPAN at ~90 days
 * regardless of granularity, so every such page is refused with `40017` and
 * the whole call returns `NOTOK` with nothing (spec 019 §1.2).
 *
 * Run: `npm test` (mocha). No network / auth — the REST client is stubbed with
 * a venue that behaves like the live one: half-open `[startTime, endTime)`,
 * `limit` rows per page, and a `40017` refusal for any window wider than the
 * measured cap (spec 019 §2.1, measured 2026-09-23).
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { timeIntervalMap } from '../okx'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** What the live venue accepts; the code's own constant must sit at or below it. */
const VENUE_SPAN_CAP = 90 * DAY

const VENUE_WIDTHS: Record<string, number> = {
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

type Call = { granularity: string; start: number; end: number }

/**
 * A `BitgetExchange` whose futures candle endpoint is the live venue's
 * behaviour: bars anchored on the epoch at the requested granularity, served
 * half-open over `[startTime, endTime)` and capped at `limit` rows — and a
 * `40017` refusal for a window wider than `VENUE_SPAN_CAP`.
 */
function stub() {
  const calls: Call[] = []
  const ex: any = new BitgetExchange(Futures.usdm, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.client = {
    getFuturesHistoricCandles: async (p: any) => {
      const start = +p.startTime
      const end = +p.endTime
      calls.push({ granularity: p.granularity, start, end })
      if (end - start > VENUE_SPAN_CAP) {
        return {
          code: '40017',
          msg: 'Parameter verification failed startTime || endTime',
          data: null,
        }
      }
      const width = VENUE_WIDTHS[p.granularity]
      if (!width) {
        return { code: '400171', msg: `Parameter ${p.granularity}`, data: null }
      }
      const rows: string[][] = []
      for (
        let t = Math.ceil(start / width) * width;
        t < end && rows.length < +p.limit;
        t += width
      ) {
        rows.push([`${t}`, '1', '2', '0', '1', '1', '1'])
      }
      return { code: '00000', msg: 'success', data: rows }
    },
  }
  return { ex, calls }
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

/** Ask for `days` of `interval` and describe the series that came back. */
async function read(ex: any, interval: ExchangeIntervals, days: number) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex.futures_getCandles('BTCUSDT', interval, from, to)
  if (res.status === StatusEnum.notok) {
    return { from, to, error: `${res.reason?.message ?? res.reason}` }
  }
  const times: number[] = [
    ...new Set<number>(res.data.map((c: any) => c.time)),
  ].sort((a, b) => a - b)
  return {
    from,
    to,
    count: times.length,
    oldest: times[0],
    newest: times[times.length - 1],
  }
}

describe('bitget futures candles — the venue span cap is paged around (#914)', () => {
  const WINDOW = 730

  for (const [interval, label] of [
    [ExchangeIntervals.oneD, '1d'],
    [ExchangeIntervals.oneW, '1w'],
  ] as [ExchangeIntervals, string][]) {
    it(`${label} over ${WINDOW}d returns the series instead of nothing`, async () => {
      // spec 019 §1.1/§1.2 — one page is 200 bars = 200d at 1d and 1400d at
      // 1w, both wider than the venue's cap, so every page was refused.
      const { ex } = stub()
      const r: any = await read(ex, interval, WINDOW)
      ok(`${label} status`, !r.error, `NOTOK: ${r.error}`)
      const width = timeIntervalMap[interval]
      // The series must start within one page of the requested `from` and run
      // to the last closed bar — i.e. the whole window is covered.
      ok(
        `${label} depth`,
        r.oldest - r.from <= VENUE_SPAN_CAP,
        `oldest bar is ${(r.oldest - r.from) / DAY}d after the requested start`,
      )
      ok(
        `${label} reach`,
        r.to - r.newest <= VENUE_SPAN_CAP,
        `newest bar is ${(r.to - r.newest) / DAY}d before the requested end`,
      )
      ok(
        `${label} count`,
        r.count >= Math.floor((WINDOW * DAY) / width) * 0.9,
        `only ${r.count} bars for ${WINDOW}d at ${label}`,
      )
    })
  }

  it('never asks the venue for a window wider than it accepts', async () => {
    // spec 019 §1.3 — the page budget must respect the span cap as well as the
    // row limit, at every granularity.
    for (const interval of [
      ExchangeIntervals.oneH,
      ExchangeIntervals.fourH,
      ExchangeIntervals.eightH,
      ExchangeIntervals.oneD,
      ExchangeIntervals.oneW,
    ]) {
      const { ex, calls } = stub()
      await read(ex, interval, WINDOW)
      const widest = Math.max(...calls.map((c) => c.end - c.start))
      ok(
        `${interval} page span`,
        widest <= VENUE_SPAN_CAP,
        `widest requested window was ${widest / DAY}d`,
      )
    }
  })

  it('still reaches back past 89 days — bug #225 stays fixed', async () => {
    // spec 019 §1.4 — the fix for #225 removed a hard clamp of the start to 89
    // days ago; a span-aware pager must page BACK through the window, never
    // truncate it.
    const { ex } = stub()
    const r: any = await read(ex, ExchangeIntervals.oneD, WINDOW)
    ok('225 status', !r.error, `NOTOK: ${r.error}`)
    ok(
      '225 depth',
      r.to - r.oldest > 700 * DAY,
      `series only reaches back ${(r.to - r.oldest) / DAY}d`,
    )
  })

  it('leaves 8h and below on the row-sized pages they already used', async () => {
    // spec 019 §1.5 — a 200-row page is already inside the cap at every
    // interval up to 4h (200 × 4h = 33d), so the cap must not shrink those
    // pages: every page but the last is still exactly 200 rows wide, and the
    // series is the same one they got before.
    for (const interval of [
      ExchangeIntervals.oneH,
      ExchangeIntervals.fourH,
      ExchangeIntervals.eightH,
    ]) {
      const { ex, calls } = stub()
      const r: any = await read(ex, interval, WINDOW)
      ok(`${interval} status`, !r.error, `NOTOK: ${r.error}`)
      // 8h is read at its 4h base and merged (#913), so the page width is the
      // base interval's.
      const pageWidth =
        interval === ExchangeIntervals.eightH
          ? 4 * HOUR
          : timeIntervalMap[interval]
      eq(
        `${interval} page span`,
        [...new Set(calls.map((c) => c.end - c.start))],
        [200 * pageWidth],
      )
      // The last page still runs one page past the requested end, exactly as
      // it always has — that overhang is what carries the bar the end falls
      // inside, because the venue only serves bars that close within the
      // window. Clamping it would silently drop the in-progress candle from
      // every multi-page read.
      const last = calls[calls.length - 1]
      ok(
        `${interval} overhang`,
        last.end > r.to,
        `last page ends at or before the requested end`,
      )
    }
  })
})
