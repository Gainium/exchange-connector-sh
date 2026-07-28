/**
 * symbolCodec.ts — the single home for pair-symbol format knowledge.
 *
 * Canonical platform form: `BASE-QUOTE`, uppercase, single dash separator
 * (`BTC-USDC`, `PF_XBTUSD` is NOT canonical — it is Kraken's wire form).
 * The `pairs` collection's `baseAsset.name`/`quoteAsset.name` are the source
 * of truth; the dashed string is just their join.
 *
 * ## The contract every adapter must follow
 *
 * 1. Convert between OUR symbol and the exchange's wire symbol in exactly
 *    one place per adapter (an asset-map-backed resolver), not inline at
 *    call sites.
 * 2. **Never fabricate a wire symbol on a lookup miss.** Return `null` and
 *    let the caller reject with a one-attempt `NOTOK Unknown pair <symbol>`.
 *    Fabricated symbols reach the exchange and fail in whatever way that
 *    venue fails — Hyperliquid answers `500`/`null`, which our error handler
 *    reads as transient and retries 10x for ~93s per request (bug #153).
 *    A miss-with-fallback is only acceptable while the asset map itself is
 *    unavailable (failed refresh), where rejecting everything would turn a
 *    transient outage into a hard one.
 * 3. Symbols that are ALREADY in wire form must pass through resolvers
 *    unchanged (callers hold both forms during migrations).
 *
 * Keep parsing strict and dumb: `splitDashedPair` only understands the
 * canonical dashed form. Guessing the quote of a concatenated symbol
 * (`BTCUSDC`) by suffix is inherently ambiguous — that heuristic lives in
 * the dashboards for display purposes and must not spread to the backend.
 */

export type PairParts = {
  base: string
  quote: string
}

/** Join canonical parts into the canonical dashed pair string. */
export const formatDashedPair = (base: string, quote: string): string =>
  `${base}-${quote}`

/**
 * Split a canonical dashed pair into its parts, or `null` when the symbol
 * is not in canonical form (no dash, leading/trailing dash, empty). Splits
 * on the FIRST dash — bases never contain one, but exotic quotes might.
 * Tokenized-stock bases keep their case (`BRK.Bx-USD`); no case folding.
 */
export const splitDashedPair = (
  symbol: string | null | undefined,
): PairParts | null => {
  if (!symbol) return null
  const i = symbol.indexOf('-')
  if (i <= 0 || i === symbol.length - 1) return null
  return { base: symbol.slice(0, i), quote: symbol.slice(i + 1) }
}

/** True when the symbol is in the canonical dashed `BASE-QUOTE` form. */
export const isDashedPair = (symbol: string | null | undefined): boolean =>
  splitDashedPair(symbol) !== null
