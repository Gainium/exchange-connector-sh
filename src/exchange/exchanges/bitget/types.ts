import { FuturesOpenOrderV2 } from 'bitget-api'

export type SpotAccountType = {
  userId: string
  inviterId: string
  ips: string
  authorities: string[]
  parentId: number
  traderType: string
  channelCode: string
  channel: string
  regisTime: string
}

export type FuturesContractConfig = {
  symbol: string
  baseCoin: string
  quoteCoin: string
  buyLimitPriceRatio: string
  sellLimitPriceRatio: string
  feeRateUpRatio: string
  makerFeeRate: string
  takerFeeRate: string
  openCostUpRatio: string
  supportMarginCoins: string[]
  minTradeNum: string
  priceEndStep: string
  volumePlace: string
  pricePlace: string
  sizeMultiplier: string
  symbolType: string
  minTradeUSDT: string
  maxSymbolOrderNum: string
  maxProductOrderNum: string
  maxPositionNum: string
  symbolStatus: string
  offTime: string
  limitOpenTime: string
  deliveryTime: string
  deliveryStartTime: string
  launchTime: string
  fundInterval: string
  minLever: string
  maxLever: string
  posLimit: string
  maintainTime: string
}

export type FuturesAssets = {
  marginCoin: string
  locked: string
  available: string
  crossedMaxAvailable: string
  isolatedMaxAvailable: string
  maxTransferOut: string
  accountEquity: string
  usdtEquity: string
  btcEquity: string
  crossedRiskRate: string
  unrealizedPL: string
  coupon: string
  unionTotalMagin: string
  unionAvailable: string
  unionMm: string
  assetList: {
    coin: string
    balance: string
  }[]
}

export type FuturesSubmitOrderResponse = {
  clientOid: string
  orderId: string
}

export type FuturesOrder = {
  symbol: string
  size: string
  orderId: string
  clientOid: string
  baseVolume: string
  priceAvg: string
  fee: string
  price: string
  state?: string
  status?: string
  side: string
  force: string
  totalProfits: string
  posSide: string
  marginCoin: string
  presetStopSurplusPrice: string
  presetStopLossPrice: string
  quoteVolume: string
  orderType: string
  leverage: string
  marginMode: string
  reduceOnly: string
  enterPointSource: string
  tradeSide: string
  posMode: string
  orderSource: string
  cancelReason: string
  cTime: string
  uTime: string
}

export type FuturesCancelOrder = {
  orderId: string
  clientOid: string
}

export type FuturesAllOpenOrders = {
  entrustedList: FuturesOpenOrderV2[]
  endId: string
}

export type FuturesPosition = {
  marginCoin: string
  symbol: string
  holdSide: string
  openDelegateSize: string
  marginSize: string
  available: string
  locked: string
  total: string
  leverage: string
  achievedProfits: string
  openPriceAvg: string
  marginMode: string
  posMode: string
  unrealizedPL: string
  liquidationPrice: string
  keepMarginRate: string
  markPrice: string
  breakEvenPrice: string
  totalFee: string
  deductedFee: string
  marginRatio: string
  assetMode: string
  cTime: string
  uTime: string
}

export type FuturesAllTickers = {
  symbol: string
  lastPr: string
  askPr: string
  bidPr: string
  bidSz: string
  askSz: string
  high24h: string
  low24h: string
  ts: string
  change24h: string
  baseVolume: string
  quoteVolume: string
  usdtVolume: string
  openUtc: string
  changeUtc24h: string
  indexPrice: string
  fundingRate: string
  holdingAmount: string
  deliveryStartTime: string
  deliveryTime: string
  deliveryStatus: string
  open24h: string
  markPrice: string
}

export type FuturesSetMarginResponse = {
  symbol: string
  marginCoin: string
  longLeverage: string
  shortLeverage: string
  marginMode: string
}

export type FuturesSingleAccount = {
  marginCoin: string
  locked: string
  available: string
  crossedMaxAvailable: string
  isolatedMaxAvailable: string
  maxTransferOut: string
  accountEquity: string
  usdtEquity: string
  btcEquity: string
  crossedRiskRate: string
  crossedMarginLeverage: string
  isolatedLongLever: string
  isolatedShortLever: string
  marginMode: string
  posMode: string
  unrealizedPL: string
  coupon: string
}

export type FuturesSetHedgeResponse = {
  posMode: string
}

export type SpotExchangeInfo = {
  symbol: string
  baseCoin: string
  quoteCoin: string
  minTradeAmount: string
  maxTradeAmount: string
  takerFeeRate: string
  makerFeeRate: string
  pricePrecision: string
  quantityPrecision: string
  quotePrecision: string
  minTradeUSDT: string
  status: string
  buyLimitPriceRatio: string
  sellLimitPriceRatio: string
  orderQuantity: string
  areaSymbol: string
}

export type SpotOrder = {
  userId: string
  symbol: string
  orderId: string
  clientOid: string
  priceAvg: string
  size: string
  orderType: string
  side: string
  status: string
  basePrice: string
  baseVolume: string
  quoteVolume: string
  enterPointSource: string
  cTime: string
  uTime: string
  tpslType: string
  triggerPrice: string
}

export type SpotAssets = {
  coin: string
  available: string
  frozen: string
  locked: string
  limitAvailable: string
  uTime: string
}
