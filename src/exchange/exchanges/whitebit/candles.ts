import { CandleResponse, ExchangeIntervals } from '../../types'

/**
 * WhiteBit's candle row layout — spec 002 §2.3, and the single most dangerous
 * detail in this integration.
 *
 * `GET /api/v1/public/kline` returns each candle as
 *
 *     [ time, open, close, high, low, volume_stock, volume_money ]
 *        0     1      2     3     4        5             6
 *
 * **open/close come BEFORE high/low.** Every other adapter in this repo reads
 * `[time, open, high, low, close, volume]` (see Kraken's spot `getCandles`,
 * which maps indices 1/2/3/4 straight through). Copying that column order here
 * silently swaps `close` with `high` and `low` with `close` — which does not
 * throw, does not fail validation, and produces candles that are individually
 * plausible and collectively wrong. Every indicator, backtest and grid built on
 * them would be wrong too, with nothing anywhere to say so.
 *
 * Hence: map by explicit named index, in a pure function, with a test that
 * pins the mapping (`candle-parsing.spec.ts`).
 */

/** Column positions in a WhiteBit kline row. Do not reorder. */
export const WHITEBIT_CANDLE_INDEX = {
  time: 0,
  open: 1,
  close: 2,
  high: 3,
  low: 4,
  /** Volume denominated in the BASE asset — the one `CandleResponse` wants. */
  volumeStock: 5,
  /** Volume denominated in the QUOTE asset (turnover). Not used. */
  volumeMoney: 6,
} as const

/**
 * WhiteBit's interval strings, which happen to match Gainium's own
 * {@link ExchangeIntervals} values one-for-one — WhiteBit publishes
 * `1m/3m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w/1M`, a superset of ours. The
 * map is written out rather than passing `interval` straight through, so that a
 * new Gainium interval cannot silently reach the venue as an unsupported
 * string.
 */
export const WHITEBIT_INTERVALS: { [x in ExchangeIntervals]: string } = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '8h': '8h',
  '1d': '1d',
  '1w': '1w',
}

/** One raw kline row, as WhiteBit sends it (numbers arrive as strings). */
export type WhitebitCandleRow = (string | number)[]

/**
 * Turn WhiteBit's kline rows into `CandleResponse[]`.
 *
 * Pure: no client, no clock, no I/O — feed it rows, get candles. `time` is
 * converted from WhiteBit's SECONDS to the platform-wide milliseconds; every
 * price and volume stays a string, because `CandleResponse` is a string-typed
 * contract and re-parsing a decimal through a float is how precision gets lost.
 *
 * Rows that are too short to carry a full candle are dropped rather than
 * emitted with `undefined` fields: a half-read candle is worse than a missing
 * one, because it looks like data.
 */
export function parseWhitebitCandles(
  rows: WhitebitCandleRow[] | undefined | null,
): CandleResponse[] {
  if (!Array.isArray(rows)) {
    return []
  }
  const out: CandleResponse[] = []
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length <= WHITEBIT_CANDLE_INDEX.volumeStock
    ) {
      continue
    }
    out.push({
      time: Number(row[WHITEBIT_CANDLE_INDEX.time]) * 1000,
      open: String(row[WHITEBIT_CANDLE_INDEX.open]),
      high: String(row[WHITEBIT_CANDLE_INDEX.high]),
      low: String(row[WHITEBIT_CANDLE_INDEX.low]),
      close: String(row[WHITEBIT_CANDLE_INDEX.close]),
      volume: String(row[WHITEBIT_CANDLE_INDEX.volumeStock]),
    })
  }
  return out
}
