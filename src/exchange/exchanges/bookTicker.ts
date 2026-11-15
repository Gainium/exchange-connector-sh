import type { BookTicker } from '../abstractExchange'

/**
 * A venue's best bid / best ask as numbers, or `null` when the book side is
 * missing, unparsable, not positive, or crossed (bid > ask). Callers turn
 * `null` into a NOTOK — a 0 or NaN must never reach a caller as a price.
 */
export const toBookTicker = (bid: unknown, ask: unknown): BookTicker | null => {
  const b = typeof bid === 'number' ? bid : parseFloat(`${bid ?? ''}`)
  const a = typeof ask === 'number' ? ask : parseFloat(`${ask ?? ''}`)
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0) {
    return null
  }
  if (b > a) {
    return null
  }
  return { bid: b, ask: a }
}

export const noBookTicker = (symbol: string) =>
  new Error(`No book ticker for ${symbol}`)
