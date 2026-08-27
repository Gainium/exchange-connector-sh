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
