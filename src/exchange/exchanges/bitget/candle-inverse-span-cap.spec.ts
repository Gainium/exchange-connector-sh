process.env.NODE_ENV = 'testing'

/**
 * Inverse perpetuals (`BTCUSD`, `DOGEUSD` … on `bitgetCoinm`) read their
 * candles from `/api/v3/market/candles` (spec 014), and that endpoint caps the
 * `[startTime, endTime]` span at 90 days exactly like v2 does — refusing a
 * wider window with `00001 "startTime and endTime interval cannot be greater
 * than 90 days"` (measured live on DOGEUSD_CM / BTCUSD_CM, 2026-09-24, at
 * `4H`, `1Dutc` and `1Wutc`).
 *
 * `coinm_getCandles` sized its pages by ROW count only (1000 × the interval),
 * so every page at 4h and wider broke the cap: `1w` returned nothing at all,
 * and the archive's backfill of a daily gap was refused wholesale, leaving the
 * chart with the few days written since the relisting. It also stopped at the
 * first short page, so a window that opens before the listing (v3 serves the
 * unified line from 2026-01-23) ended on the empty page and never reached the
 * listed range.
 *
 * Run: `npm test` (mocha). No network / auth — the v3 client is stubbed with a
 * venue that caps the span, serves at most `limit` rows and has no bars before
 * `LISTED`.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { timeIntervalMap } from '../okx'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const VENUE_SPAN_CAP = 90 * DAY

const VENUE_WIDTHS: Record<string, number> = {
  '1m': MIN,
  '15m': 15 * MIN,
  '1H': HOUR,
  '4H': 4 * HOUR,
  '1Dutc': DAY,
  '1Wutc': 7 * DAY,
}

type Call = { interval: string; start: number; end: number }

function stub(listed: number) {
  const calls: Call[] = []
  const ex: any = new BitgetExchange(Futures.coinm, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.orderClient = {
    getCandlesV3: async (p: any) => {
      const start = +p.startTime
      const end = +p.endTime
      calls.push({ interval: p.interval, start, end })
      if (end - start > VENUE_SPAN_CAP) {
        throw {
          code: 400,
          message: 'Bad Request',
          body: {
            code: '00001',
            msg: 'startTime and endTime interval cannot be greater than 90 days',
          },
        }
      }
      const width = VENUE_WIDTHS[p.interval]
      const rows: string[][] = []
      for (
        let t = Math.max(Math.ceil(start / width), Math.ceil(listed / width)) *
          width;
        t <= end && rows.length < +p.limit;
        t += width
      ) {
        rows.push([`${t}`, '1', '2', '0', '1', '1', '1'])
      }
      return { code: '00000', msg: 'success', data: rows }
    },
  }
  return { ex, calls }
}

function ok(label: string, cond: boolean, detail: string) {
  if (!cond) {
    throw new Error(`${label}: ${detail}`)
  }
}

async function read(
  ex: any,
  interval: ExchangeIntervals,
  days: number,
): Promise<{ error?: string; times: number[]; from: number; to: number }> {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex.futures_getCandles('DOGEUSD', interval, from, to)
  if (res.status === StatusEnum.notok) {
    return { error: `${res.reason?.message ?? res.reason}`, times: [], from, to }
  }
  return { times: res.data.map((c: any) => c.time), from, to }
}

describe('bitget inverse candles — the v3 span cap is paged around', () => {
  for (const [interval, days] of [
    [ExchangeIntervals.fourH, 200],
    [ExchangeIntervals.oneD, 400],
    [ExchangeIntervals.oneW, 1400],
  ] as [ExchangeIntervals, number][]) {
    it(`${interval} over ${days}d returns the whole series`, async () => {
      const { ex, calls } = stub(0)
      const r = await read(ex, interval, days)
      ok(`${interval} status`, !r.error, `NOTOK: ${r.error}`)
      const widest = Math.max(...calls.map((c) => c.end - c.start))
      ok(
        `${interval} page span`,
        widest <= VENUE_SPAN_CAP,
        `widest requested window was ${widest / DAY}d`,
      )
      const width = timeIntervalMap[interval]
      ok(
        `${interval} count`,
        r.times.length >= Math.floor((days * DAY) / width),
        `only ${r.times.length} bars for ${days}d`,
      )
      ok(
        `${interval} reach`,
        r.times[r.times.length - 1] === r.to,
        `newest bar ${(r.to - r.times[r.times.length - 1]) / DAY}d short of the end`,
      )
    })
  }

  it('walks past empty pages before the listing', async () => {
    const width = timeIntervalMap[ExchangeIntervals.oneD]
    const now = Math.floor(Date.now() / width) * width
    const listed = now - 240 * DAY
    const { ex } = stub(listed)
    const r = await read(ex, ExchangeIntervals.oneD, 700)
    ok('pre-listing status', !r.error, `NOTOK: ${r.error}`)
    ok(
      'pre-listing reach',
      r.times[0] === listed && r.times[r.times.length - 1] === r.to,
      `series ran ${r.times[0]}..${r.times[r.times.length - 1]}, want ${listed}..${r.to}`,
    )
  })

  it('returns each bar once, oldest first', async () => {
    const { ex } = stub(0)
    const r = await read(ex, ExchangeIntervals.oneD, 400)
    ok('dedup', new Set(r.times).size === r.times.length, 'duplicate bars')
    ok(
      'ascending',
      r.times.every((t, i) => i === 0 || t > r.times[i - 1]),
      'bars out of order',
    )
  })

  it('keeps row-sized pages where they already fit the cap', async () => {
    // 1000 × 1h = 41.7d — inside the cap, so the page layout must not change.
    const { ex, calls } = stub(0)
    const r = await read(ex, ExchangeIntervals.oneH, 80)
    ok('1h status', !r.error, `NOTOK: ${r.error}`)
    ok(
      '1h pages',
      calls.length === Math.ceil((80 * DAY) / (1000 * HOUR)),
      `${calls.length} pages`,
    )
  })
})
