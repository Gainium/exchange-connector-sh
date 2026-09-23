process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #923 — a binance or bybit candle range comes back as
 * ONE venue page, however long a window was asked for (spec 024).
 *
 * The stub venues below model what spec 024 §2.2 MEASURED against the live
 * APIs on 2026-09-23, not what the docs claim:
 *
 *   - both ends INCLUSIVE (`[start, end]`) — a 5-bar span returns 6 bars, so a
 *     chunk must span `pageSize - 1` bars or the limit binds;
 *   - binance anchors at `startTime` and serves the OLDEST rows of the window,
 *     ascending; bybit anchors at `end` and serves the NEWEST, descending —
 *     which is why the same 200-day request loses its start on one venue and
 *     its end on the other;
 *   - over-asking is silently CLAMPED, never rejected: binance spot caps at
 *     1000, binance futures at 1500, bybit at 1000 on every category.
 *
 * Every case runs the window through BOTH as numbers and as the query strings
 * `@Query` really delivers (spec 023 §2.1): the pager is the first code in
 * either adapter to ADD to `from`/`to`, so an un-coerced string would
 * concatenate and collapse the loop exactly as #921's did.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../types'
import BinanceExchange from './binance'
import BybitExchange from './bybit'
import { timeIntervalMap } from './okx'

const DAY = 24 * 60 * 60 * 1000

/** `detail` is a thunk so an assertion that passes never formats its message. */
function ok(label: string, cond: boolean, detail: () => string) {
  if (!cond) {
    throw new Error(`${label}: ${detail()}`)
  }
}

const at = (t: number) => new Date(t).toISOString()

type VenueLog = { limit: number; start: number; end: number }

/**
 * Binance `/klines`: ascending, `[startTime, endTime]` inclusive, the OLDEST
 * `min(limit, cap)` rows of the window. Row shape is the venue's own array with
 * a NUMERIC open time (the adapter reads `k[0]` straight into `time`).
 */
function binanceVenue(cap: number, width: number, log: VenueLog[]) {
  return async (p: any) => {
    const limit = Math.min(+p.limit || cap, cap)
    const start = +p.startTime
    const end = +p.endTime
    log.push({ limit, start, end })
    const rows: (number | string)[][] = []
    for (
      let t = Math.ceil(start / width) * width;
      t <= end && rows.length < limit;
      t += width
    ) {
      rows.push([t, '1', '2', '0', '1', '1'])
    }
    return rows
  }
}

/**
 * Bybit `/v5/market/kline`: descending, `[start, end]` inclusive, the NEWEST
 * `min(limit, cap)` rows of the window. Row shape is the venue's own array of
 * strings.
 */
function bybitVenue(cap: number, width: number, log: VenueLog[]) {
  return async (p: any) => {
    const limit = Math.min(+p.limit || cap, cap)
    const start = +p.start
    const end = +p.end
    log.push({ limit, start, end })
    const rows: string[][] = []
    for (
      let t = Math.floor(end / width) * width;
      t >= start && rows.length < limit;
      t -= width
    ) {
      rows.push([`${t}`, '1', '2', '0', '1', '1', '1'])
    }
    return { retCode: 0, retMsg: 'OK', result: { list: rows } }
  }
}

function binanceStub(futures: Futures, interval: ExchangeIntervals) {
  const width = timeIntervalMap[interval]
  const log: VenueLog[] = []
  const ex: any = new BinanceExchange('com' as any, futures, '', '')
  ex.checkLimits = async (..._a: any[]) => undefined
  const venue = binanceVenue(futures === Futures.null ? 1000 : 1500, width, log)
  ex.client = { getKlines: venue }
  ex.usdmClient = { getKlines: venue }
  ex.coinmClient = { getKlines: venue }
  ex.log = log
  return ex
}

function bybitStub(futures: Futures, interval: ExchangeIntervals) {
  const width = timeIntervalMap[interval]
  const log: VenueLog[] = []
  const ex: any = new BybitExchange(futures, '', '')
  ex.checkLimits = async (..._a: any[]) => undefined
  ex.client = { getKline: bybitVenue(1000, width, log) }
  ex.log = log
  return ex
}

/**
 * Ask `ex` for `days` of `interval` and describe what came back. `as` picks the
 * runtime type of the window, which is `string` in production.
 */
async function read(
  ex: any,
  interval: ExchangeIntervals,
  days: number,
  as: 'number' | 'string',
  count?: number,
) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex.getCandles(
    'BTCUSDT',
    interval,
    as === 'number' ? from : (`${from}` as any),
    as === 'number' ? to : (`${to}` as any),
    count,
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
    expected: Math.round((to - from) / width),
    raw,
    inWindow,
    missing,
    dupes: raw.length - times.length,
    ascending: raw.every((t, i) => i === 0 || t >= raw[i - 1]),
    log: ex.log as VenueLog[],
    calls: (ex.log as VenueLog[]).length,
  }
}

/** interval, label, days, and the ceiling on venue calls the window needs. */
const CASES: [ExchangeIntervals, string, number, number][] = [
  [ExchangeIntervals.oneH, '1h', 200, 15],
  [ExchangeIntervals.oneD, '1d', 700, 5],
  [ExchangeIntervals.fifteenM, '15m', 60, 15],
]

const VENUES: [string, (i: ExchangeIntervals) => any][] = [
  ['binance spot', (i) => binanceStub(Futures.null, i)],
  ['binance usdm', (i) => binanceStub(Futures.usdm, i)],
  ['bybit spot', (i) => bybitStub(Futures.null, i)],
  ['bybit linear', (i) => bybitStub(Futures.usdm, i)],
]

describe('binance / bybit candle ranges page the venue (#923)', () => {
  for (const [venue, make] of VENUES) {
    for (const [interval, label, days, callCeiling] of CASES) {
      it(`${venue} ${label} over ${days}d returns the whole window`, async () => {
        // spec 024 §1.1/§1.2 — today this is one call and one page: the oldest
        // 1000 bars on binance, the newest 200 on bybit.
        for (const as of ['number', 'string'] as const) {
          const r = await read(make(interval), interval, days, as)
          ok(
            `${venue} ${label} ${as} coverage`,
            r.inWindow.length === r.expected,
            () =>
              `${r.inWindow.length} bars for a window of ${r.expected} — ` +
              `series starts at ${at(r.inWindow[0])} in ${r.calls} call(s)`,
          )
          ok(
            `${venue} ${label} ${as} holes`,
            r.missing.length === 0,
            () =>
              `${r.missing.length} bar(s) missing, first at ${at(r.missing[0])}`,
          )
          ok(
            `${venue} ${label} ${as} dedup`,
            r.dupes === 0,
            () => `${r.dupes} duplicate bar(s) reached the caller`,
          )
          // spec 024 §3 — pages are concatenated, so the result has to be
          // ordered; bybit's own rows arrive newest-first.
          ok(
            `${venue} ${label} ${as} order`,
            r.ascending,
            () => `series is not ascending`,
          )
          ok(
            `${venue} ${label} ${as} call ceiling`,
            r.calls <= callCeiling,
            () => `${r.calls} venue calls for ${days}d of ${label}`,
          )
        }
      })
    }

    it(`${venue} uses the venue's full page size when it pages`, async () => {
      // spec 024 §2.2 — bybit's `limit: countData || 200` leaves 80% of its own
      // page unused; asking for a fifth of what the venue serves is a 5x call
      // multiplier on exactly the two busiest adapters.
      const r = await read(
        make(ExchangeIntervals.oneH),
        ExchangeIntervals.oneH,
        200,
        'string',
      )
      ok(
        `${venue} page size`,
        r.calls > 1 && r.log.every((c) => c.limit >= 1000),
        () =>
          `${r.calls} call(s), limits ${[...new Set(r.log.map((c) => c.limit))].join('/')}`,
      )
    })

    it(`${venue} leaves a count-passing read at exactly one page`, async () => {
      // spec 024 §3.1 — the out-of-scope constraint. Every caller that passes a
      // count (indicator warm-up, backtest loader, the dashboard chart, the
      // agent tool) must issue the request it issues today.
      const ex = make(ExchangeIntervals.oneH)
      await read(ex, ExchangeIntervals.oneH, 200, 'string', 999)
      const log = ex.log as VenueLog[]
      ok(
        `${venue} count call count`,
        log.length === 1,
        () => `${log.length} venue call(s) for a count-passing read`,
      )
      ok(
        `${venue} count limit`,
        log[0].limit === 999,
        () => `limit ${log[0].limit} sent for count=999`,
      )
    })

    it(`${venue} leaves a read with no range at one page`, async () => {
      // spec 024 §3.1 — no `from`/`to` is "the most recent page", unchanged.
      const ex = make(ExchangeIntervals.oneH)
      const res = await ex.getCandles('BTCUSDT', ExchangeIntervals.oneH)
      ok(
        `${venue} no-range status`,
        res.status === StatusEnum.ok,
        () => `${res.reason?.message ?? res.reason}`,
      )
      ok(
        `${venue} no-range call count`,
        (ex.log as VenueLog[]).length === 1,
        () =>
          `${(ex.log as VenueLog[]).length} venue call(s) for a read with no range`,
      )
    })
  }
})
