import { CandleResponse, ExchangeIntervals } from '../../types'
import { convertNumberToString, round } from '../../../utils/math'

/**
 * The ONLY `interval` values Kraken spot `/0/public/OHLC` accepts, in minutes.
 * Anything else is answered with HTTP 200 + `{"error":["EGeneral:Invalid
 * arguments"]}`.
 *
 * This set was previously present only as an inline cast at the call site
 * (`intervalMinutes as 1 | 5 | ... | 21600`), which *names* the valid values
 * but cannot enforce them — so `3m`/`2h`/`8h` were sent as 3/120/480 and every
 * such request failed at the venue (bug #709).
 */
export const KRAKEN_SPOT_OHLC_INTERVALS: readonly number[] = [
  1, 5, 15, 30, 60, 240, 1440, 10080, 21600,
]

/**
 * Kraken's OHLC endpoint answers with (at most) this many candles, ALWAYS the
 * most recent ones: `since` narrows the response but cannot page backwards
 * into older history. Measured 2026-09-08 — `since` = 2026-02-10 returned
 * 2026-09-08 data at both `interval=1` and `interval=60`.
 *
 * So the reachable horizon is `KRAKEN_SPOT_OHLC_MAX_CANDLES * interval`:
 * ~12 h at 1m, ~30 d at 1h, ~120 d at 4h.
 */
export const KRAKEN_SPOT_OHLC_MAX_CANDLES = 720

/**
 * Extra candles of slack on the horizon check. The endpoint returns 720 closed
 * candles plus the in-progress one, and our clock is not Kraken's; padding the
 * window makes `krakenSpotWindowIsUnreachable` strictly conservative, so it can
 * only ever skip a request that was already guaranteed to come back empty.
 */
const HORIZON_PAD_CANDLES = 5

/**
 * Our intervals that Kraken cannot serve natively but which are exact integer
 * multiples of one that it can. Aggregating the base is lossless — a `2h` bar
 * is precisely two `1h` bars — and it is the only way to serve these at all.
 */
const AGGREGATED_FROM: Partial<
  Record<ExchangeIntervals, { base: number; target: number }>
> = {
  [ExchangeIntervals.threeM]: { base: 1, target: 3 },
  [ExchangeIntervals.twoH]: { base: 60, target: 120 },
  [ExchangeIntervals.eightH]: { base: 240, target: 480 },
}

/** Minutes per bar, for the intervals Kraken serves natively. */
const NATIVE_MINUTES: Partial<Record<ExchangeIntervals, number>> = {
  [ExchangeIntervals.oneM]: 1,
  [ExchangeIntervals.fiveM]: 5,
  [ExchangeIntervals.fifteenM]: 15,
  [ExchangeIntervals.thirtyM]: 30,
  [ExchangeIntervals.oneH]: 60,
  [ExchangeIntervals.fourH]: 240,
  [ExchangeIntervals.oneD]: 1440,
  [ExchangeIntervals.oneW]: 10080,
}

export type KrakenSpotCandleSource = {
  /** The `interval` to actually send to Kraken. Always a supported value. */
  baseMinutes: number
  /**
   * Target bar width in ms when the base has to be aggregated up, or `0` when
   * Kraken serves the interval natively and the response is used as-is.
   */
  bucketMs: number
}

/**
 * How to obtain `interval` from Kraken spot: natively, by aggregating a finer
 * supported interval, or not at all (`undefined`).
 */
export function krakenSpotCandleSource(
  interval: ExchangeIntervals,
): KrakenSpotCandleSource | undefined {
  const native = NATIVE_MINUTES[interval]
  if (native) {
    return { baseMinutes: native, bucketMs: 0 }
  }
  const aggregated = AGGREGATED_FROM[interval]
  if (aggregated) {
    return {
      baseMinutes: aggregated.base,
      bucketMs: aggregated.target * 60 * 1000,
    }
  }
  return undefined
}

/**
 * True when the requested window ends before the oldest candle Kraken can
 * return, i.e. the request is guaranteed to come back empty after the caller
 * has already paid a public (per-egress-IP) API request for it.
 *
 * Only `to` is consulted: a window whose `to` is recent may still overlap the
 * horizon even if `from` is ancient, and an open-ended window (`to` absent)
 * always reaches the live edge.
 */
export function krakenSpotWindowIsUnreachable(
  to: number | undefined,
  baseMinutes: number,
  now: number,
): boolean {
  if (!to) {
    return false
  }
  const horizonMs =
    (KRAKEN_SPOT_OHLC_MAX_CANDLES + HORIZON_PAD_CANDLES) *
    baseMinutes *
    60 *
    1000
  return to < now - horizonMs
}

/**
 * Decimal places in a numeric string. Kraken emits plain decimals here; an
 * exponential form would make the character count meaningless, so it falls back
 * to a precision wide enough to hold any venue volume.
 */
function decimals(value: string): number {
  if (!value || value.indexOf('e') !== -1 || value.indexOf('E') !== -1) {
    return 8
  }
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

/**
 * Aggregate ascending base candles into `bucketMs`-wide bars.
 *
 * Buckets are anchored on the Unix epoch, not on the caller's `from`: 3m, 2h
 * and 8h all divide 24 h evenly and epoch 0 is a UTC midnight, so these land on
 * the same boundaries every other venue uses. Anchoring on `from` would make
 * the same bar differ per caller.
 *
 * A LEADING partial bucket is dropped — its open/high/low would be missing the
 * start of the bar, which is wrong data rather than late data. A TRAILING
 * partial bucket is kept: that is the live in-progress bar, which is what every
 * connector already returns as its last candle.
 *
 * open/high/low/close are carried over as the ORIGINAL strings (only compared
 * numerically), so no precision is lost. Only volume is arithmetic, and it is
 * rounded back to the widest decimal place seen among its inputs so the sum
 * cannot surface a float artefact.
 */
export function aggregateCandles(
  candles: CandleResponse[],
  bucketMs: number,
): CandleResponse[] {
  if (bucketMs <= 0 || !candles.length) {
    return candles
  }

  const out: CandleResponse[] = []
  let bucketStart: number | undefined
  let bar: CandleResponse | undefined
  let traded = false
  let volume = 0
  let volumeDecimals = 0

  const flush = () => {
    if (bar) {
      out.push({
        ...bar,
        volume: convertNumberToString(round(volume, volumeDecimals)),
      })
    }
  }

  for (const candle of candles) {
    const start = Math.floor(candle.time / bucketMs) * bucketMs
    if (start !== bucketStart) {
      flush()
      bucketStart = start
      // Seeded from the first candle of the bucket so that a bucket made up
      // ENTIRELY of filler still yields a flat bar rather than none.
      bar = { ...candle, time: start }
      traded = false
      volume = 0
      volumeDecimals = 0
    }

    const candleVolume = Number(candle.volume) || 0
    volume += candleVolume
    volumeDecimals = Math.max(volumeDecimals, decimals(candle.volume ?? ''))

    // A minute with no trades comes back from Kraken as a zero-volume,
    // zero-count bar holding a carried price with open === high === low ===
    // close. Kraken's OWN native aggregation ignores those: measured on
    // TAO/USD 2026-09-08, 115 of 721 1m rows were filler, and each time one
    // opened a 15m window the native 15m bar took its open from the next
    // TRADED minute — in one case the filler price (254.6719) sat outside the
    // native bar's whole high/low range. Letting filler set open/high/low here
    // would make an aggregated bar disagree with a native one for the same
    // window, which is exactly what an aggregated interval must not do.
    if (candleVolume <= 0) {
      continue
    }

    if (!traded) {
      traded = true
      bar!.open = candle.open
      bar!.high = candle.high
      bar!.low = candle.low
    } else {
      if (Number(candle.high) > Number(bar!.high)) {
        bar!.high = candle.high
      }
      if (Number(candle.low) < Number(bar!.low)) {
        bar!.low = candle.low
      }
    }
    bar!.close = candle.close
  }
  flush()

  // Drop a leading bucket the base data started part-way into.
  if (out.length && candles[0].time !== out[0].time) {
    out.shift()
  }

  return out
}
