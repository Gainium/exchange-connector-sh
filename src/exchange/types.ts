export type ExchangeInfo = {
  wsCode?: string
  code?: string
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

export type VerifyResponse = { status: boolean; reason: string }

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
export type UserFee = { maker: number; taker: number }
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
 * Legacy zone codes that used to be stored in the per-account `bybitHost`
 * field before the domain migration. Kept only so the connector can still
 * resolve accounts that have not been migrated yet (and dropdowns that still
 * emit the old codes). New accounts store the bare frontend host directly,
 * e.g. `bybit.eu`. Once the migration has run everywhere this can be dropped.
 */
const legacyBybitZoneMap: Record<string, string> = {
  eu: 'bybit.eu',
  com: 'bybit.com',
  nl: 'bybit.nl',
  kz: 'bybit.kz',
  ge: 'bybitgeorgia.ge',
  tr: 'bybit-tr.com',
  ae: 'bybit.ae',
  id: 'bybit.id',
}

/**
 * Normalize a user-supplied Bybit domain (or legacy zone code) to a bare
 * frontend host. Scheme, path, port and any leading `www`/`api`/`stream`
 * label are stripped, so `https://www.bybit.com/login`, `api.bybit.eu` and
 * `bybit.eu` all collapse to `bybit.eu`. Bybit's REST and WS hosts are
 * uniformly `api.<host>` / `stream.<host>`, so no curated per-region table
 * is needed — we route to whatever domain the user declared.
 */
export function normalizeBybitHost(input?: string): string {
  const fallback = 'bybit.com'
  if (!input) return fallback
  const raw = input.trim().toLowerCase()
  if (!raw) return fallback
  if (legacyBybitZoneMap[raw]) return legacyBybitZoneMap[raw]
  let host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.split(/[/?#]/)[0].split(':')[0]
  host = host.replace(/^(www|api|stream)\./, '')
  return host || fallback
}

/** Build the Bybit REST base URL from a user-supplied domain / legacy zone. */
export function bybitRestUrl(input?: string): string {
  return `https://api.${normalizeBybitHost(input)}`
}
