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
 * 2. **Net cost, by the venue's own sign.** OKX and Bitget report a charge as
 *    a NEGATIVE number (money leaving the account) and a rebate as a positive
 *    one. Hyperliquid, Binance, Bybit, KuCoin and Coinbase do the opposite: a
 *    charge is positive and a maker rebate negative. Each caller states which
 *    (`FeeSign`). `feePaid` is the cost, so a rebate on the same order lowers
 *    it, and a currency that nets to a rebate is not a fee and is omitted.
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

/**
 * Which way round the venue writes a charge. There is no default: getting it
 * wrong turns every rebate into a fee, so each mapper has to say.
 */
export type FeeSign = 'charge-positive' | 'charge-negative'

/** One raw fee line as a venue reported it, before any normalisation. */
export type RawFeeEntry = {
  /** The venue's own number, signed by the venue's convention (`FeeSign`). */
  amount: string | number | undefined | null
  /** The venue's own currency ticker, when it names one. */
  asset: string | undefined | null
}

/**
 * The venue's number as a signed cost: positive for a charge, negative for a
 * rebate. `undefined` when there is nothing usable.
 *
 * Zero is excluded on purpose. A venue that has not settled the fee yet
 * reports `0`, and that is indistinguishable from a genuinely free fill; the
 * safe reading of an ambiguous 0 is "not observed", which leaves the caller's
 * estimate in force.
 */
function signedCost(
  amount: RawFeeEntry['amount'],
  sign: FeeSign,
): number | undefined {
  const n = Number(amount)
  if (!Number.isFinite(n) || n === 0) {
    return undefined
  }
  return sign === 'charge-negative' ? -n : n
}

/**
 * Collapse a venue's fee lines into the `CommonOrder` fee fields.
 *
 * Lines in the same currency are netted (a partially filled order settles fee
 * per trade, and one order can carry both a taker fee and a maker rebate). A
 * currency that nets to zero or less is dropped. Lines in different currencies are kept apart — they cannot be
 * added, and converting them here would mean inventing an FX rate, which is
 * exactly the kind of assumption this whole change exists to remove.
 */
export function normalizeOrderFees(
  entries: RawFeeEntry[],
  sign: FeeSign,
): OrderFeeFields {
  const byAsset = new Map<string, number>()
  for (const entry of entries ?? []) {
    const cost = signedCost(entry?.amount, sign)
    if (cost === undefined) {
      continue
    }
    const asset = `${entry?.asset ?? ''}`.trim().toUpperCase()
    if (!asset) {
      // A currency-less line is unbookable: we would have to guess which side
      // of the pair it came from. Mappers that CAN answer that question do so
      // by setting `feeSide` themselves.
      continue
    }
    byAsset.set(asset, (byAsset.get(asset) ?? 0) + cost)
  }
  const assets = [...byAsset.entries()].filter(([, amount]) => amount > 0)
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
  sign: FeeSign,
): OrderFeeFields {
  return normalizeOrderFees([{ amount, asset }], sign)
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
  sign: FeeSign,
): { feePaid?: string; feeSide?: 'base' | 'quote' } {
  const cost = signedCost(amount, sign)
  if (cost === undefined || cost <= 0) {
    return {}
  }
  return { feePaid: `${cost}`, feeSide }
}
