import type { AccountFill } from '../../types'

/**
 * The fields of one `/fapi/v1/userTrades` (USDⓈ-M) or `/dapi/v1/userTrades`
 * (COIN-M) row this mapping reads. COIN-M `qty` is in contracts, the same unit
 * the venue reports an order's `executedQty` in.
 */
export type BinanceFuturesTrade = {
  id: number | string
  orderId: number | string
  symbol: string
  side: string
  price: string
  qty: string
  time: number
  commission?: string
  commissionAsset?: string
  realizedPnl?: string
}

/**
 * The fields of one spot `/api/v3/myTrades` row this mapping reads. Spot rows
 * carry `isBuyer` instead of `side`, and no `realizedPnl`.
 */
export type BinanceSpotTrade = {
  id: number | string
  orderId: number | string
  symbol: string
  isBuyer: boolean
  price: string
  qty: string
  time: number
  commission?: string
  commissionAsset?: string
}

/**
 * A spot trade in the futures trade's shape, so one mapping serves both. The
 * fee rule is the same: it counts only when charged in the symbol's quote coin
 * (a fee taken in the base coin or in BNB is left out).
 */
export const binanceSpotTradeAsTrade = (
  t: BinanceSpotTrade,
): BinanceFuturesTrade => ({
  id: t.id,
  orderId: t.orderId,
  symbol: t.symbol,
  side: t.isBuyer ? 'BUY' : 'SELL',
  price: `${t.price}`,
  qty: `${t.qty}`,
  time: +t.time,
  commission: t.commission,
  commissionAsset: t.commissionAsset,
})

/**
 * Who placed an order, read off the client order id Binance stamps on every
 * order that was not given one over the API. A hand trade carries its channel
 * (`web_…`, `ios_…`, `android_…`, `electron_…` for the desktop app); the
 * venue's own closes carry `autoclose-…` (liquidation), `adl_autoclose…`
 * (auto-deleveraging) or `…settlement_autoclose…` / `…delivery_autoclose…`
 * (contract delivery). Anything else was supplied by an API client — a bot's
 * order, or another tool's — and is reported as `API` with its id kept.
 */
export const binanceOrderOrigin = (
  clientOrderId: string,
): { source: string; fillType?: string; venueAssigned: boolean } => {
  const id = `${clientOrderId ?? ''}`.toLowerCase()
  if (id.startsWith('adl_autoclose')) {
    return { source: 'SYS', fillType: 'unwindCounterparty', venueAssigned: true }
  }
  if (id.startsWith('autoclose-')) {
    return { source: 'SYS', fillType: 'liquidation', venueAssigned: true }
  }
  if (
    id.includes('settlement_autoclose') ||
    id.includes('delivery_autoclose')
  ) {
    return { source: 'SYS', fillType: 'settlement', venueAssigned: true }
  }
  const channel = id.match(/^(web|ios|android|electron)_/)?.[1]
  if (channel) {
    return { source: channel.toUpperCase(), venueAssigned: true }
  }
  return { source: 'API', venueAssigned: false }
}

/**
 * Fee in the quote coin, positive. USDⓈ-M charges in the margin coin unless
 * the account pays in BNB, so the fee counts only when `commissionAsset` is
 * the symbol's quote. COIN-M charges in the base coin, which a caller pricing
 * in the quote coin cannot add, so it gets none. `usdm` is "the fee may be in
 * the quote coin": true for USDⓈ-M and for spot, false for COIN-M.
 */
const quoteFee = (
  t: BinanceFuturesTrade,
  usdm: boolean,
): string | undefined => {
  const asset = `${t.commissionAsset ?? ''}`.toUpperCase()
  const raw = `${t.commission ?? ''}`
  const v = Math.abs(+raw)
  if (
    !usdm ||
    !asset ||
    !`${t.symbol ?? ''}`.toUpperCase().endsWith(asset) ||
    raw === '' ||
    !Number.isFinite(v)
  ) {
    return undefined
  }
  return `${v}`
}

/**
 * One trade as an `AccountFill`, attributed through its order's client id.
 * `clientOrderId` is the id an API client supplied; a venue-assigned id (a
 * hand trade's channel id, a liquidation's `autoclose-…`) is not one of ours
 * and is reported empty, with the channel as `source`, so a caller excludes a
 * bot's own fills and keeps everything the bot did not place.
 */
export const binanceTradeToAccountFill = (
  t: BinanceFuturesTrade,
  clientOrderId: string,
  usdm: boolean,
): AccountFill => {
  const origin = binanceOrderOrigin(clientOrderId)
  const fee = quoteFee(t, usdm)
  return {
    fillId: `${t.id}`,
    orderId: `${t.orderId}`,
    clientOrderId: origin.venueAssigned ? '' : `${clientOrderId}`,
    symbol: `${t.symbol ?? ''}`.toUpperCase(),
    side: `${t.side}`.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    price: `${t.price}`,
    quantity: `${t.qty}`,
    timestamp: +t.time,
    source: origin.source,
    ...(origin.fillType ? { fillType: origin.fillType } : {}),
    ...(fee !== undefined ? { fee } : {}),
    ...(t.realizedPnl !== undefined && `${t.realizedPnl}` !== ''
      ? { realizedPnl: `${t.realizedPnl}` }
      : {}),
  }
}

/**
 * Trades mapped newest first, each attributed through `clientIds` (the
 * venue's order id → that order's client order id). The list stops at the
 * newest trade whose order could not be attributed: that trade could be one
 * of the bot's own, and dropping it from the middle would let a caller walking
 * the fills newest first reach past it into older ones. What is returned is
 * always an unbroken newest-first run.
 */
export const binanceTradesToAccountFills = (
  trades: BinanceFuturesTrade[],
  clientIds: Map<string, string>,
  usdm: boolean,
): AccountFill[] => {
  const fills: AccountFill[] = []
  const newestFirst = [...trades].sort((a, b) => +b.time - +a.time)
  for (const t of newestFirst) {
    const cid = clientIds.get(`${t.orderId}`)
    if (cid === undefined) {
      break
    }
    fills.push(binanceTradeToAccountFill(t, cid, usdm))
  }
  return fills
}
