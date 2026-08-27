/**
 * Normalising the fee a venue says it charged for an order.
 *
 * Every venue reports this differently — a different field name, a different
 * sign convention, and a different way (or no way) of naming the currency it
 * came out of. What they have in common is that the number is an OBSERVATION.
 * `deal.commission` has always been an estimate (`qty * price * storedFeeRate`)
 * and an estimate is only ever as good as the stored rate — which can silently
 * stop matching what the venue charges, as a stale published fee ladder was
 * found to have done. An observed fee cannot go stale that way.
 *
 * The rules this module enforces, so that no venue mapper has to re-derive
 * them:
 *
 * 1. **A fee we cannot observe is omitted, never reported as 0.** Callers keep
 *    their existing estimate when the field is absent; a `0` would tell them
 *    the order was free. This is the single most important property here.
 * 2. **Magnitude, not sign.** OKX, Bitget and Hyperliquid report a fee as a
 *    NEGATIVE number (money leaving the account) and a rebate as a positive
 *    one. `feePaid` is defined as the cost, so it is always the magnitude of a
 *    charge; a net rebate is not a fee and is omitted.
 * 3. **The currency is stated, never assumed.** Where the venue names the
 *    currency we pass its ticker through as `feeAsset`. Where the venue names
 *    a side of the pair instead (Kraken's `oflags`), the mapper sets `feeSide`.
 *    Where more than one asset was charged — a partial BNB/BGB deduction — the
 *    whole list goes in `feeBreakdown` and `feePaid` is deliberately left
 *    unset, so a consumer that reads only `feePaid` cannot mistake one leg for
 *    the whole cost.
 */

export type OrderFeeFields = {
  feePaid?: string
  feeAsset?: string
  feeBreakdown?: { asset: string; amount: string }[]
}

/** One raw fee line as a venue reported it, before any normalisation. */
export type RawFeeEntry = {
  /** The venue's own number. May be negative (a charge on OKX/Bitget/HL). */
  amount: string | number | undefined | null
  /** The venue's own currency ticker, when it names one. */
  asset: string | undefined | null
}

/**
 * True when the venue's number is a usable charge.
 *
 * Zero is excluded on purpose. A venue that has not settled the fee yet
 * reports `0`, and that is indistinguishable from a genuinely free fill; the
 * safe reading of an ambiguous 0 is "not observed", which leaves the caller's
 * estimate in force.
 */
function chargeMagnitude(amount: RawFeeEntry['amount']): number | undefined {
  const n = Number(amount)
  if (!Number.isFinite(n) || n === 0) {
    return undefined
  }
  return Math.abs(n)
}

/**
 * Collapse a venue's fee lines into the `CommonOrder` fee fields.
 *
 * Lines in the same currency are summed (a partially filled order settles fee
 * per trade). Lines in different currencies are kept apart — they cannot be
 * added, and converting them here would mean inventing an FX rate, which is
 * exactly the kind of assumption this whole change exists to remove.
 */
export function normalizeOrderFees(entries: RawFeeEntry[]): OrderFeeFields {
  const byAsset = new Map<string, number>()
  for (const entry of entries ?? []) {
    const magnitude = chargeMagnitude(entry?.amount)
    if (magnitude === undefined) {
      continue
    }
    const asset = `${entry?.asset ?? ''}`.trim().toUpperCase()
    if (!asset) {
      // A currency-less line is unbookable: we would have to guess which side
      // of the pair it came from. Mappers that CAN answer that question do so
      // by setting `feeSide` themselves.
      continue
    }
    byAsset.set(asset, (byAsset.get(asset) ?? 0) + magnitude)
  }
  const assets = [...byAsset.entries()]
  if (assets.length === 0) {
    return {}
  }
  if (assets.length === 1) {
    const [asset, amount] = assets[0]
    return { feePaid: `${amount}`, feeAsset: asset }
  }
  return {
    feeBreakdown: assets.map(([asset, amount]) => ({
      asset,
      amount: `${amount}`,
    })),
  }
}

/**
 * The single-line form, for the venues that report one fee and one currency on
 * the order itself (OKX `fee`/`feeCcy`, KuCoin `fee`/`feeCurrency`, Bitget
 * futures `fee`/`marginCoin`).
 */
export function normalizeOrderFee(
  amount: RawFeeEntry['amount'],
  asset: RawFeeEntry['asset'],
): OrderFeeFields {
  return normalizeOrderFees([{ amount, asset }])
}

/**
 * The form for venues that name a SIDE of the pair rather than a ticker.
 *
 * Coinbase settles every fee in the quote currency and so has no fee-currency
 * field at all; Bybit's derivatives fee is always in the settle coin. Naming
 * the side directly avoids having to split the symbol string to recover a
 * ticker we would only map back to a side anyway.
 */
export function normalizeSidedOrderFee(
  amount: RawFeeEntry['amount'],
  feeSide: 'base' | 'quote',
): { feePaid?: string; feeSide?: 'base' | 'quote' } {
  const magnitude = chargeMagnitude(amount)
  if (magnitude === undefined) {
    return {}
  }
  return { feePaid: `${magnitude}`, feeSide }
}
