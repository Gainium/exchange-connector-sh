import { normalizeOrderFees, type OrderFeeFields } from '../../helpers/orderFee'

/**
 * Bitget's spot `feeDetail`, which is the only place spot states the fee it
 * actually charged.
 *
 * The shape is awkward enough to be worth isolating. Bitget sends it as a JSON
 * **string** on the wire (the SDK types it as an object, which is true only
 * after a caller has parsed it, so both forms are accepted here), and inside
 * it mixes two unrelated kinds of entry:
 *
 * ```
 * {
 *   "newFees": { "c":0, "d":0, "deduction":false, "r":-0.113, "t":-0.113, … },
 *   "USDT":    { "deduction":false, "feeCoinCode":"USDT", "totalFee":-0.113 }
 * }
 * ```
 *
 * `newFees` is a currency-less summary — it cannot be booked, because nothing
 * in it says which asset left the account. The currency-keyed entries are the
 * bookable ones: each names its own `feeCoinCode` and carries a `totalFee`.
 * There can be more than one when a BGB balance partially covered the fee,
 * which is exactly the case `normalizeOrderFees` keeps separate instead of
 * summing across currencies.
 *
 * Anything unparseable yields no fee fields at all, so the caller's estimate
 * stays in force rather than an unobserved fee booking as zero cost.
 */
export function bitgetSpotFeeDetail(feeDetail: unknown): OrderFeeFields {
  const parsed = parseFeeDetail(feeDetail)
  if (!parsed) {
    return {}
  }
  const entries: { amount: unknown; asset: string }[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const leg = value as { feeCoinCode?: unknown; totalFee?: unknown }
    // Skip `newFees` and anything else that does not name its own currency —
    // the key alone is not trustworthy as a ticker.
    const asset =
      `${leg.feeCoinCode ?? ''}`.trim() || (key === 'newFees' ? '' : key)
    if (!asset) {
      continue
    }
    entries.push({ amount: leg.totalFee as string, asset })
  }
  return normalizeOrderFees(
    entries.map((e) => ({ amount: e.amount as string, asset: e.asset })),
  )
}

function parseFeeDetail(feeDetail: unknown): Record<string, unknown> | null {
  if (!feeDetail) {
    return null
  }
  if (typeof feeDetail === 'string') {
    try {
      const parsed = JSON.parse(feeDetail)
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return typeof feeDetail === 'object'
    ? (feeDetail as Record<string, unknown>)
    : null
}
