process.env.NODE_ENV = 'testing'

/**
 * Unit-level check for WhiteBit's candle column order — spec 002 §2.3.
 *
 * `GET /api/v1/public/kline` returns each candle as
 *
 *     [ time, open, close, high, low, volume_stock, volume_money ]
 *
 * **open/close BEFORE high/low.** Every other adapter in this repo reads
 * `[time, open, high, low, close, volume]` — Kraken's spot `getCandles` maps
 * indices 1/2/3/4 straight through — so copying that column order here swaps
 * `close` with `high` and `low` with `close`.
 *
 * That mistake does not throw and does not fail validation. It produces candles
 * that are individually plausible (`high` really is a price, from the right
 * candle) and collectively wrong, and every indicator, backtest and grid built
 * on them is wrong too with nothing anywhere to say so. This spec is the only
 * thing standing between that and production, so the fixture below deliberately
 * uses values where each field is distinguishable from every other.
 *
 * Run: `npm test` (mocha).
 *
 * No network — `parseWhitebitCandles` is pure.
 */
import { describe, it } from 'mocha'
import {
  parseWhitebitCandles,
  WHITEBIT_CANDLE_INDEX,
  WHITEBIT_INTERVALS,
} from './candles'
import { ExchangeIntervals } from '../../types'

function expect(label: string, actual: unknown, want: unknown) {
  it(label, () => {
    if (actual !== want) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

function check(label: string, ok: boolean, detail = '') {
  it(label, () => {
    if (!ok) throw new Error(detail ? `${label} :: ${detail}` : label)
  })
}

describe('WhiteBit candle parsing (spec 002 §2.3)', () => {
  // Every value is distinct and ordered so that a mis-mapping cannot
  // accidentally produce the right answer:
  //   time 1735689600  open 100  close 200  high 300  low 50
  //   volume_stock 7   volume_money 1400
  // A parser that used the common OHLCV order would report high=200, low=300,
  // close=50 — a candle whose low is above its high, which is exactly the kind
  // of nonsense that survives unnoticed in aggregate.
  const row = [1735689600, '100', '200', '300', '50', '7', '1400']

  describe('one canonical row', () => {
    const [candle] = parseWhitebitCandles([row])

    expect('time is converted from seconds to ms', candle.time, 1735689600000)
    expect('open comes from index 1', candle.open, '100')
    expect('close comes from index 2 — NOT index 4', candle.close, '200')
    expect('high comes from index 3 — NOT index 2', candle.high, '300')
    expect('low comes from index 4 — NOT index 3', candle.low, '50')
    expect('volume is volume_stock (base), index 5', candle.volume, '7')

    // The invariant that catches a swap even without knowing the fixture.
    check(
      'high >= open/close >= low holds',
      +candle.high >= +candle.open &&
        +candle.high >= +candle.close &&
        +candle.low <= +candle.open &&
        +candle.low <= +candle.close,
      JSON.stringify(candle),
    )
    check(
      'quote volume (index 6) is never reported as volume',
      candle.volume !== '1400',
    )
    expect(
      'the result is exactly the CandleResponse shape',
      Object.keys(candle).sort().join(','),
      'close,high,low,open,time,volume',
    )
  })

  describe('the index map itself', () => {
    // Pinned separately: the map is what the parser reads, so a reordering
    // there would silently move every field at once.
    expect('time', WHITEBIT_CANDLE_INDEX.time, 0)
    expect('open', WHITEBIT_CANDLE_INDEX.open, 1)
    expect('close', WHITEBIT_CANDLE_INDEX.close, 2)
    expect('high', WHITEBIT_CANDLE_INDEX.high, 3)
    expect('low', WHITEBIT_CANDLE_INDEX.low, 4)
    expect('volume_stock', WHITEBIT_CANDLE_INDEX.volumeStock, 5)
    expect('volume_money', WHITEBIT_CANDLE_INDEX.volumeMoney, 6)
  })

  describe('multiple rows and ordering', () => {
    const candles = parseWhitebitCandles([
      [1735689600, '100', '200', '300', '50', '7', '1400'],
      [1735689660, '200', '210', '215', '199', '3', '630'],
    ])
    expect('row count preserved', candles.length, 2)
    expect('rows keep their order', candles[0].time, 1735689600000)
    expect('second row time', candles[1].time, 1735689660000)
    expect('second row close', candles[1].close, '210')
  })

  describe('defensive parsing', () => {
    expect('undefined input yields []', parseWhitebitCandles(undefined).length, 0)
    expect('null input yields []', parseWhitebitCandles(null).length, 0)
    expect(
      'non-array input yields []',
      parseWhitebitCandles({} as any).length,
      0,
    )
    // A truncated row is dropped, not emitted with undefined fields: a
    // half-read candle is worse than a missing one because it looks like data.
    expect(
      'a short row is dropped, not half-parsed',
      parseWhitebitCandles([[1735689600, '100', '200']] as any).length,
      0,
    )
    // Numeric (rather than string) values still come back as strings, because
    // CandleResponse is a string-typed contract.
    expect(
      'numeric values are stringified',
      parseWhitebitCandles([[1735689600, 100, 200, 300, 50, 7, 1400]])[0].open,
      '100',
    )
  })

  describe('interval mapping', () => {
    // Written out rather than passed through, so a new Gainium interval cannot
    // silently reach the venue as an unsupported string.
    for (const interval of Object.values(ExchangeIntervals)) {
      check(
        `${interval} maps to a WhiteBit interval`,
        typeof WHITEBIT_INTERVALS[interval] === 'string' &&
          WHITEBIT_INTERVALS[interval].length > 0,
        `${interval} -> ${WHITEBIT_INTERVALS[interval]}`,
      )
    }
    expect('1m', WHITEBIT_INTERVALS[ExchangeIntervals.oneM], '1m')
    expect('4h', WHITEBIT_INTERVALS[ExchangeIntervals.fourH], '4h')
    expect('1w', WHITEBIT_INTERVALS[ExchangeIntervals.oneW], '1w')
  })
})
