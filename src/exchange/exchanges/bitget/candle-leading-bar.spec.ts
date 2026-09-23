process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #924 — a Bitget spot range whose FIRST chunk is
 * served by `/spot/market/candles` never returns the bar opening exactly at
 * `from` (spec 025).
 *
 * The recent endpoint serves `(startTime, endTime]` — open at the start (spec
 * 025 §2.1, re-measured live 2026-09-23) — and the first chunk asks for
 * `startTime: from`, so the bar at `from` is never inside any requested
 * window. #918's `cursor = pageEnd - step` already compensates at every LATER
 * boundary; the first chunk is the one it cannot reach.
 *
 * `candle-page-boundary.spec.ts` cannot see this: its `read()` helper looks for
 * holes only BETWEEN the first and last bar returned, and a series that simply
 * starts one bar late has no interior hole (spec 025 §2.4). So the leading edge
 * gets its own assertions here rather than being bolted onto that file.
 *
 * Run: `npm test` (mocha). No network / auth — the same two-endpoint spot venue
 * `candle-page-boundary.spec.ts` stubs, with their opposite `endTime`
 * conventions.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, StatusEnum } from '../../types'
import BitgetExchange from './index'
import { timeIntervalMap } from '../okx'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

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
 * The live spot pair, both endpoints, with the conventions measured in spec 025
 * §2.1/§2.2: `/spot/market/candles` is `(startTime, endTime]`, and
 * `/spot/market/history-candles` is `endTime`-only, `limit` bars back,
 * exclusive of `endTime`. `recentFloorMs` is the lookback past which the recent
 * endpoint answers `00000` with nothing.
 *
 * Every call is recorded so a test can assert on the WINDOW ASKED FOR, not only
 * on the series that came back.
 */
function spotStub(recentFloorMs: number) {
  const ex: any = new BitgetExchange(undefined, '', '', '')
  ex.checkLimits = async (_m: string, _c?: number, tp?: any) => tp
  ex.isRealitySymbol = async () => false
  const asked: { ep: 'recent' | 'historic'; start?: number; end: number }[] = []
  ex.asked = asked
  ex.client = {
    getSpotCandles: async (p: any) => {
      asked.push({ ep: 'recent', start: +p.startTime, end: +p.endTime })
      const width = SPOT_WIDTHS[p.granularity]
      const limit = +p.limit
      const end = +p.endTime
      const floor = Date.now() - recentFloorMs
      const rows: string[][] = []
      for (
        let t = Math.floor(+p.startTime / width) * width + width;
        t <= end;
        t += width
      ) {
        if (t >= floor) {
          rows.push(row(t))
        }
      }
      // `limit` is anchored on `endTime` and truncates at the START, measured
      // live 2026-09-23: a 1001-bar window at `limit: 1000` came back without
      // the bar at its own `startTime + width` and ending exactly on `endTime`.
      // Modelling this the other way round would green a fix that asks for a
      // window one bar too wide — the venue would cap the extra bar straight
      // back off (spec 025 §3).
      return { code: '00000', msg: 'success', data: rows.slice(-limit) }
    },
    getSpotHistoricCandles: async (p: any) => {
      asked.push({ ep: 'historic', end: +p.endTime })
      const width = SPOT_WIDTHS[p.granularity]
      const limit = +p.limit
      const rows: string[][] = []
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
async function read(ex: any, interval: ExchangeIntervals, days: number) {
  const width = timeIntervalMap[interval]
  const to = Math.floor(Date.now() / width) * width
  const from = to - days * DAY
  const res = await ex.spot_getCandles('BTCUSDT', interval, from, to)
  if (res.status === StatusEnum.notok) {
    throw new Error(`NOTOK: ${res.reason?.message ?? res.reason}`)
  }
  const times: number[] = [...new Set<number>(res.data.map((c: any) => c.time))]
    .sort((a, b) => a - b)
  const inWindow = times.filter((t) => t >= from && t < to)
  const missing: number[] = []
  for (let t = from; t < to; t += width) {
    if (!inWindow.includes(t)) {
      missing.push(t)
    }
  }
  return { from, to, width, times, inWindow, missing, asked: ex.asked }
}

describe('bitget spot candles — the range starts on the bar at `from` (#924)', () => {
  // Each window is short enough that its first chunk is inside the recent
  // lookback, which is the only shape that loses the bar (spec 025 §1.2).
  for (const [interval, label, days, floor] of [
    [ExchangeIntervals.threeM, '3m', 10, 30 * DAY],
    [ExchangeIntervals.oneH, '1h', 20, 59 * DAY],
    [ExchangeIntervals.fourH, '4h', 60, 239 * DAY],
  ] as [ExchangeIntervals, string, number, number][]) {
    it(`spot ${label} over ${days}d returns the bar opening at \`from\``, async () => {
      // spec 025 §1.1 — the recent endpoint is open at the start, so asking it
      // for `startTime: from` puts the bar at `from` outside every window.
      const r = await read(spotStub(floor), interval, days)
      ok(
        `spot ${label} first bar`,
        r.inWindow[0] === r.from,
        () =>
          `series begins at ${at(r.inWindow[0])}, ${
            (r.inWindow[0] - r.from) / r.width
          } bar(s) after the requested ${at(r.from)}`,
      )
      ok(
        `spot ${label} count`,
        r.missing.length === 0,
        () =>
          `${r.missing.length} bar(s) missing from the window, first at ${at(
            r.missing[0],
          )}`,
      )
    })
  }

  it('the first recent chunk asks the venue one bar before `from`', async () => {
    // spec 025 §2.3/§3 — the mechanism, asserted on the REQUEST rather than on
    // the series, so a stub that happened to be generous could not fake it.
    const ex = spotStub(30 * DAY)
    const r = await read(ex, ExchangeIntervals.threeM, 10)
    const first = r.asked[0]
    ok('first call endpoint', first.ep === 'recent', () => `was ${first.ep}`)
    ok(
      'first call startTime',
      first.start === r.from - r.width,
      () =>
        `asked startTime=${at(first.start)}, expected one bar before ${at(
          r.from,
        )}`,
    )
  })

  it('a history-starting range is unchanged and gains no bar before `from`', async () => {
    // spec 025 §1.3 — the historic endpoint is anchored on `endTime` and
    // already reaches back to exactly `cursor`, so it must NOT be back-stepped:
    // doing so would return an out-of-window bar and shift every later chunk.
    for (const [interval, days, floor] of [
      [ExchangeIntervals.oneH, 90, 59 * DAY],
      [ExchangeIntervals.oneD, 400, 355 * DAY],
    ] as [ExchangeIntervals, number, number][]) {
      const ex = spotStub(floor)
      const r = await read(ex, interval, days)
      ok(
        `${interval} first chunk`,
        r.asked[0].ep === 'historic',
        () => `first chunk was ${r.asked[0].ep}, not a history-starting range`,
      )
      ok(
        `${interval} first bar`,
        r.inWindow[0] === r.from,
        () => `series begins at ${at(r.inWindow[0])}, not ${at(r.from)}`,
      )
      ok(
        `${interval} no pre-\`from\` bar`,
        r.times.filter((t) => t < r.from).length === 0,
        () =>
          `${r.times.filter((t) => t < r.from).length} bar(s) before ${at(
            r.from,
          )}, first at ${at(r.times[0])}`,
      )
      ok(
        `${interval} holes`,
        r.missing.length === 0,
        () => `${r.missing.length} bar(s) missing, first at ${at(r.missing[0])}`,
      )
    }
  })

  it('the leading back-step is not repeated at later boundaries', async () => {
    // spec 025 §1.4 — #918's `cursor = pageEnd - step` already handles every
    // boundary after the first. A second back-step there would re-ask bars two
    // pages deep; the seed must move the FIRST window only, so every later
    // recent call starts exactly one bar before the page that preceded it.
    const ex = spotStub(59 * DAY)
    const r = await read(ex, ExchangeIntervals.oneH, 50)
    const recent = r.asked.filter((a) => a.ep === 'recent')
    ok('multi-page', recent.length >= 2, () => `${recent.length} recent call(s)`)
    for (let i = 1; i < recent.length; i++) {
      ok(
        'later chunk back-step',
        recent[i].start === recent[i - 1].end - r.width,
        () =>
          `chunk ${i} asked startTime=${at(recent[i].start)}, expected one bar` +
          ` before the previous page end ${at(recent[i - 1].end)}`,
      )
    }
  })
})
