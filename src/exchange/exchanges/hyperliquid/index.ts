import AbstractExchange, { Exchange } from '../../abstractExchange'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  FundingRateResponse,
  CommonOrder,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  LeverageBracket,
  OrderStatusType,
  OrderTypes,
  OrderTypeT,
  StatusEnum,
  UserFee,
  TradeResponse,
  Futures,
  PositionSide,
  PositionInfo,
  MarginType,
  TimeProfile,
  RebateOverview,
  RebateRecord,
} from '../../types'
import * as hl from '@nktkas/hyperliquid'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { IdMute, IdMutex } from '../../../utils/mutex'

type OrderResponseMissing = {
  status: 'unknownOid'
}

type OrderResponseFound = {
  status: 'order'
  order: {
    order: {
      coin: string
      side: string
      limitPx: string
      sz: string
      oid: number
      timestamp: number
      triggerCondition: string
      isTrigger: boolean
      triggerPx: string
      children: unknown[]
      isPositionTpsl: boolean
      reduceOnly: boolean
      orderType: string
      origSz: string
      tif: string
      cloid: string | null
    }
    status:
      | 'open'
      | 'filled'
      | 'canceled'
      | 'rejected'
      | 'marginCanceled'
      | 'vaultWithdrawalCanceled'
      | 'openInterestCapCanceled'
      | 'selfTradeCanceled'
      | 'reduceOnlyCanceled'
      | 'siblingFilledCanceled'
      | 'delistedCanceled'
      | 'liquidatedCanceled'
      | 'scheduledCancel'
      | 'tickRejected'
      | 'minTradeNtlRejected'
      | 'perpMarginRejected'
      | 'reduceOnlyRejected'
      | 'badAloPxRejected'
      | 'iocCancelRejected'
      | 'badTriggerPxRejected'
      | 'marketOrderNoLiquidityRejected'
      | 'positionIncreaseAtOpenInterestCapRejected'
      | 'positionFlipAtOpenInterestCapRejected'
      | 'tooAggressiveAtOpenInterestCapRejected'
      | 'openInterestIncreaseRejected'
      | 'insufficientSpotBalanceRejected'
      | 'oracleRejected'
      | 'perpMaxPositionRejected'
    statusTimestamp: number
  }
}

type OrderResponse = OrderResponseMissing | OrderResponseFound

type PlaceOrderResponseScheduled = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          resting: {
            oid: number
          }
        },
      ]
    }
  }
}

type PalceOrderResponseError = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          error: string
        },
      ]
    }
  }
}

type PlaceOrderResponseFilled = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          filled: {
            totalSz: string
            avgPx: string
            oid: number
          }
        },
      ]
    }
  }
}

export type PlaceOrderResponse =
  | PlaceOrderResponseScheduled
  | PalceOrderResponseError
  | PlaceOrderResponseFilled

type CancelOrderResponseSuccess = {
  status: 'ok'
  response: {
    type: 'cancel'
    data: {
      statuses: ['success']
    }
  }
}

type CancelOrderResponseError = {
  status: 'ok'
  response: {
    type: 'cancel'
    data: {
      statuses: [
        {
          error: 'Order was never placed, already canceled, or filled.'
        },
      ]
    }
  }
}

type CancelOrderResponse = CancelOrderResponseSuccess | CancelOrderResponseError

const mutex = new IdMutex()

export class HyperliquidError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

type Market = 'spot' | 'futures'

/**
 * Hyperliquid spot tokens use deployer-chosen names that differ from the
 * canonical ticker the rest of the platform (and the user) thinks in.
 *
 * The dominant case is **Unit** (hyperunit.xyz): it bridges spot assets under
 * a `U`-prefixed name whose `fullName` is `Unit <Asset>` — `UBTC`/'Unit
 * Bitcoin', `UETH`/'Unit Ethereum', `USOL`/'Unit Solana', and any future one.
 * We display those under the stripped canonical ticker (`UBTC`→`BTC`).
 *
 * This is derived **authoritatively from Hyperliquid's own `spotMeta`**, not a
 * hand-maintained list: a token is normalized iff its `fullName` starts with
 * `'Unit '` AND its `name` starts with `'U'`. We strip exactly the leading
 * `U`. We never blanket-strip `U` (that would mangle real tickers `UP`, `UNI`,
 * `USDC`, `USDE`, whose `fullName` is not `Unit …`). New Unit assets normalize
 * automatically with zero code changes. See `buildTokenDisplayMap`.
 *
 * Guards: the stripped name must be a safe ident and must NOT collide with an
 * already-listed token of the same canonical name (`UPUMP`→`PUMP` collides
 * with the separately-listed `PUMP`) — collisions stay un-normalized so two
 * markets never share one pair string. `USDT0` (a wrapped-USDT quote whose
 * `fullName` is `USDT0`, not `Unit …`) keeps a small explicit alias to `USDT`.
 *
 * The map is rebuilt from `tokens` on every spot/futures `updateAssets`
 * refresh. It is seeded with the historically-hardcoded pair so behavior can
 * never regress below the old static table before the first fetch lands.
 */
const SAFE_TOKEN_IDENT = /^[A-Za-z0-9_.]{1,32}$/
/** Wrapped-stablecoin quotes that are not Unit tokens but should still show
 *  under their canonical ticker. Kept tiny and explicit. */
const QUOTE_TOKEN_ALIASES: Record<string, string> = { USDT0: 'USDT' }

function buildTokenDisplayMap(
  tokens: ReadonlyArray<{ name: string; fullName?: string | null }>,
): Map<string, string> {
  const rawNames = new Set(tokens.map((t) => t.name))
  // Pass 1: propose a canonical display name for every Unit-bridged token.
  const proposals: Array<[string, string]> = []
  const proposedCount = new Map<string, number>()
  for (const t of tokens) {
    if (
      (t.fullName ?? '').startsWith('Unit ') &&
      t.name.startsWith('U') &&
      t.name.length > 1
    ) {
      const stripped = t.name.slice(1)
      if (SAFE_TOKEN_IDENT.test(stripped) && !stripped.includes('..')) {
        proposals.push([t.name, stripped])
        proposedCount.set(stripped, (proposedCount.get(stripped) ?? 0) + 1)
      }
    }
  }
  const map = new Map<string, string>()
  // Pass 2: accept a proposal only when its canonical name doesn't collide
  // with an already-listed raw token OR with another Unit proposal.
  for (const [name, display] of proposals) {
    if (rawNames.has(display)) continue
    if ((proposedCount.get(display) ?? 0) > 1) continue
    map.set(name, display)
  }
  // Explicit wrapped-stablecoin quote aliases, collision-guarded the same way.
  for (const [from, to] of Object.entries(QUOTE_TOKEN_ALIASES)) {
    if (!rawNames.has(to) && !map.has(from)) map.set(from, to)
  }
  return map
}

/** Rebuilt on every spotMeta fetch (`updateAssets`). Seeded with the old
 *  static pair so a failed/late first fetch can't regress UBTC/USDT0. */
let tokenDisplayMap: Map<string, string> = new Map([
  ['UBTC', 'BTC'],
  ['USDT0', 'USDT'],
])
const aliasToken = (name: string): string => tokenDisplayMap.get(name) ?? name

/**
 * Hyperliquid HIP-3 builder dexes let third-party deployers register
 * arbitrary asset names. Names propagate into pair strings that flow
 * into Redis keys, file paths, URLs and similar surfaces — names with
 * '/', '..', spaces, control characters or non-ASCII are unsafe and
 * have been observed in the wild causing path-traversal-shaped pairs
 * (e.g. 'tndex:A B:C/../../../../../中'). We require alphanumerics
 * + '_' + '.' only, and explicitly reject '..' to block traversal.
 */
const SAFE_IDENT = /^[A-Za-z0-9_.]{1,32}$/
const isSafeIdent = (s: string): boolean =>
  SAFE_IDENT.test(s) && !s.includes('..')

export type FuturesAssetInfo = {
  /** Display pair used as the public identifier (e.g. 'BTC-USDC' or
   *  'F:TSLA-USDH' when collision-prefixed). */
  pair: string
  /** Wire identifier: 'BTC' for HL native, 'xyz:HYUNDAI' for builder dexes. */
  code: string
  /** HL asset index used for order placement / leverage updates. */
  assetIndex: number
  /** Quote/collateral asset name resolved from `collateralToken`. */
  quoteAsset: string
  /** null for HL native; builder dex name (e.g. 'xyz') otherwise. */
  dexName: string | null
  /** 0 for HL native; raw `deployerFeeScale` for builder dexes. */
  deployerFeeScale: number
  onlyIsolated: boolean
  szDecimals: number
  maxLeverage: number
  isDelisted: boolean
  marginTableId: number
  /** Authoritative asset class from Hyperliquid `perpCategories` (builder-dex
   *  TradFi perps: stocks/commodities/indices/fx/preipo). Undefined => crypto. */
  assetClass?: ExchangeInfo['assetClass']
}

/**
 * Map Hyperliquid's own `perpCategories` value to our normalized asset class.
 * This is Hyperliquid's authoritative classification of builder-dex (HIP-3)
 * TradFi perps — NOT a name heuristic. Hyperliquid lumps precious metals under
 * `commodities` (GOLD/SILVER/PLATINUM), which we keep verbatim (re-bucketing to
 * `metal` by ticker name would be a forbidden heuristic). `fx`/`FX` case varies
 * across dexes. `crypto` and anything unknown => undefined (defaults to crypto).
 */
const hyperliquidPerpCategoryToClass = (
  category?: string,
): ExchangeInfo['assetClass'] => {
  switch ((category ?? '').toLowerCase()) {
    case 'stocks':
    case 'preipo':
      return 'stock'
    case 'commodities':
      return 'commodity'
    case 'indices':
      return 'index'
    case 'fx':
      return 'forex'
    default:
      return undefined
  }
}

type RawPerpDex = {
  name: string
  fullName?: string
  deployer?: string
  oracleUpdater?: string | null
  feeRecipient?: string | null
  deployerFeeScale?: string
} | null

type RawPerpsUniverseEntry = {
  name: string
  szDecimals: number
  maxLeverage: number
  marginTableId: number
  isDelisted?: boolean
  onlyIsolated?: boolean
  marginMode?: string
}

type RawPerpsMeta = {
  universe: RawPerpsUniverseEntry[]
  marginTables?: Array<[number, unknown]>
  collateralToken?: number
}

class HyperliquidAssets {
  static HyperliquidAssetsInstance: HyperliquidAssets
  static getInstance() {
    if (!HyperliquidAssets.HyperliquidAssetsInstance) {
      HyperliquidAssets.HyperliquidAssetsInstance = new HyperliquidAssets()
    }
    return HyperliquidAssets.HyperliquidAssetsInstance
  }

  private assetsSpot: Map<string, number> = new Map()
  private pairsSpot: Map<number, string> = new Map()
  private futuresByPair: Map<string, FuturesAssetInfo> = new Map()
  private futuresByCode: Map<string, string> = new Map()
  /** Builder-dex names with at least one listed market (HL native excluded). */
  private dexNames: Set<string> = new Set()
  /** Canonical ticker → assetClass, derived from Hyperliquid's authoritative
   *  `perpCategories` (perps-only endpoint). Used to classify SPOT RWA/equity
   *  pairs (AAPL/TSLA/… tokenized stocks) that HL lists on spot but does not
   *  classify there — we cross-reference the perp classification by ticker. */
  private assetClassByBase: Map<string, ExchangeInfo['assetClass']> = new Map()
  private lastAssetClassFetch = 0
  private lastUpdateSpot = 0
  private lastUpdateFutures = 0
  private updateInterval = 20 * 60000
  private client: hl.InfoClient = new hl.InfoClient({
    transport: new hl.HttpTransport({
      isTestnet: process.env.HYPERLIQUIDENV === 'demo',
    }),
  })

  @IdMute(mutex, () => 'getCoinByPair')
  public async getCoinByPair(pair: string, market: Market) {
    if (market === 'futures') {
      const info = await this.getFuturesInfo(pair)
      return `${info?.assetIndex ?? 0}`
    }
    if (
      this.assetsSpot.size === 0 ||
      this.lastUpdateSpot + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('spot')
    }
    return `${10000 + (this.assetsSpot.get(pair) ?? 0)}`
  }

  /** Ensure the spot token display map (`tokenDisplayMap`) is populated.
   *  Used by spot balance normalization, which reads clearinghouse state and
   *  never fetches spot meta itself, so it would otherwise see an unwarmed
   *  (seed-only) map right after boot. */
  public async ensureSpotAssets(): Promise<void> {
    if (
      this.assetsSpot.size === 0 ||
      this.lastUpdateSpot + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('spot')
    }
  }

  /** Refresh the ticker→assetClass map from `perpCategories` (Hyperliquid's
   *  authoritative classifier). Cheap single call, cached like the other maps;
   *  the previous map is preserved on failure so spot classification degrades
   *  to "last known" rather than empty. */
  public async ensureAssetClasses(): Promise<void> {
    if (
      this.assetClassByBase.size > 0 &&
      this.lastAssetClassFetch + this.updateInterval > Date.now()
    ) {
      return
    }
    // perpCategories is a mainnet classifier; skip on demo.
    if (process.env.HYPERLIQUIDENV === 'demo') return
    try {
      await this.checkLimits('perpCategories', 20)
      const cats = (await this.client.transport.request('info', {
        type: 'perpCategories',
      })) as [string, string][]
      if (Array.isArray(cats) && cats.length > 0) {
        const m = new Map<string, ExchangeInfo['assetClass']>()
        for (const [code, cat] of cats) {
          // Strip any builder-dex prefix ('xyz:AAPL' → 'AAPL').
          const base = code.includes(':')
            ? code.slice(code.indexOf(':') + 1)
            : code
          const cls = hyperliquidPerpCategoryToClass(cat)
          if (cls) m.set(base, cls)
        }
        this.assetClassByBase = m
        this.lastAssetClassFetch = Date.now()
      }
    } catch (e) {
      Logger.warn(
        `Hyperliquid perpCategories (spot classify) failed: ${(e as Error)?.message ?? e}`,
      )
    }
  }

  /** Asset class for a SPOT pair whose base is `baseTicker` (canonical /
   *  normalized). Returns a TradFi class ONLY for an un-curated HIP-1 spot
   *  token that namesquats a real ticker — a permissionless deployment we
   *  should HIDE from the listing (near-zero depth, one-genesis-address
   *  synthetic; the real equity exposure is the HIP-3 perp, which HL curates
   *  and which we classify on the perp path). Undefined = keep (legit).
   *
   *  Signal (spotMeta-only, no per-token calls): the base ticker matches a
   *  TradFi-classified perp (`perpCategories`) AND the token is NOT a curated
   *  Unit issuance. Unit-bridged assets — crypto ('Unit Bitcoin') and Unit
   *  xStocks ('Unit SP500 xStock') alike — start their `fullName` with
   *  'Unit ' and are kept; the namesquats (fullName null or '… - Wagyu.xyz')
   *  are hidden. This also protects real Unit crypto from a coincidental
   *  ticker collision with a TradFi perp. */
  public spotNamesquatClass(
    baseTicker: string,
    fullName?: string | null,
  ): ExchangeInfo['assetClass'] {
    if ((fullName ?? '').startsWith('Unit ')) return undefined
    return this.assetClassByBase.get(baseTicker)
  }

  @IdMute(mutex, () => 'getCoinNameByPair')
  public async getCoinNameByPair(pair: string, market: Market) {
    if (market === 'futures') {
      const info = await this.getFuturesInfo(pair)
      return info?.code ?? pair.split('-')[0]
    }
    if (
      this.assetsSpot.size === 0 ||
      this.lastUpdateSpot + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('spot')
    }
    const code = this.assetsSpot.get(pair)
    if (typeof code === 'undefined') {
      return pair
    }
    return `${code === 0 ? 'PURR/USDC' : `@${code}`}`
  }

  @IdMute(mutex, () => 'getCoinByPair')
  public async getPairByCoin(coin: string, market: Market) {
    if (market === 'futures') {
      if (
        this.futuresByCode.size === 0 ||
        this.lastUpdateFutures + this.updateInterval < Date.now()
      ) {
        await this.updateAssets('futures')
      }
      return this.futuresByCode.get(coin) ?? coin
    }
    if (
      this.pairsSpot.size === 0 ||
      this.lastUpdateSpot + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('spot')
    }
    if (coin === 'PURR/USDC') {
      return 'PURR-USDC'
    }
    return this.pairsSpot.get(+coin.replace('@', '')) ?? coin
  }

  public async getFuturesInfo(
    pair: string,
  ): Promise<FuturesAssetInfo | undefined> {
    if (
      this.futuresByPair.size === 0 ||
      this.lastUpdateFutures + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('futures')
    }
    return this.futuresByPair.get(pair)
  }

  public async getDeployerFeeScale(pair: string): Promise<number> {
    const info = await this.getFuturesInfo(pair)
    return info?.deployerFeeScale ?? 0
  }

  public async listFuturesAssets(): Promise<FuturesAssetInfo[]> {
    if (
      this.futuresByPair.size === 0 ||
      this.lastUpdateFutures + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('futures')
    }
    return [...this.futuresByPair.values()]
  }

  /** Builder-dex names with at least one listed market (HL native excluded). */
  public async listDexNames(): Promise<string[]> {
    if (
      this.futuresByPair.size === 0 ||
      this.lastUpdateFutures + this.updateInterval < Date.now()
    ) {
      await this.updateAssets('futures')
    }
    return [...this.dexNames]
  }

  protected async checkLimits(request: string, count?: number): Promise<void> {
    const limit = await limitHelper.addWeight(count)
    if (limit > 0) {
      Logger.warn(
        `Hyperliquid Assets request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, count)
    }
    return
  }

  /** Backoff before retrying after an empty/failed fetch — keeps a
   *  persistently-failing endpoint from burning rate-limit budget on
   *  every consumer call until the regular interval elapses. */
  private failureRetryInterval = 60 * 1000

  @IdMute(mutex, () => 'updateAssets')
  private async updateAssets(market: Market) {
    if (market === 'spot') {
      // Skip if we attempted recently. Use the regular interval when the
      // cache is populated, a much shorter one when it's empty so we can
      // recover from a transient failure without hammering. Crucially we
      // do NOT bypass the guard just because the cache is empty —
      // bypassing causes every caller to re-fetch on every request.
      const sinceLast = Date.now() - this.lastUpdateSpot
      const interval =
        this.pairsSpot.size > 0
          ? this.updateInterval
          : this.failureRetryInterval
      if (this.lastUpdateSpot && sinceLast < interval) {
        return
      }
      try {
        await this.checkLimits('spotMeta', 20)
        const { tokens, universe } = await this.client.spotMeta()
        tokenDisplayMap = buildTokenDisplayMap(tokens)
        universe.forEach((u) => {
          const base = tokens.find((tk) => tk.index === u.tokens[0])
          const quote = tokens.find((tk) => tk.index === u.tokens[1])
          if (base && quote) {
            // Normalized display pair (what we emit everywhere) plus the raw
            // Unit pair registered as a backward-compat alias, so bots created
            // before normalization (stored e.g. 'UETH-USDC') still resolve to
            // the same market. Reverse lookup returns the normalized form.
            const dispPair = `${aliasToken(base.name)}-${aliasToken(quote.name)}`
            const rawPair = `${base.name}-${quote.name}`
            this.assetsSpot.set(dispPair, u.index)
            if (rawPair !== dispPair) this.assetsSpot.set(rawPair, u.index)
            this.pairsSpot.set(u.index, dispPair)
          }
        })
      } catch (e) {
        Logger.error(`Error updating Hyperliquid spot assets: ${e.message}`)
      } finally {
        // Mark "attempted" even on failure so the next request waits the
        // failureRetryInterval rather than re-fetching immediately.
        this.lastUpdateSpot = Date.now()
      }
      return
    }
    // futures: enumerate HL native + builder dexes via perpDexs() + meta({dex})
    // Same logic as spot branch — see comment there. The `size > 0` gate
    // used to live here too and caused every consumer call to re-fetch
    // when the cache was empty (e.g. after a transient network failure),
    // which produced an unbounded retry storm hitting 429.
    {
      const sinceLast = Date.now() - this.lastUpdateFutures
      const interval =
        this.futuresByPair.size > 0
          ? this.updateInterval
          : this.failureRetryInterval
      if (this.lastUpdateFutures && sinceLast < interval) {
        return
      }
    }
    try {
      await this.checkLimits('spotMeta', 20)
      const spotTokens = (await this.client.spotMeta()).tokens
      // Keep the display map fresh even when only a futures refresh runs
      // (same spotMeta tokens → identical map as the spot branch).
      tokenDisplayMap = buildTokenDisplayMap(spotTokens)
      // Hyperliquid testnet has thousands of builder dexes (most empty),
      // so enumerating them all on demo wastes the rate-limit budget and
      // never finishes. Skip the perpDexs() fan-out and only fetch HL
      // native meta on demo.
      const isDemo = process.env.HYPERLIQUIDENV === 'demo'
      let perpDexs: RawPerpDex[]
      if (isDemo) {
        perpDexs = [null]
      } else {
        await this.checkLimits('perpDexs', 20)
        perpDexs = (await this.client.perpDexs()) as RawPerpDex[]
      }
      const newByPair = new Map<string, FuturesAssetInfo>()
      const newByCode = new Map<string, string>()
      const newDexNames = new Set<string>()
      for (let i = 0; i < perpDexs.length; i++) {
        const dex = perpDexs[i]
        if (dex && !isSafeIdent(dex.name)) {
          Logger.warn(
            `Hyperliquid skipping dex with unsafe name: ${JSON.stringify(dex.name)}`,
          )
          continue
        }
        // Per-dex try/catch — one bad dex must not poison the whole map.
        // A thrown meta() (or downstream) call previously caused dexNames
        // to stay empty and all multi-dex consumers to iterate only HL
        // native, hanging on retries until the rate limiter 429s.
        try {
          await this.checkLimits('meta', 20)
          const meta = (await (dex
            ? this.client.meta({ dex: dex.name })
            : this.client.meta())) as unknown as RawPerpsMeta
          if (!meta.universe || meta.universe.length === 0) continue
          const collateralIdx = meta.collateralToken ?? 0
          const quoteToken = spotTokens.find((t) => t.index === collateralIdx)
          const quoteAsset = quoteToken?.name
            ? aliasToken(quoteToken.name)
            : 'USDC'
          if (!isSafeIdent(quoteAsset)) {
            Logger.warn(
              `Hyperliquid skipping ${dex?.name ?? 'native'}: unsafe quote ${JSON.stringify(quoteAsset)}`,
            )
            continue
          }
          if (dex) newDexNames.add(dex.name)
          const deployerFeeScale = dex ? +(dex.deployerFeeScale ?? '0') : 0
          meta.universe.forEach((u, coinIdx) => {
            // Builder-dex universes return names already prefixed (e.g.
            // 'xyz:HYUNDAI'). Use slice rather than split(':')[1] so an
            // asset name containing extra colons is preserved intact —
            // and then sanitized below.
            const code = u.name
            const baseRaw =
              dex && u.name.startsWith(`${dex.name}:`)
                ? u.name.slice(dex.name.length + 1)
                : u.name
            const baseName = aliasToken(baseRaw)
            if (!isSafeIdent(baseName)) {
              Logger.warn(
                `Hyperliquid skipping unsafe asset: ${JSON.stringify(u.name)} (dex=${dex?.name ?? 'native'})`,
              )
              return
            }
            const basePair = `${baseName}-${quoteAsset}`
            // Always prefix builder-dex pairs: provider:BASE-QUOTE.
            // HL native stays unprefixed.
            const pair = dex ? `${dex.name}:${basePair}` : basePair
            // HL encodes builder-dex assets as `100000 + slot * 10000 +
            // coinIdx` where `slot` is the position in `perpDexs()` —
            // including the null (HL native) slot at index 0. So xyz at
            // perpDexs[1] uses multiplier 1, not 0. Earlier `(i - 1)` was
            // an off-by-one and produced asset indices one builder-dex
            // slot too low (e.g. 100001 for xyz:TSLA instead of 110001),
            // which HL rejects with "invalid spot".
            const assetIndex = i === 0 ? coinIdx : 100000 + i * 10000 + coinIdx
            if (newByPair.has(pair)) {
              Logger.warn(
                `Hyperliquid duplicate pair ${pair}: keeping ${newByPair.get(pair)!.code}, dropping ${code}`,
              )
              return
            }
            newByPair.set(pair, {
              pair,
              code,
              assetIndex,
              quoteAsset,
              dexName: dex?.name ?? null,
              deployerFeeScale,
              onlyIsolated: !!u.onlyIsolated,
              szDecimals: u.szDecimals,
              maxLeverage: u.maxLeverage,
              isDelisted: !!u.isDelisted,
              marginTableId: u.marginTableId,
            })
            newByCode.set(code, pair)
          })
        } catch (e) {
          Logger.error(
            `Hyperliquid meta failed for ${dex?.name ?? 'native'}: ${(e as Error)?.message ?? e}`,
          )
        }
      }
      // Authoritative asset class for builder-dex (HIP-3) TradFi perps.
      // `perpCategories` maps each wire code (`dex:ASSET`, e.g. `xyz:AAPL`) to
      // Hyperliquid's own category (stocks/commodities/indices/fx/preipo/crypto).
      // One call returns every dex. Not exposed by the SDK, so we go through the
      // transport directly (respects the connector's outbound IP binding). On
      // any failure we leave classes unset → everything defaults to crypto.
      if (!isDemo) {
        try {
          await this.checkLimits('perpDexs', 20)
          const cats = (await this.client.transport.request('info', {
            type: 'perpCategories',
          })) as [string, string][]
          if (Array.isArray(cats)) {
            const catByCode = new Map(cats)
            for (const info of newByPair.values()) {
              const cls = hyperliquidPerpCategoryToClass(
                catByCode.get(info.code),
              )
              if (cls) info.assetClass = cls
            }
          }
        } catch (e) {
          Logger.warn(
            `Hyperliquid perpCategories failed: ${(e as Error)?.message ?? e}`,
          )
        }
      }
      this.futuresByPair = newByPair
      this.futuresByCode = newByCode
      this.dexNames = newDexNames
    } catch (e) {
      Logger.error(`Error updating Hyperliquid futures assets: ${e.message}`)
    } finally {
      // Mark "attempted" even on failure so the next request waits the
      // failureRetryInterval rather than re-fetching immediately.
      this.lastUpdateFutures = Date.now()
    }
  }
}

/** Read a non-negative integer env var, falling back to `def`. */
const hlEnvInt = (name: string, def: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : def
}

/**
 * Adaptive Hyperliquid `clearinghouseState` fan-out control.
 *
 * `clearinghouseState` is per-dex: covering HL native + every HIP-3 builder dex
 * means one info call per dex. The builder-dex list has grown to ~10 and keeps
 * growing, so a naive poll fires ~10 calls — and it runs twice per cycle
 * (balance + positions), for every HL user sharing an egress IP. That blew past
 * Hyperliquid's ~1200 weight/min/IP info budget (clearinghouseState = 2 wt) and
 * returned 429, silently dropping that dex's state for the poll.
 *
 * A dex the user has no position / balance / resting order on returns empty
 * state, so skipping it loses nothing. This tracker remembers, per wallet, which
 * dexes the user is actually active on so routine polls hit only HL native +
 * those dexes. New activity is discovered by:
 *   - {@link markActive} when we place an order on a dex (instant; covers all
 *     Gainium-driven trades before the position/balance even settles), and
 *   - a periodic FULL sweep (every `fullSweepMs`) that re-queries every dex and
 *     picks up out-of-band activity (manual HL trades, funding, transfers).
 * A dex is dropped once it has shown no activity for `activeTtlMs`.
 *
 * Env knobs (rate-limit tuning without a redeploy):
 *   HL_DEX_FANOUT_ADAPTIVE=0  -> disable; always full fan-out (old behaviour)
 *   HL_DEX_FULL_SWEEP_MS      -> full-sweep cadence (default 60000)
 *   HL_DEX_ACTIVE_TTL_MS      -> how long a dex stays "active" (default 300000)
 */
class HyperliquidDexActivity {
  private static instance: HyperliquidDexActivity
  static getInstance(): HyperliquidDexActivity {
    if (!HyperliquidDexActivity.instance) {
      HyperliquidDexActivity.instance = new HyperliquidDexActivity()
    }
    return HyperliquidDexActivity.instance
  }

  private readonly adaptive = process.env.HL_DEX_FANOUT_ADAPTIVE !== '0'
  private readonly fullSweepMs = hlEnvInt('HL_DEX_FULL_SWEEP_MS', 60_000)
  private readonly activeTtlMs = hlEnvInt('HL_DEX_ACTIVE_TTL_MS', 5 * 60_000)
  // Open-orders relies on the clearinghouse-driven discovery below and does NOT
  // full-sweep every poll (its frontendOpenOrders call is weight 20 — the
  // heaviest info draw). It keeps its OWN, much slower safety sweep purely to
  // cover the one edge clearinghouse discovery can miss: a reduce-only resting
  // order on a dex whose collateral has since dropped to ~0 (accountValue ~0 =>
  // not "active"), plus bootstrap before the first discovery has run.
  private readonly openSweepMs = hlEnvInt('HL_OPENORDERS_SWEEP_MS', 20 * 60_000)

  constructor() {
    // Emit the EFFECTIVE config once at first use so a deployed env tune is
    // verifiable from the logs (dotenv-loaded vars aren't visible via pm2 env).
    Logger.log(
      `HL dex fan-out config: adaptive=${this.adaptive} fullSweepMs=${this.fullSweepMs} activeTtlMs=${this.activeTtlMs} openSweepMs=${this.openSweepMs}`,
      'HyperliquidDexActivity',
    )
  }

  /**
   * wallet(lowercased) -> {
   *   active:      dex -> lastSeenMs (shared across all 3 methods),
   *   discoveryAt: last clearinghouse discovery sweep (balance+positions share it),
   *   openSweepAt: last open-orders safety sweep,
   * }
   */
  private readonly perUser = new Map<
    string,
    { active: Map<string, number>; discoveryAt: number; openSweepAt: number }
  >()

  private entry(user: string) {
    const key = `${user ?? ''}`.toLowerCase()
    let e = this.perUser.get(key)
    if (!e) {
      e = { active: new Map(), discoveryAt: 0, openSweepAt: 0 }
      this.perUser.set(key, e)
    }
    return e
  }

  private activeDexes(
    e: { active: Map<string, number> },
    allDexes: string[],
    now: number,
  ): string[] {
    const listed = new Set(allDexes)
    const dexes: string[] = []
    for (const [dex, seen] of e.active) {
      if (listed.has(dex) && now - seen < this.activeTtlMs) dexes.push(dex)
    }
    return dexes
  }

  /**
   * Discovery plan for the clearinghouseState methods (balance + positions).
   * They SHARE one `discoveryAt` timer, so only the first of the two past the
   * interval does the all-dex sweep that rebuilds the active set — the other
   * (and every open-orders poll) rides that shared result. HL native is always
   * queried by the caller and is not included here.
   */
  planClearinghouse(
    user: string,
    allDexes: string[],
  ): { dexes: string[]; fullSweep: boolean } {
    if (!this.adaptive) return { dexes: allDexes, fullSweep: true }
    const now = Date.now()
    const e = this.entry(user)
    if (now - e.discoveryAt >= this.fullSweepMs) {
      e.discoveryAt = now
      return { dexes: allDexes, fullSweep: true }
    }
    return { dexes: this.activeDexes(e, allDexes, now), fullSweep: false }
  }

  /**
   * Plan for open-orders: normally just the shared active set (no fan-out),
   * with an occasional slow safety sweep (`openSweepMs`) to bootstrap and to
   * catch the reduce-only-on-empty-dex edge. This removes ~3/4 of the weight-20
   * open-orders sweeps versus sweeping every interval.
   */
  planOpenOrders(
    user: string,
    allDexes: string[],
  ): { dexes: string[]; fullSweep: boolean } {
    if (!this.adaptive) return { dexes: allDexes, fullSweep: true }
    const now = Date.now()
    const e = this.entry(user)
    if (now - e.openSweepAt >= this.openSweepMs) {
      e.openSweepAt = now
      return { dexes: allDexes, fullSweep: true }
    }
    return { dexes: this.activeDexes(e, allDexes, now), fullSweep: false }
  }

  /** Record a single dex as active right now (e.g. on order placement). */
  markActive(user: string, dex?: string | null): void {
    if (!dex) return
    this.entry(user).active.set(dex, Date.now())
  }

  /**
   * Refresh the active set from a completed pass: `seenActive` are the dexes
   * that showed a position/balance/order this pass. Also prunes dexes that have
   * shown no activity within `activeTtlMs`.
   */
  observe(user: string, seenActive: Iterable<string>): void {
    const now = Date.now()
    const e = this.entry(user)
    for (const dex of seenActive) e.active.set(dex, now)
    for (const [dex, seen] of e.active) {
      if (now - seen >= this.activeTtlMs) e.active.delete(dex)
    }
  }
}

/** Does a clearinghouseState carry any activity worth tracking the dex for? */
const hlStateHasActivity = (state: unknown): boolean => {
  const s = state as {
    assetPositions?: unknown[]
    marginSummary?: { accountValue?: string | number }
    withdrawable?: string | number
  } | null
  if (!s) return false
  if (Array.isArray(s.assetPositions) && s.assetPositions.length > 0)
    return true
  if ((Number(s.marginSummary?.accountValue) || 0) > 0) return true
  if ((Number(s.withdrawable) || 0) > 0) return true
  return false
}

/** Classify an HL info-endpoint error for retry decisions. */
const hlInfoErrorKind = (err: unknown): 'rate' | 'transient' | 'fatal' => {
  const e = err as {
    response?: { status?: number }
    status?: number
    message?: string
  }
  const status = e?.response?.status ?? e?.status
  const msg = `${e?.message ?? ''}`.toLowerCase()
  if (
    status === 429 ||
    msg.includes('too many requests') ||
    msg.includes('429')
  )
    return 'rate'
  if (status === 422 || msg.includes('failed to deserialize'))
    return 'transient'
  return 'fatal'
}

/** Best-effort Retry-After (ms) from an HL 429, capped so we never stall long. */
const hlRetryAfterMs = (err: unknown): number | undefined => {
  const resp = (err as { response?: { headers?: unknown } })?.response
  const headers = resp?.headers as
    | { get?: (k: string) => string | null }
    | Record<string, string>
    | undefined
  if (!headers) return undefined
  const raw =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (k: string) => string | null }).get('retry-after')
      : ((headers as Record<string, string>)['retry-after'] ??
        (headers as Record<string, string>)['Retry-After'])
  if (raw == null) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.min(5000, Math.max(0, secs * 1000))
  const at = Date.parse(String(raw))
  if (!Number.isNaN(at)) return Math.min(5000, Math.max(0, at - Date.now()))
  return undefined
}

/**
 * Optional short-TTL cache + in-flight coalescing for identical
 * `clearinghouseState` fetches (same wallet + dex + network). balance and
 * positions read the same per-dex state each poll; within the TTL the second
 * reuses the first instead of issuing another info call. OFF by default — set
 * HL_CH_STATE_CACHE_MS to a small value (1000-2000) to enable. Trades up to
 * `ttlMs` of staleness (may miss a fill inside the window) for fewer info calls.
 */
class HyperliquidChStateCache {
  private static instance: HyperliquidChStateCache
  static getInstance(): HyperliquidChStateCache {
    if (!HyperliquidChStateCache.instance) {
      HyperliquidChStateCache.instance = new HyperliquidChStateCache()
    }
    return HyperliquidChStateCache.instance
  }

  private readonly ttlMs = hlEnvInt('HL_CH_STATE_CACHE_MS', 0)
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor() {
    Logger.log(
      `HL clearinghouseState cache: ${
        this.ttlMs > 0 ? `ON ttlMs=${this.ttlMs}` : 'OFF'
      }`,
      'HyperliquidChStateCache',
    )
  }

  get enabled(): boolean {
    return this.ttlMs > 0
  }

  /** Fresh cached value, or undefined if disabled/absent/expired. */
  peek(key: string): unknown | undefined {
    if (!this.enabled) return undefined
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    if (hit) this.cache.delete(key)
    return undefined
  }
  set(key: string, value: unknown): void {
    if (this.enabled) this.cache.set(key, { at: Date.now(), value })
  }
  inFlight(key: string): Promise<unknown> | undefined {
    return this.enabled ? this.inflight.get(key) : undefined
  }
  track(key: string, p: Promise<unknown>): void {
    if (!this.enabled) return
    this.inflight.set(key, p)
    void p.finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key)
    })
  }
}

class HyperliquidExchange extends AbstractExchange implements Exchange {
  static FUTURES_BUILDER_FEE = 0.00045
  static SPOT_BUILDER_FEE = 0.0007
  static MAX_DECIMALS_FUTURES = 6
  static MAX_DECIMALS_SPOT = 8
  static MAX_FIGURES = 5
  /** Hyperliquid info client */
  protected infoClient: hl.InfoClient
  /** Hyperliquid exchange client */
  protected exchangeClient: hl.ExchangeClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures
  private demo = process.env.HYPERLIQUIDENV === 'demo'
  private code?: string
  constructor(
    futures: Futures,
    key: string,
    secret: string,
    passphrase?: string,
    _environment?: string,
    _keysType?: string,
    _okxSource?: string,
    code?: string,
    _subaccount?: boolean,
  ) {
    super({ key, secret, passphrase, subaccount: `${_subaccount}` === 'true' })
    this.infoClient = new hl.InfoClient({
      transport: new hl.HttpTransport({ isTestnet: this.demo }),
    })
    this.exchangeClient = new hl.ExchangeClient({
      transport: new hl.HttpTransport({ isTestnet: this.demo }),
      wallet: this.secret as `0x${string}`,
      isTestnet: this.demo,
    })
    this.retry = 10
    this.retryErrors = ['429']
    this.futures = futures === Futures.null ? this.futures : futures
    this.code = code
  }

  private methodNotSupported() {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  async getRebateOverview(
    _timestamp: number,
  ): Promise<BaseReturn<RebateOverview>> {
    return this.methodNotSupported()
  }

  async getRebateRecords(
    _timestamp: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>> {
    return this.methodNotSupported()
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return false
  }

  get _key() {
    return this.key as `0x${string}`
  }

  /**
   * Hyperliquid account role for this connection's address, per HL's own
   * `userRole`. Used at verify time to catch the common onboarding mistake of
   * pasting an **API/agent wallet** address in place of the main account:
   * every info request (balance/positions/orders) must target the master, so
   * an agent address silently returns empty and the bot never sees its own
   * fills. Returns `{ role: 'unknown' }` on any lookup error so verification
   * falls through to the existing balance check rather than hard-failing.
   */
  async getAccountRole(): Promise<{ role: string; master?: string }> {
    try {
      const r = await this.infoClient.userRole({ user: this._key })
      return {
        role: r.role,
        master: r.role === 'agent' ? r.data.user : undefined,
      }
    } catch (e) {
      Logger.warn(
        `Hyperliquid userRole check failed for ${this._key}: ${
          (e as Error)?.message ?? e
        }`,
      )
      return { role: 'unknown' }
    }
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async getUid() {
    return this.methodNotSupported()
  }

  async getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    try {
      timeProfile =
        (await this.checkLimits('getAffiliate', 20, timeProfile)) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
        const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
        if (diff >= this.timeout) {
          Logger.error(
            `Hyperliquid Queue time is too long ${diff / 1000} getAffiliate ${
              this.usdm ? 'usdm' : 'coinm'
            }`,
          )
          return this.returnBad(timeProfile)(new Error('Response timeout'))
        }
      }
      const get = await this.infoClient.maxBuilderFee({
        user: this._key as `0x${string}`,
        builder: uid.toString() as `0x${string}`,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      return this.returnGood<boolean>(timeProfile)(
        get === HyperliquidExchange.SPOT_BUILDER_FEE * 100000,
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.getAffiliate,
        uid,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    try {
      if (!this.futures) {
        return this.errorFutures(timeProfile)
      }
      timeProfile =
        (await this.checkLimits('updateLeverage', 1, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
        const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
        if (diff >= this.timeout) {
          Logger.error(
            `Hyperliquid Queue time is too long ${diff / 1000} futures_changeLeverage ${
              this.usdm ? 'usdm' : 'coinm'
            }`,
          )
          return this.returnBad(timeProfile)(new Error('Response timeout'))
        }
      }
      return await this.exchangeClient
        .updateLeverage(
          {
            asset: +(await this.getCoinByPair(symbol, true)),
            isCross: false,
            leverage,
          },
          {
            vaultAddress: this.subaccount ? (this.key as `0x${string}`) : null,
          },
        )
        .then(() => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          return this.returnGood<number>(timeProfile)(leverage)
        })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_changeLeverage,
        symbol,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }
  }

  /**
   * Fetch one `clearinghouseState` (HL native when `dex` is undefined, else the
   * builder dex). Centralizes rate-limit acquisition, the queue-timeout bail,
   * and retry/backoff so both balance and positions behave identically.
   *
   * Retry (was previously only in the balance path, and only for 422/deserialize):
   *   - 429 "too many requests" -> honor Retry-After (capped), else short backoff.
   *     A 429 used to fall straight through to the caller's catch and drop that
   *     dex's state (`null`); it is now recovered instead.
   *   - 422 / "Failed to deserialize" -> short fixed backoff.
   *   - anything else -> rethrow to the caller (logged + state dropped as before).
   * Each retry re-acquires a rate-limit slot so it counts against local budget.
   *
   * When the short-TTL cache is enabled (HL_CH_STATE_CACHE_MS>0) a fresh cached
   * value or an in-flight identical fetch is returned WITHOUT consuming a
   * rate-limit slot; `timedOut` is only ever set on the fetch path.
   */
  private async fetchClearinghouseState(
    dex: string | undefined,
    timeProfile: TimeProfile,
  ): Promise<{ state: unknown; timeProfile: TimeProfile; timedOut?: boolean }> {
    const cache = HyperliquidChStateCache.getInstance()
    const key = `${`${this._key}`.toLowerCase()}|${dex ?? 'native'}|${
      this.demo ? 't' : 'm'
    }`

    const cached = cache.peek(key)
    if (cached !== undefined) return { state: cached, timeProfile }
    const flight = cache.inFlight(key)
    if (flight) return { state: await flight, timeProfile }

    timeProfile =
      (await this.checkLimits('getClearinghouseState', 2, timeProfile)) ||
      timeProfile
    if (
      timeProfile.inQueueStartTime &&
      timeProfile.inQueueEndTime &&
      timeProfile.inQueueEndTime - timeProfile.inQueueStartTime >= this.timeout
    ) {
      return { state: null, timeProfile, timedOut: true }
    }

    const callOnce = () =>
      dex
        ? this.infoClient.clearinghouseState({ user: this._key, dex })
        : this.infoClient.clearinghouseState({ user: this._key })

    const run = (async () => {
      const maxRetries = 2
      for (let attempt = 0; ; attempt++) {
        try {
          return await callOnce()
        } catch (err) {
          const kind = hlInfoErrorKind(err)
          if (
            (kind !== 'rate' && kind !== 'transient') ||
            attempt >= maxRetries
          ) {
            throw err
          }
          const waitMs =
            kind === 'rate'
              ? (hlRetryAfterMs(err) ?? Math.min(2000, 500 * (attempt + 1)))
              : 750
          const userPrefix =
            typeof this._key === 'string' ? this._key.slice(0, 10) : '<unset>'
          Logger.warn(
            `Hyperliquid clearinghouseState ${kind} ${
              dex ?? 'HL native'
            } (user=${userPrefix}…) attempt ${attempt + 1}/${
              maxRetries + 1
            }; wait ${waitMs}ms`,
          )
          await sleep(waitMs)
          // Re-acquire a rate-limit slot for the retry (another real HTTP call).
          await this.checkLimits('getClearinghouseState', 2)
        }
      }
    })()

    cache.track(key, run)
    const state = await run
    cache.set(key, state)
    return { state, timeProfile }
  }

  /**
   * Fetch one frontendOpenOrders page (HL native when `dex` is undefined, else
   * the builder dex) with the same 429/transient retry as
   * {@link fetchClearinghouseState}. `frontendOpenOrders` is weight 20 and draws
   * on the SAME per-IP info budget as clearinghouseState, so its per-dex fan-out
   * was a major 429 contributor; a per-dex error previously just dropped that
   * dex's open orders for the poll. No cache here — open orders is read by a
   * single endpoint, so there is nothing to coalesce.
   */
  private async fetchOpenOrdersForDex(
    dex: string | undefined,
    timeProfile: TimeProfile,
  ): Promise<{
    orders: Awaited<ReturnType<typeof this.infoClient.frontendOpenOrders>>
    timeProfile: TimeProfile
    timedOut?: boolean
  }> {
    timeProfile =
      (await this.checkLimits('getFuturesOpenOrders', 20, timeProfile)) ||
      timeProfile
    if (
      timeProfile.inQueueStartTime &&
      timeProfile.inQueueEndTime &&
      timeProfile.inQueueEndTime - timeProfile.inQueueStartTime >= this.timeout
    ) {
      return { orders: [], timeProfile, timedOut: true }
    }
    const callOnce = () =>
      dex
        ? this.infoClient.frontendOpenOrders({ user: this._key, dex })
        : this.infoClient.frontendOpenOrders({ user: this._key })
    const maxRetries = 2
    for (let attempt = 0; ; attempt++) {
      try {
        const orders = await callOnce()
        return { orders, timeProfile }
      } catch (err) {
        const kind = hlInfoErrorKind(err)
        if (
          (kind !== 'rate' && kind !== 'transient') ||
          attempt >= maxRetries
        ) {
          throw err
        }
        const waitMs =
          kind === 'rate'
            ? (hlRetryAfterMs(err) ?? Math.min(2000, 500 * (attempt + 1)))
            : 750
        const userPrefix =
          typeof this._key === 'string' ? this._key.slice(0, 10) : '<unset>'
        Logger.warn(
          `Hyperliquid frontendOpenOrders ${kind} ${
            dex ?? 'HL native'
          } (user=${userPrefix}…) attempt ${attempt + 1}/${
            maxRetries + 1
          }; wait ${waitMs}ms`,
        )
        await sleep(waitMs)
        await this.checkLimits('getFuturesOpenOrders', 20)
      }
    }
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: FreeAsset = []
    try {
      // HL native always settles in USDC; each builder dex has its own
      // collateral token (USDH, USDE, USDT, …) — fetch one clearinghouseState
      // per dex and label balances with the dex's quote asset.
      // Calls are serialized through checkLimits() — running them in parallel
      // bypasses the rate limiter and triggers 429 on Hyperliquid.
      const assetsCache = HyperliquidAssets.getInstance()
      const allDexNames = await assetsCache.listDexNames()
      const dexQuoteByName = new Map<string, string>()
      const allAssets = await assetsCache.listFuturesAssets()
      for (const a of allAssets) {
        if (a.dexName) dexQuoteByName.set(a.dexName, a.quoteAsset)
      }

      // Only query HL native + dexes this wallet is active on (see
      // HyperliquidDexActivity). Empty dexes return empty state, so skipping
      // them loses no data while cutting the per-poll info-call fan-out that
      // drove the 429s.
      const activity = HyperliquidDexActivity.getInstance()
      const plan = activity.planClearinghouse(this._key, allDexNames)
      type StateOrNull = Awaited<
        ReturnType<typeof this.infoClient.clearinghouseState>
      > | null
      const states: Array<{ asset: string; state: StateOrNull }> = []
      const targets: Array<{ asset: string; dex?: string }> = [
        { asset: 'USDC' },
        ...plan.dexes.map((dex) => ({
          asset: dexQuoteByName.get(dex) ?? 'USDC',
          dex,
        })),
      ]
      const seenActive = new Set<string>()
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const t of targets) {
        try {
          const r = await this.fetchClearinghouseState(t.dex, timeProfile)
          timeProfile = r.timeProfile
          if (r.timedOut) {
            Logger.error(
              `Hyperliquid Queue time is too long futures_getBalance ${
                this.usdm ? 'usdm' : 'coinm'
              }`,
            )
            return this.returnBad(timeProfile)(new Error('Response timeout'))
          }
          states.push({ asset: t.asset, state: r.state as StateOrNull })
          if (t.dex && hlStateHasActivity(r.state)) seenActive.add(t.dex)
        } catch (e) {
          const err = e as {
            message?: string
            response?: { status?: number; statusText?: string }
            body?: unknown
          }
          const status = err.response?.status
          const userPrefix =
            typeof this._key === 'string' ? this._key.slice(0, 10) : '<unset>'
          Logger.error(
            `Hyperliquid clearinghouseState failed for ${
              t.dex ?? 'HL native'
            } (status=${status ?? '?'}, user=${userPrefix}…): ${
              err.message ?? e
            } body=${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`,
          )
          states.push({ asset: t.asset, state: null })
        }
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      // Rebuild the active-dex set from what this pass actually saw (prunes
      // dexes the user has fully exited; refreshes the rest).
      if (plan.fullSweep) activity.observe(this._key, seenActive)
      else for (const dex of seenActive) activity.markActive(this._key, dex)

      // Aggregate by collateral asset (multiple USDH dexes sum into one entry).
      const totals = new Map<string, { free: number; locked: number }>()
      for (const { asset, state } of states) {
        if (!state) continue
        // Total balance for a futures collateral MUST equal its equity
        // (`marginSummary.accountValue`), i.e. free + locked = accountValue.
        // `free` = the portion available to withdraw / open new orders =
        // `withdrawable`; `locked` = everything else tied up as margin. Crucially
        // `locked` is NOT `totalMarginUsed` — that counts only OPEN-POSITION
        // margin and omits the collateral HL reserves for OPEN ORDERS, so
        // `withdrawable + totalMarginUsed` under-reports the account by the
        // open-order margin (e.g. a grid bot with deep resting ladders shows far
        // less than its real equity). Derive `locked = accountValue - free`
        // instead — it captures position margin + open-order margin + any other
        // reserved collateral, and equals the old `accountValue - withdrawable`.
        //
        // `free` is bounded by THIS dex-state's own accountValue, not the raw
        // (account-level) `withdrawable`: for a healthy single-collateral account
        // withdrawable <= accountValue so this is `withdrawable` (no change); for
        // the anomalous non-primary state reading accountValue=0 while
        // withdrawable carries the account total it collapses to free=0/locked=0,
        // dropping the phantom balance instead of surfacing it under the wrong
        // asset. Both clamped >= 0, so `locked` can never go negative.
        const accountValue = +state.marginSummary.accountValue || 0
        const free = Math.max(
          0,
          Math.min(+state.withdrawable || 0, accountValue),
        )
        const locked = Math.max(0, accountValue - free)
        const cur = totals.get(asset) ?? { free: 0, locked: 0 }
        cur.free += free
        cur.locked += locked
        totals.set(asset, cur)
      }
      totals.forEach((v, asset) => {
        res.push({ asset, free: v.free, locked: v.locked })
      })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  protected async getCoinByPair(pair: string, _force = false) {
    return await HyperliquidAssets.getInstance().getCoinByPair(
      pair,
      this.futures ? 'futures' : 'spot',
    )
  }

  private async getCoinNameByPair(pair: string, _force = false) {
    return await HyperliquidAssets.getInstance().getCoinNameByPair(
      pair,
      this.futures ? 'futures' : 'spot',
    )
  }

  private async getPairByCoin(coin: string) {
    return await HyperliquidAssets.getInstance().getPairByCoin(
      coin,
      this.futures ? 'futures' : 'spot',
    )
  }

  /**
   * Returns the HIP-3 deployer fee scale for a futures pair, or 0 for HL
   * native / spot. Used by parent class to gross up base fees.
   */
  public async getDeployerFeeScale(pair: string): Promise<number> {
    if (!this.futures) return 0
    return HyperliquidAssets.getInstance().getDeployerFeeScale(pair)
  }

  async openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (order.newClientOrderId) {
      const getOrder = await this.getOrder(
        { symbol: order.symbol, newClientOrderId: order.newClientOrderId },
        timeProfile,
      )
      if (
        getOrder.status === StatusEnum.notok &&
        getOrder.reason !== 'unknownOid'
      ) {
        return getOrder
      }
      if (getOrder.data?.clientOrderId) {
        Logger.warn(
          `Order with ClientOrderId ${order.newClientOrderId} already exists on Hyperliquid`,
        )
        return this.returnBad(timeProfile)(
          new Error(`Client order ID already exists`),
        )
      }
    }
    timeProfile =
      (await this.checkLimits('placeOrder', 1, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} openOrder ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    const pricePrecision = `${order.price}`.includes('.')
      ? `${order.price}`.split('.')[1].length
      : 0
    const orders: hl.OrderParams = {
      a: +(await this.getCoinByPair(order.symbol, true)),
      b: order.side === 'BUY',
      s: `${order.quantity}`,
      p: this.updateMaxFiguresInPrice(
        `${order.type === 'MARKET' ? (order.side === 'BUY' ? (order.price * 1.1).toFixed(pricePrecision) : (order.price * 0.9).toFixed(pricePrecision)) : order.price}`,
        order.newClientOrderId,
        order.symbol,
      ),
      t: {
        limit: { tif: 'Gtc' },
      },
      r: !!order.reduceOnly,
      c: order.newClientOrderId as `0x${string}`,
    }
    if (!this.futures) {
      orders.r = false
    }
    let builder: hl.OrderParameters['builder'] = undefined
    if (this.code) {
      builder = {
        b: this.code as `0x${string}`,
        f: this.futures
          ? HyperliquidExchange.FUTURES_BUILDER_FEE * 100000
          : HyperliquidExchange.SPOT_BUILDER_FEE * 100000,
      }
    }
    const input: hl.OrderParameters = {
      orders: [orders],
      grouping: 'na',
      builder,
    }
    if (this.code) {
      Logger.log(
        `Placing order with builder ${this.code} and fee ${
          this.futures
            ? HyperliquidExchange.FUTURES_BUILDER_FEE
            : HyperliquidExchange.SPOT_BUILDER_FEE
        } on ${this.futures ? 'futures' : 'spot'} market ${input.builder.b} | ${input.builder.f}`,
        'HyperliquidExchange',
      )
    }
    return this.exchangeClient
      .order(input, {
        vaultAddress: this.subaccount ? (this.key as `0x${string}`) : null,
      })
      .then(async (r: any) => {
        const result: PlaceOrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if ('error' in result.response.data.statuses[0]) {
          return this.handleHyperliquidErrors(
            this.openOrder,
            order,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new HyperliquidError(result.response.data.statuses[0].error, 0))
        }
        // Discovery hint: mark this order's builder dex active so the next
        // balance/positions poll queries it immediately instead of waiting for
        // the periodic full sweep. Best-effort — never block the order flow.
        if (this.futures) {
          try {
            const info = await HyperliquidAssets.getInstance().getFuturesInfo(
              order.symbol,
            )
            if (info?.dexName) {
              HyperliquidDexActivity.getInstance().markActive(
                this._key,
                info.dexName,
              )
            }
          } catch {
            /* ignore — discovery hint only */
          }
        }
        const getOrderPayload = {
          symbol: order.symbol,
          newClientOrderId: order.newClientOrderId,
        }
        if (order.type === 'MARKET') {
          await sleep(500)
        }
        const price =
          'filled' in result.response.data.statuses[0]
            ? result.response.data.statuses[0].filled.avgPx
            : `${order.price}`
        try {
          return await this.getOrder(getOrderPayload, timeProfile, price, true)
        } catch (e) {
          return this.handleHyperliquidErrors(
            this.getOrder,
            getOrderPayload,
            this.endProfilerTime(timeProfile, 'exchange'),
            price,
            true,
          )(e)
        }
      })
      .catch(
        this.handleHyperliquidErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getOrder(
    data: { symbol: string; newClientOrderId: string },
    timeProfile = this.getEmptyTimeProfile(),
    price = '',
    useRetry = false,
    retryCount = 0,
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('getOrderStatus', 2, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} getOrder ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return this.infoClient
      .orderStatus({
        user: this._key,
        oid: data.newClientOrderId as `0x${string}`,
      })
      .then(async (r: any) => {
        const result: OrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.status === 'unknownOid') {
          if (useRetry && retryCount < 4) {
            await sleep(retryCount >= 1 ? 3000 : 500)
            Logger.warn(
              `Retrying getOrder for ${data.symbol} with OID ${data.newClientOrderId}, attempt ${retryCount + 1}`,
            )
            return this.getOrder(
              data,
              timeProfile,
              price,
              useRetry,
              retryCount + 1,
            )
          }
          return this.returnBad(timeProfile)(
            new HyperliquidError(result.status, 0),
          )
        }
        if (
          result.order.order.orderType === 'Limit' &&
          result.order.status === 'filled'
        ) {
          try {
            timeProfile =
              (await this.checkLimits('userFillsByTime', 20, timeProfile)) ||
              timeProfile
            timeProfile = this.startProfilerTime(timeProfile, 'exchange')
            const fills = await this.infoClient
              .userFillsByTime({
                startTime: result.order.order.timestamp,
                endTime: result.order.statusTimestamp,
                user: this._key,
              })
              .then((r) => r.filter((f) => f.oid === result.order.order.oid))
            if (fills.length) {
              const base = fills.reduce((acc, fill) => acc + +fill.sz, 0)
              const quote = fills.reduce(
                (acc, fill) => acc + +fill.sz * +fill.px,
                0,
              )
              price = (quote / base).toFixed(10)
              Logger.log(
                `Calculated price for order ${data.newClientOrderId} based on fills: ${price}`,
              )
              result.order.order.limitPx = price
            }
            timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          } catch (e) {
            timeProfile = this.endProfilerTime(timeProfile, 'exchange')
            Logger.error(
              `Error fetching fills for order ${data.newClientOrderId}: ${e.message}`,
            )
          }
        }
        return this.returnGood<CommonOrder>(timeProfile)(
          await this.convertOrder(
            result.order.order,
            result.order.status,
            result.order.statusTimestamp,
            price,
          ),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
          price,
          useRetry,
          retryCount + 1,
        ),
      )
  }

  async cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 1, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} cancelOrder ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    const cancel = {
      asset: +(await this.getCoinByPair(order.symbol, true)),
      cloid: order.newClientOrderId as `0x${string}`,
    }
    return this.exchangeClient
      .cancelByCloid(
        {
          cancels: [cancel],
        },
        { vaultAddress: this.subaccount ? (this.key as `0x${string}`) : null },
      )
      .then(async (r: any) => {
        const result: CancelOrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.response.data.statuses[0] === 'success') {
          return await this.getOrder(order, timeProfile, '', true)
        }
        return this.handleHyperliquidErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new HyperliquidError(result.response.data.statuses[0].error, 1))
      })
      .catch(
        this.handleHyperliquidErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async latestPrice(symbol: string) {
    const res = await this.getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<number>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol)?.price ?? 0,
    )
  }

  async getExchangeInfo(symbol: string) {
    const res = await this.getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<ExchangeInfo>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol),
    )
  }

  async getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    let res: CommonOrder[] = []
    try {
      // Default frontendOpenOrders only returns HL native + spot. Builder
      // dexes need a per-dex call. Only query HL native + dexes this wallet is
      // active on (shared HyperliquidDexActivity set — an open order is itself
      // an activity signal that cross-feeds balance/positions discovery).
      const dexNames = this.futures
        ? await HyperliquidAssets.getInstance().listDexNames()
        : []
      const activity = HyperliquidDexActivity.getInstance()
      const plan = this.futures
        ? activity.planOpenOrders(this._key, dexNames)
        : { dexes: [] as string[], fullSweep: false }
      const targets: Array<string | undefined> = [undefined, ...plan.dexes]
      type OrdersResult = Awaited<
        ReturnType<typeof this.infoClient.frontendOpenOrders>
      >
      const results: OrdersResult = []
      const seenActive = new Set<string>()
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const dex of targets) {
        try {
          const r = await this.fetchOpenOrdersForDex(dex, timeProfile)
          timeProfile = r.timeProfile
          if (r.timedOut) {
            Logger.error(
              `Hyperliquid Queue time is too long getAllOpenOrders ${
                this.usdm ? 'usdm' : 'coinm'
              }`,
            )
            return this.returnBad(timeProfile)(new Error('Response timeout'))
          }
          results.push(...r.orders)
          if (dex && r.orders.length > 0) seenActive.add(dex)
        } catch (e) {
          Logger.error(
            `Hyperliquid frontendOpenOrders failed for ${dex ?? 'HL native'}: ${(e as Error)?.message ?? e}`,
          )
        }
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (this.futures) {
        if (plan.fullSweep) activity.observe(this._key, seenActive)
        else for (const dex of seenActive) activity.markActive(this._key, dex)
      }

      const data = (results as OrdersResult).filter((r) =>
        this.futures
          ? !r.coin.includes('/') && !r.coin.startsWith('@')
          : r.coin.startsWith('@') || r.coin.includes('/'),
      )
      await Promise.all(
        (data ?? []).map(async (o) =>
          res.push(await this.convertOrder(o, 'open')),
        ),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.getAllOpenOrders,
        symbol,
        returnOrders,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    res = res.filter((s) => (symbol ? s.symbol === symbol : true))

    return {
      timeProfile,
      usage: limitHelper.getUsage(),
      status: StatusEnum.ok as StatusEnum.ok,
      data: returnOrders ? res : res.length,
    }
  }

  async getUserFees(symbol: string) {
    const res = await this.getAllUserFees()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<UserFee>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol) ?? {
        maker: 0,
        taker: 0,
        pair: symbol,
      },
    )
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    const allPairs = await this.getAllExchangeInfo()
    if (allPairs.status === StatusEnum.notok) {
      return allPairs
    }
    timeProfile =
      (await this.checkLimits('placeOrder', 1, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} getAllUserFees ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return this.infoClient
      .userFees({ user: this._key })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const baseAdd = +(this.futures
          ? result.userAddRate
          : result.userSpotAddRate)
        const baseCross = +(this.futures
          ? result.userCrossRate
          : result.userSpotCrossRate)
        const builderAdjust = this.code
          ? this.futures
            ? HyperliquidExchange.FUTURES_BUILDER_FEE
            : HyperliquidExchange.SPOT_BUILDER_FEE
          : 0
        const fees = await Promise.all(
          allPairs.data.map(async (p) => {
            const scale = await this.getDeployerFeeScale(p.pair)
            const factor = 1 + scale
            return {
              pair: p.pair,
              maker: baseAdd * factor + builderAdjust,
              taker: baseCross * factor + builderAdjust,
            }
          }),
        )
        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          fees,
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: PositionInfo[] = []
    try {
      // clearinghouseState only returns positions for one dex at a time;
      // enumerate HL native + every builder dex. Calls are serialized
      // through checkLimits — running them in parallel triggers 429.
      // Only query HL native + dexes this wallet is active on (see
      // HyperliquidDexActivity) instead of fanning out to every builder dex.
      const activity = HyperliquidDexActivity.getInstance()
      const allDexNames = await HyperliquidAssets.getInstance().listDexNames()
      const plan = activity.planClearinghouse(this._key, allDexNames)
      const targets: Array<string | undefined> = [undefined, ...plan.dexes]
      type StateOrNull = Awaited<
        ReturnType<typeof this.infoClient.clearinghouseState>
      > | null
      const states: StateOrNull[] = []
      const seenActive = new Set<string>()
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const dex of targets) {
        try {
          const r = await this.fetchClearinghouseState(dex, timeProfile)
          timeProfile = r.timeProfile
          if (r.timedOut) {
            Logger.error(
              `Hyperliquid Queue time is too long futures_getPositions ${
                this.usdm ? 'usdm' : 'coinm'
              }`,
            )
            return this.returnBad(timeProfile)(new Error('Response timeout'))
          }
          states.push(r.state as StateOrNull)
          if (dex && hlStateHasActivity(r.state)) seenActive.add(dex)
        } catch (e) {
          Logger.error(
            `Hyperliquid clearinghouseState failed for ${dex ?? 'HL native'}: ${(e as Error)?.message ?? e}`,
          )
          states.push(null)
        }
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (plan.fullSweep) activity.observe(this._key, seenActive)
      else for (const dex of seenActive) activity.markActive(this._key, dex)

      const data = states.flatMap((s) => s?.assetPositions ?? [])
      await Promise.all(
        data.map(async (o) => res.push(await this.convertPosition(o))),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getPositions,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<PositionInfo[]>(timeProfile)(res)
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    _countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('candleSnapshot', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} getCandles ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return this.infoClient
      .candleSnapshot({
        coin: await this.getCoinNameByPair(symbol),
        interval,
        startTime: +from,
        endTime: +to,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const data = result
        return this.returnGood<CandleResponse[]>(timeProfile)(
          data.map((d) => ({
            open: `${d.o}`,
            high: `${d.h}`,
            low: `${d.l}`,
            close: `${d.c}`,
            volume: `${d.v}`,
            time: +d.t,
          })),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          _countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    const res: AllPricesResponse[] = []
    try {
      // Default allMids() returns HL native (perp + spot). For builder dexes
      // we have to call once per dex with { dex: name }. Calls are
      // serialized through checkLimits — running them in parallel triggers
      // 429 on Hyperliquid.
      const dexNames = this.futures
        ? await HyperliquidAssets.getInstance().listDexNames()
        : []
      const targets: Array<string | undefined> = [undefined, ...dexNames]
      const allMidsResults: Record<string, string>[] = []
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const dex of targets) {
        timeProfile =
          (await this.checkLimits('getAllMids', 2, timeProfile)) || timeProfile
        if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
          const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
          if (diff >= this.timeout) {
            Logger.error(
              `Hyperliquid Queue time is too long ${diff / 1000} getAllPrices ${
                this.usdm ? 'usdm' : 'coinm'
              }`,
            )
            return this.returnBad(timeProfile)(new Error('Response timeout'))
          }
        }
        try {
          const part = (await (dex
            ? this.infoClient.allMids({ dex })
            : this.infoClient.allMids())) as Record<string, string>
          allMidsResults.push(part)
        } catch (e) {
          Logger.error(
            `Hyperliquid allMids failed for ${dex ?? 'HL native'}: ${(e as Error)?.message ?? e}`,
          )
        }
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      const merged: Record<string, string> = Object.assign(
        {},
        ...allMidsResults,
      )
      const data = Object.entries(merged).filter(([n]) =>
        this.futures
          ? !n.includes('/') && !n.startsWith('@')
          : n.startsWith('@') || n.includes('/'),
      )
      await Promise.all(
        data.map(async (o) =>
          res.push({
            pair: await this.getPairByCoin(o[0]),
            price: +o[1],
          }),
        ),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.getAllPrices,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<AllPricesResponse[]>(timeProfile)(
      res.filter((p) => !p.pair.startsWith('@')),
    )
  }

  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    try {
      if (!this.futures) {
        return this.errorFutures(timeProfile)
      }
      timeProfile =
        (await this.checkLimits('updateLeverage', 1, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
        const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
        if (diff >= this.timeout) {
          Logger.error(
            `Hyperliquid Queue time is too long ${diff / 1000} futures_changeMarginType ${
              this.usdm ? 'usdm' : 'coinm'
            }`,
          )
          return this.returnBad(timeProfile)(new Error('Response timeout'))
        }
      }
      const info = await HyperliquidAssets.getInstance().getFuturesInfo(symbol)
      let effectiveMargin = margin
      if (info?.onlyIsolated && margin === MarginType.CROSSED) {
        Logger.warn(
          `Hyperliquid ${symbol} only supports isolated margin (onlyIsolated); coercing CROSSED → ISOLATED`,
        )
        effectiveMargin = MarginType.ISOLATED
      }
      return await this.exchangeClient
        .updateLeverage(
          {
            asset: +(await this.getCoinByPair(symbol, true)),
            isCross: effectiveMargin === MarginType.CROSSED,
            leverage,
          },
          {
            vaultAddress: this.subaccount ? (this.key as `0x${string}`) : null,
          },
        )
        .then(() => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          return this.returnGood<MarginType>(timeProfile)(effectiveMargin)
        })
    } catch (e) {
      this.handleHyperliquidErrors(
        this.futures_changeMarginType,
        symbol,
        margin,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    //Hedge is not supported on Hyperliquid yet, always false
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async futures_setHedge(
    _value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    //Hedge is not supported on Hyperliquid yet, always false
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<LeverageBracket[]>(all.timeProfile)(
      all.data.map((a) => ({
        symbol: a.pair,
        leverage: a.maxLeverage ? +a.maxLeverage : 100,
        step: a.stepLeverage ? +a.stepLeverage : 1,
        min: a.minLeverage ? +a.minLeverage : 1,
      })),
    )
  }

  async getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>(timeProfile)(true)
  }

  override returnGood<T>(
    timeProfile: TimeProfile,
    usage = limitHelper.getUsage(),
  ) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  override returnBad(timeProfile: TimeProfile, usage = limitHelper.getUsage()) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  async cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return await this.cancelOrder({
      symbol: order.symbol,
      newClientOrderId: order.orderId,
    })
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */

  async getAllExchangeInfo(): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
      })[]
    >
  > {
    if (this.futures) {
      return this.futures_getAllExchangeInfo()
    }
    return this.spot_getAllExchangeInfo()
  }

  protected updateMaxFiguresInPrice(
    p: number | string,
    orderId: string,
    symbol: string,
  ): string {
    if (
      !`${p}`.includes('.') ||
      `${p}`.length - 1 <= HyperliquidExchange.MAX_FIGURES
    ) {
      return `${p}`
    }
    const price = (+`${p}`).toFixed(12)
    let updatedPrice = ''
    let figuresCount = 0
    for (let i = 0; i < price.length; i++) {
      if (figuresCount >= HyperliquidExchange.MAX_FIGURES) {
        break
      }
      updatedPrice = `${updatedPrice}${price[i]}`
      if (price[i] !== '0' || figuresCount > 0) {
        if (price[i] === '.') {
          continue
        }
        figuresCount++
      }
    }
    const pricePrecision = `${updatedPrice}`.includes('.')
      ? `${updatedPrice}`.split('.')[1].length
      : 0
    const result = (+updatedPrice).toFixed(pricePrecision)
    if (result !== `${p}`) {
      Logger.warn(
        `Price ${p} updated to ${result} to match max figures limit. Order ID: ${orderId}, Symbol: ${symbol}`,
      )
    }
    return result
  }

  private calculatePricePrecision(
    market: Market,
    sizeDecimals: number,
    pair: string,
    allPrices: AllPricesResponse[],
  ) {
    const MAX_DECIMALS =
      market === 'futures'
        ? HyperliquidExchange.MAX_DECIMALS_FUTURES
        : HyperliquidExchange.MAX_DECIMALS_SPOT
    const maxDecimals = Math.max(0, MAX_DECIMALS - sizeDecimals)
    let pricePrecision = maxDecimals
    const find = allPrices.find((p) => p.pair === pair)
    if (find && find.price > 0) {
      const price = find.price.toFixed(12)
      let sliceIndex = price.length
      let figuresCount = 0
      let decimals = -1
      let shouldCountFigures = false
      for (let i = 0; i < price.length; i++) {
        if (
          decimals > maxDecimals ||
          figuresCount >= HyperliquidExchange.MAX_FIGURES
        ) {
          break
        }
        const hasDot = decimals >= 0
        if (hasDot) {
          decimals++
        }
        if (
          price[i] !== '0' ||
          (hasDot && shouldCountFigures) ||
          figuresCount > 0
        ) {
          if (price[i] === '.') {
            decimals = 0
            continue
          }
          shouldCountFigures = true
          figuresCount++
          sliceIndex = i + 1
        }
      }
      const splitPrice = price.slice(0, sliceIndex).split('.')
      const lastFigureIndex = splitPrice[1] ? splitPrice[1].length : 0
      pricePrecision = Math.min(lastFigureIndex, maxDecimals)
    }

    return pricePrecision
  }

  async futures_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
      })[]
    >
  > {
    const res: (ExchangeInfo & {
      pair: string
      maxLeverage?: string
      stepLeverage?: string
      minLeverage?: string
    })[] = []

    try {
      timeProfile =
        (await this.checkLimits('getMeta', 20, timeProfile)) || timeProfile
      const allPrices = await this.getAllPrices(timeProfile)
      if (allPrices.status === StatusEnum.notok) {
        return allPrices
      }

      if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
        const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
        if (diff >= this.timeout) {
          Logger.error(
            `Hyperliquid Queue time is too long ${diff / 1000} futures_getAllExchangeInfo ${
              this.usdm ? 'usdm' : 'coinm'
            }`,
          )
          return this.returnBad(timeProfile)(new Error('Response timeout'))
        }
      }
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const assets = await HyperliquidAssets.getInstance().listFuturesAssets()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      assets
        .filter((a) => !a.isDelisted)
        .forEach((a) => {
          const minAmount =
            a.szDecimals === 0 ? 1 : +`0.${'0'.repeat(a.szDecimals - 1)}1`
          // baseAsset.name carries the dex prefix (e.g. 'xyz:HYUNDAI') so
          // downstream balance/position trackers can't accidentally aggregate
          // a builder-dex position with HL native or with another dex that
          // happens to list the same coin. HL native stays bare ('BTC').
          const baseAssetName = aliasToken(a.code)
          const priceAssetPrecision = this.calculatePricePrecision(
            'futures',
            a.szDecimals,
            a.pair,
            allPrices.data,
          )
          res.push({
            code: a.code,
            pair: a.pair,
            // Authoritative class from Hyperliquid perpCategories (undefined =>
            // main-app defaults to crypto). No heuristics.
            assetClass: a.assetClass,
            baseAsset: {
              minAmount,
              maxAmount: 0,
              step: minAmount,
              name: baseAssetName,
              maxMarketAmount: 0,
            },
            quoteAsset: {
              minAmount: 10,
              name: a.quoteAsset,
            },
            maxOrders: 200,
            priceAssetPrecision,
            minLeverage: '1',
            maxLeverage: `${a.maxLeverage}`,
          })
        })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getAllExchangeInfo,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<typeof res>(timeProfile)(res)
  }
  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
      })[]
    >
  > {
    const allPrices = await this.getAllPrices(timeProfile)
    if (allPrices.status === StatusEnum.notok) {
      return allPrices
    }
    timeProfile =
      (await this.checkLimits('getSpotMeta', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `Hyperliquid Queue time is too long ${diff / 1000} spot_getAllExchangeInfo ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return this.infoClient
      .spotMeta()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const pairs = result.universe
        const tokens = result.tokens
        // Refresh the display map from the tokens we just fetched (raw names),
        // so the pair listing normalizes consistently even if this runs before
        // an updateAssets() refresh.
        tokenDisplayMap = buildTokenDisplayMap(tokens)
        // Warm the ticker→assetClass map so spot RWA/equity pairs (AAPL, TSLA,
        // …) get classified as stocks. Hyperliquid only classifies TradFi on
        // the perp side (perpCategories); we cross-reference it onto spot by
        // ticker. See spotAssetClass().
        await HyperliquidAssets.getInstance().ensureAssetClasses()

        return this.returnGood<
          (ExchangeInfo & {
            pair: string
          })[]
        >(timeProfile)(
          pairs
            .map((d, i) => {
              const base = tokens.find((t) => t.index === d.tokens[0])
              const quote = tokens.find((t) => t.index === d.tokens[1])
              if (!base || !quote) {
                return null
              }

              // isCanonical is read off the RAW token before we alias its name.
              const canonical =
                !!base.isCanonical || (base.fullName ?? '').startsWith('Unit ')
              base.name = aliasToken(base.name)
              quote.name = aliasToken(quote.name)
              // Previously we HID un-curated HIP-1 spot tokens that namesquat a
              // TradFi ticker (AAPL/TSLA/…). Instead we surface every pair and let
              // the dashboard filter/annotate them: `isCanonical` drives the
              // pair-picker "Canonical only" toggle (HL-canonical or Unit-bridged
              // = canonical; permissionless HIP-1 = non-canonical). We still reuse
              // the perpCategories cross-reference (Unit-guarded) to classify
              // equity/commodity spot tokens so they land under the right tab.
              const assetClass =
                HyperliquidAssets.getInstance().spotNamesquatClass(
                  base.name,
                  base.fullName,
                )
              const minAmountBase =
                base.szDecimals === 0
                  ? 1
                  : +`0.${'0'.repeat(base.szDecimals - 1)}1`

              const pricePrecision = this.calculatePricePrecision(
                'spot',
                base.szDecimals,
                `${base.name}-${quote.name}`,
                allPrices.data,
              )

              const res = {
                code: d.name,
                pair: `${base.name}-${quote.name}`,
                assetClass,
                isCanonical: canonical,
                baseAsset: {
                  minAmount: minAmountBase,
                  maxAmount: 0,
                  step: minAmountBase,
                  name: base.name,
                  maxMarketAmount: 0,
                },
                quoteAsset: {
                  minAmount: 10,
                  name: quote.name,
                  precision: quote.szDecimals,
                },
                maxOrders: 200,
                priceAssetPrecision: pricePrecision,
              }
              return res
            })
            .filter((r) => r !== null),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    if (this.futures) {
      return await this.futures_getBalance()
    }
    return await this.spot_getBalance()
  }

  /** Bybit get balance
   * get user account info from bybit and look for necessary balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async spot_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const res: FreeAsset = []

    try {
      timeProfile =
        (await this.checkLimits('getSpotClearinghouseState', 2, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
        const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
        if (diff >= this.timeout) {
          Logger.error(
            `Hyperliquid Queue time is too long ${diff / 1000} spot_getBalance ${
              this.usdm ? 'usdm' : 'coinm'
            }`,
          )
          return this.returnBad(timeProfile)(new Error('Response timeout'))
        }
      }
      // Warm the token display map so wrapped wallet assets normalize to the
      // same ticker the pair base uses (UBTC->BTC, UETH->ETH, …). Without
      // this, balance.asset ('UBTC') never matches the aliased pair base
      // ('BTC') and consumers that reconcile by string-equality read 0 — the
      // user can't sell their spot balance and bot forms show no funds
      // (forum #4860).
      await HyperliquidAssets.getInstance().ensureSpotAssets()
      const get = await this.infoClient.spotClearinghouseState({
        user: this._key,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')

      const data = get.balances
      data.map((b) => {
        // Hyperliquid spot `hold` is nominally the amount reserved by open
        // orders and should be >= 0, but the API can return a NEGATIVE hold on
        // spot-perp / builder-dex wallets (observed live: USDC total=59953
        // hold=-85125, USDT0 total=0 hold=-89572). The old
        // `free = total - hold` then INFLATED free by the absolute hold — the
        // account showed USDC free=145078 instead of the real 59953 and USDT
        // free=89572 with nothing actually held — and `locked = hold` went
        // negative. `total` is the authoritative spot balance, so clamp hold to
        // >= 0: locked is never negative, free never exceeds the real total,
        // and free + locked === total for every asset.
        const locked = Math.max(0, +b.hold || 0)
        const free = Math.max(0, (+b.total || 0) - locked)
        res.push({
          asset: aliasToken(b.coin),
          free,
          locked,
        })
      })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  /**
   * Convert Hyperliquid order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private async convertOrder(
    order?: OrderResponseFound['order']['order'],
    status?: OrderResponseFound['order']['status'],
    timestamp?: number,
    filledPrice?: string,
  ): Promise<CommonOrder> {
    const orderStatus: OrderStatusType =
      status === 'open' ? 'NEW' : status === 'filled' ? 'FILLED' : 'CANCELED'

    const orderType: OrderTypeT =
      order.orderType === 'Market' ? 'MARKET' : 'LIMIT'
    let quote = +order.limitPx * +order.sz
    if (isNaN(quote) || !isFinite(quote)) {
      quote = 0
    }
    const response: CommonOrder = {
      symbol: await this.getPairByCoin(order.coin),
      orderId: order.oid,
      clientOrderId: order.cloid,
      transactTime: order.timestamp,
      updateTime: timestamp || order.timestamp,
      price: filledPrice || order.limitPx,
      origQty: order.origSz,
      executedQty: `${+order.origSz - +order.sz}`,
      cummulativeQuoteQty: `${quote}`,
      status: orderStatus,
      type: orderType,
      side: order.side === 'A' ? 'SELL' : 'BUY',
      fills: [],
    }
    return response
  }

  private async convertPosition(
    position: hl.AssetPosition,
  ): Promise<PositionInfo> {
    return {
      symbol: await this.getPairByCoin(position.position.coin),
      initialMargin: position.position.marginUsed,
      maintMargin: position.position.marginUsed,
      unrealizedProfit: position.position.unrealizedPnl,
      positionInitialMargin: position.position.marginUsed,
      openOrderInitialMargin: position.position.marginUsed,
      leverage: `${position.position.leverage.value}`,
      isolated: position.position.leverage.type === 'isolated',
      entryPrice: position.position.entryPx,
      maxNotional: '',
      positionSide:
        +position.position.szi > 0 ? PositionSide.LONG : PositionSide.SHORT,
      positionAmt: `${Math.abs(+position.position.szi)}`,
      notional: '',
      isolatedWallet: '',
      updateTime: +new Date(),
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Hyperliquid API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleHyperliquidErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (
      e: Error & {
        code: number
        response?: string
      },
    ) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      const restApiNotEnabled = 'Rest API trading is not enabled'.toLowerCase()
      const cannotCancel =
        'Can not cancel order, please try again later'.toLowerCase()
      const unknownError = 'unknown error'.toLowerCase()
      const bad = 'Bad Request'.toLowerCase()
      const msg = `${
        (e as { body?: { msg?: string } })?.body?.msg || e.message
      }`.toLowerCase()
      if (
        this.retryErrors.includes(`${e.code}`) ||
        msg.indexOf('request timestamp expired') !== -1 ||
        msg.indexOf('Internal System Error'.toLowerCase()) !== -1 ||
        msg.indexOf('Forbidden') !== -1 ||
        msg.indexOf(bad) !== -1 ||
        msg.indexOf('Server Timeout'.toLowerCase()) !== -1 ||
        msg.indexOf('Server error'.toLowerCase()) !== -1 ||
        msg.indexOf('fetch failed'.toLowerCase()) !== -1 ||
        msg.indexOf('getaddrinfo'.toLowerCase()) !== -1 ||
        msg.indexOf('outside of the recvWindow'.toLowerCase()) !== -1 ||
        msg.indexOf('recv_window'.toLowerCase()) !== -1 ||
        msg.indexOf('socket hang up'.toLowerCase()) !== -1 ||
        msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
        msg.indexOf('too many requests'.toLowerCase()) !== -1 ||
        msg.indexOf('possible ip block'.toLowerCase()) !== -1 ||
        msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
        msg.indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
        msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1 ||
        msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1 ||
        msg.indexOf(tls) !== -1 ||
        msg.indexOf('timeout of 300000ms exceeded'.toLowerCase()) !== -1 ||
        msg.indexOf(restApiNotEnabled) !== -1 ||
        msg.indexOf(cannotCancel) !== -1 ||
        msg.indexOf(unknownError) !== -1
      ) {
        if (timeProfile.attempts < this.retry) {
          if (msg.indexOf(restApiNotEnabled) !== -1) {
            Logger.warn(
              `Hyperliquid Rest API trading is not enabled sleep 10s ${timeProfile.attempts}`,
            )
            await sleep(10 * 1000)
          }
          if (msg.indexOf(unknownError) !== -1) {
            Logger.warn(
              `Hyperliquid Unknown Error sleep 3s ${timeProfile.attempts}`,
            )
            await sleep(3 * 1000)
          }
          if (msg.indexOf('request timestamp expired') !== -1) {
            Logger.warn(
              `Hyperliquid Request timestamp sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (msg.indexOf('recv_window') !== -1) {
            Logger.warn(
              `Hyperliquid recv_window sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (
            msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
            `${e.code}` === '429'
          ) {
            const time = 1000
            Logger.log(
              `Hyperliquid Too many visits wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('too many requests'.toLowerCase()) !== -1) {
            const time = 1000
            if (timeProfile.attempts > 1) {
              Logger.log(
                `Hyperliquid too many requests wait ${time}ms ${
                  timeProfile.attempts
                } ${cb.name} ${this.key}`,
              )
            }
            await sleep(time)
          }
          if (`${e.code}` === '403') {
            const time = 60000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Hyperliquid 403 block wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Gateway Time-out wait 5s ${timeProfile.attempts}`,
            )
            await sleep(5000)
          }
          if (msg.indexOf(bad) !== -1) {
            Logger.log(
              `Hyperliquid Bad Request wait 0.1s ${timeProfile.attempts}`,
            )
            await sleep(100)
          }
          if (msg.indexOf('socket hang up'.toLowerCase()) !== -1) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Hyperliquid socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Internal System Error'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Server Timeout wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server error'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Server error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid Forbidden wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('possible ip block'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('ECONNRESET'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('getaddrinfo'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid getaddrinfo wait 2s ${timeProfile.attempts}`,
            )
            await sleep(2000)
          }
          if (msg.indexOf(tls) !== -1) {
            Logger.log(
              `Hyperliquid Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf(cannotCancel) !== -1) {
            Logger.log(
              `Hyperliquid Cannot cancel order wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(`${this.exchangeProblems}${msg}`),
          )
        }
      } else {
        const message = msg
        return this.returnBad(timeProfile)(new Error(message))
      }
    }
  }

  /**
   * Check info from binance provider about limits and set them to {@link BybitExchange#info}
   * If limits exceeded - call {@link BybitExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: string,
    count?: number,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    const limit = await limitHelper.addWeight(count)
    if (limit > 0) {
      Logger.warn(
        `Hyperliquid request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, count)
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
  }

  getUsage() {
    return limitHelper.getUsage()
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    // Hyperliquid requires startTime; default to a 7d lookback when omitted.
    const endTime = to ? +to : +new Date()
    const startTime = from ? +from : endTime - 7 * 24 * 60 * 60 * 1000
    timeProfile =
      (await this.checkLimits('fundingHistory', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.infoClient
      .fundingHistory({
        coin: symbol,
        startTime,
        endTime,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<FundingRateResponse[]>(timeProfile)(
          (result ?? [])
            .map((r) => ({
              symbol,
              fundingRate: parseFloat(r.fundingRate),
              fundingTime: +r.time,
            }))
            .slice(0, limit),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getFundingRateHistory,
          symbol,
          from,
          to,
          limit,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getTrades(
    _symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.returnGood<TradeResponse[]>(this.getEmptyTimeProfile())([])
  }
}

export default HyperliquidExchange
