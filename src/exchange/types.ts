export type AssetClass =
  'crypto' | 'stock' | 'etf' | 'commodity' | 'metal' | 'forex' | 'index'

export type ExchangeInfo = {
  wsCode?: string
  code?: string
  // Asset class of the instrument. Producers set this where the exchange exposes
  // an authoritative signal (e.g. Bitget `isRwa`); consumers (main-app) refine /
  // default it. Absent => treat as 'crypto'. See platform Danger List #1.
  assetClass?: AssetClass
  baseAsset: {
    minAmount: number
    maxAmount: number
    step: number
    name: string
    maxMarketAmount: number
    multiplier?: number
  }
  quoteAsset: {
    minAmount: number
    name: string
    precision?: number
  }
  maxOrders: number
  priceAssetPrecision: number
  // Whether the market is a canonical / officially-curated listing on its
  // exchange. Currently only Hyperliquid spot sets it (HL `isCanonical` OR a
  // Unit-bridged asset); everything else leaves it undefined = treated as
  // canonical. The dashboard's "Canonical only" pair-picker toggle filters on
  // `=== false` so non-HL exchanges are unaffected.
  isCanonical?: boolean
  priceMultiplier?: {
    up: number
    down: number
    decimals: number
  }
  type?: string
  crossAvailable?: boolean
}
export type PositionInfo = {
  symbol: string
  initialMargin: string
  maintMargin: string
  unrealizedProfit: string
  positionInitialMargin: string
  openOrderInitialMargin: string
  leverage: string
  isolated: boolean
  entryPrice: string
  maxNotional: string
  positionSide: PositionSide_LT
  positionAmt: string
  notional: string
  isolatedWallet: string
  updateTime: number
  bidNotional: string
  askNotional: string
  positionId?: string
}

export enum TradeTypeEnum {
  all = 'all',
  margin = 'margin',
  spot = 'spot',
  futures = 'futures',
}

/** Tri-state so "we could not find out" is never confused with "no".
 *  Every consumer must treat `unknown` as "do not act", not as a failure. */
export type PermissionState = 'yes' | 'no' | 'unknown'

/**
 * What an exchange says a set of API credentials is *allowed* to do, as
 * opposed to what Gainium needs it to do.
 *
 * Gainium only ever needs read + trade, and never withdrawal. Historically
 * nothing verified that a stored key was actually limited that way, so the
 * property was assumed rather than enforced. This type is how we enforce it.
 */
export type KeyPermissions = {
  /** Can this key move funds off the exchange? Gainium never needs this. */
  withdraw: PermissionState
  /**
   * Can this key move funds *between accounts on the same exchange*?
   * Not withdrawal, but still a fund-movement capability Gainium never uses:
   * Bybit's universal-transfer can move balances between a user's own
   * sub-accounts with no withdrawal scope at all. Worth recording.
   */
  transfer: PermissionState
  /** Whether the key is bound to an IP allowlist. Unrestricted = usable from
   *  anywhere the key leaks to, which is its own risk signal. */
  ipRestricted: PermissionState
  /** The bound addresses, when the exchange discloses them. */
  ips?: string[]
  /** Human-readable provenance (the raw permission string, or why we could not
   *  tell). Surfaced to admins for forensics — must never contain the key. */
  detail?: string
  /** ms epoch at which this was observed. A key's permissions can change after
   *  it passes verification, so a reading is only as good as its timestamp. */
  checkedAt: number
}

export type VerifyResponse = {
  status: boolean
  reason: string
  /** Optional so every existing consumer of this cross-service contract keeps
   *  working unchanged (see the Danger List in the root CLAUDE.md). */
  permissions?: KeyPermissions
}

export enum MarginType {
  ISOLATED = 'ISOLATED',
  CROSSED = 'CROSSED',
}

export type CandleResponse = {
  open: string
  high: string
  low: string
  close: string
  time: number
  volume: string
}

export type TradeResponse = {
  aggId: string
  symbol: string
  price: string
  quantity: string
  firstId: number
  lastId: number
  timestamp: number
}

/**
 * One execution on the ACCOUNT — not a public market trade (`TradeResponse`).
 *
 * `clientOrderId` is the id WE supplied when placing the order, which is what
 * makes this reconcilable: a fill the venue reports against one of our client
 * order ids, for an order we recorded as cancelled-and-unfilled, is a fill we
 * lost — provable per fill, with no inference about margin or position size.
 * A trade the user placed by hand carries no client order id of ours and is
 * therefore excluded by construction rather than having to be reasoned away.
 */
export type AccountFill = {
  fillId: string
  orderId: string
  clientOrderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  price: string
  quantity: string
  timestamp: number
  /** Venue's own classification, passed through unmapped for diagnostics. */
  fillType?: string
}

export type FundingRateResponse = {
  /** Universal symbol, e.g. BTCUSDT */
  symbol: string
  /** Settled funding rate as a fraction, e.g. -0.000123 */
  fundingRate: number
  /** Settlement time in milliseconds */
  fundingTime: number
  /**
   * Mark price associated with the funding charge, when the exchange supplies
   * it (currently Binance USDM). Absent otherwise — the publisher resolves it.
   */
  markPrice?: number
}

export enum ExchangeIntervals {
  oneM = '1m',
  threeM = '3m',
  fiveM = '5m',
  fifteenM = '15m',
  thirtyM = '30m',
  oneH = '1h',
  twoH = '2h',
  fourH = '4h',
  eightH = '8h',
  oneD = '1d',
  oneW = '1w',
}

export type AllPricesResponse = {
  pair: string
  price: number
}

export enum ExchangeEnum {
  binance = 'binance',
  kucoin = 'kucoin',
  kucoinLinear = 'kucoinLinear',
  kucoinInverse = 'kucoinInverse',
  ftx = 'ftx',
  bybit = 'bybit',
  mexc = 'mexc',
  binanceUS = 'binanceUS',
  ftxUS = 'ftxUS',
  binanceCoinm = 'binanceCoinm',
  binanceUsdm = 'binanceUsdm',
  bybitCoinm = 'bybitInverse',
  bybitUsdm = 'bybitLinear',
  okx = 'okx',
  okxLinear = 'okxLinear',
  okxInverse = 'okxInverse',
  coinbase = 'coinbase',
  bitget = 'bitget',
  bitgetUsdm = 'bitgetUsdm',
  bitgetCoinm = 'bitgetCoinm',
  hyperliquid = 'hyperliquid',
  hyperliquidLinear = 'hyperliquidLinear',
  kraken = 'kraken',
  krakenUsdm = 'krakenUsdm',
  krakenCoinm = 'krakenCoinm',
  whitebit = 'whitebit',
  whitebitUsdm = 'whitebitUsdm',
}

export enum ExchangeDomain {
  us = 'us',
  com = 'com',
}

export enum Futures {
  usdm = 'usdm',
  coinm = 'coinm',
  null = 'null',
}

export enum CoinbaseKeysType {
  legacy = 'legacy',
  cloud = 'cloud',
}

export enum OKXSource {
  my = 'my',
  app = 'app',
  com = 'com',
}

export enum TypeOrderEnum {
  swap = 'swap',
  regular = 'regular',
  stop = 'stop',
  dealStart = 'dealStart',
  dealRegular = 'dealRegular',
  dealTP = 'dealTP',
}

export type TypeOrder =
  | typeof TypeOrderEnum.swap
  | typeof TypeOrderEnum.regular
  | typeof TypeOrderEnum.stop
  | typeof TypeOrderEnum.dealStart
  | typeof TypeOrderEnum.dealRegular
  | typeof TypeOrderEnum.dealTP
export const BUY = 'BUY'
export const SELL = 'SELL'
export const OK = 'OK'
export const NOTOK = 'NOTOK'

export enum StatusEnum {
  ok = 'OK',
  notok = 'NOTOK',
}

export type OrderTypes = typeof BUY | typeof SELL
export interface BaseSchema {
  created?: Date
  updated?: Date
  _id: any
}

export type ExchangeLimitUsage = { type: string; value: number }[]

export type ExcludeDoc<T> = Omit<T, keyof Document> & BaseSchema

export type TimeProfile = {
  attempts: number
  incomingTime: number
  outcomingTime: number
  inQueueStartTime: number
  inQueueEndTime: number
  exchangeRequestStartTime: number
  exchangeRequestEndTime: number
}

export type ReturnGood<T> = {
  status: StatusEnum.ok
  data: T
  reason?: null
  usage: ExchangeLimitUsage
  timeProfile: TimeProfile
}

export type ReturnBad = {
  status: StatusEnum.notok
  data: null
  reason: string
  usage: ExchangeLimitUsage
  timeProfile: TimeProfile
}

export type BaseReturn<T = any> = ReturnGood<T> | ReturnBad

type Asset = {
  asset: string
  free: number
  locked: number
}

export type FreeAsset = Asset[]

export type FuturesFreeAsset = Omit<Asset, 'locked'>[]
export type UserFee = {
  maker: number
  taker: number
  /**
   * Where this rate came from. `venue` = the exchange told us what THIS
   * account pays. `ladder` = we could not ask, so this is the published
   * schedule's entry rung — a guess that is wrong for anyone not on the
   * bottom tier, and on Kraken is currently stale enough to match no real
   * tier at all (its first rung reads 0.40%/0.25%; Kraken's live Tier 1 is
   * 0.80%/0.40%).
   *
   * It exists so the CALLER can name the account: the connector receives only
   * credentials (`AuthData` has no userId or uuid), so it can never say whose
   * lookup degraded — but main-app's fee sweep knows exactly which user and
   * connection it is asking for, and can log it the moment it sees `ladder`.
   * Without this the fallback is invisible: it returns a plausible number,
   * `status` is OK, and the stale rate is silently written to the user's fees.
   *
   * Optional and additive — absent means "not reported", never "venue".
   */
  source?: 'venue' | 'ladder'
}
export type OrderStatusType = 'CANCELED' | 'FILLED' | 'NEW' | 'PARTIALLY_FILLED'

export type OrderTypeT = 'LIMIT' | 'MARKET'

export type OrderSideType = 'BUY' | 'SELL'

export type CommonOrder = {
  /**futures */
  positionSide?: PositionSide_LT
  reduceOnly?: boolean
  closePosition?: boolean
  timeInForce?: string
  cumQuote?: string
  cumBase?: string
  cumQty?: string
  avgPrice?: string
  /**spot */
  symbol: string
  orderId: string | number
  clientOrderId: string
  transactTime?: number
  updateTime: number
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty?: string
  status: OrderStatusType
  type: OrderTypeT
  side: OrderSideType
  fills?: {
    price: string
    qty: string
    commission: string
    commissionAsset: string
    tradeId: string
  }[]
  /**
   * The fee the VENUE actually charged for this order, as the venue reports
   * it — never a rate we applied ourselves.
   *
   * This exists because `deal.commission` has always been an ESTIMATE
   * (`qty * price * storedFeeRate`), and an estimate is only ever as good as
   * the stored rate. That assumption does not hold: Kraken accounts are
   * routinely found carrying a rate matching no tier in Kraken's live schedule
   * (the public ladder we fall back to is stale — its first rung, 0.40%/0.25%,
   * is not a real tier; Kraken's actual Tier 1 is 0.80%/0.40%), so the
   * "commission" booked against those deals can be about half the true cost. An
   * observed fee cannot go stale the way a cached rate can.
   *
   * Optional and additive on purpose: `CommonOrder` is the platform's most
   * load-bearing contract (root CLAUDE.md Danger List #1). A venue that does
   * not report a fee simply omits it, and callers keep their existing
   * estimate — a missing fee must never book as zero cost.
   */
  feePaid?: string
  /**
   * WHICH side of the pair the fee came out of. Not derivable in general and
   * never to be assumed: Kraken charges quote on a buy and base on a sell (its
   * `oflags` default `fciq`/`fcib`), Binance-shaped venues normally take it
   * from the asset received, and some accounts pay in a third asset entirely.
   * Maps directly onto main-app's `deal.feePaid.{base,quote}` without any
   * symbol string-splitting.
   */
  feeSide?: 'base' | 'quote'
  /**
   * The fee asset's TICKER, as the venue named it. Most venues answer the
   * currency question this way rather than by naming a side, and the ticker
   * may be neither side of the pair (BNB on Binance, BGB on Bitget, KCS on
   * KuCoin). Resolving it against the pair is the consumer's job — it is the
   * side that knows the order's `baseAsset`/`quoteAsset`. When set, `feeSide`
   * is absent.
   */
  feeAsset?: string
  /**
   * Set INSTEAD of `feePaid`/`feeAsset` when a single order's fee was charged
   * in more than one currency — a partial BNB/BGB deduction that covers some
   * of the fee and leaves the rest in the quote asset.
   *
   * The legs are deliberately not summed: they are different currencies, and
   * adding them would mean inventing an FX rate here, which is the same class
   * of assumption that made the stored fee rate untrustworthy in the first
   * place. `feePaid` is left unset in this case so that a consumer reading
   * only `feePaid` cannot mistake one leg for the whole cost.
   */
  feeBreakdown?: { asset: string; amount: string }[]
}

export type FuturesOrderType_LT =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'TAKE_PROFIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET'

export type PositionSide_LT = 'BOTH' | 'SHORT' | 'LONG'

export const enum PositionSide {
  BOTH = 'BOTH',
  SHORT = 'SHORT',
  LONG = 'LONG',
}

export type LeverageBracket = {
  symbol: string
  leverage: number
  step: number
  min: number
}

export type WorkingType_LT = 'MARK_PRICE' | 'CONTRACT_PRICE'

export type FuturesCommonOrder = {
  avgPrice: string
  origType: FuturesOrderType_LT
  positionSide: PositionSide_LT
  reduceOnly: boolean
  closePosition: boolean
  timeInForce: string
  priceRate: string
  stopPrice: string
  workingType: WorkingType_LT
  symbol: string
  orderId: number | string
  clientOrderId: string
  updateTime: number
  price: string
  origQty: string
  executedQty: string
  status: OrderStatusType
  type: OrderTypeT
  side: OrderSideType
}

type AdditionalOrderData = {
  _id?: string
  exchange: ExchangeEnum
  exchangeUUID: string
  typeOrder: TypeOrder
  botId: string
  userId: string
  dealId?: string
  baseAsset: string
  quoteAsset: string
  origPrice: string
}

export type Order = CommonOrder & AdditionalOrderData

export type FuturesOrder = FuturesCommonOrder & AdditionalOrderData

export const maxTime = 2 * 60 * 1000

export type RebateRecord = {
  customerId: string
  email: string
  income: string
  asset: string
  symbol: string
  time: number
  orderId: number
  tradeId: number
}

export type RebateOverview = {
  unit: string
  rebateVol: string
  time: number
}

/**
 * Per-trader rebate, as the BROKER sees it. `customerId` is whatever identifies
 * the trader to the referral program: the id we registered for them via
 * {@link Exchange.setReferralCustomerId}, or — when nothing was ever registered
 * — a MASKED email (`el***87@***.com`), which is useless as a join key. Callers
 * that need per-user attribution must register ids first.
 */
export type TraderSummary = {
  customerId: string
  unit: string
  tradeVol: string
  rebateVol: string
  time: number
}

/**
 * Whether a set of user credentials actually earns us broker commission.
 *
 * Binance pays only when BOTH flags hold, so neither one alone is an answer:
 *  - `isNewUser`  — the account signed up AFTER we joined the broker program.
 *                   Fixed forever at that account's signup; no way to change it.
 *  - `rebateWorking` — the account is not bound to some other referral and is
 *                   below VIP 3. Unlike `isNewUser` this can flip either way
 *                   over the account's life, so it has to be re-checked.
 *
 * `supported: false` means the venue has no such API at all — read it as "no
 * opinion", never as "not earning".
 */
export type ReferralStatus = {
  /** Bare agent/broker code the check ran against (no `x-` clientOrderId prefix). */
  code: string
  isNewUser: boolean
  rebateWorking: boolean
  /** `isNewUser && rebateWorking` — the only field that answers "are we paid?". */
  earning: boolean
  supported: boolean
}

export enum BybitHost {
  eu = 'eu',
  com = 'com',
  nl = 'nl',
  tr = 'tr',
  kz = 'kz',
  ge = 'ge',
}

export const bybitHostMap: Record<BybitHost, string> = {
  [BybitHost.eu]: 'https://api.bybit.eu',
  [BybitHost.com]: 'https://api.bybit.com',
  [BybitHost.nl]: 'https://api.bybit.eu',
  [BybitHost.tr]: 'https://api.bybit-tr.com',
  [BybitHost.kz]: 'https://api.bybit.kz',
  [BybitHost.ge]: 'https://api.bybitgeorgia.ge',
}
