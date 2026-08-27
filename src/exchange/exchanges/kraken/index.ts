import AbstractExchange, { Exchange } from '../../abstractExchange'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  FundingRateResponse,
  CommonOrder,
  ExchangeInfo,
  ExchangeIntervals,
  AccountFill,
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
  KeyPermissions,
} from '../../types'
import {
  krakenWithdrawState,
  unknownPermissions,
} from '../../helpers/keyPermissions'
import {
  SpotClient,
  DerivativesClient,
  krakenNonceFromError,
} from '../../../kraken-custom'
import limitHelper from './limit'
import { krakenLadderFee } from './fees'
import { Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { sleep } from '../../../utils/sleepUtils'
import { safeStringify } from '../../../utils/redact'
import {
  FuturesCancelOrderStatus,
  FuturesGetCandlesParams,
  FuturesOrderEvent,
  FuturesOrderJson,
} from '@siebly/kraken-api'

class KrakenError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/**
 * Authoritative per-symbol asset class from Kraken Futures' `category` field on
 * the `/derivatives/api/v3/instruments` response. Kraken's OWN classification —
 * no name heuristics. Tokenized equities are `xStocks`/`Pre-IPO`; FX perps are
 * `Forex`; oil etc. is `Commodities`. NOTE: `Real-world assets` and `DTF` are
 * Kraken's CRYPTO narrative buckets (VET, CFG, LCAP…), so they stay crypto.
 * Crypto categories (Layer 1/DeFi/Meme/…) and `''` → undefined (main-app
 * defaults to crypto). Kraken SPOT carries no class signal (every `aclass_base`
 * is `currency`), so only the futures path is classified.
 */
function krakenFuturesAssetClass(
  category?: string,
): ExchangeInfo['assetClass'] {
  switch (category) {
    case 'xStocks':
    case 'Pre-IPO':
      return 'stock'
    case 'Forex':
      return 'forex'
    case 'Commodities':
      return 'commodity'
    default:
      return undefined
  }
}

/**
 * Kraken tokenized-equity ("xStocks") underlyings that are ETFs / index
 * trackers rather than single-name stocks. Keyed by the base with its trailing
 * `x` stripped (e.g. Kraken base `SPYx` -> `SPY`). Everything tokenized that is
 * NOT in this set is classified `'stock'`. Curated from Kraken's tokenized
 * universe (probed 2026-07-06). Membership only affects the `assetClass` tag
 * surfaced to main-app; it does not gate trading.
 */
const KRAKEN_XSTOCK_ETFS = new Set<string>([
  'SPY',
  'VOO',
  'VTI',
  'VT',
  'VUG',
  'VXUS',
  'QQQ',
  'TQQQ',
  'SOXL',
  'DIA',
  'IWM',
  'IJR',
  'IEMG',
  'SCHF',
  'VGK',
  'EWG',
  'EWQ',
  'EWU',
  'EWY',
  'FEZ',
  'GLD',
  'SLV',
  'PPLT',
  'PALL',
  'GDX',
  'MOO',
  'COPX',
  'URA',
  'NLR',
  'ITA',
  'XLE',
  'XOP',
  'SMH',
  'SOXX',
  'SGOV',
  'JPST',
  'TBLL',
  'JAAA',
  'FLBL',
  'YLDE',
  'BSP',
  'BITX',
])

// Interval mapping for Kraken
const intervalMap: { [x in ExchangeIntervals]: number } = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '1d': 1440,
  '1w': 10080,
}

/**
 * Singleton class to manage Kraken symbol mappings
 * Maps between our symbol format (BTC-USDT) and Kraken's format (XXBTZUSD)
 */
class KrakenSymbolMapper {
  private static spotInstance: KrakenSymbolMapper
  private static usdmInstance: KrakenSymbolMapper

  static getSpotInstance() {
    if (!KrakenSymbolMapper.spotInstance) {
      KrakenSymbolMapper.spotInstance = new KrakenSymbolMapper('spot')
    }
    return KrakenSymbolMapper.spotInstance
  }

  static getUsdmInstance() {
    if (!KrakenSymbolMapper.usdmInstance) {
      KrakenSymbolMapper.usdmInstance = new KrakenSymbolMapper('usdm')
    }
    return KrakenSymbolMapper.usdmInstance
  }

  private ourSymbolToKraken: Map<string, string> = new Map()
  private krakenToOurSymbol: Map<string, string> = new Map()
  private krakenAssetToActual: Map<string, string> = new Map() // For spot: XXBT -> XBT, ZUSD -> USD
  // Our-symbols (e.g. "AAPLx-USD") that are Kraken tokenized-equity ("xStocks")
  // pairs. These require the `asset_class: 'tokenized_asset'` param on every
  // per-pair Kraken call. Replace-set on each getAllExchangeInfo (spot only).
  private tokenizedSymbols: Set<string> = new Set()
  private isInitialized = false
  private marketType: 'spot' | 'usdm'

  private constructor(marketType: 'spot' | 'usdm') {
    this.marketType = marketType
  }

  /**
   * Update asset name mappings (spot only)
   * @param assets Record of Kraken asset name to asset info
   */
  updateAssets(assets: Record<string, { altname: string }>) {
    this.krakenAssetToActual.clear()

    for (const [krakenName, info] of Object.entries(assets)) {
      if (info.altname) {
        if (krakenName === 'XXBT' && info.altname === 'XBT') {
          this.krakenAssetToActual.set(krakenName, 'BTC') // Special case for Bitcoin
        } else if (info.altname === 'XDG') {
          this.krakenAssetToActual.set(krakenName, 'DOGE') // Special case for Dogecoin
        } else {
          this.krakenAssetToActual.set(krakenName, info.altname)
        }
      }
    }
  }

  /**
   * Convert Kraken asset name to actual name
   * @param krakenAsset Kraken asset name (e.g., "XXBT", "ZUSD")
   * @returns Actual asset name (e.g., "XBT", "USD")
   */
  getActualAssetName(krakenAsset: string): string {
    const actualName = this.krakenAssetToActual.get(krakenAsset)
    if (actualName) {
      return actualName
    }

    // Fallback to basic conversion if not in map
    Logger.warn(
      `Kraken ${this.marketType}: Asset ${krakenAsset} not found in map, using fallback`,
    )
    return krakenAsset
  }

  /**
   * Update symbol maps from exchange info
   * @param infos Array of exchange info with pair (our format) and code (Kraken format)
   */
  updateMaps(infos: Array<{ pair: string; code: string }>) {
    this.ourSymbolToKraken.clear()
    this.krakenToOurSymbol.clear()

    for (const info of infos) {
      if (info.pair && info.code) {
        this.ourSymbolToKraken.set(info.pair, info.code)
        this.krakenToOurSymbol.set(info.code, info.pair)
      }
    }

    this.isInitialized = true
  }

  /**
   * Record which our-symbols are Kraken tokenized-equity ("xStocks") pairs.
   * Replace-set: called on each spot getAllExchangeInfo.
   * @param ourSymbols Our-format symbols (e.g. "AAPLx-USD")
   */
  setTokenized(ourSymbols: string[]) {
    this.tokenizedSymbols = new Set(ourSymbols)
  }

  /**
   * Whether an our-symbol is a Kraken tokenized-equity pair (needs the
   * `asset_class: 'tokenized_asset'` param on per-pair Kraken calls).
   * @param ourSymbol Symbol in our format (e.g. "AAPLx-USD")
   */
  isTokenized(ourSymbol: string): boolean {
    return this.tokenizedSymbols.has(ourSymbol)
  }

  /**
   * Convert our symbol format to Kraken's format
   * @param ourSymbol Symbol in our format (e.g., "BTC-USDT")
   * @returns Symbol in Kraken format (e.g., "XXBTZUSD")
   */
  async toKrakenSymbol(ourSymbol: string): Promise<string> {
    // Defensive: an undefined/empty symbol used to reach `.replace()` below and
    // throw a bare TypeError that got mislabeled as a "Kraken API error".
    if (!ourSymbol) {
      return ''
    }
    if (!this.isInitialized) {
      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.toKrakenSymbol(ourSymbol))
        }, 500)
      })
    }
    const krakenSymbol = this.ourSymbolToKraken.get(ourSymbol)
    if (krakenSymbol) {
      return krakenSymbol
    }

    return ourSymbol.replace('-', '').replace('BTC', 'XXBT')
  }

  /**
   * Convert Kraken's symbol format to our format
   * @param krakenSymbol Symbol in Kraken format (e.g., "XXBTZUSD")
   * @returns Symbol in our format (e.g., "BTC-USDT")
   */
  async toOurSymbol(krakenSymbol: string): Promise<string> {
    // Defensive: guard the `.replace()` below against undefined/empty input.
    if (!krakenSymbol) {
      return ''
    }
    if (!this.isInitialized) {
      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.toOurSymbol(krakenSymbol))
        }, 500)
      })
    }
    const ourSymbol = this.krakenToOurSymbol.get(krakenSymbol)
    if (ourSymbol) {
      return ourSymbol
    }
    if (krakenSymbol === 'XBT:USD') {
      return 'BTC-USD'
    }

    return krakenSymbol.replace(/^Z+/, '').replace('XXBT', 'BTC')
  }

  getIsInitialized(): boolean {
    return this.isInitialized
  }
}

/**
 * Process-wide cache of the last CONFIRMED Kraken Futures leverage-preference
 * state, keyed by account + Kraken symbol.
 *
 * Kraken applies leverage/margin as a persistent per-symbol account setting, but
 * the bot engine re-sends it (changeMarginType + changeLeverage, both of which hit
 * `/derivatives/api/v3/leveragepreferences`) on every deal open. A multi-pair
 * futures bot therefore sprays setLeverageSettings across many symbols in a short
 * window and blows Kraken's rate budget -> HTTP 429 `apiLimitExceeded`, which also
 * blocks the actual order that follows.
 *
 * Exchange instances are created fresh per HTTP request (see
 * exchange.service.getExchange), so an instance field would never survive between
 * calls — this MUST live at module scope to actually dedupe. We skip the API call
 * when the desired state already matches the last confirmed one, and only ever
 * write the cache on confirmed success. A TTL bounds staleness (e.g. if the user
 * changes leverage on Kraken directly) so it self-heals.
 */
type KrakenLeveragePref = 'cross' | number // number => isolated maxLeverage
const krakenLeveragePrefCache = new Map<
  string,
  { pref: KrakenLeveragePref; ts: number }
>()
const KRAKEN_LEVERAGE_PREF_TTL = 30 * 60 * 1000 // 30 min safety re-sync

// djb2 hash so we key on the account without retaining raw API secrets in a
// long-lived module map.
function hashKrakenKey(key: string | undefined): string {
  let h = 5381
  const k = key ?? ''
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function krakenLeveragePrefKey(
  apiKey: string | undefined,
  krakenSymbol: string,
): string {
  return `${hashKrakenKey(apiKey)}:${krakenSymbol}`
}

function krakenLeveragePrefMatches(
  cacheKey: string,
  pref: KrakenLeveragePref,
): boolean {
  const cached = krakenLeveragePrefCache.get(cacheKey)
  return (
    !!cached &&
    cached.pref === pref &&
    Date.now() - cached.ts < KRAKEN_LEVERAGE_PREF_TTL
  )
}

/**
 * The account's own rate per pair, from the PRIVATE `TradeVolume` endpoint.
 *
 * Fees used to come from the PUBLIC `AssetPairs` ladder's first entry — the
 * highest tier, for the lowest volume — so every Kraken user on the platform
 * traded against 0.40% taker / 0.25% maker no matter what they actually pay.
 * That is not cosmetic: main-app grosses a spot base order up by `1 + taker`
 * and sizes take-profits against the same number, so a user on a better tier
 * silently over-buys on entry. Pair-scoped `TradeVolume` answers with the
 * rate the account ACTUALLY pays — Kraken does the tier arithmetic, and a
 * negotiated rate (which exists on no public ladder) comes back the same way.
 * Cached briefly so the hourly sweep and per-pair callers don't re-ask.
 */
type KrakenAccountFees = {
  /** The account's own rate for the asked pair — already a fraction, straight
   *  from Kraken (volume tier or negotiated alike). Null when unanswerable. */
  taker: number | null
  maker: number | null
}
/** Keyed `<key fingerprint>:<pair|*>`; the raw API key is never stored. */
const krakenTradeVolumeCache = new Map<
  string,
  KrakenAccountFees & { ts: number }
>()
const KRAKEN_TRADE_VOLUME_TTL = 10 * 60 * 1000
const KRAKEN_ACCOUNT_FEES_UNKNOWN: KrakenAccountFees = {
  taker: null,
  maker: null,
}

/**
 * Per-pair account rates from PAIR-SCOPED `TradeVolume` calls, per API key —
 * the bulk-sweep counterpart of `getAccountFees`. Kraken only reveals what an
 * account actually pays when asked about specific pairs (`fees` / `fees_maker`
 * maps in a pair-scoped response), and that answer covers volume tiers and
 * negotiated rates alike. Live example that forced this: an account with ~5k
 * EUR of 30-day volume paying a negotiated 0.10% taker / 0.00% maker — no
 * volume-derived placement can ever produce that.
 */
const krakenPairFeeMapCache = new Map<
  string,
  {
    map: Map<string, { taker: number | null; maker: number | null }>
    ts: number
  }
>()
/** Pairs per TradeVolume request. ~700 Kraken pairs → ~14 calls per sweep. */
const KRAKEN_TRADE_VOLUME_CHUNK = 50

/**
 * Last time an avg-fill-price lookup failure was logged, per
 * `<key fingerprint>:<class>`. A key that lacks the permission fails on EVERY
 * filled order, so logging each one would bury the signal it is meant to raise;
 * a key that hits a 429 recovers by itself and does not deserve a line at all
 * beyond the first. Process-local and unbounded only in the number of API keys
 * this instance serves, which is already bounded by the connection pool.
 */
const krakenAvgPriceFailureLog = new Map<string, number>()
const KRAKEN_AVG_PRICE_LOG_TTL = 60 * 60 * 1000

/**
 * How long after Kraken Futures logs an `OrderPlaced` we still accept that
 * event as evidence the order is resting, when `getOrderStatus` has not caught
 * up and reports the id as unknown.
 *
 * Beyond this the two answers stop being a race and start being a
 * contradiction, and `getOrderStatus` — the live open-orders view — is the one
 * that is actually about *now*. Erring the same way as main-app's
 * `noteOrderNotFound` age floor: a venue that says "unknown id" about an order
 * placed moments ago is describing its own propagation lag, and calling that a
 * phantom would force-cancel an order about to appear on the book. 60s is far
 * beyond any propagation delay observed on this venue and far short of the
 * hours a real phantom persists.
 */
const KRAKEN_ORDER_PLACED_PROPAGATION_MS = 60 * 1000

/**
 * Does this failure mean "this key will never be allowed to read fills", as
 * opposed to "try again later"?
 *
 * Kraken Futures answers a key that lacks the query-trades/history permission
 * with `{result:'error', error:'authenticationError'}` at HTTP 200 — an
 * application-layer refusal that looks nothing like a transport error — and the
 * history API family refuses with a transport 401. Neither ever recovers on
 * retry, so both must be visible; rate limits and 5xx must not be.
 */
export function isKrakenPermanentAuthFailure(reason: string): boolean {
  const r = reason.toLowerCase()
  return (
    r.includes('authenticationerror') ||
    r.includes('status code 401') ||
    r.includes('status code 403') ||
    r.includes('unauthorized') ||
    r.includes('insufficient permission')
  )
}

class KrakenExchange extends AbstractExchange implements Exchange {
  /** Kraken Spot client */
  protected spotClient?: SpotClient
  /** Kraken Derivatives/Futures client */
  protected derivativesClient?: DerivativesClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures
  /** Symbol mapper for converting between our format and Kraken's format */
  private symbolMapper: KrakenSymbolMapper

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: string,
    _keysType?: unknown,
    _okxSource?: string,
    _code?: string,
    _bybitHost?: unknown,
    _subaccount?: boolean,
  ) {
    super({ key, secret })

    const isDemo = process.env.KRAKEN_ENV === 'demo'

    const spotOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
    }

    const derivativesOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
      testnet: isDemo,
    }

    this.futures = futures === Futures.null ? this.futures : futures

    // Initialize appropriate client based on futures type
    if (this.usdm) {
      this.derivativesClient = new DerivativesClient(derivativesOptions)
      this.symbolMapper = KrakenSymbolMapper.getUsdmInstance()
    } else {
      this.spotClient = new SpotClient(spotOptions)
      this.symbolMapper = KrakenSymbolMapper.getSpotInstance()
    }

    this.retry = 10
    this.retryErrors = [
      'EAPI:Rate limit exceeded',
      // Kraken *Futures* returns a different rate-limit shape than spot:
      // { result: 'error', error: 'apiLimitExceeded', httpStatus: 429 }. The spot
      // string above never matches it, so futures 429s used to be thrown straight
      // through (surfacing to users as an uncategorized `apiLimitExceeded`). Retry
      // it with the same exponential backoff.
      'apiLimitExceeded',
      'EService:Timeout',
      'EService:Unavailable',
      'EService:Busy',
      'EGeneral:Temporary lockout',
      // Kraken's *public* (per-IP) rate limit. Unlike the private counter it is
      // delivered as HTTP **200** with the code in the body
      // (`{"error":["EGeneral:Too many requests"],"httpStatus":200}`), so neither
      // the spot/futures strings above nor the numeric httpStatus entries below
      // ever matched it — public `/public/OHLC` rejections were thrown straight
      // through with no backoff at all, and the archive backfiller simply
      // re-requested, so the egress fleet hammered Kraken continuously
      // (2026-07-28: 142 of 145 error lines on a single node, 0 retries logged).
      'EGeneral:Too many requests',
      // Nonce collisions (spot `EAPI:Invalid nonce`; futures lowercase
      // `invalid nonce` / `duplicate nonce`) are pre-execution rejections — the
      // order/cancel never reached the matching engine — so re-signing with a
      // fresh, higher nonce is safe. Combo-bot Kraken legs hit this the same way
      // Hyperliquid does; retry self-heals it instead of alerting the user.
      'EAPI:Invalid nonce',
      'invalid nonce',
      'duplicate nonce',
      '500',
      '502',
      '503',
      '504',
      '520',
      '521',
      '522',
    ]

    // Initialize symbol maps in background
    this.initializeSymbolMaps()
  }

  /**
   * Initialize symbol maps by fetching exchange info
   * This runs in the background and doesn't block construction
   */
  private async initializeSymbolMaps() {
    if (!this.symbolMapper.getIsInitialized()) {
      try {
        await this.getAllExchangeInfo()
      } catch (error) {
        Logger.warn(
          `Failed to initialize Kraken symbol maps: ${error.message}. Maps will be populated on first getAllExchangeInfo call.`,
        )
      }
    }
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  private errorClient(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Client not initialized'))
  }

  /**
   * Handle Kraken API errors with retry logic
   *
   * Call sites MUST pass the wrapped method's full argument list (ending with
   * the timeProfile) — the retry re-invokes `cb.call(this, ...args)` verbatim.
   * Passing only the timeProfile makes the retry call the method with the
   * TimeProfile object in the first parameter slot (e.g. as `symbol`), which
   * surfaced as "ourSymbol.replace is not a function" 500s.
   */
  private handleKrakenErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (e: Error): Promise<any> => {
      const errorObj = e as any
      const timeProfile: TimeProfile = args[args.length - 1]

      // Extract error information from different possible locations
      const httpStatus = errorObj.code || errorObj.response?.status || ''
      const errorBody = errorObj.body
      const errorResponse = errorObj.response
      // The arguments the wrapped method was actually called with, minus the
      // trailing TimeProfile. NOT `errorObj.requestParams`: that is set only by
      // @siebly/kraken-api's `parseException`, i.e. only when the SPOT client
      // gets an HTTP-level failure. The futures path throws plain `Error`s
      // raised by this file (e.g. `new Error(result.sendStatus.status)` ->
      // "wouldNotReducePosition"), which carry no `requestParams`, so the log
      // below rendered `openOrder called with params: {}` for every futures
      // rejection — hiding the symbol/side/size needed to diagnose them.
      // `args` is always present, is the caller-meaningful input, and (unlike
      // the spot `requestParams`) never contains signed API-Key/API-Sign
      // headers. See bug #310.
      //
      // Both this and `errorDetails` still go through `safeStringify`: the
      // thrown object DOES carry live credentials (`requestParams.options
      // .headers['API-Key'|'API-Sign']`, stapled on by @siebly/kraken-api's
      // `parseException`), so any future edit that widens what gets logged
      // here must not be able to put them in a pm2 log line.
      const calledWithArgs = args.slice(0, -1)

      // Kraken API errors are in body.error or body.errors array
      let actualError: string
      let errorDetails: any = {}

      if (errorBody?.errors && Array.isArray(errorBody.errors)) {
        // Kraken Futures API error format with errors array
        const errors = errorBody.errors.map(
          (e: any) => `[${e.code}] ${e.message}`,
        )
        actualError = errors.join(', ')
        errorDetails = {
          status: errorBody.status,
          result: errorBody.result,
          errors: errorBody.errors,
          serverTime: errorBody.serverTime,
          httpStatus,
        }
      } else if (errorBody?.error) {
        // Kraken Futures API error format with single error
        actualError = errorBody.error
        errorDetails = {
          result: errorBody.result,
          error: errorBody.error,
          serverTime: errorBody.serverTime,
          httpStatus,
          ...(errorBody.errorCode && { errorCode: errorBody.errorCode }),
          ...(errorBody.message && { message: errorBody.message }),
        }
      } else if (errorResponse?.data) {
        // Alternative error format
        actualError =
          errorResponse.data.error || errorResponse.data.message || e.message
        errorDetails = errorResponse.data
      } else {
        // Fallback to basic error message
        actualError = e.message
        errorDetails = { message: e.message, httpStatus }
      }

      // The nonce the rejected request carried. Kraken scopes nonces per API
      // key, so `EAPI:Invalid nonce` is the one error class you cannot diagnose
      // from the message alone — a duplicate nonce and an out-of-order arrival
      // log identically. Logging the value makes `pid + nonce` across the
      // fleet's logs decide which it was. Spread rather than mutate:
      // `errorDetails` may be a reference to the live response body above.
      // Only the nonce is taken — `requestParams` also carries live API-Key /
      // API-Sign headers (see the note on `calledWithArgs`).
      const nonce = krakenNonceFromError(errorObj)
      if (nonce) {
        errorDetails = { ...errorDetails, nonce }
      }

      // Distinguish genuine Kraken API rejections from our own JS bugs. A bare
      // TypeError/ReferenceError etc. (no error body/response) is a connector
      // code fault, not something Kraken rejected — logging it as a "Kraken API
      // error" hides it among real exchange rejections.
      const isJsError =
        !errorBody &&
        !errorResponse?.data &&
        (e instanceof TypeError ||
          e instanceof ReferenceError ||
          e instanceof RangeError ||
          e instanceof SyntaxError)

      // Log comprehensive error information including request details
      Logger.error(
        isJsError
          ? `[${httpStatus || 'NO_STATUS'}] Kraken connector error (${e.name}): ${actualError}`
          : `[${httpStatus || 'NO_STATUS'}] Kraken API error: ${actualError}`,
        `Details: ${safeStringify(errorDetails)}, ${cb.name} called with params: ${safeStringify(calledWithArgs)}${
          isJsError ? `, stack: ${e.stack}` : ''
        }`,
      )

      // Check if error is retryable
      const shouldRetry = this.retryErrors.some(
        (code) =>
          actualError.includes(code) ||
          e.message.includes(code) ||
          (httpStatus && String(httpStatus).includes(code)),
      )

      // Rate-limit rejections are the one retryable class where fast, deep
      // retry is counterproductive: every attempt re-costs Kraken's
      // per-account counter (decay only ~0.33–0.5/s), so 10 retries capped at
      // 10s apart amplify a saturation storm instead of riding it out
      // (2026-07-14: ~2.3k logged rate-limit errors fleet-wide in 4h, most of
      // them retry attempts). Give these fewer, slower attempts sized to the
      // counter decay; each retry still re-enters checkLimits, so the local
      // budget accounting is preserved.
      const matches = (codes: string[]) =>
        codes.some(
          (code) => actualError.includes(code) || e.message.includes(code),
        )
      // Per-account (private REST) rate limits — spot and futures spellings.
      const isAccountRateLimit = matches([
        'EAPI:Rate limit exceeded',
        'apiLimitExceeded',
      ])
      // Kraken's public endpoints are limited **per egress IP**, not per account
      // (see exchange-balancer's `publicUrl` routing note). It saturates the same
      // way, so it gets the same slow-retry pacing…
      const isRateLimit =
        isAccountRateLimit || matches(['EGeneral:Too many requests'])
      // …but NOT the adaptive tier drop: a real *account* rate-limit rejection
      // means that account's true Kraken budget is tighter than we assumed, so we
      // drop it to Starter for a cooldown window (no-op unless per-account limits
      // are enabled). An IP-level public rejection says nothing about any
      // account's private budget — attributing it to one would throttle an
      // unrelated account's private throughput for congestion it did not cause.
      if (isAccountRateLimit) {
        limitHelper.noteRateLimited(hashKrakenKey(this.key))
      }
      // A provider-wide OUTAGE (HTTP 5xx, or Kraken spot's own
      // `EService:Unavailable`/`EService:Busy`) is not an ordinary per-request
      // transient: every caller on every egress node is getting it at the same
      // instant, and it lasts MINUTES, not milliseconds. The generic ladder is
      // sized for a blip — 10 attempts at `min(1000 * 2^n, 10000)` = 74s of
      // retrying and TEN logged error lines per failing call — so it cannot
      // outlast a real outage and buys nothing by trying. Worse, the ramp is
      // per-request state (`timeProfile.attempts`) and resets to zero on every
      // new call, so the poll loop keeps starting fresh 74s ladders and the
      // fleet re-requests at near-full rate into a dead provider.
      // 2026-08-06: Kraken was down 07:01:45Z→07:16:38Z and all six nodes
      // logged ~2,850 `[503] Kraken API error: Service Unavailable` lines
      // (peak 141/min on .111) with in-flight getOrder calls stalling 76–89s.
      // Note the observed message is the HTTP reason phrase `Service
      // Unavailable`, which does NOT substring-match the `EService:Unavailable`
      // code above — it is retryable only via the numeric `'503'` entry — so
      // this class is matched on httpStatus as well as by name.
      // Same treatment as the rate-limit class (bug #181): fewer, paced
      // attempts. Ride out a short blip, then fail fast and let the caller's
      // own loop retry, instead of camping on a dead endpoint.
      const isProviderOutage =
        matches(['EService:Unavailable', 'EService:Busy']) ||
        ['500', '502', '503', '504', '520', '521', '522'].includes(
          String(httpStatus),
        )
      const maxAttempts = isRateLimit || isProviderOutage ? 3 : this.retry

      if (shouldRetry && timeProfile.attempts < maxAttempts) {
        const waitTime = isRateLimit
          ? 30000
          : isProviderOutage
            ? 5000
            : Math.min(1000 * Math.pow(2, timeProfile.attempts), 10000)
        Logger.warn(
          `Retrying after ${waitTime}ms (attempt ${timeProfile.attempts + 1}/${maxAttempts})`,
        )
        await sleep(waitTime)

        timeProfile.attempts++
        return cb.call(this, ...args)
      }

      return this.returnBad(timeProfile)(
        new KrakenError(actualError, String(httpStatus)),
      )
    }
  }

  /**
   * Check rate limits before making API call
   */
  protected async checkLimits(
    method: string,
    symbol?: string,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | undefined> {
    const isOrderMethod = ['submitOrder', 'cancelOrder', 'amendOrder'].includes(
      method,
    )
    const isHeavyMethod = ['getLedgersInfo', 'getTradesHistory'].includes(
      method,
    )

    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }

    // Per-account budget key: hash of this connection's API key (never the key
    // itself). No-op unless KRAKEN_PER_ACCOUNT_LIMITS is on, in which case the
    // limiter tracks each account's Kraken budget separately — correct only
    // because the balancer routes an account's private calls to one connector
    // instance (KRAKEN_STICKY_ROUTING). With the flag off this is ignored and
    // the legacy global counter is used.
    const accountKey = hashKrakenKey(this.key)

    let waitTime = 0
    if (isOrderMethod && symbol) {
      const orderType =
        method === 'submitOrder'
          ? 'add'
          : method === 'cancelOrder'
            ? 'cancel'
            : 'amend'
      waitTime = await limitHelper.addOrderCall(symbol, orderType, accountKey)
    } else {
      waitTime = await limitHelper.addRestCall(isHeavyMethod, accountKey)
    }

    if (waitTime > 0) {
      await sleep(waitTime)
    }

    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
      return timeProfile
    }
    return undefined
  }

  getUsage() {
    return limitHelper.getUsage()
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

  /**
   * Map Kraken order status to common format
   */
  private mapOrderStatus(status: string): OrderStatusType {
    const statusMap: Record<string, OrderStatusType> = {
      pending: 'NEW',
      open: 'NEW',
      closed: 'FILLED',
      canceled: 'CANCELED',
      cancelled: 'CANCELED',
      expired: 'CANCELED',
      filled: 'FILLED',
      'partially filled': 'PARTIALLY_FILLED',
      FULLY_EXECUTED: 'FILLED',
      REJECTED: 'CANCELED',
      // Kraken Futures raw statuses (getOrderStatus / getOpenOrders) — without
      // these a resting-but-(partially)filled order fell through to NEW (#4924).
      entered_book: 'NEW',
      untouched: 'NEW',
      partiallyfilled: 'PARTIALLY_FILLED',
      fullyexecuted: 'FILLED',
      // Idempotent on our own canonical value so a status we derived from fills
      // survives the re-map inside futures_convertOrder (also repairs the
      // getOrderEvents fallback, which already passes PARTIALLY_FILLED here).
      partially_filled: 'PARTIALLY_FILLED',
    }

    return statusMap[status.toLowerCase()] || statusMap[status] || 'NEW'
  }

  /**
   * Derive the canonical status of a Kraken Futures order from its fill amounts.
   * Kraken reports a resting order that is partially or fully filled with a raw
   * status of ENTERED_BOOK / partiallyFilled / untouched (getOrderStatus &
   * getOpenOrders), so the raw status alone never yields PARTIALLY_FILLED/FILLED
   * — main-app then keys off status, misses the fill and re-buys the same size
   * (forum #4924). Mirror the getOrderEvents path: a terminal cancel/reject
   * wins, otherwise derive from executed vs original quantity.
   */
  private futures_deriveOrderStatus(
    rawStatus: string,
    executedQty: number,
    origQty: number,
  ): OrderStatusType {
    const mapped = this.mapOrderStatus(rawStatus)
    if (mapped === 'CANCELED') return 'CANCELED'
    if (executedQty > 0) {
      return executedQty >= origQty && origQty > 0
        ? 'FILLED'
        : 'PARTIALLY_FILLED'
    }
    return mapped
  }

  /**
   * Does this `/orders/status` element actually describe an order Kraken has?
   *
   * `getOrderStatus` answers about orders that are open, or were filled or
   * cancelled in the last 5 seconds — and it returns an ELEMENT even for an id
   * outside that window, carrying no usable `status` (absent, or a not-found
   * marker) and often an `error`. That element is "we do not know this order",
   * not a snapshot of it.
   *
   * The caller used to feed it through as `orderInfo.status || 'NEW'`, which
   * turns "we do not know" into the one answer that means the opposite: NEW =
   * resting on the book. Bug #366 is what that costs. A Kraken Futures grid
   * order (`GRID-RO-1w23…` / `a26e32f1-…`) was gone from the venue, so every
   * cancel came back `notFound` -> `Unknown order`, and main-app's
   * `_handleUnknownOrder` then re-read it here and was told NEW. Because that
   * is a SUCCESSFUL read, main-app cleared its `canceledMap` retry counter on
   * each pass, so the 5-attempt force-cancel that exists for exactly this case
   * could never be reached — the order sat at NEW in Mongo from 2026-08-05
   * while the bot re-attempted the cancel ~4x/day indefinitely, holding a dead
   * grid level.
   *
   * So: only a status Kraken documents for a real order is evidence about that
   * order. Anything else falls through to the getOrderEvents lookup, which
   * either resolves the true outcome or fails and lets the caller reconcile —
   * the path already proven in production on `CMB-GR-…` orders, which reach
   * "Order not found in history" and then main-app's force-cancel.
   *
   * Deliberately NOT relaxed into `mapOrderStatus`'s unknown -> NEW default:
   * that default is shared with the spot paths and is not in evidence here.
   *
   * Pure — no network.
   */
  futures_isKnownOrderStatus(status?: string): boolean {
    return [
      'ENTERED_BOOK',
      'FULLY_EXECUTED',
      'REJECTED',
      'CANCELLED',
      'TRIGGER_PLACED',
      'TRIGGER_ACTIVATION_FAILURE',
    ].includes(`${status ?? ''}`.toUpperCase())
  }

  /**
   * Size-weighted average execution price from a batch of Kraken order events.
   *
   * Kraken attaches `EXECUTION` events — each carrying an exact `price` and
   * `amount` — to the responses for submitting, editing and cancelling an
   * order. That is the venue stating what it actually filled, in the same
   * round trip, for free. It is the ONLY execution-price source here that
   * needs no second call and no extra permission, which matters because the
   * `/fills` endpoint needs both.
   *
   * Returns `executedQty: 0` and no price when the batch carries no execution
   * (e.g. a limit order that only rested), so callers can tell "nothing filled
   * in this batch" from "filled at price X". Pure — no network.
   */
  futures_readExecutionPrice(events?: FuturesOrderEvent[]): {
    executedQty: number
    avgPrice?: number
  } {
    const executions = (events ?? []).filter(
      (e): e is Extract<FuturesOrderEvent, { type: 'EXECUTION' }> =>
        e.type === 'EXECUTION' && 'amount' in e,
    )
    const executedQty = executions.reduce((acc, e) => acc + (e.amount || 0), 0)
    if (executedQty <= 0) {
      return { executedQty: 0 }
    }
    return {
      executedQty,
      avgPrice:
        executions.reduce(
          (acc, e) => acc + (e.price || 0) * (e.amount || 0),
          0,
        ) / executedQty,
    }
  }

  /**
   * Read what Kraken says actually happened to a cancelled order.
   *
   * Kraken answers a cancel with `cancelStatus.status`:
   * `'cancelled' | 'filled' | 'notFound'`. This used to be ignored in favour of
   * a hardcoded `CANCELED` with no executed quantity — so a cancel that raced a
   * fill reported the order as dead while the position stayed on the venue,
   * leaving an untracked position with no TP and no SL and a deal short by the
   * filled size. It also discarded PARTIAL fills on genuine cancels, and
   * asserted a side/price it had never read.
   *
   * `unknown` means "do not claim to know": either Kraken could not find the
   * order, or it says the order executed but gave us nothing to size the fill
   * with. Both must reach the caller's unknown-order path so the real order is
   * re-fetched, because inventing a quantity here would book a phantom fill.
   *
   * Pure — no network. Exercised by `cancel-verdict.spec.ts`.
   */
  futures_readCancelOutcome(cancelStatus?: FuturesCancelOrderStatus): {
    unknown: boolean
    rawStatus: string
    executedQty: number
    origQty: number
    avgPrice?: number
    limitPrice?: number
    symbol?: string
    clientOrderId: string
    side: string
    type: string
  } {
    const unknownOutcome = {
      unknown: true,
      rawStatus: 'cancelled',
      executedQty: 0,
      origQty: 0,
      clientOrderId: '',
      side: 'buy',
      type: 'LIMIT',
    }
    if (!cancelStatus || cancelStatus.status === 'notFound') {
      return unknownOutcome
    }

    const events = cancelStatus.orderEvents ?? []
    // Every event carries a snapshot of the order it happened to, so side,
    // quantity and limit price come from Kraken rather than being assumed.
    const snapshot = events.reduce<FuturesOrderJson | undefined>(
      (acc, e) =>
        acc ??
        ('order' in e
          ? e.order
          : 'orderPriorExecution' in e
            ? e.orderPriorExecution
            : 'old' in e
              ? e.old
              : undefined),
      undefined,
    )
    // EXECUTION events are the fills the cancel raced. Prefer them over the
    // snapshot's `filled`, which predates the executions in this same batch.
    const { executedQty: executedFromEvents, avgPrice } =
      this.futures_readExecutionPrice(events)
    const executedQty = executedFromEvents || snapshot?.filled || 0

    if (cancelStatus.status === 'filled' && executedQty <= 0) {
      return unknownOutcome
    }

    return {
      unknown: false,
      // `filled` is Kraken's own word for "already fully executed". For
      // `cancelled`, `futures_deriveOrderStatus` keeps CANCELED while the
      // executed quantity above still carries any partial fill.
      rawStatus: cancelStatus.status === 'filled' ? 'filled' : 'cancelled',
      executedQty,
      origQty: snapshot?.quantity || 0,
      avgPrice,
      limitPrice: snapshot?.limitPrice,
      symbol: snapshot?.symbol,
      clientOrderId: cancelStatus.cliOrdId ?? snapshot?.cliOrdId ?? '',
      side: snapshot?.side || 'buy',
      type: snapshot?.type || 'LIMIT',
    }
  }

  /**
   * Map Kraken order type to common format
   */
  private mapOrderType(type: string): OrderTypeT {
    return type.toLowerCase() === 'market' ? 'MARKET' : 'LIMIT'
  }

  /**
   * Normalize Kraken symbol format to our format (XXBTZUSD -> BTC-USD)
   * Uses symbol mapper with fallback to basic conversion
   */
  private async normalizeSymbol(krakenSymbol: string): Promise<string> {
    return this.symbolMapper.toOurSymbol(krakenSymbol)
  }

  /**
   * Convert our symbol format to Kraken format (BTC-USD -> XXBTZUSD)
   * Uses symbol mapper with fallback to basic conversion
   */
  private async toKrakenSymbol(symbol: string): Promise<string> {
    return this.symbolMapper.toKrakenSymbol(symbol)
  }

  /**
   * Convert Kraken spot order to common format
   */
  private convertOrder(order: {
    orderId: string
    symbol: string
    clientOrderId?: string
    price: string
    origQty: string
    executedQty: string
    status: string
    type: string
    side: string
    updateTime?: number
    transactTime?: number
  }): CommonOrder {
    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId || '',
      transactTime: order.transactTime || Date.now(),
      updateTime: order.updateTime || Date.now(),
      price: order.price,
      origQty: order.origQty,
      executedQty: order.executedQty,
      status: this.mapOrderStatus(order.status),
      type: this.mapOrderType(order.type),
      side: order.side as OrderSideType,
    }
  }

  /**
   * Convert Kraken futures order to common format
   */
  private futures_convertOrder(order: {
    orderId: string
    symbol: string
    clientOrderId?: string
    price?: number
    avgPrice?: number
    origQty?: number
    executedQty?: number
    status: string
    type: string
    side: string
    updateTime?: number
    transactTime?: number
  }): CommonOrder {
    // Kraken Futures order objects only expose the LIMIT price, so callers pass the
    // real (size-weighted) average fill price as `avgPrice` for filled orders. Mirror
    // the Binance-futures contract: `price` carries the fill price when known so
    // downstream (deal entry/avg) records the actual execution, not the limit.
    const avgPrice =
      order.avgPrice && isFinite(order.avgPrice) ? order.avgPrice : undefined
    // Give main-app the fill notional so its order-fill logic resolves the true
    // average (quote/base) instead of the limit price on both the placement and
    // poll/reconcile paths.
    const cummulativeQuoteQty =
      avgPrice && order.executedQty
        ? (avgPrice * order.executedQty).toString()
        : undefined
    const order2: CommonOrder = {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId || '',
      transactTime: order.transactTime || Date.now(),
      updateTime: order.updateTime || Date.now(),
      price: (avgPrice ?? order.price)?.toString() || '0',
      avgPrice: avgPrice?.toString() || '',
      cummulativeQuoteQty,
      origQty: order.origQty?.toString() || '0',
      executedQty: order.executedQty?.toString() || '0',
      status: this.mapOrderStatus(order.status),
      type: this.mapOrderType(order.type),
      side: order.side.toUpperCase() as OrderSideType,
    }
    return order2
  }

  /**
   * Kraken Futures `getOrderStatus` / `getOrderEvents` responses only carry the
   * order's LIMIT price, never its execution price — so a limit order that fills
   * better than its limit would be recorded at the (worse) limit price, understating
   * deal P/L. This fetches the account fills and returns the size-weighted average
   * execution price for the given order. Returns null when no matching fills are
   * found or on any error, so callers fall back to the limit price. Only call when
   * the order has a non-zero filled quantity to avoid needless rate-limit spend.
   */
  private async futures_getAvgFillPrice(
    orderId?: string,
    clientOrderId?: string,
  ): Promise<number | null> {
    if (!this.derivativesClient || (!orderId && !clientOrderId)) return null
    try {
      const result = await this.derivativesClient.getFills()
      if (result.result !== 'success') {
        // An application-layer refusal at HTTP 200. This is where a key that
        // lacks the query-trades permission lands, and where the old bare
        // `catch` made a permanent failure indistinguishable from a blip.
        this.logAvgFillPriceFailure(
          `${(result as { error?: string }).error || result.result || 'unknown'}`,
        )
        return null
      }
      if (!result.fills?.length) return null
      const matches = result.fills.filter(
        (f) =>
          (clientOrderId && f.cliOrdId === clientOrderId) ||
          (orderId && f.order_id === orderId),
      )
      // Not an error: `getFills()` returns Kraken's most recent page, so an
      // order that filled outside it simply is not here. Callers fall back to
      // the limit price, which for a resting limit order IS the fill price.
      if (!matches.length) return null
      let notional = 0
      let size = 0
      for (const fill of matches) {
        notional += fill.price * fill.size
        size += fill.size
      }
      if (size <= 0) return null
      return notional / size
    } catch (e) {
      this.logAvgFillPriceFailure(e instanceof Error ? e.message : `${e}`)
      // Never break order recording over a price refinement — the caller still
      // records the order, at its limit price.
      return null
    }
  }

  /**
   * Surface an avg-fill-price lookup failure without either spamming the log or
   * swallowing it.
   *
   * A permission failure is permanent: it recurs on every filled order for that
   * key, forever, and silently downgrades the recorded price to the order's
   * limit price. That is worth an error line. A 429 or a 5xx fixes itself and is
   * worth at most a warning. Both are logged at most once an hour per key so a
   * busy account cannot drown the signal.
   *
   * The key itself is NEVER logged — only a short non-reversible fingerprint,
   * enough to tell two accounts apart. `reason` goes through `safeStringify`
   * and is truncated because Kraken SDK error objects can carry live
   * credentials, and a log line must never be the thing that leaks one.
   */
  private logAvgFillPriceFailure(reason: string) {
    const permanent = isKrakenPermanentAuthFailure(reason)
    const fingerprint = createHash('sha256')
      .update(this.key ?? '')
      .digest('hex')
      .slice(0, 8)
    const bucket = `${fingerprint}:${permanent ? 'auth' : 'transient'}`
    const now = Date.now()
    const last = krakenAvgPriceFailureLog.get(bucket)
    if (last && now - last < KRAKEN_AVG_PRICE_LOG_TTL) return
    krakenAvgPriceFailureLog.set(bucket, now)

    const detail = safeStringify(reason).slice(0, 300)
    const message =
      `Kraken avg fill price unavailable for key ${fingerprint} ` +
      `(${permanent ? 'PERMANENT — orders for this key are being recorded at their LIMIT price' : 'transient'}): ${detail}`
    if (permanent) {
      Logger.error(message)
    } else {
      Logger.warn(message)
    }
  }

  /**
   * Convert Kraken futures position to common format
   */
  private futures_convertPosition(pos: {
    symbol: string
    side: 'long' | 'short'
    size: number
    price: number
    unrealizedFunding: number | null
    /**
     * The account's leverage preference for this contract: an isolated
     * maxLeverage, `'cross'` when no isolated preference is set, or
     * `undefined` when the preference could not be read.
     */
    leveragePref?: KrakenLeveragePref
  }): PositionInfo {
    // Kraken's position payload carries no leverage — it is a per-contract
    // account preference. This used to be hardcoded `'1'`, and the bot
    // engine's pre-start check compared it with the bot's own leverage, so
    // every Kraken futures bot above 1x refused to start into an existing
    // position ("Leverage in active position is 1, but in settings 2"). Report
    // the real isolated preference; `'0'` means "not an isolated leverage"
    // (cross / dynamic, or unknown), which the consumer must not compare.
    const isolated = typeof pos.leveragePref === 'number'
    return {
      symbol: pos.symbol,
      initialMargin: '0',
      maintMargin: '0',
      unrealizedProfit: pos.unrealizedFunding?.toString() || '0',
      positionInitialMargin: '0',
      openOrderInitialMargin: '0',
      leverage: isolated ? `${pos.leveragePref}` : '0',
      isolated,
      entryPrice: pos.price.toString(),
      maxNotional: '0',
      positionSide: pos.side === 'long' ? 'LONG' : 'SHORT',
      positionAmt: pos.size.toString(),
      notional: '0',
      isolatedWallet: '0',
      updateTime: Date.now(),
      bidNotional: '0',
      askNotional: '0',
    }
  }

  // ===========================
  // Account & Authentication
  // ===========================

  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<string | number>> {
    // Kraken doesn't have a direct UID endpoint, return -1
    return this.returnGood<number>(timeProfile)(-1)
  }

  async getAffiliate(
    _uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    // Not supported by Kraken API
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async getRebateOverview(
    _timestamp: number,
  ): Promise<BaseReturn<RebateOverview>> {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  async getRebateRecords(
    _timestamp: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>> {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  /**
   * Kraken Futures pools every collateral currency into one flex account, so a
   * wallet holding only EUR can still margin a USD-quoted perpetual. Report the
   * venue's own `availableMargin` (USD) so order sizing stops reading the
   * absent USD *quantity* as "no funds". Spot and the non-flex account types
   * keep the base behaviour (`null` = use the quote-asset balance).
   */
  async getMarginAvailableUsd(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number | null>> {
    if (!this.usdm || !this.derivativesClient) {
      return this.returnGood<number | null>(timeProfile, [])(null)
    }

    timeProfile =
      (await this.checkLimits('getAccountBalance', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .getAccounts()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.result !== 'success' || !result.accounts) {
          throw new Error(
            `Failed to get margin. Result: ${result.result || 'undefined'}`,
          )
        }
        const flex = result.accounts.flex
        // Only the pooled account type has a cross-collateral figure worth
        // reporting; anything else must fall back to the quote balance.
        const available =
          flex && typeof flex.availableMargin === 'number'
            ? flex.availableMargin
            : null
        return this.returnGood<number | null>(
          timeProfile,
          [],
        )(
          available !== null && isFinite(available) && available >= 0
            ? available
            : null,
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.getMarginAvailableUsd,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Executions on this account, newest first. Read-only.
   *
   * The point of this endpoint is reconciliation: every fill carries the client
   * order id WE supplied, so a fill reported against one of our ids for an order
   * we recorded as cancelled-and-unfilled is a fill we lost — provable per fill,
   * with no inference about margin or position size. Trades the user placed by
   * hand carry no client order id of ours and drop out on their own.
   *
   * Rate-limited as a history call (`getTradesHistory`), which is the heavy
   * bucket — this walks account history and must not compete with trading calls
   * for the account's budget. Futures only: Kraken's spot fills live behind a
   * different endpoint and are not needed here.
   *
   * ⚠️ This endpoint is refused for SOME accounts, not all — do not read a
   * failure here as "Kraken never lets us read fills".
   *
   * A 2026-08-08 measurement saw `/derivatives/api/v3/fills` answer
   * `{result:'error', error:'authenticationError'}` (HTTP 200) on two unrelated
   * production accounts, and concluded the keys our users grant simply lack the
   * query-trades permission. **That conclusion was too strong and is wrong as a
   * generalisation.** `futures_getAvgFillPrice` calls the same endpoint on the
   * same credentials from inside this connector, and recorded order history from
   * before that measurement carries — on many accounts, over a long window — an
   * average fill price that ONLY that call can produce. So the endpoint does
   * authenticate, routinely, for the large majority of accounts. The two
   * failures were a sample, not the population.
   *
   * What remains unexplained is why those two refused; a granular per-key
   * permission is still the most likely reason, it just is not universal. An
   * executions-history (`api/history/v3/executions`) fallback was written and
   * removed again: it never once executed, so it was unverified code implying a
   * working path nobody had proven. Do not re-add one without first proving that
   * endpoint authenticates.
   */
  async getAccountFills(
    sinceMs?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AccountFill[]>> {
    if (!this.usdm) {
      return this.returnGood<AccountFill[]>(timeProfile)([])
    }
    if (!this.derivativesClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTradesHistory', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .getFills(
        sinceMs ? { lastFillTime: new Date(sinceMs).toISOString() } : undefined,
      )
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.result !== 'success' || !result.fills) {
          throw new Error(
            `Failed to get fills. Result: ${result.result || 'undefined'}`,
          )
        }
        const fills: AccountFill[] = []
        for (const f of result.fills) {
          fills.push({
            fillId: `${f.fill_id}`,
            orderId: `${f.order_id}`,
            clientOrderId: f.cliOrdId ?? '',
            symbol: await this.normalizeSymbol(f.symbol),
            side: f.side === 'sell' ? 'SELL' : 'BUY',
            price: `${f.price}`,
            quantity: `${f.size}`,
            timestamp: +new Date(f.fillTime),
            fillType: f.fillType,
          })
        }
        return this.returnGood<AccountFill[]>(timeProfile)(fills)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAccountFills,
          sinceMs,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getAccountBalance', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getAccounts()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.result !== 'success' || !result.accounts) {
            const errorDetails = {
              result: result.result,
              hasAccounts: !!result.accounts,
              serverTime: result.serverTime,
              fullResponse: result,
            }
            throw new Error(
              `Failed to get balance. Details: ${safeStringify(errorDetails)}`,
            )
          }

          const balances: FreeAsset = []
          const accounts = result.accounts

          // Handle flex account
          if (accounts.flex) {
            for (const [currency, summary] of Object.entries(
              accounts.flex.currencies,
            )) {
              balances.push({
                asset: currency,
                free: summary.quantity || 0,
                locked: 0,
              })
            }
          }

          // Handle margin accounts
          /* for (const [key, account] of Object.entries(accounts)) {
            if (
              key !== 'flex' &&
              key !== 'cash' &&
              account &&
              'type' in account &&
              account.type === 'marginAccount'
            ) {
              const marginAccount = account as any
              balances.push({
                asset: this.symbolMapper.getActualAssetName(
                  marginAccount.currency || 'UNKNOWN',
                ),
                free: parseFloat(marginAccount.auxiliary?.af || '0'),
                locked: parseFloat(marginAccount.marginRequirements?.im || '0'),
              })
            }
          } */

          return this.returnGood<FreeAsset>(timeProfile)(balances)
        })
        .catch(
          this.handleKrakenErrors(
            this.getBalance,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAccountBalance', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getAccountBalance()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result) {
          throw new Error('Failed to get balance')
        }

        const balances: FreeAsset = []
        for (const [asset, balance] of Object.entries(result.result)) {
          balances.push({
            asset: this.symbolMapper.getActualAssetName(asset),
            free: parseFloat(balance as string),
            locked: 0, // Kraken's basic balance doesn't separate locked
          })
        }

        return this.returnGood<FreeAsset>(timeProfile)(balances)
      })
      .catch(
        this.handleKrakenErrors(
          this.getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Check the key can mint a WS auth token (spot "WebSocket interface"
   * permission). A REST-only key passes every other verify probe but leaves
   * the user-stream connector unable to subscribe (`EGeneral:Permission
   * denied` on `GetWebSocketsToken`), so the user silently loses realtime
   * order updates and falls back to delayed reconcile-sweep fills — surface
   * it at verify time instead. Spot-only: Kraken Futures WS auth signs a
   * challenge with the key itself and has no separate permission. Only a
   * definite permission rejection reports `ok:false`; transient failures
   * (rate limit, 5xx) never block verification.
   */
  async verifyWebsocketPermission(): Promise<{ ok: boolean; reason: string }> {
    if (!this.spotClient) {
      return { ok: true, reason: '' }
    }
    const isPermissionDenied = (s: string) =>
      /EGeneral\s*:?\s*Permission denied/i.test(s)
    try {
      const res = await this.spotClient.getWebSocketsToken()
      const errors: string[] = Array.isArray((res as any)?.error)
        ? (res as any).error
        : []
      if (errors.some(isPermissionDenied)) {
        return { ok: false, reason: errors.join(',') }
      }
      return { ok: true, reason: '' }
    } catch (e: any) {
      const msg = e?.body?.error?.join?.(',') || e?.message || `${e}`
      if (isPermissionDenied(msg)) {
        return { ok: false, reason: msg }
      }
      return { ok: true, reason: '' }
    }
  }

  /**
   * Kraken publishes nothing that describes a key's own permissions, so it is
   * the only venue we have to probe. `POST /0/private/WithdrawMethods` requires
   * BOTH "Funds permissions - Query" and "Funds permissions - Withdraw", and
   * only lists methods — it moves no money.
   *
   * Because two permissions gate it, a bare denial is ambiguous: it could mean
   * "no withdrawal" or "no funds-query at all". So we first confirm funds-query
   * works via Balance; only then does a denial prove the key cannot withdraw.
   * Anything else is `unknown`. Kraken exposes no IP-binding field.
   */
  override async getKeyPermissions(): Promise<KeyPermissions> {
    if (!this.spotClient) {
      return unknownPermissions(
        'Kraken Futures keys do not expose withdrawal permission',
      )
    }
    const errorsOf = (res: unknown): string[] =>
      Array.isArray((res as any)?.error) ? (res as any).error : []
    let queryFundsOk = false
    try {
      const balance = await this.spotClient.getAccountBalance()
      queryFundsOk = !errorsOf(balance).length
    } catch {
      queryFundsOk = false
    }
    try {
      const res = await this.spotClient.getWithdrawalMethods()
      const errors = errorsOf(res)
      if (!errors.length) {
        return krakenWithdrawState({ queryFundsOk, withdrawMethodsOk: true })
      }
      return krakenWithdrawState({
        queryFundsOk,
        withdrawMethodsOk: false,
        error: errors.join(','),
      })
    } catch (e: any) {
      return krakenWithdrawState({
        queryFundsOk,
        withdrawMethodsOk: false,
        error: e?.body?.error?.join?.(',') || e?.message || `${e}`,
      })
    }
  }

  // ===========================
  // Orders
  // ===========================

  async openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: OrderTypeT
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
      leverage?: number
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const {
      symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type = 'LIMIT',
      reduceOnly,
    } = order

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('submitOrder', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      // Map order type to Kraken format
      const krakenOrderType =
        type === 'LIMIT'
          ? 'lmt'
          : type === 'MARKET'
            ? 'mkt'
            : (type as string).toLowerCase()

      const krakenSymbol = await this.toKrakenSymbol(symbol)

      const orderParams = {
        orderType: krakenOrderType as 'lmt' | 'mkt',
        symbol: krakenSymbol,
        side: side.toLowerCase() as 'buy' | 'sell',
        size: quantity,
        limitPrice: type === 'LIMIT' ? price : undefined,
        cliOrdId: newClientOrderId,
        reduceOnly,
      }

      return this.derivativesClient
        .submitOrder(orderParams)
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.result !== 'success' || !result.sendStatus) {
            throw new Error(
              `Failed to create order. Result: ${result.result || 'undefined'}, SendStatus: ${!!result.sendStatus}`,
            )
          }
          if (result.sendStatus.orderEvents?.length === 0) {
            throw new Error(
              result.sendStatus.status ||
                'Failed to create order, no order events returned',
            )
          }
          // Kraken states what this order actually executed at, right here, in
          // the submit response — and this used to be thrown away in favour of
          // a re-fetch whose only price source is `getOrderStatus` (limit price
          // only) plus `futures_getAvgFillPrice`. When that lookup came back
          // empty the fill was recorded at the order's LIMIT price, which for a
          // MARKET order means "the price we asked for", erasing all slippage.
          // These events cost nothing, need no extra permission, and are exact.
          const placed = this.futures_readExecutionPrice(
            result.sendStatus.orderEvents,
          )
          await sleep(500)
          const fetched = await this.getOrder(
            { symbol, newClientOrderId: orderParams.cliOrdId || '' },
            timeProfile,
          )
          // Only fill a gap — never overwrite a price the fills endpoint
          // resolved, and never invent a quantity: if the re-fetch says nothing
          // executed, believe it and leave the order alone.
          if (
            placed.avgPrice &&
            fetched.status === StatusEnum.ok &&
            fetched.data &&
            +fetched.data.executedQty > 0 &&
            !+(fetched.data.avgPrice || 0)
          ) {
            const executedQty = +fetched.data.executedQty
            fetched.data.avgPrice = `${placed.avgPrice}`
            fetched.data.price = `${placed.avgPrice}`
            fetched.data.cummulativeQuoteQty = `${placed.avgPrice * executedQty}`
          }
          return fetched
        })
        .catch(
          this.handleKrakenErrors(
            this.openOrder,
            order,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('submitOrder', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .submitOrder({
        ordertype: type.toLowerCase() as 'limit' | 'market',
        type: side.toLowerCase() as 'buy' | 'sell',
        pair: await this.toKrakenSymbol(symbol),
        volume: quantity.toString(),
        price: type === 'LIMIT' ? price.toString() : undefined,
        userref: newClientOrderId
          ? parseInt(newClientOrderId.substring(0, 8), 16)
          : undefined,
        ...this.xstockParams(symbol),
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to create order')
        }

        const orderIds = result.result.txid || []

        await sleep(500)
        // Re-fetch by the Kraken txid via QueryOrders — the ONLY unambiguous
        // lookup available. getOrder() resolves spot orders by userref =
        // parseInt(clientOrderId.substring(0,8), 16); every Gainium client id
        // starts with a shared prefix ("D-…", "GRID-…"), so parseInt stops at
        // the first non-hex char and MANY orders collide on the same userref
        // (e.g. all "D-*" ids → 13). With ≥2 such orders on the account,
        // getOrder() returned a DIFFERENT order's data — an instantly-filled
        // market Add came back as the account's resting limit order (open/
        // vol_exec 0), so the fill was silently never registered on the deal
        // (community thread 4890). QueryOrders also covers the closed-orders
        // consistency lag for instantly-filled market orders.
        const txid = orderIds?.[0]
        if (txid) {
          // QueryOrders can briefly lag right after submit, so a single miss
          // does not mean the order failed — we hold its txid and the submit
          // succeeded. Retry the exact lookup a few times before ever touching
          // the userref path, which collides (all client ids → one userref) and
          // would report a just-placed order as "not found" (false negative).
          for (let attempt = 0; attempt < 3; attempt++) {
            const fetched = await this.getSpotOrderByTxid(
              txid,
              symbol,
              newClientOrderId || txid,
              timeProfile,
            )
            if (fetched) {
              return fetched
            }
            await sleep(500)
          }
        }
        // Last resort: prefer the Kraken txid so getOrder() re-routes through
        // the exact isKrakenSpotTxid() path; only fall back to the ambiguous
        // client-order-id/userref lookup when no txid was returned at all.
        return await this.getOrder(
          { symbol, newClientOrderId: txid || newClientOrderId || '' },
          timeProfile,
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * A Kraken spot order txid: 'O' + three dash-separated uppercase
   * alphanumeric groups (e.g. OSVJII-BHJHI-XTNXN4). Gainium client order
   * ids never match this (they start with D-/GRID-/GA- and contain
   * lowercase), so this cleanly distinguishes "resolve by txid" from
   * "resolve by userref" when main-app hands us either.
   */
  private isKrakenSpotTxid(id: string): boolean {
    return /^O[A-Z0-9]{5}-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/.test(id)
  }

  /**
   * Kraken requires `asset_class: 'tokenized_asset'` on every public/private
   * per-pair call for tokenized-equity ("xStocks") pairs — without it Kraken
   * replies "Unknown asset pair". Returns the param object to spread into the
   * Kraken call for a tokenized pair, or `{}` for ordinary crypto spot pairs
   * (which must NOT carry the param). Spot-only; the futures path never sets
   * tokenized symbols. NOTE: AssetPairs uses `aclass`, everything else uses
   * `asset_class` — this helper is for the `asset_class` callers.
   */
  private xstockParams(ourSymbol: string): {
    asset_class?: 'tokenized_asset'
  } {
    return this.symbolMapper.isTokenized(ourSymbol)
      ? { asset_class: 'tokenized_asset' }
      : {}
  }

  /**
   * Resolve a spot order by its Kraken txid via QueryOrders. Exact —
   * immune to the shared-userref collision in getOrder() — and works
   * regardless of open/closed state. Returns null when the txid can't
   * be resolved (caller falls back to the legacy userref lookup).
   */
  private async getSpotOrderByTxid(
    txid: string,
    symbol: string,
    clientOrderId: string,
    timeProfile: TimeProfile,
  ): Promise<BaseReturn<CommonOrder> | null> {
    if (!this.spotClient) {
      return null
    }
    try {
      timeProfile =
        (await this.checkLimits('getOrders', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const result = await this.spotClient.getOrders({ txid })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (!result.result || result.error?.length) {
        return null
      }
      const orderData = result.result[txid]
      if (!orderData) {
        return null
      }
      return this.returnGood<CommonOrder>(timeProfile)(
        this.convertOrder({
          orderId: txid,
          symbol: await this.normalizeSymbol(orderData.descr?.pair || symbol),
          clientOrderId,
          // `price` is the average executed price — the real fill price for
          // market orders, whose descr.price is '0'. Fall back to the limit
          // price for unfilled orders.
          price:
            +(orderData.price || 0) > 0
              ? orderData.price
              : orderData.descr?.price || '0',
          origQty: orderData.vol || '0',
          executedQty: orderData.vol_exec || '0',
          status: orderData.status || 'NEW',
          type: orderData.descr?.ordertype || 'limit',
          side: orderData.descr?.type?.toUpperCase() || 'BUY',
        }),
      )
    } catch {
      // Any failure here is non-fatal — caller falls back to getOrder().
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      return null
    }
  }

  async getOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getOrders', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      // Did the live open-orders view actually ANSWER about this id, as
      // opposed to the call itself failing? Only the former is evidence the
      // order is absent, and the staleness check in the history fallback below
      // is allowed to act on evidence only — a request that did not come back
      // `success` says nothing about the order and must not be rendered as a
      // definitive negative (the mistake `isDefinitiveOrderNotFound` exists to
      // prevent, with money attached).
      let statusViewAnswered = false

      return this.derivativesClient
        .getOrderStatus({
          cliOrdIds: [newClientOrderId],
        })
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (
            result.result !== 'success' ||
            !result.orders ||
            result.orders.length === 0
          ) {
            statusViewAnswered =
              result.result === 'success' && Array.isArray(result.orders)
            throw new Error('Order not found in active orders')
          }

          statusViewAnswered = true

          const orderInfo = result.orders[0]

          // An element without a status Kraken documents for a real order is
          // "we do not know this id", not "it is resting". Treat it exactly
          // like an empty `orders` array and fall through to the history
          // lookup below. See `futures_isKnownOrderStatus` (bug #366).
          if (
            !orderInfo?.order ||
            !this.futures_isKnownOrderStatus(orderInfo.status)
          ) {
            throw new Error('Order not found in active orders')
          }

          const order = orderInfo.order
          const avgFillPrice =
            (order.filled || 0) > 0
              ? await this.futures_getAvgFillPrice(
                  order.orderId,
                  newClientOrderId,
                )
              : null
          return this.returnGood<CommonOrder>(timeProfile)(
            this.futures_convertOrder({
              orderId: order.orderId || '',
              symbol: await this.normalizeSymbol(order.symbol || symbol),
              clientOrderId: newClientOrderId,
              price: order.limitPrice,
              avgPrice: avgFillPrice ?? undefined,
              origQty: order.quantity,
              executedQty: order.filled,
              status: this.futures_deriveOrderStatus(
                orderInfo.status || 'NEW',
                order.filled || 0,
                order.quantity || 0,
              ),
              type: order.type || 'lmt',
              side: order.side || 'buy',
            }),
          )
        })
        .catch(async (error) => {
          // If order not found in active orders, try order events history
          // getOrderStatus only returns open orders or orders filled/cancelled in last 5 seconds
          if (error.message?.includes('Order not found')) {
            try {
              timeProfile = this.startProfilerTime(timeProfile, 'exchange')
              const eventsResult = await this.derivativesClient!.getOrderEvents(
                {
                  tradeable: await this.toKrakenSymbol(symbol),
                },
              )

              timeProfile = this.endProfilerTime(timeProfile, 'exchange')
              if (!eventsResult.elements) {
                throw new Error('Failed to get order events')
              }

              // Find the order by client order ID in events
              // Events can be: OrderPlaced, OrderRejected, OrderCancelled
              const orderEvent = eventsResult.elements.find((e: any) => {
                const order =
                  e.event?.OrderPlaced?.order ||
                  e.event?.OrderRejected?.order ||
                  e.event?.OrderCancelled?.order ||
                  null
                return order?.clientId === newClientOrderId
              })

              if (!orderEvent || !orderEvent.event) {
                throw new Error('Order not found in history')
              }

              // Extract order from event
              const order =
                orderEvent.event?.OrderPlaced?.order ||
                orderEvent.event?.OrderRejected?.order ||
                orderEvent.event?.OrderCancelled?.order ||
                null

              if (!order) {
                throw new Error('Order data not found in event')
              }

              // Determine status based on event type and filled amount
              let status = 'NEW'
              if (
                orderEvent.event.OrderRejected ||
                orderEvent.event.OrderCancelled
              ) {
                status = 'CANCELED'
              } else if (orderEvent.event.OrderPlaced) {
                const filled = parseFloat(order.filled || '0')
                const quantity = parseFloat(order.quantity || '0')

                if (filled > 0) {
                  status = filled >= quantity ? 'FILLED' : 'PARTIALLY_FILLED'
                } else if (
                  statusViewAnswered &&
                  +new Date() - (orderEvent.timestamp || 0) >
                    KRAKEN_ORDER_PLACED_PROPAGATION_MS
                ) {
                  // Bug #408. `OrderPlaced` records that Kraken once accepted
                  // this order — it is not a snapshot of it. We only get here
                  // because `getOrderStatus`, the authoritative live view, has
                  // already said it does not know the id, so an old placement
                  // with nothing filled is the record of how the phantom was
                  // born, not evidence it is resting. Reporting NEW is what
                  // survived the #375 fix: main-app's `_handleUnknownOrder`
                  // treats a successful read as a resolution and clears its
                  // `canceledMap` counter, so the 5-attempt force-cancel that
                  // exists for exactly this case is never reached and the row
                  // sits at NEW forever (7 cancels/18h on `GRID-RO-9BQqa08…`).
                  //
                  // Surfaced as a definitive not-found so `main-app`'s
                  // `isDefinitiveOrderNotFound` matches and the counter can
                  // finally saturate. Deliberately narrow: fills above are real
                  // evidence at any age, a terminal cancel/reject is handled
                  // above, and only a placement younger than the propagation
                  // floor is still trusted — see that constant.
                  throw new Error('Order not found in history')
                }
              }

              const avgFillPrice =
                parseFloat(order.filled || '0') > 0
                  ? await this.futures_getAvgFillPrice(
                      order.uid,
                      newClientOrderId,
                    )
                  : null
              return this.returnGood<CommonOrder>(timeProfile)(
                this.futures_convertOrder({
                  orderId: order.uid || '',
                  symbol: await this.normalizeSymbol(order.tradeable || symbol),
                  clientOrderId: newClientOrderId,
                  price: parseFloat(order.limitPrice || '0'),
                  avgPrice: avgFillPrice ?? undefined,
                  origQty: parseFloat(order.quantity || '0'),
                  executedQty: parseFloat(order.filled || '0'),
                  status: status,
                  type: order.orderType?.toLowerCase() || 'lmt',
                  side: order.direction?.toLowerCase() || 'buy',
                }),
              )
            } catch (historyError) {
              // If both methods fail, return original error
              return this.handleKrakenErrors(
                this.getOrder,
                { symbol, newClientOrderId },
                this.endProfilerTime(timeProfile, 'exchange'),
              )(historyError)
            }
          }

          // For other errors, use standard error handling
          return this.handleKrakenErrors(
            this.getOrder,
            { symbol, newClientOrderId },
            this.endProfilerTime(timeProfile, 'exchange'),
          )(error)
        })
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    // When main-app resolves a spot order it translates our client id to the
    // stored Kraken txid first (see the kraken branch of bot getOrder), so a
    // txid is what actually arrives here for reconcile / order-status polling.
    // Resolve it exactly via QueryOrders — the userref lookup below can't
    // (parseInt('O…',16)=NaN) and, even for real client ids, collides because
    // every Gainium id shares a prefix. This is what repairs missed-fill
    // reconcile for resting Kraken spot orders (forum #4890).
    if (this.isKrakenSpotTxid(newClientOrderId)) {
      const byTxid = await this.getSpotOrderByTxid(
        newClientOrderId,
        symbol,
        newClientOrderId,
        timeProfile,
      )
      if (byTxid) {
        return byTxid
      }
    }

    timeProfile =
      (await this.checkLimits('getOrders', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    // Kraken doesn't support querying by client order ID directly for spot
    // We need to use userref if it was set, or fetch all open orders
    return this.spotClient
      .getOpenOrders()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get orders')
        }

        // Find order by client order ID (userref)
        // Convert client order ID to userref (same way as in submitOrder)
        const userref = newClientOrderId
          ? parseInt(newClientOrderId.substring(0, 8), 16)
          : undefined

        const orders = result.result.open || {}
        for (const [orderId, orderData] of Object.entries(orders)) {
          if (orderData.userref?.toString() === userref?.toString()) {
            return this.returnGood<CommonOrder>(timeProfile)(
              this.convertOrder({
                orderId,
                symbol: await this.normalizeSymbol(
                  orderData.descr?.pair || symbol,
                ),
                clientOrderId: newClientOrderId,
                price: orderData.descr?.price || '0',
                origQty: orderData.vol || '0',
                executedQty: orderData.vol_exec || '0',
                status: orderData.status || 'NEW',
                type: orderData.descr?.ordertype || 'limit',
                side: orderData.descr?.type?.toUpperCase() || 'BUY',
              }),
            )
          }
        }

        throw new Error('Order not found in open orders')
      })
      .catch(async (error) => {
        // If order not found in open orders, try closed orders history
        if (error.message?.includes('Order not found')) {
          try {
            timeProfile = this.startProfilerTime(timeProfile, 'exchange')

            // Convert client order ID to userref (same way as in submitOrder)
            const userref = newClientOrderId
              ? parseInt(newClientOrderId.substring(0, 8), 16)
              : undefined

            const closedResult = await this.spotClient!.getClosedOrders({
              userref,
            })

            timeProfile = this.endProfilerTime(timeProfile, 'exchange')

            if (!closedResult.result || closedResult.error?.length) {
              throw new Error(
                closedResult.error?.[0] || 'Failed to get closed orders',
              )
            }

            // Find order by client order ID (userref) in closed orders
            const closedOrders = closedResult.result.closed || {}
            for (const [orderId, orderData] of Object.entries(closedOrders)) {
              if (orderData.userref?.toString() === userref?.toString()) {
                return this.returnGood<CommonOrder>(timeProfile)(
                  this.convertOrder({
                    orderId,
                    symbol: await this.normalizeSymbol(
                      orderData.descr?.pair || symbol,
                    ),
                    clientOrderId: newClientOrderId,
                    // avg executed price when filled (descr.price is '0'
                    // for market orders), limit price otherwise
                    price:
                      +(orderData.price || 0) > 0
                        ? orderData.price
                        : orderData.descr?.price || '0',
                    origQty: orderData.vol || '0',
                    executedQty: orderData.vol_exec || '0',
                    status: orderData.status || 'FILLED',
                    type: orderData.descr?.ordertype || 'limit',
                    side: orderData.descr?.type?.toUpperCase() || 'BUY',
                  }),
                )
              }
            }

            throw new Error('Order not found in history')
          } catch (historyError) {
            // If both methods fail, return original error
            return this.handleKrakenErrors(
              this.getOrder,
              { symbol, newClientOrderId },
              this.endProfilerTime(timeProfile, 'exchange'),
            )(error)
          }
        }

        // For other errors, use standard error handling
        return this.handleKrakenErrors(
          this.getOrder,
          { symbol, newClientOrderId },
          this.endProfilerTime(timeProfile, 'exchange'),
        )(error)
      })
  }

  async cancelOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId?: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!newClientOrderId) {
      return this.returnBad(timeProfile)(new Error('Client order ID required'))
    }

    // First get the order to find its exchange ID
    const orderResult = await this.getOrder(
      { symbol, newClientOrderId },
      timeProfile,
    )

    if (orderResult.status !== StatusEnum.ok) {
      return orderResult as BaseReturn<CommonOrder>
    }

    const orderId = orderResult.data.orderId

    return this.cancelOrderByOrderIdAndSymbol(
      { symbol, orderId: orderId.toString() },
      timeProfile,
    )
  }

  async cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const { symbol, orderId } = order

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('cancelOrder', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .cancelOrder({
          order_id: orderId,
        })
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success') {
            throw new Error(
              `Failed to cancel order. Result: ${result.result || 'undefined'}`,
            )
          }

          const outcome = this.futures_readCancelOutcome(result.cancelStatus)

          if (outcome.unknown) {
            // Hand the caller its unknown-order path, which re-fetches and
            // reconciles, rather than asserting a cancel we did not observe.
            throw new Error(`Unknown order ${orderId}`)
          }

          // Only reach for the account fills when the events carried no price.
          const avgPrice =
            outcome.avgPrice ||
            (outcome.executedQty > 0
              ? ((await this.futures_getAvgFillPrice(
                  orderId,
                  outcome.clientOrderId || undefined,
                )) ?? undefined)
              : undefined)

          return this.returnGood<CommonOrder>(timeProfile)(
            this.futures_convertOrder({
              orderId,
              symbol: outcome.symbol
                ? await this.normalizeSymbol(outcome.symbol)
                : symbol,
              clientOrderId: outcome.clientOrderId,
              price: outcome.limitPrice,
              avgPrice,
              origQty: outcome.origQty,
              executedQty: outcome.executedQty,
              status: this.futures_deriveOrderStatus(
                outcome.rawStatus,
                outcome.executedQty,
                outcome.origQty,
              ),
              type: outcome.type,
              side: outcome.side,
            }),
          )
        })
        .catch(
          this.handleKrakenErrors(
            this.cancelOrderByOrderIdAndSymbol,
            order,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('cancelOrder', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .cancelOrder({
        txid: orderId,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to cancel order')
        }

        return this.returnGood<CommonOrder>(timeProfile)(
          this.convertOrder({
            orderId,
            symbol,
            clientOrderId: '',
            price: '0',
            origQty: '0',
            executedQty: '0',
            status: 'CANCELED',
            type: 'LIMIT',
            side: 'BUY',
          }),
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol: string | undefined,
    returnOrders: true,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders: boolean = false,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number> | BaseReturn<CommonOrder[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getOpenOrders', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getOpenOrders()
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.openOrders) {
            const errorDetails = {
              result: result.result,
              hasOpenOrders: !!result.openOrders,
              serverTime: result.serverTime,
              fullResponse: result,
            }
            throw new Error(
              `Failed to get open orders. Details: ${safeStringify(errorDetails)}`,
            )
          }

          // No symbol => return ALL open orders (matches the connector-family
          // contract, e.g. Binance). Only map+filter when a symbol is given;
          // calling toKrakenSymbol(undefined) used to crash in the mapper.
          const krakenSymbol = symbol
            ? await this.toKrakenSymbol(symbol)
            : undefined
          const filteredOrders = krakenSymbol
            ? result.openOrders.filter((o) => o.symbol === krakenSymbol)
            : result.openOrders

          if (!returnOrders) {
            return this.returnGood<number>(timeProfile)(filteredOrders.length)
          }

          const commonOrders: CommonOrder[] = []
          for (const order of filteredOrders) {
            const origQty = order.filledSize + (order.unfilledSize || 0)
            commonOrders.push(
              this.futures_convertOrder({
                orderId: order.order_id || '',
                symbol: await this.normalizeSymbol(
                  order.symbol || krakenSymbol || '',
                ),
                clientOrderId: order.cliOrdId || '',
                price: order.limitPrice,
                origQty,
                executedQty: order.filledSize,
                status: this.futures_deriveOrderStatus(
                  order.status || 'NEW',
                  order.filledSize,
                  origQty,
                ),
                type: order.orderType || 'lmt',
                side: order.side || 'buy',
              }),
            )
          }

          return this.returnGood<CommonOrder[]>(timeProfile)(commonOrders)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllOpenOrders,
            symbol,
            returnOrders,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getOpenOrders', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getOpenOrders()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get open orders')
        }

        const orders = result.result.open || {}
        // No symbol => return ALL open orders (connector-family contract).
        const krakenSymbol = symbol
          ? await this.toKrakenSymbol(symbol)
          : undefined
        const filteredOrders = krakenSymbol
          ? Object.entries(orders).filter(
              ([_, order]) => order.descr?.pair === krakenSymbol,
            )
          : Object.entries(orders)

        if (!returnOrders) {
          return this.returnGood<number>(timeProfile)(filteredOrders.length)
        }

        const commonOrders: CommonOrder[] = []
        for (const [orderId, order] of filteredOrders) {
          commonOrders.push(
            this.convertOrder({
              orderId,
              symbol: await this.normalizeSymbol(
                order.descr?.pair || symbol || '',
              ),
              clientOrderId: order.userref?.toString() || '',
              price: order.descr?.price || '0',
              origQty: order.vol || '0',
              executedQty: order.vol_exec || '0',
              status: order.status || 'NEW',
              type: order.descr?.ordertype || 'limit',
              side: order.descr?.type?.toUpperCase() || 'BUY',
            }),
          )
        }

        return this.returnGood<CommonOrder[]>(timeProfile)(commonOrders)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Market Data
  // ===========================

  async latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getTicker', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTicker({ symbol: await this.toKrakenSymbol(symbol) })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.ticker) {
            throw new Error(
              `Failed to get ticker. Result: ${result.result || 'undefined'}, Ticker: ${!!result.ticker}`,
            )
          }

          const price = result.ticker.last || 0
          return this.returnGood<number>(timeProfile)(price)
        })
        .catch(
          this.handleKrakenErrors(
            this.latestPrice,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTicker', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTicker({
        pair: await this.toKrakenSymbol(symbol),
        ...this.xstockParams(symbol),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get ticker')
        }

        const tickers = result.result
        const ticker = Object.values(tickers)[0]
        const price = parseFloat(ticker?.c?.[0] || '0')

        return this.returnGood<number>(timeProfile)(price)
      })
      .catch(
        this.handleKrakenErrors(
          this.latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getTickers', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTickers()
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.tickers) {
            throw new Error(
              `Failed to get tickers. Result: ${result.result || 'undefined'}, Tickers: ${!!result.tickers}`,
            )
          }
          const prices: AllPricesResponse[] = []
          for (const ticker of result.tickers.filter(
            (t) =>
              t.tag === 'perpetual' &&
              (this.usdm
                ? t.symbol.startsWith('PF')
                : t.symbol.startsWith('PI')),
          )) {
            prices.push({
              pair: await this.normalizeSymbol(ticker.symbol || ''),
              price: ticker.last || 0,
            })
          }

          return this.returnGood<AllPricesResponse[]>(timeProfile)(prices)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTicker', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTicker()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get tickers')
        }

        const prices: AllPricesResponse[] = []
        for (const [pair, ticker] of Object.entries(result.result)) {
          prices.push({
            pair: await this.normalizeSymbol(pair),
            price: parseFloat(ticker.c?.[0] || '0'),
          })
        }

        // xStocks aren't in the default Ticker, so deals on Kraken stock
        // pairs had no live/last price → the UI showed "Price unavailable"
        // (and P&L/TP couldn't compute). Fetch the tokenized tickers too
        // (Kraken returns the last price even out of hours). Filter to
        // known tokenized symbols so the duplicate `…SPV…` keys drop out.
        // Additive + flag-gated; never touches crypto prices.
        if (
          process.env.KRAKEN_XSTOCKS_ENABLED !== 'false' &&
          process.env.KRAKEN_ENV !== 'demo'
        ) {
          try {
            const tok = await this.spotClient!.getTicker({
              asset_class: 'tokenized_asset',
            } as Parameters<typeof this.spotClient.getTicker>[0])
            if (tok.result && !tok.error?.length) {
              for (const [pair, ticker] of Object.entries(tok.result)) {
                const ourSymbol = await this.normalizeSymbol(pair)
                if (this.symbolMapper.isTokenized(ourSymbol)) {
                  prices.push({
                    pair: ourSymbol,
                    price: parseFloat(ticker.c?.[0] || '0'),
                  })
                }
              }
            }
          } catch (error) {
            Logger.warn(
              `Failed to get Kraken tokenized prices: ${error.message}`,
            )
          }
        }

        return this.returnGood<AllPricesResponse[]>(timeProfile)(prices)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<ExchangeInfo>> {
    const full = await this.getAllExchangeInfo(timeProfile)

    if (full.status !== StatusEnum.ok) {
      return full
    }

    const info = full.data.find((e) => e.pair === symbol)

    if (!info) {
      return this.returnBad(timeProfile)(new Error('Symbol not found'))
    }

    return this.returnGood<ExchangeInfo>(timeProfile)(info)
  }

  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getInstruments', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      // Kraken USDM linear futures use PF prefix
      const symbolPrefix = 'PF'

      return this.derivativesClient
        .getInstruments()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.instruments) {
            throw new Error(
              `Failed to get all instruments. Result: ${result.result || 'undefined'}, Instruments: ${!!result.instruments}`,
            )
          }

          const infos: (ExchangeInfo & { pair: string })[] = result.instruments
            .filter((i) => i.tradeable && i.symbol.startsWith(symbolPrefix))
            .map((instrument) => {
              const tick = instrument.tickSize || 1
              const priceAssetPrecision =
                tick < 1 ? Math.ceil(-Math.log10(tick)) : 0
              const basePrecision =
                typeof instrument.contractValueTradePrecision === 'number'
                  ? instrument.contractValueTradePrecision === 0
                    ? 1
                    : Math.pow(10, -instrument.contractValueTradePrecision)
                  : 0.0001
              return {
                wsCode: `${instrument.base}/${instrument.quote}`,
                code: instrument.symbol,
                pair: `${instrument.base}-${instrument.quote}`,
                // Authoritative class from Kraken Futures `category` (undefined
                // => main-app defaults to crypto). No heuristics.
                assetClass: krakenFuturesAssetClass(
                  (instrument as unknown as { category?: string }).category,
                ),
                baseAsset: {
                  name: instrument.base || '',
                  minAmount: basePrecision,
                  maxAmount: instrument.maxPositionSize || 999999999,
                  step: basePrecision,
                  maxMarketAmount: instrument.maxPositionSize || 999999999,
                },
                quoteAsset: {
                  name: instrument.quote,
                  minAmount: instrument.contractSize || 1,
                },
                maxOrders: 200,
                priceAssetPrecision,
              }
            })

          // Remove duplicates and update symbol maps
          const uniqueInfos = [
            ...new Map(infos.map((info) => [info.pair, info])).values(),
          ]

          // Update symbol maps for futures
          // Use info.symbol (e.g., "PF_XBTUSD") as the Kraken format because that's what API calls expect
          // Use info.pair (e.g., "BTC-USD") as our normalized format
          this.symbolMapper.updateMaps(
            uniqueInfos.map((info) => ({
              pair: info.pair,
              code: info.code,
            })),
          )

          return this.returnGood<(ExchangeInfo & { pair: string })[]>(
            timeProfile,
          )(uniqueInfos)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAssetPairs', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    try {
      // First, get asset info to map Kraken asset names to actual names
      const assetInfoResult = await this.spotClient.getAssetInfo()

      if (assetInfoResult.result) {
        this.symbolMapper.updateAssets(assetInfoResult.result)
      }
    } catch (error) {
      Logger.warn(`Failed to get Kraken asset info: ${error.message}`)
    }

    return this.spotClient
      .getAssetPairs()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get asset pairs')
        }

        // Tokenized-equity ("xStocks") pairs are NOT returned by the default
        // AssetPairs call — they require the `aclass: 'tokenized_asset'` param
        // (note: AssetPairs uses `aclass`; every OTHER Kraken call uses
        // `asset_class`). Additive + flag-gated (default ON) and skipped in
        // demo/testnet, so ordinary crypto spot pairs are never affected.
        // A tokenized entry is tagged assetClass 'etf' | 'stock'; crypto
        // entries stay untagged (undefined => main-app treats as crypto).
        const xstocksEnabled =
          process.env.KRAKEN_XSTOCKS_ENABLED !== 'false' &&
          process.env.KRAKEN_ENV !== 'demo'
        // Same shape as the default AssetPairs `result.result` entries.
        const tokenizedPairs: typeof result.result = {}
        if (xstocksEnabled) {
          try {
            const tokenizedResult = await this.spotClient!.getAssetPairs({
              // `aclass` is the AssetPairs-specific param name; the lib types
              // AssetPairs as `aclass_base`, so pass through a cast (SpotClient
              // serializes arbitrary params verbatim).
              aclass: 'tokenized_asset',
            } as Parameters<typeof this.spotClient.getAssetPairs>[0])
            if (tokenizedResult.result && !tokenizedResult.error?.length) {
              // Kraken returns EACH tokenized market under two identical keys —
              // an internal `…SPVUSD` settlement key and the altname key
              // (`AAPLxUSD`). Collapse by altname so every xStock surfaces once
              // with a clean `code`; otherwise pairDb gets 320 rows for 160
              // markets (dupes in the picker + ambiguous symbol map).
              for (const info of Object.values(tokenizedResult.result)) {
                const altname = (info as { altname?: string }).altname
                if (altname) tokenizedPairs[altname] = info
              }
            }
          } catch (error) {
            Logger.warn(
              `Failed to get Kraken tokenized asset pairs: ${error.message}`,
            )
          }
        }
        const tokenizedCodes = new Set(Object.keys(tokenizedPairs))

        const infos: (ExchangeInfo & { pair: string })[] = Object.entries({
          ...result.result,
          ...tokenizedPairs,
        }).map(([code, pairInfo]) => {
          const isTokenized = tokenizedCodes.has(code)
          // Tokenized bases (e.g. "AAPLx", "BRK.Bx") are already display-ready
          // — do NOT run them through the crypto asset-name map. Crypto pairs
          // keep the existing mapping (XXBT -> BTC, ZUSD -> USD).
          const base = isTokenized
            ? pairInfo.base || ''
            : this.symbolMapper.getActualAssetName(pairInfo.base || '')
          const quote = this.symbolMapper.getActualAssetName(
            pairInfo.quote || '',
          )
          const tick = parseFloat(pairInfo.tick_size || '1')
          const priceAssetPrecision =
            tick < 1 ? Math.ceil(-Math.log10(tick)) : 0
          // Strip the trailing `x` tokenized marker for the ETF lookup
          // (keep the dot for "BRK.Bx" -> "BRK.B").
          const underlying = base.endsWith('x') ? base.slice(0, -1) : base
          return {
            code,
            wsCode: `${base}/${quote}`,
            pair: `${base}-${quote}`,
            ...(isTokenized
              ? {
                  assetClass: (KRAKEN_XSTOCK_ETFS.has(underlying)
                    ? 'etf'
                    : 'stock') as ExchangeInfo['assetClass'],
                }
              : {}),
            baseAsset: {
              name: base,
              minAmount: parseFloat(pairInfo.ordermin || '0'),
              maxAmount:
                Math.min(
                  pairInfo.long_position_limit,
                  pairInfo.short_position_limit,
                  0,
                ) || 0,
              step: Math.pow(10, -(pairInfo.lot_decimals || 8)),
              maxMarketAmount: 999999999,
            },
            quoteAsset: {
              name: quote,
              minAmount: +(pairInfo.costmin || 0),
              precision: pairInfo.pair_decimals,
            },
            maxOrders: 200,
            priceAssetPrecision,
          }
        })

        // Register which our-symbols are tokenized so per-pair calls inject
        // `asset_class` (replace-set each call).
        this.symbolMapper.setTokenized(
          infos
            .filter((info) => tokenizedCodes.has(info.code!))
            .map((info) => info.pair),
        )

        // Update symbol maps (code is always defined for Kraken pairs)
        this.symbolMapper.updateMaps(
          infos.map((info) => ({ pair: info.pair, code: info.code! })),
        )

        return this.returnGood<(ExchangeInfo & { pair: string })[]>(
          timeProfile,
        )(infos)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * What this account actually pays, from the PRIVATE `TradeVolume` endpoint.
   *
   * Best-effort by design. Every failure path returns "unknown" rather than an
   * error, and the caller then falls back to the published ladder's first rung
   * — i.e. exactly the behaviour that shipped before this existed. That matters
   * for more than tidiness: main-app's hourly fee sweep treats a hard failure
   * from `getAllUserFees` as evidence the API key is dead and counts it toward
   * disabling the key (`feeAuthFailures` / `feeAuthDisabled` in
   * `src/user/utils.ts`). Letting a TradeVolume hiccup surface as a failed fee
   * fetch would start switching off working Kraken keys.
   *
   * Pair-scoped, and authoritative: Kraken answers with the rate this account
   * actually pays on this pair — volume tier or negotiated alike — so no
   * client-side tier arithmetic is involved. The bulk sweep's counterpart is
   * `getAccountPairFees`, which batches the whole pair list the same way.
   */
  private async getAccountFees(
    krakenSymbol: string,
  ): Promise<KrakenAccountFees> {
    // No credentials — the keyless public client (cron pair sync, unauthenticated
    // callers) can never answer this, and must not pay for finding that out.
    if (!this.spotClient || !this.key || !this.secret) {
      return KRAKEN_ACCOUNT_FEES_UNKNOWN
    }

    const cacheKey = `${hashKrakenKey(this.key)}:${krakenSymbol ?? '*'}`
    const cached = krakenTradeVolumeCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < KRAKEN_TRADE_VOLUME_TTL) {
      return { taker: cached.taker, maker: cached.maker }
    }

    try {
      await this.checkLimits('getTradingVolume', krakenSymbol)
      const res = await this.spotClient.getTradingVolume(
        krakenSymbol ? { pair: krakenSymbol } : {},
      )
      if (!res.result || res.error?.length) {
        throw new Error(res.error?.[0] || 'Failed to get trade volume')
      }

      // Kraken echoes the pair back under its own name, which is not always the
      // string we asked with. Prefer an exact match, then fall back to the sole
      // entry — a pair-scoped call only ever describes one pair.
      const pick = (
        map: Record<string, { fee: string }> | undefined,
      ): number | null => {
        if (!map || !krakenSymbol) {
          return null
        }
        const entry =
          map[krakenSymbol] ??
          (Object.keys(map).length === 1 ? map[Object.keys(map)[0]] : undefined)
        const percent = Number(entry?.fee)
        return Number.isFinite(percent) ? percent / 100 : null
      }

      const fees: KrakenAccountFees = {
        taker: pick(res.result.fees),
        maker: pick(res.result.fees_maker),
      }
      krakenTradeVolumeCache.set(cacheKey, { ...fees, ts: Date.now() })
      return fees
    } catch (error) {
      // Cache the miss too, so a key without the permission (or an account
      // Kraken refuses this endpoint for) does not re-ask on every pair of
      // every sweep. It re-probes once the TTL lapses.
      krakenTradeVolumeCache.set(cacheKey, {
        ...KRAKEN_ACCOUNT_FEES_UNKNOWN,
        ts: Date.now(),
      })
      Logger.warn(
        // The SDK wraps a Kraken-level rejection (HTTP 200 + non-empty
        // `error`) as `{code: 200, message: statusText, body: response.data}`
        // — so `.message` is literally "OK" and the REAL reason ("EGeneral:
        // Permission denied", "EAPI:Invalid key", …) lives in `body.error`.
        // Logging `.message` made the first day of this fallback undiagnosable.
        `Kraken trade volume lookup failed, falling back to the published fee ladder: ${
          (error as { body?: { error?: string[] } })?.body?.error?.join('; ') ||
          (error?.message && error.message !== 'OK'
            ? error.message
            : safeStringify(error).slice(0, 200))
        }`,
      )
      return KRAKEN_ACCOUNT_FEES_UNKNOWN
    }
  }

  /**
   * The account's ACTUAL rate for each requested pair, from pair-scoped
   * `TradeVolume` calls in chunks. This is the only way Kraken exposes what
   * an account actually pays (see `krakenPairFeeMapCache`); the published
   * ladder's first rung is the fallback for any pair this cannot answer.
   *
   * Same best-effort contract as `getAccountFees`: every failure degrades to
   * an empty (or partial) map, never an error — a TradeVolume problem must not
   * surface as a failed fee fetch (main-app's sweep counts those toward
   * disabling the key). A failed chunk is skipped, not fatal: chunks are
   * independent, and one bad pair name must not cost the other 650 pairs
   * their real rate. Tokenized (xStock) pairs are deliberately NOT batched —
   * they live in a different asset class that TradeVolume may refuse, and
   * refusing a chunk of 50 over one of them is the poisoning this avoids.
   */
  private async getAccountPairFees(
    krakenPairs: string[],
  ): Promise<Map<string, { taker: number | null; maker: number | null }>> {
    const out = new Map<
      string,
      { taker: number | null; maker: number | null }
    >()
    if (!this.spotClient || !this.key || !this.secret || !krakenPairs.length) {
      return out
    }

    const cacheKey = `${hashKrakenKey(this.key)}:pairmap`
    const cached = krakenPairFeeMapCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < KRAKEN_TRADE_VOLUME_TTL) {
      return cached.map
    }

    let failures = 0
    for (let i = 0; i < krakenPairs.length; i += KRAKEN_TRADE_VOLUME_CHUNK) {
      const chunk = krakenPairs.slice(i, i + KRAKEN_TRADE_VOLUME_CHUNK)
      try {
        await this.checkLimits('getTradingVolume')
        const res = await this.spotClient.getTradingVolume({
          pair: chunk.join(','),
        })
        if (!res.result) {
          failures++
          continue
        }
        const takers = res.result.fees ?? {}
        const makers = res.result.fees_maker ?? {}
        for (const p of chunk) {
          const t = Number(takers[p]?.fee)
          const m = Number(makers[p]?.fee)
          if (Number.isFinite(t) || Number.isFinite(m)) {
            out.set(p, {
              taker: Number.isFinite(t) ? t / 100 : null,
              maker: Number.isFinite(m) ? m / 100 : null,
            })
          }
        }
      } catch (error) {
        failures++
        if (failures === 1) {
          Logger.warn(
            `Kraken pair-scoped trade volume failed (chunk ${i / KRAKEN_TRADE_VOLUME_CHUNK + 1}), affected pairs fall back to the ladder: ${
              (error as { body?: { error?: string[] } })?.body?.error?.join(
                '; ',
              ) ||
              (error?.message && error.message !== 'OK'
                ? error.message
                : safeStringify(error).slice(0, 200))
            }`,
          )
        }
      }
    }
    // Cache partial and even empty results: a key that cannot answer (missing
    // permission) must not re-ask 14 times per pair-sweep every 10 minutes.
    krakenPairFeeMapCache.set(cacheKey, { map: out, ts: Date.now() })
    return out
  }

  async getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    if (this.usdm) {
      // Kraken Futures has different fee structure, using defaults
      return this.returnGood<UserFee>(timeProfile)({
        maker: 0.0002, // 0.02%
        taker: 0.0005, // 0.05%
      })
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAssetPairs', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    const krakenSymbol = await this.toKrakenSymbol(symbol)

    return this.spotClient
      .getAssetPairs({
        pair: krakenSymbol,
        // xStocks are absent from the default AssetPairs — without the `aclass`
        // filter this returns nothing for them, so the fee lookup threw
        // "Pair not found" → main-app surfaced "User fee not found".
        ...(this.symbolMapper.isTokenized(symbol)
          ? { aclass: 'tokenized_asset' }
          : {}),
      } as Parameters<typeof this.spotClient.getAssetPairs>[0])
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get asset pairs')
        }

        const pairInfo = result.result[krakenSymbol]
        if (!pairInfo) {
          throw new Error(`Pair ${symbol} not found`)
        }

        // `AssetPairs` publishes the whole tier ladder — `[[volume, percent], …]`
        // e.g. [[0, 0.40], [50000, 0.35], …] — but says nothing about WHICH rung
        // this account is on. Reading `fees[0]` therefore charged every user the
        // lowest-volume tier. Ask the account's own schedule and use that; the
        // ladder's first rung is now only the answer for a caller we cannot
        // identify.
        const account = await this.getAccountFees(krakenSymbol)

        const fee: UserFee = {
          taker: account.taker ?? krakenLadderFee(pairInfo.fees, null, 0.26),
          maker:
            account.maker ?? krakenLadderFee(pairInfo.fees_maker, null, 0.16),
        }

        return this.returnGood<UserFee>(timeProfile)(fee)
      })
      .catch(
        this.handleKrakenErrors(
          this.getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (this.usdm) {
      // Return default fees for futures
      const allPairsResult = await this.getAllExchangeInfo(timeProfile)
      if (allPairsResult.status !== StatusEnum.ok) {
        return allPairsResult
      }

      const fees: (UserFee & { pair: string })[] = allPairsResult.data.map(
        (info) => ({
          pair: info.pair,
          maker: 0.0002,
          taker: 0.0005,
        }),
      )

      return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(fees)
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAssetPairs', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getAssetPairs()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get asset pairs')
        }

        // xStocks aren't in the default AssetPairs, so their fees were missing
        // from the map → "User fee not found" for any Kraken stock pair. Fetch
        // the tokenized universe too (deduped by altname, same as
        // getAllExchangeInfo). Additive + flag-gated; never affects crypto.
        const tokenizedPairs: typeof result.result = {}
        if (
          process.env.KRAKEN_XSTOCKS_ENABLED !== 'false' &&
          process.env.KRAKEN_ENV !== 'demo'
        ) {
          try {
            const tok = await this.spotClient!.getAssetPairs({
              aclass: 'tokenized_asset',
            } as Parameters<typeof this.spotClient.getAssetPairs>[0])
            if (tok.result && !tok.error?.length) {
              for (const info of Object.values(tok.result)) {
                const altname = (info as { altname?: string }).altname
                if (altname) tokenizedPairs[altname] = info
              }
            }
          } catch (error) {
            Logger.warn(`Failed to get Kraken tokenized fees: ${error.message}`)
          }
        }

        // The account's ACTUAL per-pair rates, straight from Kraken. The
        // pair-scoped TradeVolume batch is authoritative for both volume-tier
        // and negotiated rates — Kraken does the tier arithmetic, not us. Any
        // pair the batch could not answer (tokenized pairs, a failed chunk,
        // no credentials) falls back to the published ladder's FIRST rung,
        // which is byte-for-byte the pre-1.20.3 behaviour. Deliberately no
        // client-side ladder-by-volume interpolation: it duplicated arithmetic
        // Kraken already performs, and could only ever fire in the narrow case
        // where a chunk failed but a pairless call worked.
        const pairFees = await this.getAccountPairFees(
          Object.keys(result.result),
        )

        const fees: (UserFee & { pair: string })[] = Object.entries({
          ...result.result,
          ...tokenizedPairs,
        }).map(([pairKey, pairInfo]) => {
          const exact = pairFees.get(pairKey)
          const takerFee =
            exact?.taker ?? krakenLadderFee(pairInfo.fees, null, 0.26)
          const makerFee =
            exact?.maker ?? krakenLadderFee(pairInfo.fees_maker, null, 0.16)
          const base = this.symbolMapper.getActualAssetName(pairInfo.base || '')
          const quote = this.symbolMapper.getActualAssetName(
            pairInfo.quote || '',
          )
          return {
            pair: `${base}-${quote}`,
            maker: makerFee,
            taker: takerFee,
          }
        })

        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          fees,
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const intervalMinutes = intervalMap[interval]

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      const krakenSymbol = await this.toKrakenSymbol(symbol)

      timeProfile =
        (await this.checkLimits('getCandles', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getCandles({
          tickType: 'mark',
          symbol: krakenSymbol,
          resolution: interval as FuturesGetCandlesParams['resolution'],
          from: from ? Math.floor(from / 1000) : undefined,
          to: to ? Math.floor(to / 1000) : undefined,
          count,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (!result.candles) {
            throw new Error(
              `Failed to get candles. Candles: ${!!result.candles}`,
            )
          }

          const candles: CandleResponse[] = result.candles.map((candle) => ({
            time: new Date(candle.time).getTime(),
            open: candle.open.toString(),
            high: candle.high.toString(),
            low: candle.low.toString(),
            close: candle.close.toString(),
            volume: candle.volume.toString(),
          }))

          return this.returnGood<CandleResponse[]>(timeProfile)(candles)
        })
        .catch(
          this.handleKrakenErrors(
            this.getCandles,
            symbol,
            interval,
            from,
            to,
            count,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getCandles', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getCandles({
        pair: await this.toKrakenSymbol(symbol),
        interval: intervalMinutes as
          1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080 | 21600,
        since: from ? Math.floor(from / 1000) : undefined,
        ...this.xstockParams(symbol),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get candles')
        }

        const krakenPair = Object.keys(result.result)[0]
        const ohlcData = result.result[krakenPair]

        if (!Array.isArray(ohlcData)) {
          throw new Error('Invalid candle data format')
        }

        let candles: CandleResponse[] = ohlcData.map((candle) => ({
          time: candle[0] * 1000,
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[6],
        }))

        // Filter by time range if specified
        if (from) {
          candles = candles.filter((c) => c.time >= from)
        }
        if (to) {
          candles = candles.filter((c) => c.time <= to)
        }

        // Limit count if specified
        if (count && candles.length > count) {
          candles = candles.slice(0, count)
        }

        return this.returnGood<CandleResponse[]>(timeProfile)(candles)
      })
      .catch(
        this.handleKrakenErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          count,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    if (!this.usdm || !this.derivativesClient) {
      // Kraken funding rates exist only for futures (derivatives).
      return this.usdm
        ? this.errorClient(timeProfile)
        : this.returnGood<FundingRateResponse[]>(timeProfile)([])
    }
    // Callers normally pass the Kraken futures code (e.g. PF_XBTUSD), but the
    // funding registry can also hold our normalized pair (BTC-USD), which the
    // API rejects with "Argument invalid: symbol". Our pairs always contain a
    // dash and futures codes never do, so convert only that form.
    const krakenSymbol = symbol.includes('-')
      ? await this.toKrakenSymbol(symbol)
      : symbol
    timeProfile =
      (await this.checkLimits(
        'getFundingRateHistory',
        krakenSymbol,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    // Kraken returns the full history (no time filter), ascending by timestamp.
    return this.derivativesClient
      .getHistoricalFundingRates({ symbol: krakenSymbol })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (!result.rates) {
          throw new Error('Failed to get funding rates')
        }
        return this.returnGood<FundingRateResponse[]>(timeProfile)(
          result.rates
            .map((r) => ({
              symbol,
              // relativeFundingRate is the fractional rate (vs absolute fundingRate)
              fundingRate: r.relativeFundingRate,
              fundingTime: new Date(r.timestamp).getTime(),
            }))
            .filter(
              (r) =>
                (from ? r.fundingTime >= +from : true) &&
                (to ? r.fundingTime <= +to : true),
            )
            .slice(-(limit ?? Infinity)),
        )
      })
      .catch(
        this.handleKrakenErrors(
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
    symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<TradeResponse[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      const krakenSymbol = await this.toKrakenSymbol(symbol)

      timeProfile =
        (await this.checkLimits('getTradeHistory', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTradeHistory({ symbol: krakenSymbol })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.history) {
            throw new Error(
              `Failed to get trades. Result: ${result.result || 'undefined'}, History: ${!!result.history}`,
            )
          }

          const trades: TradeResponse[] = result.history.map(
            (trade, index) => ({
              aggId: index.toString(),
              symbol,
              price: trade.price?.toString() || '0',
              quantity: trade.size?.toString() || '0',
              firstId: index,
              lastId: index,
              timestamp: new Date(trade.time || 0).getTime(),
            }),
          )

          return this.returnGood<TradeResponse[]>(timeProfile)(trades)
        })
        .catch(
          this.handleKrakenErrors(
            this.getTrades,
            symbol,
            _fromId,
            _startTime,
            _endTime,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getRecentTrades', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getRecentTrades({
        pair: await this.toKrakenSymbol(symbol),
        ...this.xstockParams(symbol),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get trades')
        }

        const krakenPair = Object.keys(result.result)[0]
        const tradesData = result.result[krakenPair]

        if (!Array.isArray(tradesData)) {
          throw new Error('Invalid trades data format')
        }

        const trades: TradeResponse[] = tradesData.map((trade, index) => ({
          aggId: index.toString(),
          symbol,
          price: trade[0],
          quantity: trade[1],
          firstId: index,
          lastId: index,
          timestamp: Math.floor(trade[2] * 1000),
        }))

        return this.returnGood<TradeResponse[]>(timeProfile)(trades)
      })
      .catch(
        this.handleKrakenErrors(
          this.getTrades,
          symbol,
          _fromId,
          _startTime,
          _endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Futures-specific methods
  // ===========================

  /**
   * Change leverage for a futures symbol
   *
   * IMPORTANT - Kraken Leverage Handling:
   * Kraken Futures has a unique margin system:
   *
   * 1. ISOLATED MARGIN (with fixed leverage):
   *    - Call setLeverageSettings with maxLeverage parameter
   *    - Example: { symbol: 'PF_XBTUSD', maxLeverage: 10 }
   *    - This sets 10x leverage in isolated mode
   *
   * 2. CROSS MARGIN (dynamic leverage):
   *    - Call setLeverageSettings without maxLeverage (or pass undefined)
   *    - Example: { symbol: 'PF_XBTUSD' }
   *    - In cross margin mode, leverage is DYNAMICALLY calculated based on:
   *      * Your total account balance
   *      * Your position size
   *      * Market conditions
   *    - You cannot "set" a fixed leverage in cross mode
   *    - The system automatically uses maximum available leverage based on account equity
   *
   * 3. Sending Orders:
   *    - submitOrder() does NOT have a leverage parameter
   *    - Leverage must be set BEFORE placing orders using setLeverageSettings
   *    - The order will use whatever leverage/margin mode is currently configured
   *
   * See: https://docs.kraken.com/api/docs/futures-api/trading/set-leverage-setting
   */
  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.usdm) {
      return this.returnBad(timeProfile)(
        new Error('Leverage change only supported for futures'),
      )
    }

    if (!this.derivativesClient) {
      return this.errorClient(timeProfile)
    }

    const krakenSymbol = await this.toKrakenSymbol(symbol)
    const cacheKey = krakenLeveragePrefKey(this.key, krakenSymbol)

    // Skip the (rate-limited) API call when the isolated leverage is already known
    // to be set to this value. Don't spend a checkLimits token either.
    if (krakenLeveragePrefMatches(cacheKey, leverage)) {
      return this.returnGood<number>(timeProfile)(leverage)
    }

    timeProfile =
      (await this.checkLimits('setLeveragePreference', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .setLeverageSettings({
        symbol: krakenSymbol,
        maxLeverage: leverage,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success') {
          throw new Error(
            `Failed to set leverage. Result: ${result.result || 'undefined'}, Error: ${result.error || 'none'}`,
          )
        }

        krakenLeveragePrefCache.set(cacheKey, {
          pref: leverage,
          ts: Date.now(),
        })
        return this.returnGood<number>(timeProfile)(leverage)
      })
      .catch(
        this.handleKrakenErrors(
          this.futures_changeLeverage,
          symbol,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Change margin type for a futures symbol
   *
   * Kraken handles margin type through the leverage setting:
   * - ISOLATED: Set by calling setLeverageSettings WITH maxLeverage
   * - CROSS: Set by calling setLeverageSettings WITHOUT maxLeverage
   *
   * This method calls setLeverageSettings appropriately based on margin type.
   */
  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (!this.usdm) {
      return this.returnBad(timeProfile)(
        new Error('Margin type change only supported for futures'),
      )
    }

    if (!this.derivativesClient) {
      return this.errorClient(timeProfile)
    }

    const krakenSymbol = await this.toKrakenSymbol(symbol)
    const cacheKey = krakenLeveragePrefKey(this.key, krakenSymbol)
    // Both changeMarginType and changeLeverage write the same leveragepreferences
    // setting, so they share one cache entry. Isolated => the maxLeverage value;
    // cross => the 'cross' sentinel (setLeverageSettings called without maxLeverage).
    const desiredPref: KrakenLeveragePref =
      margin === MarginType.ISOLATED ? leverage : 'cross'

    if (krakenLeveragePrefMatches(cacheKey, desiredPref)) {
      return this.returnGood<MarginType>(timeProfile)(margin)
    }

    timeProfile =
      (await this.checkLimits('setLeverageSettings', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .setLeverageSettings({
        symbol: krakenSymbol,
        // Pass maxLeverage only for isolated mode
        // For cross margin, omit maxLeverage to enable dynamic leverage
        maxLeverage: margin === MarginType.ISOLATED ? leverage : undefined,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success') {
          throw new Error(
            `Failed to set margin type. Result: ${result.result || 'undefined'}, Error: ${result.error || 'none'}`,
          )
        }

        krakenLeveragePrefCache.set(cacheKey, {
          pref: desiredPref,
          ts: Date.now(),
        })
        return this.returnGood<MarginType>(timeProfile)(margin)
      })
      .catch(
        this.handleKrakenErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    // Kraken Futures uses a one-way / netting position model (a single net
    // position per contract; orders carry no positionSide). It does not
    // support hedge mode, so always report one-way. Reporting `true` here
    // permanently blocked neutral futures grid bots ("Bot cannot run in
    // hedge mode").
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async futures_setHedge(
    _value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    // Hedge mode cannot be enabled on Kraken Futures (one-way / netting only),
    // so the account stays in one-way mode regardless of the requested value.
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    if (!this.usdm) {
      return this.returnBad(timeProfile)(
        new Error('Leverage brackets only available for futures'),
      )
    }

    if (!this.derivativesClient) {
      return this.errorClient(timeProfile)
    }

    // Kraken Futures doesn't provide a detailed leverage bracket API
    // Return default structure
    const brackets: LeverageBracket[] = [
      {
        symbol: '',
        leverage: 50,
        step: 1,
        min: 0,
      },
    ]

    return this.returnGood<LeverageBracket[]>(timeProfile)(brackets)
  }

  /**
   * The account's leverage preferences, keyed by upper-cased Kraken symbol.
   *
   * `GET /derivatives/api/v3/leveragepreferences` lists only contracts with an
   * isolated preference set (`maxLeverage`); anything absent is cross. A
   * failure returns `null` so callers can tell "unknown" from "cross" — the
   * two are not the same thing and only one of them is safe to assert.
   * Read-only; never written into `krakenLeveragePrefCache`, whose contract is
   * "last state WE confirmed by writing".
   */
  private async futures_readLeveragePrefs(timeProfile: TimeProfile): Promise<{
    prefs: Map<string, KrakenLeveragePref> | null
    timeProfile: TimeProfile
  }> {
    if (!this.derivativesClient) {
      return { prefs: null, timeProfile }
    }
    timeProfile =
      (await this.checkLimits(
        'getLeveragePreferences',
        undefined,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.derivativesClient.getLeverageSettings()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (result.result !== 'success') {
        return { prefs: null, timeProfile }
      }
      const prefs = new Map<string, KrakenLeveragePref>()
      for (const p of result.leveragePreferences ?? []) {
        const max = +(p.maxLeverage ?? 0)
        prefs.set(
          `${p.symbol ?? ''}`.toUpperCase(),
          Number.isFinite(max) && max > 0 ? max : 'cross',
        )
      }
      return { prefs, timeProfile }
    } catch (e) {
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      Logger.warn(
        `Kraken leverage preferences unavailable, positions will not carry a leverage: ${safeStringify(e).slice(0, 200)}`,
      )
      return { prefs: null, timeProfile }
    }
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.usdm) {
      return this.returnBad(timeProfile)(
        new Error('Positions only available for futures'),
      )
    }

    if (!this.derivativesClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getOpenPositions', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .getOpenPositions()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success' || !result.openPositions) {
          throw new Error(
            `Failed to get positions. Result: ${result.result || 'undefined'}, OpenPositions: ${!!result.openPositions}`,
          )
        }

        let positions = result.openPositions
        if (symbol) {
          const krakenSymbol = await this.toKrakenSymbol(symbol)
          positions = positions.filter((p) => p.symbol === krakenSymbol)
        }

        // One read covers every contract on the account; skip it when there
        // is nothing to label.
        let prefs: Map<string, KrakenLeveragePref> | null = null
        if (positions.length > 0) {
          const read = await this.futures_readLeveragePrefs(timeProfile)
          prefs = read.prefs
          timeProfile = read.timeProfile
        }

        const positionInfos: PositionInfo[] = []
        for (const pos of positions) {
          positionInfos.push(
            this.futures_convertPosition({
              symbol: await this.normalizeSymbol(pos.symbol || ''),
              side: pos.side,
              size: pos.size,
              price: pos.price,
              unrealizedFunding: pos.unrealizedFunding,
              // No entry in the preference list = no isolated preference =
              // cross. A failed read is `undefined` — unknown, not cross.
              leveragePref:
                prefs === null
                  ? undefined
                  : (prefs.get(`${pos.symbol ?? ''}`.toUpperCase()) ?? 'cross'),
            }),
          )
        }
        return this.returnGood<PositionInfo[]>(timeProfile)(positionInfos)
      })
      .catch(
        this.handleKrakenErrors(
          this.futures_getPositions,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
}

export default KrakenExchange

// Type guard to ensure proper type inference
type OrderSideType = 'BUY' | 'SELL'
