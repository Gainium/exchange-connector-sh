import { CandleResponse } from '../types'

/**
 * Walk a candle range across as many venue pages as it takes.
 *
 * Exists because an adapter that issues ONE call for a range returns one page
 * and says nothing about the rest — `status: OK`, a plausible series that just
 * begins later than it was asked for (bug #923, spec 024). Binance and bybit
 * both did exactly that, so the walk lives here rather than a third and fourth
 * time inside an adapter.
 *
 * Pure control flow: the only I/O is `fetchPage`, which the adapter supplies
 * along with its own rate-limit accounting and error translation. A throw from
 * `fetchPage` propagates untouched so each adapter keeps its own handler.
 *
 * NOT used by Bitget's `spot_getCandles`, which switches endpoint per chunk
 * (recent vs historic, different page sizes, a lookback retry) — a different
 * walk that happens to page.
 */
export async function pageCandleRange(input: {
  /** Window start in ms. Must already be a number — see the note below. */
  from: number
  /** Window end in ms, inclusive of the bar opening at `to`. */
  to: number
  /** Bar width in ms. */
  step: number
  /**
   * The most bars this endpoint will serve in one call. Both venues silently
   * CLAMP an over-ask rather than rejecting it (spec 024 §2.2), so asking for
   * more than the real cap is not an error — it is a hole.
   */
  pageSize: number
  /**
   * Ask the venue for `[start, end]`. Returns the bars it served, in any
   * order; duplicates across chunk boundaries are expected and removed here.
   */
  fetchPage: (
    start: number,
    end: number,
    limit: number,
  ) => Promise<CandleResponse[]>
}): Promise<CandleResponse[]> {
  const { from, to, step, pageSize, fetchPage } = input

  // A chunk spans `pageSize - 1` bars, not `pageSize`. Both binance and bybit
  // serve `[start, end]` with BOTH ends inclusive (measured, spec 024 §2.2), so
  // a span of `pageSize` bars asks for `pageSize + 1` of them and the limit
  // binds — dropping whichever end the venue does not anchor on. Binance
  // anchors at `start` and would drop the newest bar (re-asked on the next
  // chunk, merely wasteful); bybit anchors at `end` and would drop the OLDEST,
  // which is a hole at every page boundary.
  const span = Math.max(1, pageSize - 1) * step

  const candles: CandleResponse[] = []
  let cursor = from
  // Safety cap. The walk advances `span - step` per iteration (the deliberate
  // overlap below), so a well-formed range needs `totalChunks` rounds plus a
  // rounding bar or two; anything approaching this cap means it is spinning.
  const hardLimit = Math.max(1, Math.ceil((to - from) / span)) + 5

  for (let attempt = 0; attempt < hardLimit && cursor <= to; attempt++) {
    const chunkEnd = Math.min(cursor + span, to)
    candles.push(...(await fetchPage(cursor, chunkEnd, pageSize)))
    if (chunkEnd >= to) {
      // This chunk reached the end of the window. Re-asking would only spin to
      // `hardLimit`, since `chunkEnd` is clamped to `to`.
      break
    }
    // Step BACK one bar instead of past `chunkEnd` — the #918 rule. It costs
    // one bar of overlap per boundary (absorbed by the dedup below) and is the
    // only advance that leaves no hole whichever way a venue reads its bounds,
    // which is the failure mode nothing downstream can detect. `Math.max`
    // keeps it strictly forward-moving for a pathologically small `pageSize`.
    cursor = Math.max(chunkEnd - step, cursor + step)
  }

  // Dedup + sort ascending: chunks overlap by construction, and bybit's rows
  // arrive newest-first, so concatenated pages are neither unique nor ordered
  // (the #920 rule).
  const seen = new Set<number>()
  return candles
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time)
}
