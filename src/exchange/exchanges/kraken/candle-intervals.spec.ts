process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #709 — "Failed Backtesting, Kraken".
 *
 * Two defects in the SPOT branch of `getCandles`, both proven in production on
 * the reporter's own pair (see specs/005 §2):
 *
 *  1. `intervalMap` is a unit conversion ('2h' -> 120 minutes) used as a venue
 *     capability map. Kraken spot /0/public/OHLC accepts only
 *     1,5,15,30,60,240,1440,10080,21600 — so `3m`/`2h`/`8h` are sent as
 *     3/120/480 and come back `EGeneral:Invalid arguments`, every time, for
 *     every symbol. The call site's cast
 *       `intervalMinutes as 1|5|15|30|60|240|1440|10080|21600`
 *     names the valid set but cannot enforce it.
 *
 *  2. Kraken's OHLC endpoint always answers with the ~720 most recent candles;
 *     `since` does not page backwards. Nothing checks that horizon before
 *     calling out, so a window older than `720 * interval` costs one public
 *     (per-egress-IP) request to discover, once per window, per node, per
 *     caller retry — the budget whose exhaustion is `EGeneral:Too many
 *     requests`.
 *
 * Run: `npm test` (mocha). No network / auth — the spot client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { ExchangeIntervals, Futures } from '../../types'
import KrakenExchange from './index'
import {
  KRAKEN_SPOT_OHLC_INTERVALS,
  aggregateCandles,
  krakenSpotCandleSource,
  krakenSpotWindowIsUnreachable,
} from './candles'

const ex: any = new KrakenExchange(Futures.null, '', '')

function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const a = JSON.stringify(actual)
    const w = JSON.stringify(want)
    if (a !== w) {
      throw new Error(`${label}: got ${a} want ${w}`)
    }
  })
}

const MIN = 60 * 1000

/**
 * Replace the spot client with one that records every request and replays
 * `rows` as Kraken's OHLC shape ([time, open, high, low, close, vwap, volume,
 * count]). `interval` values Kraken rejects answer the way it really does:
 * HTTP 200 carrying `{"error":["EGeneral:Invalid arguments"]}` — verbatim the
 * production line in specs/005 §2.2.
 */
function stubSpotClient(rows: (string | number)[][]) {
  const calls: any[] = []
  ex.spotClient = {
    getCandles: async (params: any) => {
      calls.push(params)
      if (!KRAKEN_SPOT_OHLC_INTERVALS.includes(params.interval)) {
        return { error: ['EGeneral:Invalid arguments'], result: {} }
      }
      return { error: [], result: { TAOUSD: rows, last: 0 } }
    },
  }
  // Bypass the rate limiter and the symbol mapper's network warm-up.
  ex.checkLimits = async (_m: string, _s: string, tp: any) => tp
  ex.toKrakenSymbol = async () => 'TAOUSD'
  ex.xstockParams = () => ({})
  return calls
}

/** `count` 1m candles ending at `endMs`, price/volume = the minute index. */
function oneMinuteRows(endMs: number, count: number) {
  const rows: (string | number)[][] = []
  for (let i = count - 1; i >= 0; i--) {
    const t = (endMs - i * MIN) / 1000
    const p = count - i
    rows.push([t, `${p}`, `${p + 1}`, `${p - 1}`, `${p}`, `${p}`, '1.5', 10])
  }
  return rows
}

describe('bug #709 — Kraken spot candle intervals', () => {
  describe('§3.1 the interval sent to Kraken is always one Kraken accepts', () => {
    expect(
      'every ExchangeIntervals value resolves to a supported base interval',
      () =>
        Object.values(ExchangeIntervals)
          .map((i) => krakenSpotCandleSource(i as ExchangeIntervals))
          .every(
            (s) => !!s && KRAKEN_SPOT_OHLC_INTERVALS.includes(s.baseMinutes),
          ),
      true,
    )

    expect(
      '3m/2h/8h aggregate from 1m/60m/240m instead of sending 3/120/480',
      () =>
        [
          ExchangeIntervals.threeM,
          ExchangeIntervals.twoH,
          ExchangeIntervals.eightH,
        ].map((i) => krakenSpotCandleSource(i)!.baseMinutes),
      [1, 60, 240],
    )

    expect(
      'a natively supported interval is requested as-is, with no aggregation',
      () => krakenSpotCandleSource(ExchangeIntervals.oneH),
      { baseMinutes: 60, bucketMs: 0 },
    )

    expect(
      'an interval Kraken cannot express is unservable, not a bad request',
      () => krakenSpotCandleSource('7m' as ExchangeIntervals),
      undefined,
    )
  })

  describe('§3.1 aggregation is lossless', () => {
    // Three 1m candles, one whole 3m bucket starting exactly on a boundary.
    const base = [
      { time: 0, open: '10', high: '12', low: '9', close: '11', volume: '1.1' },
      {
        time: MIN,
        open: '11',
        high: '15',
        low: '10',
        close: '14',
        volume: '2.2',
      },
      {
        time: 2 * MIN,
        open: '14',
        high: '14',
        low: '8',
        close: '13',
        volume: '3.3',
      },
    ]

    expect(
      'first open / last close / max high / min low / summed volume',
      () => aggregateCandles(base, 3 * MIN),
      [
        {
          time: 0,
          open: '10',
          high: '15',
          low: '8',
          close: '13',
          volume: '6.6',
        },
      ],
    )

    expect(
      'volume sum carries no float artefact (1.1+2.2+3.3 !== 6.6000000000000005)',
      () => aggregateCandles(base, 3 * MIN)[0].volume,
      '6.6',
    )

    expect(
      'a leading partial bucket is dropped, the trailing in-progress one kept',
      () =>
        // starts at 1*MIN — the 0..3m bucket is missing its first minute — and
        // ends mid-way through the 3..6m bucket.
        aggregateCandles(
          base.slice(1).concat([
            {
              time: 3 * MIN,
              open: '20',
              high: '21',
              low: '19',
              close: '20',
              volume: '1',
            },
          ]),
          3 * MIN,
        ).map((c) => c.time),
      [3 * MIN],
    )

    // Kraken returns a minute with no trades as a zero-volume, zero-count bar
    // holding a carried price (open === high === low === close), and its OWN
    // native aggregation ignores those. Verbatim shape of the 11:30 filler on
    // TAO/USD, 2026-09-08 — whose price 254.6719 sat OUTSIDE the native 15m
    // bar's entire high/low range, so counting it produced a bar that Kraken
    // disagreed with. 115 of that window's 721 1m rows were filler.
    const filler = {
      time: 0,
      open: '254.6719',
      high: '254.6719',
      low: '254.6719',
      close: '254.6719',
      volume: '0.00000',
    }
    const traded = [
      {
        time: MIN,
        open: '254.2689',
        high: '254.2964',
        low: '254.2689',
        close: '254.2964',
        volume: '5',
      },
      {
        time: 2 * MIN,
        open: '254.2964',
        high: '254.4356',
        low: '254.1231',
        close: '254.1417',
        volume: '5',
      },
    ]

    expect(
      'a zero-volume filler candle never sets open/high/low (matches native)',
      () => aggregateCandles([filler, ...traded], 3 * MIN),
      [
        {
          time: 0,
          open: '254.2689',
          high: '254.4356',
          low: '254.1231',
          close: '254.1417',
          volume: '10',
        },
      ],
    )

    expect(
      'a bucket that is ENTIRELY filler still yields a flat, zero-volume bar',
      () => aggregateCandles([filler], 3 * MIN),
      [{ ...filler, volume: '0' }],
    )

    expect(
      'high/low keep the original strings rather than a reparsed number',
      () =>
        aggregateCandles(
          [
            {
              time: 0,
              open: '0.000012340000',
              high: '0.000012350000',
              low: '0.000012330000',
              close: '0.000012340000',
              volume: '1',
            },
          ],
          3 * MIN,
        )[0].high,
      '0.000012350000',
    )
  })

  describe('§3.2 an unreachable window costs no venue request', () => {
    // 2026-09-08T10:31Z — the moment the production lines in specs/005 §2.2
    // were written.
    const now = 1788863460000

    expect(
      'the reporter’s February window (to=1772164800000) is beyond the 720x1m horizon',
      () => krakenSpotWindowIsUnreachable(1772164800000, 1, now),
      true,
    )

    expect(
      'the same window is ALSO beyond the wider 720x60m horizon',
      () => krakenSpotWindowIsUnreachable(1772164800000, 60, now),
      true,
    )

    expect(
      'a window inside the horizon is reachable',
      () => krakenSpotWindowIsUnreachable(now - 60 * MIN, 1, now),
      false,
    )

    expect(
      'an open-ended window (no `to`) is never short-circuited',
      () => krakenSpotWindowIsUnreachable(undefined, 1, now),
      false,
    )
  })

  describe('end-to-end through the real getCandles (production repro)', () => {
    // The exact production line: getCandles called with
    // ["TAO-USD","3m","1772035200000","1772164800000","720"].
    const REPORTER_FROM = 1772035200000
    const REPORTER_TO = 1772164800000

    let feb: { res: any; calls: any[] }
    let live: { res: any; calls: any[] }

    before(async () => {
      let calls = stubSpotClient([])
      let res = await ex.getCandles(
        'TAO-USD',
        ExchangeIntervals.threeM,
        REPORTER_FROM,
        REPORTER_TO,
        720,
      )
      feb = { res, calls }

      // Same interval, but a window Kraken can actually reach: the last 6h.
      const end = Math.floor(Date.now() / MIN) * MIN
      calls = stubSpotClient(oneMinuteRows(end, 360))
      res = await ex.getCandles(
        'TAO-USD',
        ExchangeIntervals.threeM,
        end - 360 * MIN,
        end,
        720,
      )
      live = { res, calls }
    })

    expect(
      'the reporter’s February 3m window makes ZERO Kraken requests',
      () => feb.calls.length,
      0,
    )

    expect(
      'and still answers OK with an empty array (unchanged contract)',
      () => ({ status: feb.res.status, data: feb.res.data }),
      { status: 'OK', data: [] },
    )

    expect(
      'a reachable 3m window DOES call Kraken, asking for interval 1',
      () => live.calls.map((c) => c.interval),
      [1],
    )

    expect(
      'and returns real 3m candles instead of EGeneral:Invalid arguments',
      () => ({
        status: live.res.status,
        candles: live.res.data?.length,
        spacingMs: live.res.data?.[1]?.time - live.res.data?.[0]?.time,
      }),
      { status: 'OK', candles: 120, spacingMs: 3 * MIN },
    )
  })
})
