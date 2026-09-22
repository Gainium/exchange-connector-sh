import {
  CandleResponse,
  CommonOrder,
  ExchangeIntervals,
  FreeAsset,
  OrderStatusType,
  PositionInfo,
  PositionSide,
} from '../../types'
import { normalizeOrderFees } from '../../helpers/orderFee'
import { keyFingerprint } from '../../../utils/keyFingerprint'

/**
 * Bitget runs two account systems side by side and an account is in exactly
 * one of them:
 *
 * - **Classic** — the v2 API (`/api/v2/spot/*`, `/api/v2/mix/*`).
 * - **Unified Trading Account (UTA)** — the v3 API (`/api/v3/*`). Every
 *   classic private endpoint refuses a unified account with
 *   "you are in unified account mode, and the classic account api is not
 *   supported at this time", and Reality stock tokens (rTokens, `RAAPLUSDT`)
 *   can only be traded from one.
 *
 * Public market data is account-independent, so exchange info, tickers and
 * candles stay on v2 for both. Only the private surface is chosen per key.
 */

export type BitgetAccountMode = 'classic' | 'uta'

const MODE_TTL_MS = 15 * 60 * 1000

const modeCache = new Map<string, { mode: BitgetAccountMode; at: number }>()

export const getCachedAccountMode = (
  key: string,
): BitgetAccountMode | undefined => {
  const hit = modeCache.get(keyFingerprint(key))
  if (!hit || Date.now() - hit.at > MODE_TTL_MS) {
    return undefined
  }
  return hit.mode
}

export const setCachedAccountMode = (key: string, mode: BitgetAccountMode) => {
  modeCache.set(keyFingerprint(key), { mode, at: Date.now() })
}

/** Test hook — the cache is process-wide. */
export const clearAccountModeCache = () => modeCache.clear()

/**
 * `GET /api/v3/account/settings` answers a unified account with its
 * `accountMode`. `hybrid` and `upgrading` are unified for API purposes;
 * `switching` is on its way back to classic.
 */
export const accountModeFromSettings = (
  data: unknown,
): BitgetAccountMode | undefined => {
  const mode = `${(data as { accountMode?: unknown })?.accountMode ?? ''}`
    .trim()
    .toLowerCase()
  if (mode === 'unified' || mode === 'hybrid' || mode === 'upgrading') {
    return 'uta'
  }
  if (mode === 'switching') {
    return 'classic'
  }
  return undefined
}

/** The refusal every classic private endpoint gives a unified account. */
export const isUnifiedModeRefusal = (reason: unknown): boolean =>
  `${reason ?? ''}`.toLowerCase().includes('unified account mode')

/**
 * What a user sees when a classic account picks a Reality token. Bitget's own
 * answer to that order is not specific enough to act on.
 */
export const REALITY_NEEDS_UTA =
  'Bitget Reality stock tokens can only be traded from a Bitget Unified Trading Account. Upgrade the account to Unified on Bitget to trade this pair.'

/**
 * Upgrading an account to Unified does not upgrade its API keys: v3 endpoints
 * answer a key without the unified scopes with "incorrect permissions, need
 * uta manage read or uta manage write permissions", which says nothing about
 * what to do. The key has to be edited on Bitget, not replaced.
 */
export const UTA_MISSING_PERMISSIONS =
  'This Bitget API key does not carry the Unified Trading Account permissions. Edit the key on Bitget, enable UTA management (read) and UTA trading, and save it.'

export const isUtaPermissionRefusal = (reason: unknown): boolean =>
  `${reason ?? ''}`.toLowerCase().includes('uta manage')

/**
 * Bitget's unified COIN-M line is a different product from the classic one we
 * list: its symbols carry a `_CM` suffix (BTCUSD_CM), its order quantity is
 * denominated in the quote coin, and it has no preset TP/SL. Routing classic
 * COIN-M pairs to it would size every order in the wrong unit.
 */
export const UTA_COINM_UNSUPPORTED =
  'Bitget COIN-M futures are not supported for Unified Trading Accounts yet. Use USDT-M or USDC-M futures, or a Classic account.'

/**
 * Bitget's inverse perpetuals live only on the unified line, where they carry
 * a `_CM` suffix (`BTCUSD_CM`) that exists to keep them apart from the classic
 * delivery contracts. The platform knows them by the name the classic
 * perpetual had, so the suffix is added on the way out and stripped on the way
 * back (spec 014 §3.2).
 */
export const utaCoinmSymbol = (pair: string): string =>
  pair.endsWith('_CM') ? pair : `${pair}_CM`

export const platformCoinmSymbol = (symbol: string): string =>
  symbol.replace(/_CM$/, '')

export const isUtaCoinmSymbol = (symbol: string): boolean =>
  symbol.endsWith('_CM')

/** What a classic account sees when it picks an inverse perpetual. */
export const COINM_PERP_NEEDS_UTA =
  'Bitget inverse perpetuals can only be traded from a Bitget Unified Trading Account. Upgrade the account to Unified on Bitget to trade this pair.'

/**
 * An inverse order's quantity is a whole number of 1-USD contracts on the
 * unified line, while the platform sizes this product type in the base coin
 * (spec 014 §3.4). One contract is one USD of notional, so the two differ by
 * the price.
 */
export const coinmContracts = (
  base: number,
  price: number,
  minQty = 1,
): number => {
  const contracts = Math.round(base * price)
  return Math.max(contracts, minQty)
}

export const coinmBase = (contracts: number, price: number): number =>
  price > 0 ? contracts / price : 0

/**
 * Which unit a v3 inverse order reports its quantity in. The venue documents
 * one answer for every category and the request in another (§2.4), so the
 * answer is taken from figures that have to agree with each other: an order
 * that has traded reports `cumExecValue` in the currency its quantity is not
 * in. Without fills there is nothing to check against and the request's own
 * unit stands.
 */
export const utaInverseQtyUnit = (order: {
  cumExecQty?: string
  cumExecValue?: string
  avgPrice?: string
}): 'base' | 'quote' => {
  const qty = parseFloat(`${order.cumExecQty ?? ''}`)
  const value = parseFloat(`${order.cumExecValue ?? ''}`)
  const price = parseFloat(`${order.avgPrice ?? ''}`)
  if (!(qty > 0) || !(value > 0) || !(price > 0)) {
    return 'quote'
  }
  const asBase = Math.abs(qty * price - value)
  const asQuote = Math.abs(qty / price - value)
  return asBase <= asQuote ? 'base' : 'quote'
}

/**
 * Which spot symbols are Reality tokens, from v3 instruments `isReality`.
 * Refreshed hourly; a failed refresh is retried after a minute rather than on
 * every candle request.
 */
const REALITY_TTL_MS = 60 * 60 * 1000
const REALITY_RETRY_MS = 60 * 1000

let reality: { symbols: Set<string>; at: number; attemptAt: number } = {
  symbols: new Set(),
  at: 0,
  attemptAt: 0,
}

export const setRealitySymbols = (symbols: Iterable<string> | null) => {
  const now = Date.now()
  reality = symbols
    ? { symbols: new Set(symbols), at: now, attemptAt: now }
    : { ...reality, attemptAt: now }
}

/** The cached set, or `undefined` when it is due a refresh. */
export const getRealitySymbols = (): Set<string> | undefined => {
  const now = Date.now()
  const fresh = now - reality.at <= REALITY_TTL_MS
  const recentlyTried = now - reality.attemptAt <= REALITY_RETRY_MS
  return fresh || recentlyTried ? reality.symbols : undefined
}

/**
 * Reality candles exist only at 1min/5min/15min/1h/4h/1day/1week (every other
 * classic granularity is a 400), and their `1day`/`1week` buckets start at
 * 16:00 UTC — not the UTC midnight every other Bitget pair is served at
 * (`1Dutc`). A request is therefore served from the native interval that
 * divides it evenly and is itself UTC-aligned, and aggregated up
 * (`aggregateCandles`) when the two differ. 4h buckets are UTC-aligned.
 */
export const realityBaseInterval = (
  interval: ExchangeIntervals,
): ExchangeIntervals => {
  switch (interval) {
    case ExchangeIntervals.oneM:
    case ExchangeIntervals.threeM:
      return ExchangeIntervals.oneM
    case ExchangeIntervals.fiveM:
      return ExchangeIntervals.fiveM
    case ExchangeIntervals.fifteenM:
    case ExchangeIntervals.thirtyM:
      return ExchangeIntervals.fifteenM
    case ExchangeIntervals.oneH:
    case ExchangeIntervals.twoH:
      return ExchangeIntervals.oneH
    default:
      // 4h, 8h, 1d, 1w
      return ExchangeIntervals.fourH
  }
}

/** The Bitget granularity for a native Reality interval. */
export const realityGranularity = (interval: ExchangeIntervals): string =>
  ({
    [ExchangeIntervals.oneM]: '1min',
    [ExchangeIntervals.fiveM]: '5min',
    [ExchangeIntervals.fifteenM]: '15min',
    [ExchangeIntervals.oneH]: '1h',
    [ExchangeIntervals.fourH]: '4h',
  })[realityBaseInterval(interval)]

/**
 * The interval a NON-Reality Bitget pair's candles are actually read at, for
 * the widths the venue has no granularity of its own for. Everything else is
 * returned unchanged and is requested natively.
 *
 * Measured against the live API 2026-09-22 — an unsupported granularity is
 * answered `400171` naming the accepted set (spec 017 §2.1):
 *
 *   v2 futures   1m 3m 5m 15m 30m 1H 2H 4H 6H 12H 1D 1W ...   — no 8h
 *   v2 spot      1min 3min 5min 15min 30min 1h 4h 6h 12h ...   — no 2h, no 8h
 *   v3 unified   1m 3m 5m 15m 30m 1H 2H 4H 6H 12H 1D 1W ...   — no 8h
 *
 * So `8h` is merged from `4h` everywhere — the coarsest native width that
 * divides it, as `realityBaseInterval` also picks — and `2h` is merged from
 * `1h` on spot only. Both are exact multiples of their base and both align to
 * UTC midnight, so the merge is lossless (`aggregateCandles`).
 *
 * Substituting a different width instead of merging is what made an indicator
 * configured at 8h compute on 6-hour bars, with no error (bug #913).
 */
export const bitgetBaseInterval = (
  interval: ExchangeIntervals,
  futures: boolean,
): ExchangeIntervals => {
  if (interval === ExchangeIntervals.eightH) {
    return ExchangeIntervals.fourH
  }
  if (interval === ExchangeIntervals.twoH && !futures) {
    return ExchangeIntervals.oneH
  }
  return interval
}

/** 1970-01-01 was a Thursday; weeks start on Monday, 4 days later. */
const WEEK_ALIGN_MS = 4 * 24 * 60 * 60 * 1000

/**
 * Candles of a finer interval merged into `stepMs` buckets aligned to UTC
 * (weeks to Monday 00:00 UTC). Input need not be sorted or deduplicated;
 * the last bucket may be partial, as a live candle is.
 */
export const aggregateCandles = (
  candles: CandleResponse[],
  stepMs: number,
  weekly = false,
): CandleResponse[] => {
  const offset = weekly ? WEEK_ALIGN_MS : 0
  const seen = new Set<number>()
  const sorted = [...candles]
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time)
  const buckets = new Map<number, CandleResponse>()
  for (const c of sorted) {
    const time = Math.floor((c.time - offset) / stepMs) * stepMs + offset
    const b = buckets.get(time)
    if (!b) {
      buckets.set(time, { ...c, time })
      continue
    }
    b.high = `${Math.max(+b.high, +c.high)}`
    b.low = `${Math.min(+b.low, +c.low)}`
    b.close = c.close
    b.volume = `${(+b.volume || 0) + (+c.volume || 0)}`
  }
  const result = [...buckets.values()]
  // A range that starts mid-bucket leaves the first bucket without its open;
  // drop it rather than report a truncated candle as a whole one. That holds
  // whether or not anything follows it: guarding on `length > 1` left the
  // single-bucket case returning a bar that held only the tail of its bucket
  // — stamped at the bucket's start, indistinguishable from a whole one, and
  // written into the archive as permanent history (bug #917, spec 020). An
  // empty result is the honest answer and callers read it as a gap still to
  // fill. Same shape as the sibling helper in `kraken/candles.ts`.
  if (result.length && sorted[0].time !== result[0].time) {
    result.shift()
  }
  return result
}

export type UtaCategory =
  'SPOT' | 'USDT-FUTURES' | 'USDC-FUTURES' | 'COIN-FUTURES'

export const utaFuturesCategory = (symbol: string): UtaCategory =>
  symbol.endsWith('USDT') ? 'USDT-FUTURES' : 'USDC-FUTURES'

/** v3 answers `yes`/`YES`, `no`/`NO` depending on the endpoint. */
const yes = (v: unknown) => `${v ?? ''}`.toLowerCase() === 'yes'

const num = (v: unknown) => {
  const n = parseFloat(`${v ?? ''}`)
  return Number.isFinite(n) ? n : 0
}

export type UtaOrder = {
  orderId: string
  clientOid: string
  category: string
  symbol: string
  orderType: string
  side: string
  price: string
  qty: string
  amount?: string
  cumExecQty: string
  cumExecValue: string
  avgPrice: string
  orderStatus: string
  posSide?: string
  holdMode?: string
  reduceOnly?: string
  feeDetail?: { feeCoin?: string; fee?: string }[]
  createdTime: string
  updatedTime: string
}

const utaOrderStatus = (status: string): OrderStatusType => {
  if (status === 'live' || status === 'new') {
    return 'NEW'
  }
  if (status === 'partially_filled') {
    return 'PARTIALLY_FILLED'
  }
  if (status === 'filled') {
    return 'FILLED'
  }
  return 'CANCELED'
}

/**
 * v3 orders are one shape for every category. Unlike classic futures, `side`
 * is always the direction of the order itself (hedge mode says which position
 * it acts on through `posSide`), so there is no open/close inversion to undo.
 */
export const convertUtaOrder = (
  order: UtaOrder,
  inverse = false,
): CommonOrder => {
  const futures = `${order.category}`.toUpperCase().includes('FUTURES')
  const market = order.orderType === 'market'
  const result: CommonOrder = {
    ...normalizeOrderFees(
      (order.feeDetail ?? []).map((f) => ({
        amount: f?.fee,
        asset: `${f?.feeCoin ?? ''}`,
      })),
    ),
    symbol: inverse ? platformCoinmSymbol(order.symbol) : order.symbol,
    orderId: order.orderId,
    clientOrderId: order.clientOid,
    transactTime: +order.updatedTime,
    updateTime: +order.createdTime,
    price: market ? `${num(order.avgPrice) || num(order.price)}` : order.price,
    origQty: order.qty,
    executedQty: order.cumExecQty,
    cummulativeQuoteQty: order.cumExecValue,
    status: utaOrderStatus(order.orderStatus),
    type: market ? 'MARKET' : 'LIMIT',
    side: order.side === 'sell' ? 'SELL' : 'BUY',
    fills: [],
  }
  if (futures) {
    result.reduceOnly = yes(order.reduceOnly)
    result.positionSide =
      order.holdMode === 'hedge_mode'
        ? order.posSide === 'short'
          ? PositionSide.SHORT
          : PositionSide.LONG
        : PositionSide.BOTH
  }
  // An inverse order is sized in 1-USD contracts on the venue and in the base
  // coin everywhere else (spec 014 §3.4). Without a price there is nothing to
  // convert with, and the venue's own figures are left as they came.
  const price = num(order.avgPrice) || num(order.price)
  if (inverse && price > 0 && utaInverseQtyUnit(order) === 'quote') {
    result.origQty = `${coinmBase(num(order.qty), price)}`
    result.executedQty = `${coinmBase(num(order.cumExecQty), price)}`
    // The contracts themselves are the traded notional.
    result.cummulativeQuoteQty = order.cumExecQty
  }
  return result
}

export type UtaPosition = {
  symbol: string
  posSide: string
  holdMode?: string
  marginMode: string
  positionBalance: string
  total: string
  leverage: string
  avgPrice: string
  unrealisedPnl: string
  updatedTime: string
}

export const convertUtaPosition = (
  position: UtaPosition,
  inverse = false,
): PositionInfo => ({
  symbol: inverse ? platformCoinmSymbol(position.symbol) : position.symbol,
  initialMargin: position.positionBalance,
  maintMargin: position.positionBalance,
  unrealizedProfit: position.unrealisedPnl,
  positionInitialMargin: position.positionBalance,
  openOrderInitialMargin: position.positionBalance,
  leverage: position.leverage,
  isolated: position.marginMode === 'isolated',
  entryPrice: position.avgPrice,
  maxNotional: '',
  // v3 names the side of every position, one-way included.
  positionSide:
    position.posSide === 'short' ? PositionSide.SHORT : PositionSide.LONG,
  // Inverse positions are held in 1-USD contracts; the platform holds this
  // product type in the base coin (spec 014 §3.4).
  positionAmt:
    inverse && num(position.avgPrice) > 0
      ? `${coinmBase(num(position.total), num(position.avgPrice))}`
      : position.total,
  notional: '',
  isolatedWallet: '',
  updateTime: +position.updatedTime,
  bidNotional: '',
  askNotional: '',
})

export type UtaAsset = {
  coin: string
  balance?: string
  available?: string
  locked?: string
}

/**
 * One unified wallet backs spot and futures alike. `free` and `locked` must be
 * a partition of the coin's balance (consumers render `free + locked` as the
 * total), so `locked` is whatever the venue does not report as available —
 * order-frozen funds plus margin committed to positions — rather than the
 * order-frozen `locked` field alone, which would leave position margin in
 * `free` and count it twice.
 */
export const convertUtaAssets = (
  assets: UtaAsset[],
  coins?: string[],
): FreeAsset =>
  (assets ?? [])
    .filter((a) => !coins || coins.includes(a.coin))
    .map((a) => {
      const balance = num(a.balance) || num(a.available) + num(a.locked)
      const free = Math.min(Math.max(num(a.available), 0), balance)
      return { asset: a.coin, free, locked: balance - free }
    })
