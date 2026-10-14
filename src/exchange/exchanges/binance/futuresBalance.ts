/**
 * One asset row of Binance futures `GET /fapi/v2/account` as a balance row.
 *
 * `free` is what the asset can withdraw and `locked` the rest of its wallet
 * balance. BNFCR is the exception: on a USDⓈ-M account in Multi-Assets
 * (Credits) mode it carries settled PnL, fees and funding, and goes negative
 * after losses with `maxWithdrawAmount` 0. That debt is reported as `free`, as
 * the user stream's `crossWalletBalance` already does, so the stored row keeps
 * it instead of reading 0 after every refresh (spec 035).
 */
export const futuresAssetBalance = (balance: {
  asset: string
  walletBalance: string | number
  maxWithdrawAmount: string | number
}): { asset: string; free: number; locked: number } => {
  const wallet = parseFloat(`${balance.walletBalance}`)
  const withdrawable = parseFloat(`${balance.maxWithdrawAmount}`)
  if (balance.asset === 'BNFCR' && wallet < 0) {
    return { asset: balance.asset, free: wallet, locked: 0 }
  }
  return {
    asset: balance.asset,
    free: withdrawable,
    locked: wallet > 0 ? wallet - withdrawable : 0,
  }
}
