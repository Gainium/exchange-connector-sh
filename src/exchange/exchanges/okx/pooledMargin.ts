/**
 * OKX account modes (`acctLv` from `GET /api/v5/account/config`) whose
 * collateral is pooled across currencies: Multi-currency margin (3) and
 * Portfolio margin (4). Every coin in the trading account backs every cross
 * position there — an OKX Europe account holding only EUR trades USDC-quoted
 * X-Perps. Spot mode (1) and Single-currency margin (2) margin each position
 * from its own settlement currency, so the per-asset balance is already the
 * right answer.
 */
export const okxCollateralIsPooled = (acctLv: unknown): boolean =>
  `${acctLv ?? ''}` === '3' || `${acctLv ?? ''}` === '4'

/**
 * What a pooled OKX account can still commit, in USD: `adjEq` (collateral
 * after OKX's per-currency discount) minus `imr` (initial margin already held
 * by open positions and orders). Both are account-level fields of
 * `GET /api/v5/account/balance`, published only in the pooled modes.
 *
 * `null` for a mode that is not pooled or an answer without `adjEq`, so
 * callers keep the per-coin rule.
 */
export const pooledMarginFromOkx = (
  acctLv: unknown,
  balance: unknown,
): number | null => {
  if (!okxCollateralIsPooled(acctLv)) {
    return null
  }
  const b = balance as { adjEq?: unknown; imr?: unknown }
  const adjEq = parseFloat(`${b?.adjEq ?? ''}`)
  if (!Number.isFinite(adjEq)) {
    return null
  }
  const imr = parseFloat(`${b?.imr ?? ''}`)
  return Math.max(0, adjEq - (Number.isFinite(imr) ? imr : 0))
}
