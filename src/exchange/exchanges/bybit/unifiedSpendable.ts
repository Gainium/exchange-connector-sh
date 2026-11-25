/**
 * What a Bybit unified account lets a USDT/USDC balance commit to a new order.
 * Spec `specs/052.bybit-unified-free-ignores-account-available.md`.
 *
 * The venue checks a new order's initial margin against the account-level
 * `totalAvailableBalance` (USD, net of open positions' unrealized loss and of
 * all position and order margin). The per-coin `walletBalance - margin` does
 * not net the loss out, and is the whole wallet when the per-coin margin
 * fields come back empty.
 *
 * Returns the cap in coin units, or `NaN` when it does not apply: a
 * non-UNIFIED account, a coin other than USDT/USDC (capping collateral like
 * BTC could block a spot sell the venue accepts), or no usable figure.
 */
export const unifiedSpendableCap = (
  account: { accountType?: string; totalAvailableBalance?: string },
  coin: { coin: string; equity?: string; usdValue?: string },
): number => {
  if (account.accountType !== 'UNIFIED') return NaN
  if (coin.coin !== 'USDT' && coin.coin !== 'USDC') return NaN
  const pool = parseFloat(`${account.totalAvailableBalance ?? ''}`)
  if (!Number.isFinite(pool)) return NaN
  const equity = parseFloat(`${coin.equity ?? ''}`)
  const usd = parseFloat(`${coin.usdValue ?? ''}`)
  const price = equity > 0 && usd > 0 ? usd / equity : 1
  return Math.max(pool, 0) / price
}
