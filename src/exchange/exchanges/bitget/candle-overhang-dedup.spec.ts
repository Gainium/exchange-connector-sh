process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #920 — Bitget futures candle series repeat the bars
 * the deliberately overhanging final page re-serves (spec 022).
 *
 * The stub below is NOT the one `candle-page-boundary.spec.ts` uses. That one
 * models `/mix/market/history-candles` as start-anchored, which is what it
 * looks like for as long as the requested window ends in the past. This one
 * models what the live venue actually does (spec 022 §2.1, measured
 * 2026-09-22 23:42 UTC): it serves the LAST `min(limit, span / width)` bars of
 * the window, and the window's effective end is the last CLOSED bar. The two
 * models coincide for a page inside the window and diverge exactly on the
 * final, overhanging page — which is the defect.
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

const row = (t: number): string[] => [`${t}`, '1', '2', '0', '1', '1', '1', '1']

/** `detail` is a thunk so an assertion that passes never formats its message. */
function ok(label: string, cond: boolean, detail: () => string) {
  if (!cond) {
    throw new Error(`${label}: ${detail()}`)
  }
}

const at = (t: number) => new Date(t).toISOString()

/**
 * The futures venue as measured (spec 022 §2.1):
 *
 *   L = the latest bar open such that the bar CLOSES at or before
 *       min(endTime, now)                       -> the page's anchor
 *   n = min(limit, floor((endTime - startTime) / width))
 *   rows = the n bars ending at L, ascending
 *
 * For a window that ends in the past and holds no more than `limit` bars this
 * is indistinguishable from a start-anchored page. For the overhanging final
 * page it slides the whole page backwards, past its own `startTime`.
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
      const horizon = Math.min(end, Date.now())
      const anchor = Math.floor(horizon / width) * width - width
      const n = Math.min(+p.limit, Math.floor((end - start) / width))
      const rows: string[][] = []
      for (let i = n - 1; i >= 0; i--) {
        const t = anchor - i * width
        if (t >= 0) {
          rows.push(row(t))
        }
      }
      return { code: '00000', msg: 'success', data: rows }
    },
  }
  return ex
}

/** Ask for `days` of `interval` and describe the series that came back. */
async function read(ex: any, interval: ExchangeIntervals, days: number) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex.futures_getCandles('BTCUSDT', interval, from, to)
  if (res.status === StatusEnum.notok) {
    throw new Error(`NOTOK: ${res.reason?.message ?? res.reason}`)
  }
  const raw: number[] = res.data.map((c: any) => c.time)
  const unique = new Set(raw)
  const descending: number[] = []
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] <= raw[i - 1]) {
      descending.push(i)
    }
  }
  return { from, to, width, data: res.data, raw, unique, descending }
}

describe('bitget futures candles — the overhanging page repeats bars (#920)', () => {
  for (const [interval, label, days] of [
    [ExchangeIntervals.oneM, '1m', 1],
    [ExchangeIntervals.oneH, '1h', 30],
    [ExchangeIntervals.fourH, '4h', 730],
    [ExchangeIntervals.oneD, '1d', 730],
    [ExchangeIntervals.oneW, '1w', 730],
  ] as [ExchangeIntervals, string, number][]) {
    it(`${label} over ${days}d returns each bar open once`, async () => {
      // spec 022 §1.1/§6.1 — the venue anchors the final page on the last
      // closed bar and walks `limit` rows back from it, re-serving bars the
      // previous page already returned.
      const r = await read(futuresStub(), interval, days)
      ok(
        `${label} duplicates`,
        r.raw.length === r.unique.size,
        () =>
          `${r.raw.length - r.unique.size} repeated bar(s) of ${r.raw.length}`,
      )
    })

    it(`${label} over ${days}d is strictly ascending in time`, async () => {
      // spec 022 §1.1/§6.2 — a repeated block does not only duplicate, it
      // jumps the series backwards in the middle.
      const r = await read(futuresStub(), interval, days)
      ok(
        `${label} ordering`,
        r.descending.length === 0,
        () =>
          `${r.descending.length} non-ascending step(s), first at index ` +
          `${r.descending[0]} (${at(r.raw[r.descending[0] - 1])} -> ` +
          `${at(r.raw[r.descending[0]])})`,
      )
    })
  }

  it('still overhangs the requested end and stays inside the span cap', async () => {
    // spec 022 §1.4/§6.3 — the two behaviours this fix must leave alone. The
    // final page runs past `to` so the bar the end falls inside can survive
    // (spec 019 §1.6), and no page is ever wider than the venue accepts (spec
    // 019 §1.3). Asserted against the LAST bar the unfixed reader returned,
    // recomputed here from the venue model rather than hard-coded.
    for (const [interval, days] of [
      [ExchangeIntervals.oneH, 30],
      [ExchangeIntervals.fourH, 730],
      [ExchangeIntervals.oneD, 730],
      [ExchangeIntervals.oneW, 730],
    ] as [ExchangeIntervals, number][]) {
      const ex = futuresStub()
      const spans: number[] = []
      const inner = ex.client.getFuturesHistoricCandles
      ex.client.getFuturesHistoricCandles = async (p: any) => {
        spans.push(+p.endTime - +p.startTime)
        return inner(p)
      }
      const r = await read(ex, interval, days)
      ok(
        `${interval} span cap`,
        Math.max(...spans) <= VENUE_SPAN_CAP,
        () => `widest page was ${Math.max(...spans) / DAY}d`,
      )
      ok(
        `${interval} overhang`,
        Math.max(...spans.map(() => 0), ...r.raw) ===
          Math.floor(Date.now() / r.width) * r.width - r.width,
        () =>
          `series ends at ${at(Math.max(...r.raw))}, venue's latest closed ` +
          `bar is ${at(Math.floor(Date.now() / r.width) * r.width - r.width)}`,
      )
    }
  })

  it('8h still merges a complete 4h base', async () => {
    // spec 022 §1.3/§6.4 — the merged widths were immune because
    // `aggregateCandles` deduplicates its own input; deduplicating the base
    // series must not change what they produce. Every 8h bar still carries the
    // volume of both of its 4h halves.
    const ex = futuresStub()
    const width = timeIntervalMap[ExchangeIntervals.eightH]
    const to = Math.floor(Date.now() / width) * width
    const from = to - 730 * DAY
    const res = await ex.futures_getCandles(
      'BTCUSDT',
      ExchangeIntervals.eightH,
      from,
      to,
    )
    const times: number[] = res.data.map((c: any) => c.time)
    ok(
      '8h duplicates',
      times.length === new Set(times).size,
      () => `${times.length - new Set(times).size} repeated 8h bar(s)`,
    )
    const short = res.data.filter(
      (c: any) => c.time >= from && c.time < to && +c.volume !== 2,
    )
    ok(
      '8h merge completeness',
      short.length === 0,
      () =>
        `${short.length} 8h bar(s) built from a single 4h half, first at ` +
        `${at(short[0].time)}`,
    )
  })
})
