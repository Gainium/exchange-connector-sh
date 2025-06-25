declare module 'binance-api-node' {
  export interface TradesOptions {
    symbol: string
    fromId?: string
    startTime?: number
    endTime?: number
    limit?: number
  }
  export interface MarkPriceResult {
    symbol: string
    markPrice: string
    indexPrice: string
    lastFundingRate: string
    nextFundingTime: number
    time: number
  }

  export interface SymbolMaxNumOrdersFilter {
    filterType: SymbolFilterType.MAX_NUM_ORDERS
    maxNumOrders: number
    limit?: number
  }
  export interface SymbolMinNotionalFilter {
    filterType: SymbolFilterType.MIN_NOTIONAL
    minNotional: string
    notional?: string
  }
  export interface Symbol<T = OrderType_LT> {
    baseAsset: string
    baseAssetPrecision: number
    baseCommissionPrecision: number
    filters: SymbolFilter[]
    icebergAllowed: boolean
    isMarginTradingAllowed: boolean
    isSpotTradingAllowed: boolean
    ocoAllowed: boolean
    orderTypes: T[]
    permissions: TradingType_LT[]
    quoteAsset: string
    quoteAssetPrecision: number
    quoteCommissionPrecision: number
    quoteOrderQtyMarketAllowed: boolean
    quotePrecision: number
    status: string
    symbol: string
    contractStatus?: string
    contractSize?: string
    equalQtyPrecision?: string
  }
  export default function (options?: {
    apiKey?: string
    apiSecret?: string
    getTime?: () => number | Promise<number>
    httpBase?: string
    httpFutures?: string
    httpDelivery?: string
    wsBase?: string
    wsFutures?: string
    proxy?: string
  }): Binance
  export interface Binance {
    getInfo(): GetInfo
    accountInfo(options?: { useServerTime: boolean }): Promise<Account>
    tradeFee(options?: { useServerTime: boolean }): Promise<TradeFee[]>
    aggTrades(options?: TradesOptions): Promise<AggregatedTrade[]>
    allBookTickers(): Promise<{ [key: string]: Ticker }>
    book(options: { symbol: string; limit?: number }): Promise<OrderBook>
    exchangeInfo(options?: { symbol: string }): Promise<ExchangeInfo>
    lendingAccount(options?: {
      useServerTime: boolean
    }): Promise<LendingAccount>
    fundingWallet(options?: {
      asset?: string
      needBtcValuation?: booleanString
      useServerTime?: boolean
    }): Promise<FundingWallet[]>
    apiPermission(options?: { recvWindow?: number }): Promise<ApiPermission>
    order(options: NewOrderSpot): Promise<Order>
    orderTest(options: NewOrderSpot): Promise<Order>
    orderOco(options: NewOcoOrder): Promise<OcoOrder>
    ping(): Promise<boolean>
    prices(options?: { symbol?: string }): Promise<{ [index: string]: string }>
    avgPrice(options?: {
      symbol: string
    }): Promise<AvgPriceResult | AvgPriceResult[]>
    time(): Promise<number>
    trades(options: { symbol: string; limit?: number }): Promise<TradeResult[]>
    ws: WebSocket
    myTrades(options: {
      symbol: string
      orderId?: number
      startTime?: number
      endTime?: number
      fromId?: number
      limit?: number
      recvWindow?: number
      useServerTime?: boolean
    }): Promise<MyTrade[]>
    getOrder(options: GetOrderOptions): Promise<QueryOrderResult>
    getOrderOco(options: GetOrderOcoOptions): Promise<QueryOrderOcoResult>
    cancelOrder(options: CancelOrderOptions): Promise<CancelOrderResult>
    cancelOrderOco(
      options: CancelOrderOcoOptions,
    ): Promise<CancelOrderOcoResult>
    cancelOpenOrders(
      options: cancelOpenOrdersOptions,
    ): Promise<CancelOrderResult[]>
    openOrders(options: {
      symbol?: string
      recvWindow?: number
      useServerTime?: boolean
    }): Promise<QueryOrderResult[]>
    allOrders(options: {
      symbol?: string
      orderId?: number
      startTime?: number
      endTime?: number
      limit?: number
      recvWindow?: number
      timestamp?: number
      useServerTime?: boolean
    }): Promise<QueryOrderResult[]>
    allOrdersOCO(options: {
      timestamp: number
      fromId?: number
      startTime?: number
      endTime?: number
      limit?: number
      recvWindow: number
    }): Promise<QueryOrderResult[]>
    dailyStats(options?: {
      symbol: string
    }): Promise<DailyStatsResult | DailyStatsResult[]>
    candles(options: CandlesOptions): Promise<CandleChartResult[]>
    tradesHistory(options: {
      symbol: string
      limit?: number
      fromId?: number
    }): Promise<TradeResult[]>
    capitalConfigs(options?: {
      recvWindow?: number
    }): Promise<CoinInformation[]>
    depositAddress(options: {
      coin: string
      network?: string
      recvWindow?: number
    }): Promise<DepositAddress>
    withdraw(options: {
      coin: string
      network?: string
      address: string
      amount: number
      name?: string
      transactionFeeFlag?: boolean
    }): Promise<WithdrawResponse>
    assetDetail(): Promise<AssetDetail>
    getBnbBurn(): Promise<BNBBurn>
    setBnbBurn(opts: SetBNBBurnOptions): Promise<BNBBurn>
    accountSnapshot(options: {
      type: string
      startTime?: number
      endTime?: number
      limit?: number
    }): Promise<AccountSnapshot>
    withdrawHistory(options: {
      coin: string
      status?: number
      startTime?: number
      endTime?: number
      offset?: number
      limit?: number
    }): Promise<WithdrawHistoryResponse>
    depositHistory(options: {
      coin?: string
      status?: number
      startTime?: number
      endTime?: number
      offset?: number
      limit?: number
      recvWindow?: number
    }): Promise<DepositHistoryResponse>
    dustLog(options: {
      startTime?: number
      endTime?: number
      recvWindow?: number
      timestamp: number
    }): DustLog
    universalTransfer(options: UniversalTransfer): Promise<{ tranId: number }>
    universalTransferHistory(
      options: UniversalTransferHistory,
    ): Promise<UniversalTransferHistoryResponse>
    futuresPing(): Promise<boolean>
    futuresTime(): Promise<number>
    deliveryTime(): Promise<number>
    futuresExchangeInfo(): Promise<ExchangeInfo<FuturesOrderType_LT>>
    deliveryExchangeInfo(): Promise<ExchangeInfo<FuturesOrderType_LT>>
    futuresBook(options: { symbol: string; limit?: number }): Promise<OrderBook>
    futuresCandles(options: CandlesOptions): Promise<CandleChartResult[]>
    deliveryCandles(options: CandlesOptions): Promise<CandleChartResult[]>
    futuresMarkPriceCandles(
      options: CandlesOptions,
    ): Promise<CandleChartResult[]>
    futuresIndexPriceCandles(
      options: IndexPriceCandlesOptions,
    ): Promise<CandleChartResult[]>
    futuresAggTrades(options?: TradesOptions): Promise<AggregatedTrade[]>
    deliveryAggTrades(options?: TradesOptions): Promise<AggregatedTrade[]>
    futuresTrades(options: {
      symbol: string
      limit?: number
    }): Promise<TradeResult[]>
    futuresUserTrades(options: {
      symbol: string
      startTime?: number
      endTime?: number
      fromId?: number
      limit?: number
    }): Promise<FuturesUserTradeResult[]>
    futuresDailyStats(options?: {
      symbol: string
    }): Promise<DailyStatsResult | DailyStatsResult[]>
    futuresPrices(options?: {
      symbol: string
    }): Promise<{ [index: string]: string }>
    futuresAllBookTickers(): Promise<{ [key: string]: Ticker }>
    futuresMarkPrice(): Promise<MarkPriceResult[]>
    deliveryMarkPrice(): Promise<MarkPriceResult[]>
    futuresAllForceOrders(options?: {
      symbol?: string
      startTime?: number
      endTime?: number
      limit?: number
    }): Promise<AllForceOrdersResult[]>
    futuresFundingRate(options: {
      symbol: string
      startTime?: number
      endTime?: number
      limit?: number
    }): Promise<FundingRateResult[]>
    futuresOrder(options: NewFuturesOrder): Promise<FuturesOrder>
    deliveryOrder(options: NewFuturesOrder): Promise<FuturesOrder>
    futuresBatchOrders(options: {
      batchOrders: NewFuturesOrder[]
      recvWindow?: number
      timestamp?: number
    }): Promise<FuturesOrder[]>
    getMultiAssetsMargin(): Promise<MultiAssetsMargin>
    setMultiAssetsMargin(options: MultiAssetsMargin): Promise<MultiAssetsMargin>

    futuresCancelOrder(options: {
      symbol: string
      orderId?: number
      useServerTime?: boolean
      origClientOrderId?: string
      recvWindow?: number
    }): Promise<FuturesOrder>
    deliveryCancelOrder(options: {
      symbol: string
      orderId?: number
      useServerTime?: boolean
      origClientOrderId?: string
      recvWindow?: number
    }): Promise<FuturesOrder>
    futuresCancelAllOpenOrders(options: {
      symbol: string
      recvWindow?: number
    }): Promise<FuturesCancelAllOpenOrdersResult>
    deliveryCancelAllOpenOrders(options: {
      symbol: string
      recvWindow?: number
    }): Promise<FuturesCancelAllOpenOrdersResult>
    futuresCancelBatchOrders(options: {
      symbol: string
      orderIdList?: string
      origClientOrderIdList?: string
      recvWindow?: number
      timestamp?: number
    })
    futuresGetOrder(options: {
      symbol: string
      orderId?: number
      origClientOrderId?: string
      recvWindow?: number
      timestamp?: number
    }): Promise<QueryFuturesOrderResult>
    deliveryGetOrder(options: {
      symbol: string
      orderId?: number
      origClientOrderId?: string
      recvWindow?: number
      timestamp?: number
    }): Promise<QueryFuturesOrderResult>
    futuresOpenOrders(options: {
      symbol?: string
      useServerTime?: boolean
    }): Promise<QueryFuturesOrderResult[]>
    futuresAllOrders(options: {
      symbol?: string
      orderId?: number
      startTime?: number
      endTime?: number
      limit?: number
      recvWindow?: number
    }): Promise<QueryFuturesOrderResult[]>
    deliveryAllOrders(options: {
      symbol?: string
      orderId?: number
      startTime?: number
      endTime?: number
      limit?: number
      recvWindow?: number
    }): Promise<QueryFuturesOrderResult[]>
    futuresPositionRisk(options?: {
      symbol?: string
      recvWindow?: number
    }): Promise<PositionRiskResult[]>
    futuresLeverageBracket(options?: {
      symbol?: string
      recvWindow: number
    }): Promise<LeverageBracketResult[]>
    deliveryLeverageBracket(options?: {
      symbol?: string
      recvWindow: number
    }): Promise<LeverageBracketResult[]>
    futuresAccountBalance(options?: {
      recvWindow: number
    }): Promise<FuturesBalanceResult[]>
    deliveryAccountBalance(options?: {
      recvWindow: number
    }): Promise<FuturesBalanceResult[]>
    futuresAccountInfo(options?: {
      recvWindow: number
    }): Promise<FuturesAccountInfoResult>
    deliveryAccountInfo(options?: {
      recvWindow: number
    }): Promise<FuturesAccountInfoResult>
    futuresPositionMode(options?: {
      recvWindow: number
    }): Promise<PositionModeResult>
    futuresPositionModeChange(options: {
      dualSidePosition: string
      recvWindow: number
    }): Promise<ChangePositionModeResult>
    deliveryPositionMode(options?: {
      recvWindow: number
    }): Promise<PositionModeResult>
    deliveryPositionModeChange(options: {
      dualSidePosition: string
      recvWindow: number
    }): Promise<ChangePositionModeResult>
    futuresLeverage(options: {
      symbol: string
      leverage: number
      recvWindow?: number
    }): Promise<FuturesLeverageResult>
    deliveryLeverage(options: {
      symbol: string
      leverage: number
      recvWindow?: number
    }): Promise<FuturesLeverageResult>
    futuresMarginType(options: {
      symbol: string
      marginType: MarginType_LT
      recvWindow?: number
    }): Promise<FuturesMarginTypeResult>
    deliveryMarginType(options: {
      symbol: string
      marginType: MarginType_LT
      recvWindow?: number
    }): Promise<FuturesMarginTypeResult>
    futuresIncome(options: {
      symbol?: string
      incomeType?: FuturesIncomeType_LT
      startTime?: number
      endTime?: number
      limit?: number
      recvWindow?: number
    }): Promise<FuturesIncomeResult[]>
    marginOrder(options: NewOrderMargin): Promise<Order>
    marginOrderOco(options: NewOcoOrderMargin): Promise<MarginOcoOrder>
    marginGetOrder(options: {
      symbol: string
      isIsolated?: string | boolean
      orderId?: string
      origClientOrderId?: string
      recvWindow?: number
    }): Promise<Order>
    marginAllOrders(options: {
      symbol: string
      useServerTime?: boolean
    }): Promise<QueryOrderResult[]>
    marginCancelOrder(options: {
      symbol: string
      orderId?: number
      useServerTime?: boolean
    }): Promise<CancelOrderResult>
    marginOpenOrders(options: {
      symbol?: string
      useServerTime?: boolean
    }): Promise<QueryOrderResult[]>
    marginRepay(options: MarginBorrowOptions): Promise<{ tranId: number }>
    marginLoan(options: MarginBorrowOptions): Promise<{ tranId: number }>
    marginAccountInfo(options?: {
      recvWindow?: number
    }): Promise<IsolatedCrossAccount>
    marginIsolatedAccount(options?: {
      symbols?: string
      recvWindow?: number
    }): Promise<IsolatedMarginAccount>
    marginMaxBorrow(options: {
      asset: string
      isolatedSymbol?: string
      recvWindow?: number
    }): Promise<{ amount: string; borrowLimit: string }>
    marginCreateIsolated(options: {
      base: string
      quote: string
      recvWindow?: number
    }): Promise<{ success: boolean; symbol: string }>
    marginIsolatedTransfer(
      options: marginIsolatedTransfer,
    ): Promise<{ tranId: string }>
    marginIsolatedTransferHistory(
      options: marginIsolatedTransferHistory,
    ): Promise<marginIsolatedTransferHistoryResponse>
    marginMyTrades(options: {
      symbol: string
      isIsolated?: string | boolean
      startTime?: number
      endTime?: number
      limit?: number
      fromId?: number
    }): Promise<MyTrade[]>
    publicRequest(
      method: HttpMethod,
      url: string,
      payload: object,
    ): Promise<unknown>
    privateRequest(
      method: HttpMethod,
      url: string,
      payload: object,
    ): Promise<unknown>
    disableMarginAccount(options: {
      symbol: string
    }): Promise<{ success: boolean; symbol: string }>
    enableMarginAccount(options: {
      symbol: string
    }): Promise<{ success: boolean; symbol: string }>
    getPortfolioMarginAccountInfo(): Promise<{
      uniMMR: string
      accountEquity: string
      accountMaintMargin: string
      accountStatus: string
    }>
  }
}
