/**
 * WhiteBit symbol mapping — spec 002 §2.4.
 *
 * WhiteBit's Market Info endpoint returns spot and perpetual markets in ONE
 * list, disambiguated by a `_PERP` suffix:
 *
 *   spot  `BTC_USDT`  = `{BASE}_{QUOTE}`
 *   perp  `BTC_PERP`  = `{BASE}_PERP`   — no quote segment at all
 *
 * That asymmetry is the whole reason this file exists. Every perp is
 * USDT-margined, so the quote asset is implicit in the venue's naming and has
 * to be recovered from the market payload's own `money`/`quote` field rather
 * than by splitting the symbol. Gainium's normalized form keeps it explicit
 * (`BTC-USDT` for both variants), so a naive `replace('_', '-')` produces
 * `BTC-PERP` — a pair that exists nowhere else on the platform.
 *
 * Shape mirrors `KrakenSymbolMapper` (one cached singleton per variant,
 * `getSpotInstance()` / `getUsdmInstance()`, `toOurSymbol` / `toWhitebitSymbol`)
 * but is simpler: WhiteBit market names already use standard asset tickers, so
 * there is no `XXBT -> BTC` renaming layer. That assumption is worth
 * re-checking against a live Market Info response before this leaves draft.
 *
 * No `getCoinmInstance()` — WhiteBit has no inverse-contract product (§2.1).
 */

/** The suffix that marks a WhiteBit market as a perpetual future (§2.4). */
export const WHITEBIT_PERP_SUFFIX = '_PERP'

/** Quote asset assumed for a perp whose payload does not name one. */
const WHITEBIT_PERP_DEFAULT_QUOTE = 'USDT'

export type WhitebitMarketVariant = 'spot' | 'usdm'

/** The fields this mapper needs off a Market Info entry. */
export type WhitebitMarketLike = {
  /** WhiteBit market name, e.g. `BTC_USDT` or `BTC_PERP`. */
  name: string
  /** Base asset ticker (`stock` in WhiteBit's payload). */
  stock?: string
  /** Quote asset ticker (`money` in WhiteBit's payload). */
  money?: string
}

/** Is this WhiteBit market name a perpetual future? */
export function isWhitebitPerpMarket(name: string): boolean {
  return typeof name === 'string' && name.endsWith(WHITEBIT_PERP_SUFFIX)
}

/**
 * Split one combined Market Info list into the two variants.
 *
 * The `_PERP` suffix is the only discriminator (§2.4) — deliberately not the
 * payload's `type` field, which WhiteBit does not populate consistently across
 * the spot and futures halves of the same response.
 */
export function splitWhitebitMarkets<T extends WhitebitMarketLike>(
  markets: T[] | undefined | null,
): { spot: T[]; usdm: T[] } {
  const spot: T[] = []
  const usdm: T[] = []
  for (const market of markets ?? []) {
    if (!market?.name) {
      continue
    }
    if (isWhitebitPerpMarket(market.name)) {
      usdm.push(market)
    } else {
      spot.push(market)
    }
  }
  return { spot, usdm }
}

/**
 * Gainium's normalized pair for a WhiteBit market.
 *
 * Spot: `BTC_USDT` -> `BTC-USDT`, straight off the name.
 * Perp: `BTC_PERP` -> `BTC-USDT`, because the venue leaves the quote implicit —
 * it is read from the payload, and only falls back to USDT when the payload
 * carries nothing (every WhiteBit perp is USDT-margined today, but assuming it
 * rather than reading it is how a future non-USDT perp would silently collide
 * with the USDT one).
 */
export function whitebitMarketToPair(market: WhitebitMarketLike): string {
  const name = market?.name ?? ''
  if (!name) {
    return ''
  }
  if (isWhitebitPerpMarket(name)) {
    const base = market.stock || name.slice(0, -WHITEBIT_PERP_SUFFIX.length)
    const quote = market.money || WHITEBIT_PERP_DEFAULT_QUOTE
    return `${base}-${quote}`
  }
  const base = market.stock
  const quote = market.money
  if (base && quote) {
    return `${base}-${quote}`
  }
  // Name-only fallback: WhiteBit spot names are `{BASE}_{QUOTE}`.
  return name.replace('_', '-')
}

export class WhitebitSymbolMapper {
  private static spotInstance: WhitebitSymbolMapper
  private static usdmInstance: WhitebitSymbolMapper

  static getSpotInstance(): WhitebitSymbolMapper {
    if (!WhitebitSymbolMapper.spotInstance) {
      WhitebitSymbolMapper.spotInstance = new WhitebitSymbolMapper('spot')
    }
    return WhitebitSymbolMapper.spotInstance
  }

  static getUsdmInstance(): WhitebitSymbolMapper {
    if (!WhitebitSymbolMapper.usdmInstance) {
      WhitebitSymbolMapper.usdmInstance = new WhitebitSymbolMapper('usdm')
    }
    return WhitebitSymbolMapper.usdmInstance
  }

  /**
   * Test-only. The singletons are process-wide caches; a spec that populates
   * one would otherwise leak into the next.
   */
  static resetInstancesForTests() {
    WhitebitSymbolMapper.spotInstance = undefined as any
    WhitebitSymbolMapper.usdmInstance = undefined as any
  }

  private ourSymbolToWhitebit: Map<string, string> = new Map()
  private whitebitToOurSymbol: Map<string, string> = new Map()
  private isInitialized = false
  private readonly variant: WhitebitMarketVariant

  private constructor(variant: WhitebitMarketVariant) {
    this.variant = variant
  }

  getVariant(): WhitebitMarketVariant {
    return this.variant
  }

  getIsInitialized(): boolean {
    return this.isInitialized
  }

  /**
   * Replace the maps from a Market Info fetch. Replace, not merge: a delisted
   * market must actually disappear.
   */
  updateMaps(infos: Array<{ pair: string; code: string }>) {
    this.ourSymbolToWhitebit.clear()
    this.whitebitToOurSymbol.clear()
    for (const info of infos) {
      if (info?.pair && info?.code) {
        this.ourSymbolToWhitebit.set(info.pair, info.code)
        this.whitebitToOurSymbol.set(info.code, info.pair)
      }
    }
    this.isInitialized = true
  }

  /**
   * Best-effort conversion used before the maps have loaded, and for a market
   * that is genuinely absent from them.
   *
   * Kraken's mapper answers the not-yet-initialized case by sleeping 500ms and
   * recursing — unbounded, and it turns a cold start into an open-ended stall.
   * Here the derivation is exact for every market WhiteBit actually lists
   * (`BTC-USDT` -> `BTC_USDT` or `BTC_PERP`), so a fallback is strictly better
   * than a wait: it is right whenever the maps would have been right, and it
   * cannot hang.
   */
  private deriveWhitebitSymbol(ourSymbol: string): string {
    const [base] = ourSymbol.split('-')
    if (this.variant === 'usdm') {
      return `${base}${WHITEBIT_PERP_SUFFIX}`
    }
    return ourSymbol.replace('-', '_')
  }

  /** `BTC-USDT` -> `BTC_USDT` (spot) / `BTC_PERP` (usdm). */
  toWhitebitSymbol(ourSymbol: string): string {
    if (!ourSymbol) {
      return ''
    }
    return (
      this.ourSymbolToWhitebit.get(ourSymbol) ??
      this.deriveWhitebitSymbol(ourSymbol)
    )
  }

  /** `BTC_USDT` / `BTC_PERP` -> `BTC-USDT`. */
  toOurSymbol(whitebitSymbol: string): string {
    if (!whitebitSymbol) {
      return ''
    }
    const known = this.whitebitToOurSymbol.get(whitebitSymbol)
    if (known) {
      return known
    }
    return whitebitMarketToPair({ name: whitebitSymbol })
  }

  /** Every WhiteBit market name this variant knows about. */
  knownWhitebitSymbols(): string[] {
    return [...this.whitebitToOurSymbol.keys()]
  }

  /** Every normalized pair this variant knows about. */
  knownPairs(): string[] {
    return [...this.ourSymbolToWhitebit.keys()]
  }
}

export default WhitebitSymbolMapper
