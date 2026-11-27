import type { AccountFill } from '../../types'

/** The fields of one `/v5/execution/list` row this mapping reads. */
export type BybitExecution = {
  execId: string
  orderId: string
  orderLinkId?: string
  symbol: string
  side: string
  execPrice: string
  execQty: string
  execTime: string
  execType: string
  execFee?: string
}

/**
 * Executions that move a position. `Funding` rows carry a quantity and the
 * mark price but trade nothing, and `Settle`/`Delivery`/`MovePosition`/… are
 * not fills a deal can be priced from, so only these are kept.
 */
export const BYBIT_FILL_EXEC_TYPES = ['Trade', 'BustTrade', 'AdlTrade']

/**
 * Bybit names a forced close `BustTrade` (takeover liquidation) and
 * `AdlTrade` (auto-deleveraging). They are reported in the vocabulary the
 * other fill venues use (`liquidation`, Kraken's `unwindCounterparty`) so a
 * consumer that recognises a forced close on those venues recognises it here
 * without a Bybit-specific case. Every other type passes through as sent.
 */
export const bybitFillType = (execType: string): string =>
  execType === 'BustTrade'
    ? 'liquidation'
    : execType === 'AdlTrade'
      ? 'unwindCounterparty'
      : execType

/**
 * Fee in the quote coin, positive. A linear contract settles (and charges) in
 * its quote coin; an inverse one charges in the base coin, which a caller
 * pricing in the quote coin cannot add, so it gets none. A negative fee is a
 * maker rebate — dropped rather than handed over for a caller to read as a
 * cost.
 */
const quoteFee = (e: BybitExecution, linear: boolean): string | undefined => {
  if (!linear) {
    return undefined
  }
  const v = +`${e.execFee ?? ''}`
  if (`${e.execFee ?? ''}` === '' || !Number.isFinite(v) || v < 0) {
    return undefined
  }
  return `${v}`
}

export const bybitExecutionToAccountFill = (
  e: BybitExecution,
  linear: boolean,
): AccountFill => {
  const fee = quoteFee(e, linear)
  return {
    fillId: `${e.execId}`,
    orderId: `${e.orderId}`,
    clientOrderId: `${e.orderLinkId ?? ''}`,
    symbol: `${e.symbol ?? ''}`.toUpperCase(),
    side: `${e.side}`.toLowerCase() === 'sell' ? 'SELL' : 'BUY',
    price: `${e.execPrice}`,
    quantity: `${e.execQty}`,
    timestamp: +e.execTime,
    fillType: bybitFillType(`${e.execType}`),
    ...(fee !== undefined ? { fee } : {}),
  }
}
