import { APIResponseV3 as APIResponse, OrderSide, OrderTypeV5 } from 'bybit-api'

export type BybitGetOrderResponse = APIResponse<BybitOrder>

export type BybitCancelOrderResponse = APIResponse<BybitCancelOrder>

export type BybitGetSymbolsResponse = APIResponse<{ list: BybitSymbol[] }>

export type BybitGetOpenOrdersResponse = APIResponse<{ list: BybitOrder[] }>

export type BybitLatestTradePriceResponse = APIResponse<BybitLatestPrice>

export type BybitLatestTradePricesResponse = APIResponse<{
  list: BybitLatestPrice[]
}>

export type BybitSubmitOrderResponse = APIResponse<BybitSubmitOrderResultData>

export type BybitGetTradeHistoryResponse = APIResponse<{ list: BybitTrade[] }>

export type BybitGetKlinesResponse = APIResponse<{ list: BybitKline[] }>

export type BybitCancelOrder = {
  orderId: string
  orderLinkId: string
  symbol: string
  status: BybitOrderStatus
  accountId: string
  createTime: string
  orderPrice: string
  orderQty: string
  execQty: string
  timeInForce: string
  orderType: OrderTypeV5
  side: OrderSide
}

export type BybitSymbol = {
  name: string
  alias: string
  baseCoin: string
  quoteCoin: string
  basePrecision: string
  quotePrecision: string
  minTradeQty: string
  minTradeAmt: string
  maxTradeQty: string
  maxTradeAmt: string
  minPricePrecision: string
  category: string
  showStatus: '0' | '1'
  innovation: '0' | '1'
}

export type BybitOrder = {
  accountId: string
  symbol: string
  orderLinkId: string
  orderId: string
  orderPrice: string
  orderQty: string
  execQty: string
  cummulativeQuoteQty: string
  avgPrice: string
  status: BybitOrderStatus
  timeInForce: string
  orderType: OrderTypeV5
  side: string
  stopPrice: string
  icebergQty: string
  createTime: number
  updateTime: number
  isWorking: '0' | '1'
}

export type BybitBalance = {
  coin: string
  coinId: string
  total: string
  free: string
  locked: string
}

export type BybitLatestPrice = {
  symbol: string
  price: string
}

export type BybitSubmitOrderResultData = {
  orderId: string
  orderLinkId: string
  symbol: string
  createTime: string
  orderPrice: string
  orderQty: string
  orderType: OrderTypeV5
  side: OrderSide
  status: BybitOrderStatus
  timeInForce: string
  accountId: string
  orderCategory: number
  triggerPrice: string
}

export type BybitTrade = {
  symbol: string
  id: string
  orderId: string
  tradeId: string
  orderPrice: string
  orderQty: string
  execFee: string
  feeTokenId: string
  creatTime: string
  isBuyer: '0' | '1'
  isMaker: '0' | '1'
  matchOrderId: string
  makerRebate: string
  executionTime: string
}

export type BybitKline = {
  t: number
  s: string
  sn: string
  c: string
  h: string
  l: string
  o: string
  v: string
}

export enum BybitOrderStatus {
  NEW = 'NEW',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELED = 'CANCELED',
  PENDING_CANCEL = 'PENDING_CANCEL',
  PENDING_NEW = 'PENDING_NEW',
  REJECTED = 'REJECTED',
}
