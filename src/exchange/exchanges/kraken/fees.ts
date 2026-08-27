/**
 * Kraken fee-tier resolution.
 *
 * Kraken publishes the whole fee ladder for every pair on the PUBLIC
 * `AssetPairs` endpoint as `[[volumeThreshold, percent], …]`, ascending — e.g.
 * `[[0, 0.40], [50000, 0.35], [100000, 0.24], …]`. What it does NOT say is
 * which rung a given account stands on; that comes from the PRIVATE
 * `TradeVolume` endpoint's 30-day `volume`.
 *
 * The connector used to read `fees[0]` and stop, so every Kraken user on the
 * platform was charged the lowest-volume tier — 0.40% taker / 0.25% maker on a
 * pair like ETH-EUR — no matter what they actually pay. That number is not
 * cosmetic: main-app grosses a spot base order up by `1 + taker` before sending
 * it and sizes take-profits against the same figure, so a user on a better tier
 * silently buys more than they configured.
 */

/**
 * The fee this account pays on one pair, as a fraction (0.004 == 0.40%).
 *
 * With no volume to place the account on the ladder — no credentials, or the
 * private lookup failed — this returns the first rung, which is exactly the
 * behaviour that shipped before. An account we cannot identify is never worse
 * off than it was.
 *
 * @param ladder `fees` or `fees_maker` from `AssetPairs`, ascending by volume.
 * @param volume the account's 30-day volume, or null when unknown.
 * @param fallbackPercent used only when the pair publishes no ladder at all.
 */
export function krakenLadderFee(
  ladder: number[][] | undefined,
  volume: number | null,
  fallbackPercent: number,
): number {
  if (!ladder || ladder.length === 0) {
    return fallbackPercent / 100
  }

  let percent = Number(ladder[0]?.[1])

  if (volume != null && Number.isFinite(volume)) {
    for (const tier of ladder) {
      const threshold = Number(tier?.[0])
      const tierPercent = Number(tier?.[1])
      if (!Number.isFinite(threshold) || !Number.isFinite(tierPercent)) {
        continue
      }
      // Ascending ladder: the applicable rung is the last one this account's
      // volume has reached. Stop at the first it has not.
      if (volume >= threshold) {
        percent = tierPercent
      } else {
        break
      }
    }
  }

  return Number.isFinite(percent) ? percent / 100 : fallbackPercent / 100
}

/**
 * The fee a Kraken order actually incurred, normalised for `CommonOrder`.
 *
 * Kraken reports `fee` on the order payload and names the currency it came out
 * of in `oflags`. The defaults are asymmetric and are the thing most likely to
 * be got wrong by assumption: `fciq` (fee in QUOTE) is the default for a BUY,
 * `fcib` (fee in BASE) for a SELL — and we set no oflags when placing, so both
 * defaults apply. Kraken echoes the flag that was actually used, so the
 * explicit flag is preferred and the side-based default is only the fallback
 * for a payload that carries no flag at all.
 *
 * Returns an empty object when there is no usable fee, so the caller spreads
 * nothing and `deal.commission`'s estimate stays in force — a fee we could not
 * observe must never book as zero cost.
 */
export function krakenOrderFee(
  fee: string | undefined,
  oflags: string | undefined,
  side: string | undefined,
): { feePaid?: string; feeSide?: 'base' | 'quote' } {
  const amount = Number(fee)
  if (!Number.isFinite(amount) || amount <= 0) {
    return {}
  }
  const flags = (oflags ?? '').toLowerCase()
  const feeSide: 'base' | 'quote' = flags.includes('fcib')
    ? 'base'
    : flags.includes('fciq')
      ? 'quote'
      : // No flag echoed: fall back to Kraken's own documented defaults.
        `${side ?? ''}`.toUpperCase() === 'SELL'
        ? 'base'
        : 'quote'
  return { feePaid: String(fee), feeSide }
}
