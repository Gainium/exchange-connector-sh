process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #925 — a binance COIN-M candle range wider than 200
 * days comes back `status: OK` with no bars, because the chunk loop asks the
 * SPOT client for a COIN-M symbol (spec 026).
 *
 * Separate from `candle-range-paging.spec.ts` (#923) because that file's
 * `binanceStub` hands the SAME venue function to `client`, `usdmClient` and
 * `coinmClient` — which is the right stub for a pager test and structurally
 * blind to WHICH client a call site picked. Here the three are distinct: the
 * spot one rejects the COIN-M symbol with the venue's real `-1121`, exactly as
 * `api.binance.com` does (spec 026 §1.4), so a call landing on the wrong client
 * fails the way production fails instead of quietly succeeding.
 *
 * Run: `npm test` (mocha). No network / auth.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures, StatusEnum } from '../types'
import BinanceExchange from './binance'
import { timeIntervalMap } from './okx'

const DAY = 24 * 60 * 60 * 1000

/** `detail` is a thunk so an assertion that passes never formats its message. */
function ok(label: string, cond: boolean, detail: () => string) {
  if (!cond) {
    throw new Error(`${label}: ${detail()}`)
  }
}

const at = (t: number) => new Date(t).toISOString()

type VenueLog = { host: string; limit: number; start: number; end: number }

/**
 * A binance futures `/klines` host: ascending, `[startTime, endTime]`
 * inclusive, the OLDEST `min(limit, 1500)` rows of the window — the semantics
 * spec 024 §2.2 measured and spec 026 §3 re-verified (`limit=1501` -> `-1130`).
 */
function futuresVenue(host: string, width: number, log: VenueLog[]) {
  return async (p: any) => {
    const limit = Math.min(+p.limit || 1500, 1500)
    const start = +p.startTime
    const end = +p.endTime
    log.push({ host, limit, start, end })
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
 * The SPOT host. It does not list `BTCUSD_PERP` and answers `-1121 Invalid
 * symbol` (spec 026 §1.4) — the failure the old loop threw away.
 */
function spotVenue(log: VenueLog[]) {
  return async (p: any) => {
    log.push({
      host: 'api.binance.com',
      limit: +p.limit || 0,
      start: +p.startTime,
      end: +p.endTime,
    })
    const e: Error & { code?: number } = new Error('Invalid symbol.')
    e.code = -1121
    throw e
  }
}

function stub(futures: Futures, interval: ExchangeIntervals) {
  const width = timeIntervalMap[interval]
  const log: VenueLog[] = []
  const ex: any = new BinanceExchange('com' as any, futures, '', '')
  ex.checkLimits = async (..._a: any[]) => undefined
  ex.client = { getKlines: spotVenue(log) }
  ex.usdmClient = { getKlines: futuresVenue('fapi.binance.com', width, log) }
  ex.coinmClient = { getKlines: futuresVenue('dapi.binance.com', width, log) }
  ex.log = log
  return ex
}

/**
 * Ask `ex` for `days` of `interval` and describe what came back. `as` picks the
 * runtime type of the window, which is `string` in production (spec 023 §2.1).
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
    'BTCUSD_PERP',
    interval,
    as === 'number' ? from : (`${from}` as any),
    as === 'number' ? to : (`${to}` as any),
    count,
  )
  const log = ex.log as VenueLog[]
  if (res.status === StatusEnum.notok) {
    return {
      notok: true as const,
      reason: `${res.reason?.message ?? res.reason}`,
      log,
      hosts: [...new Set(log.map((c) => c.host))],
    }
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
    notok: false as const,
    reason: '',
    from,
    to,
    expected: Math.round((to - from) / width),
    raw,
    inWindow,
    missing,
    dupes: raw.length - times.length,
    ascending: raw.every((t, i) => i === 0 || t >= raw[i - 1]),
    log,
    hosts: [...new Set(log.map((c) => c.host))],
    calls: log.length,
  }
}

describe('binance COIN-M wide candle ranges (#925)', () => {
  // spec 026 §2.2 — the widths a real count-passing caller reaches this branch
  // with: 1500 bars exceed 200 days at 4h and wider. `1h` is not one of them,
  // but it is the width that shows the second half of the defect (§1.6), so it
  // is here with a count a caller could plausibly send.
  const CASES: [ExchangeIntervals, string, number, number, number][] = [
    // interval, label, days, count, ceiling on venue calls
    [ExchangeIntervals.oneD, '1d', 300, 400, 3],
    [ExchangeIntervals.oneD, '1d', 1500, 1500, 4],
    [ExchangeIntervals.fourH, '4h', 300, 1500, 4],
    [ExchangeIntervals.oneH, '1h', 300, 400, 8],
  ]

  for (const [interval, label, days, count, callCeiling] of CASES) {
    it(`coinm ${label} over ${days}d with count=${count} returns the whole window`, async () => {
      // spec 026 §1.2 — today this is `status: OK` with zero bars, because
      // every chunk went to the spot host and came back -1121.
      for (const as of ['number', 'string'] as const) {
        const r = await read(
          stub(Futures.coinm, interval),
          interval,
          days,
          as,
          count,
        )
        ok(`coinm ${label} ${as} status`, !r.notok, () => `notok: ${r.reason}`)
        if (r.notok) {
          return
        }
        ok(
          `coinm ${label} ${as} host`,
          r.hosts.length === 1 && r.hosts[0] === 'dapi.binance.com',
          () => `reached ${r.hosts.join(', ')}`,
        )
        ok(
          `coinm ${label} ${as} coverage`,
          r.inWindow.length === r.expected,
          () =>
            `${r.inWindow.length} bars for a window of ${r.expected} — ` +
            `series starts at ${at(r.inWindow[0])} in ${r.calls} call(s)`,
        )
        ok(
          `coinm ${label} ${as} holes`,
          r.missing.length === 0,
          () =>
            `${r.missing.length} bar(s) missing, first at ${at(r.missing[0])}`,
        )
        ok(
          `coinm ${label} ${as} dedup`,
          r.dupes === 0,
          () => `${r.dupes} duplicate bar(s) reached the caller`,
        )
        ok(
          `coinm ${label} ${as} order`,
          r.ascending,
          () => `series is not ascending`,
        )
        // spec 026 §3.1 — the pager must not cost more calls than the
        // 200-day loop it replaces.
        ok(
          `coinm ${label} ${as} call ceiling`,
          r.calls <= callCeiling,
          () => `${r.calls} venue calls for ${days}d of ${label}`,
        )
      }
    })
  }

  it('coinm reports a wide range it could not read at all as notok', async () => {
    // spec 026 §2.1 — the `.catch` returned a BaseReturn into a `for` body,
    // where nothing read it, and the `returnGood` after the loop reported the
    // empty accumulator as success.
    const ex = stub(Futures.coinm, ExchangeIntervals.oneD)
    ex.coinmClient = ex.client // every chunk fails, as production's did
    const r = await read(ex, ExchangeIntervals.oneD, 300, 'string', 400)
    ok(
      'coinm total failure status',
      r.notok,
      () =>
        `status OK with ${r.notok ? '?' : r.raw.length} bar(s) for a window nothing answered`,
    )
    ok(
      'coinm total failure reason',
      /invalid symbol/i.test(r.reason),
      () => `reason was ${JSON.stringify(r.reason)}`,
    )
  })

  it('coinm under 200 days still takes a single call on the coin-m client', async () => {
    // spec 026 §1.7 / §3.1 — the out-of-scope constraint. The 200-day trigger
    // is unchanged, so a narrower window keeps the request it issues today.
    const ex = stub(Futures.coinm, ExchangeIntervals.oneD)
    const r = await read(ex, ExchangeIntervals.oneD, 199, 'string', 400)
    ok('coinm 199d status', !r.notok, () => `notok: ${r.reason}`)
    ok(
      'coinm 199d call shape',
      r.log.length === 1 &&
        r.log[0].host === 'dapi.binance.com' &&
        r.log[0].limit === 400,
      () =>
        `${r.log.length} call(s), ${r.log.map((c) => `${c.host}@${c.limit}`).join(', ')}`,
    )
  })

  it('usdm over the same window still takes a single call on the usdm client', async () => {
    // spec 026 §1.7 — `binanceUsdm` never satisfies `this.coinm`, so a
    // count-passing read there keeps spec 024 §3.1's "one page of N".
    const ex = stub(Futures.usdm, ExchangeIntervals.oneD)
    const r = await read(ex, ExchangeIntervals.oneD, 300, 'string', 400)
    ok('usdm 300d status', !r.notok, () => `notok: ${r.reason}`)
    ok(
      'usdm 300d call shape',
      r.log.length === 1 &&
        r.log[0].host === 'fapi.binance.com' &&
        r.log[0].limit === 400,
      () =>
        `${r.log.length} call(s), ${r.log.map((c) => `${c.host}@${c.limit}`).join(', ')}`,
    )
  })
})
