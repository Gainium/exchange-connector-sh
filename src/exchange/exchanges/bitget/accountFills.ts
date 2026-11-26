import type { AccountFill } from '../../types'

/** One row of `/api/v2/mix/order/fills` (`fillList`). */
export type BitgetFuturesFill = {
  tradeId: string
  symbol: string
  orderId: string
  price: string
  baseVolume: string
  feeDetail?: { feeCoin?: string; totalFee?: string }[]
  side: string
  quoteVolume?: string
  profit?: string
  enterPointSource?: string
  tradeSide?: string
  posMode?: string
  cTime: string
}

/**
 * The direction of the trade a Bitget futures fill records.
 *
 * `tradeSide` names it whenever it names the position: `close_long`,
 * `burst_close_long`, `reduce_close_long` and the like sell; `*close_short`
 * buys; one-way fills say `buy_single` / `sell_single` (`burst_buy_single` for
 * a liquidation). Otherwise, in hedge mode `side` is the POSITION's side —
 * the same convention the order mapping reads (`buy` + `close` closes a long,
 * which is a SELL) — and in one-way mode it is the trade's own.
 */
export const bitgetFillDirection = (
  f: Pick<BitgetFuturesFill, 'side' | 'tradeSide' | 'posMode'>,
): 'BUY' | 'SELL' => {
  const t = `${f.tradeSide ?? ''}`.toLowerCase()
  if (t.endsWith('close_long') || t.endsWith('sell_single')) {
    return 'SELL'
  }
  if (t.endsWith('close_short') || t.endsWith('buy_single')) {
    return 'BUY'
  }
  if (t.endsWith('open_long')) {
    return 'BUY'
  }
  if (t.endsWith('open_short')) {
    return 'SELL'
  }
  const buy = `${f.side}`.toLowerCase() === 'buy'
  if (f.posMode === 'hedge_mode' && t === 'close') {
    return buy ? 'SELL' : 'BUY'
  }
  return buy ? 'BUY' : 'SELL'
}

/**
 * Fee paid on the fill in its quote coin, positive. `undefined` when the venue
 * charged it in anything else, so a caller never adds a coin it cannot price.
 */
const quoteFee = (f: BitgetFuturesFill, quote: string): string | undefined => {
  const legs = f.feeDetail ?? []
  if (!legs.length) {
    return undefined
  }
  let total = 0
  for (const l of legs) {
    if (`${l.feeCoin ?? ''}`.toUpperCase() !== quote) {
      return undefined
    }
    const v = +`${l.totalFee ?? ''}`
    if (!Number.isFinite(v)) {
      return undefined
    }
    total += Math.abs(v)
  }
  return `${total}`
}

export const bitgetFuturesFillToAccountFill = (
  f: BitgetFuturesFill,
): AccountFill => {
  const symbol = `${f.symbol ?? ''}`.toUpperCase()
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT'
  const fee = quoteFee(f, quote)
  return {
    fillId: `${f.tradeId}`,
    orderId: `${f.orderId}`,
    clientOrderId: '',
    symbol,
    side: bitgetFillDirection(f),
    price: `${f.price}`,
    quantity: `${f.baseVolume}`,
    timestamp: +f.cTime,
    fillType: f.tradeSide,
    ...(f.enterPointSource ? { source: f.enterPointSource } : {}),
    ...(fee !== undefined ? { fee } : {}),
  }
}
