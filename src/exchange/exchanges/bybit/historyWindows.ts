/**
 * Bybit `/v5/order/history` only returns the last 7 days when no time range is
 * passed, and refuses a range wider than 7 days. Orders beyond 7 days stay
 * queryable when they have fills (up to 2 years); fully cancelled or rejected
 * orders with no fills are kept 24 hours only, and those carry no execution to
 * miss.
 *
 * So "not in active orders and not in the default history" proves nothing
 * about an order placed more than 7 days ago: it may have filled earlier. To
 * say an order does not exist, history has to be asked about every 7-day
 * window from the order's placement up to the default window.
 */

const dayMs = 24 * 60 * 60 * 1000
/** Widest range Bybit accepts in one order-history call. */
export const bybitHistoryWindowMs = 7 * dayMs
/** How far back Bybit keeps order history (orders with fills). */
export const bybitHistoryRetentionMs = 2 * 365 * dayMs
/** Slack for clock skew between our placement stamp and Bybit's timestamps. */
export const bybitHistorySkewMs = 10 * 60 * 1000

/**
 * The reason a lookup returns once Bybit was asked about the order's whole
 * life and holds no record of it. main-app's `isDefinitiveOrderNotFound`
 * matches `order not found`; do not reword it into `order not found in open
 * orders`, which main-app deliberately reads as NOT definitive (Kraken spot).
 */
export const bybitOrderNotFoundReason =
  'Order not found in active orders or order history since placement'

/**
 * The extra order-history windows to search, newest first, after the default
 * (no time range = last 7 days) query came back empty.
 *
 * - `null`: no usable placement time, or the order is older than Bybit keeps
 *   history. The search cannot cover the order's life, so it cannot answer.
 * - `[]`: the default window already covers the order's whole life.
 * - otherwise: back-to-back windows, each at most 7 days, overlapping the
 *   default window and reaching `since` minus the clock-skew slack.
 */
export function bybitHistoryWindows(
  since: number | undefined,
  now: number,
): { startTime: number; endTime: number }[] | null {
  if (since === undefined || since === null) return null
  const placedAt = Number(since)
  if (!Number.isFinite(placedAt) || placedAt <= 0) return null
  const from = placedAt - bybitHistorySkewMs
  if (now - from > bybitHistoryRetentionMs) return null
  const windows: { startTime: number; endTime: number }[] = []
  let end = now - bybitHistoryWindowMs + bybitHistorySkewMs
  while (end > from) {
    const start = Math.max(from, end - bybitHistoryWindowMs)
    windows.push({ startTime: start, endTime: end })
    end = start
  }
  return windows
}
