/**
 * Kraken spot balance split.
 *
 * The basic `Balance` endpoint reports one number per asset — the total,
 * INCLUDING whatever open orders are holding. Reading it as `free` with
 * `locked: 0` told every consumer that funds committed to resting orders were
 * spendable. `BalanceEx` reports the hold separately, and Kraken defines what
 * is tradable as `balance + credit - credit_used - hold_trade`.
 */

/** One asset's row from Kraken's `BalanceEx`. Every field is a decimal string. */
export type KrakenExtendedBalanceRow = {
  balance?: string
  credit?: string
  credit_used?: string
  hold_trade?: string
}

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : 0
}

/**
 * `free` = what the account can trade, `locked` = what open orders hold, so
 * `free + locked` is the wallet total on an account with no credit line —
 * the same meaning the pair has on every other venue.
 *
 * Both are floored at 0: a row Kraken answers with a missing or malformed
 * field must not surface as a negative balance.
 */
export function krakenSpotFreeLocked(row: KrakenExtendedBalanceRow): {
  free: number
  locked: number
} {
  const locked = Math.max(0, num(row.hold_trade))
  const free = Math.max(
    0,
    num(row.balance) + num(row.credit) - num(row.credit_used) - locked,
  )
  // Kraken quotes at most 10 decimals; trimming at 12 drops the binary
  // subtraction residue (0.1 + 0.2 style) without touching a real digit.
  return { free: +free.toFixed(12), locked }
}
