/**
 * Delivery (expiry) time of a dated futures contract, from the exchange's own
 * instrument fields — never from the symbol's shape.
 *
 * Every producer reports perpetuals differently: Bybit sends `deliveryTime:
 * "0"`, KuCoin `expireDate: null`, Binance a far-future `deliveryDate` with
 * `contractType: "PERPETUAL"`. Each caller turns its own perpetual marker into
 * `undefined` and passes the raw timestamp here; this only accepts a positive,
 * finite millisecond epoch, so a perpetual can never be reported as dated.
 */
export function datedDeliveryTime(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined
  }
  const ms = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * Binance futures: `contractType` is `PERPETUAL` (or a `*_PERPETUAL` variant)
 * for perpetuals, which also carry a placeholder `deliveryDate` in 2100; dated
 * contracts are `CURRENT_QUARTER` / `NEXT_QUARTER` / `*_MONTH`.
 */
export function binanceDeliveryTime(
  contractType: unknown,
  deliveryDate: unknown,
): number | undefined {
  if (typeof contractType !== 'string' || !contractType) {
    return undefined
  }
  if (contractType.toUpperCase().includes('PERPETUAL')) {
    return undefined
  }
  return datedDeliveryTime(deliveryDate)
}
