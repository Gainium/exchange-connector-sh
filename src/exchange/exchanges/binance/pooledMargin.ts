/**
 * What a Binance USDⓈ-M account in Multi-Assets mode can still commit, in USD.
 *
 * In Multi-Assets mode every collateral coin backs every USDⓈ-M contract, so a
 * per-asset balance cannot answer "can this deal open": an EEA account in
 * Credits mode holds USDC, owns no USDT, and carries a BNFCR row that is only
 * its settled PnL (often negative). Binance publishes the pooled answer as the
 * account-level `availableBalance` of `GET /fapi/v2/account`, already net of
 * margin held by open positions and orders.
 *
 * `null` in single-asset mode (the per-asset balance is the right answer
 * there) and for an answer without a usable `availableBalance`, so callers
 * keep the per-coin rule.
 */
export const pooledMarginFromBinance = (
  accountInfo: unknown,
): number | null => {
  const a = accountInfo as {
    multiAssetsMargin?: unknown
    availableBalance?: unknown
  }
  if (a?.multiAssetsMargin !== true && `${a?.multiAssetsMargin}` !== 'true') {
    return null
  }
  const available = parseFloat(`${a?.availableBalance ?? ''}`)
  if (!Number.isFinite(available)) {
    return null
  }
  return Math.max(0, available)
}
