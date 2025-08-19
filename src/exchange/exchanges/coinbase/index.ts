import AbstractExchange, { Exchange } from '../../abstractExchange'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  ExchangeIntervals,
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
  CoinbaseKeysType,
  maxTime,
  TimeProfile,
  RebateOverview,
  RebateRecord,
} from '../../types'
import {
  Coinbase,
  Order,
  OrderStatus,
  Pagination,
  NewOrder,
  OrderSide,
  OrderConfiguration,
  CandleGranularity,
  OrderType,
  LimitOrderGTC,
  MarketOrder,
  Product,
  Candle,
  PaginatedData,
  Account,
  CancelOrderResponse,
  CoinbaseFees,
  CreateOrderResponse,
} from 'coinbase-advanced-node'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { AxiosError } from 'axios'

class CoinbaseError extends Error {}

type CoinbaseErrorResponse = {
  error: string
  code?: number
  message: string
  details?: {
    type_url: string
    value: string
  }
}

type FullExchangeInfo = ExchangeInfo & {
  pair: string
}

class CoinbaseExchange extends AbstractExchange implements Exchange {
  /** Coinbase client */
  private client: Coinbase
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  /** Error code that might mean account ip 30 minutes ban */
  private ipBlockError: string

  private futures?: Futures

  private useDefault = false

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: 'live' | 'sandbox',
    keysType?: CoinbaseKeysType,
    _okxSource?: string,
    _code?: string,
    _bybitHost?: string,
  ) {
    super({ key, secret })
    const options =
      keysType === CoinbaseKeysType.legacy
        ? {
            apiKey: this.key ?? '',
            apiSecret: this.secret ?? '',
          }
        : {
            cloudApiKeyName: this.key ?? '',
            cloudApiSecret: this.secret ?? '',
          }
    this.client = new Coinbase(options)
    this.retry = 10
    this.retryErrors = ['504', '429', '500', '503', '502', '520', '521', '522']
    this.ipBlockError = '403'
    this.futures = futures === Futures.null ? this.futures : futures
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

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return this.futures === Futures.coinm
  }

  async getUid(): Promise<BaseReturn<string | number>> {
    return this.returnGood<string | number>(this.getEmptyTimeProfile())(-1)
  }
  async getAffiliate(_uid: string | number): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>(this.getEmptyTimeProfile())(false)
  }

  private getClientWithDefaultKeys() {
    if (!this.key || !this.secret) {
      this.key = process.env.COINBASEKEY
      this.secret = process.env.COINBASESECRET
      this.useDefault = true
      this.client = new Coinbase({
        cloudApiKeyName: this.key,
        cloudApiSecret: this.secret,
      })
    }
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async futures_changeLeverage(): Promise<BaseReturn<number>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getBalance() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_openOrder() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getOrder() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_cancelOrder() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_cancelOrderByOrderIdAndSymbol() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_latestPrice() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getExchangeInfo() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getAllExchangeInfo() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getAllOpenOrders() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getUserFees() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getAllUserFees() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getPositions(): Promise<BaseReturn<PositionInfo[]>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getCandles() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getAllPrices() {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_changeMarginType(): Promise<BaseReturn<MarginType>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_getHedge(): Promise<BaseReturn<boolean>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_setHedge(): Promise<BaseReturn<boolean>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  async futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>> {
    return this.errorFutures(this.getEmptyTimeProfile())
  }

  private async callWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`Internal timeout ${maxTime}ms exceeded`))
      }, maxTime)
      fn().then(resolve).catch(reject)
    })
  }

  async getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile

    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<PaginatedData<Account>>(() =>
      this.client.rest.account.listAccounts(),
    )
      .then((account) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (account.data.length) {
          return this.returnGood<boolean>(timeProfile)(true)
        }
        return this.returnGood<boolean>(timeProfile)(false)
      })
      .catch(() => this.returnGood<boolean>(timeProfile)(false))
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

  /** Cancel order
   * @param {object} order Order info
   * @param count
   * @param {string} order.symbol pair
   * @param {string} order.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    const { newClientOrderId } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<CancelOrderResponse>(() =>
      this.client.rest.order.cancelOrder(newClientOrderId),
    )
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.success) {
          await this.checkLimits('private', timeProfile)
          const order = await this.callWithTimeout<Order>(() =>
            this.client.rest.order.getOrder(newClientOrderId),
          )
          if (!order) {
            return this.returnBad(timeProfile)(
              new Error('Coinbase order not found after cancel.'),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(order),
          )
        }
        return this.handleCoinbaseErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new CoinbaseError(res.failure_reason))
      })
      .catch(
        this.handleCoinbaseErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrderByOrderIdAndSymbol({
    symbol,
    orderId,
  }: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.cancelOrder({ symbol, newClientOrderId: orderId })
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<FullExchangeInfo[]>>} Exchange info about all pair
   */
  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FullExchangeInfo[]>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    this.getClientWithDefaultKeys()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<Product[]>(() =>
      this.client.rest.product.getProducts(),
    )
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<FullExchangeInfo[]>(timeProfile)(
          res.map((r) => ({
            pair: r.product_id,
            baseAsset: {
              name: r.base_currency_id,
              minAmount: parseFloat(r.base_min_size),
              maxAmount: parseFloat(r.base_max_size),
              step: parseFloat(r.base_increment),
              maxMarketAmount: parseFloat(r.base_max_size),
            },
            quoteAsset: {
              name: r.quote_currency_id,
              minAmount: parseFloat(r.quote_min_size),
            },
            maxOrders: 500,
            //@ts-ignore
            priceAssetPrecision: this.getPricePrecision(r.price_increment),
          })),
        )
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} [returnOrders] return orders or orders count. Default = false
   * @return {Promise<BaseReturn<CommonOrder[]>> | Promise<BaseReturn<number>>} Array of opened orders or orders count if returnOrders set to true
   */
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    const input: { product_id?: string; order_status: OrderStatus[] } = {
      product_id: symbol,
      order_status: [OrderStatus.OPEN],
    }
    if (!symbol) {
      delete input.product_id
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<PaginatedData<Order>>(() =>
      this.client.rest.order.getOrders(input),
    )
      .then(async (orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const convertedOrders: CommonOrder[] = []
        if (returnOrders) {
          for (const o of orders.data) {
            const data = await this.convertOrder(o)
            convertedOrders.push(data)
          }
          return this.returnGood<CommonOrder[]>(timeProfile)(convertedOrders)
        }
        return this.returnGood<number>(timeProfile)(orders.data.length)
      })
      .catch(
        this.handleCoinbaseErrors<BaseReturn<CommonOrder[] | number>>(
          this.getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get user fee for all pairs
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} maker and taker fee all pairs
   */
  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    const allPairs = await this.getAllExchangeInfo()
    if (allPairs.status === StatusEnum.notok) {
      return allPairs
    }
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<CoinbaseFees>(() =>
      this.client.rest.fee.getCurrentFees(),
    )
      .then((fee) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          allPairs.data.map((p) => ({
            pair: p.pair,
            maker: parseFloat(fee.fee_tier.maker_fee_rate),
            taker: parseFloat(fee.fee_tier.taker_fee_rate),
          })),
        )
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Bybit get balance
   * get user account info from bybit and look for necessary balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async getBalance(
    pagination?: Pagination,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<PaginatedData<Account>>(() =>
      this.client.rest.account.listAccounts(pagination),
    )
      .then(async (balances) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const fullBalances: FreeAsset = []
        for (const b of balances.data) {
          fullBalances.push({
            asset: b.currency,
            free: parseFloat(b.available_balance.value),
            locked: parseFloat(b.hold.value),
          })
        }
        if (balances.pagination.has_next) {
          const fullResult = await this.getBalance(
            {
              cursor: balances.pagination.cursor,
              limit: 250,
            },
            timeProfile,
          )
          if (fullResult.status === StatusEnum.ok) {
            fullBalances.push(...fullResult.data)
          } else {
            return fullResult
          }
        }
        return this.returnGood<FreeAsset>(timeProfile)(fullBalances)
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getBalance,
          pagination,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<ExchangeInfo>>} Exchange info about pair
   */

  async getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<ExchangeInfo>(all.timeProfile)(
      all.data.find((s) => s.pair === symbol),
    )
  }

  async getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    wait = true,
    waitCount = 1,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    const { newClientOrderId } = data
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<Order>(() =>
      this.client.rest.order.getOrder(newClientOrderId),
    )
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (!res) {
          if (wait) {
            Logger.log(
              `Order ${data.newClientOrderId} not found at ${data.symbol}. Wait 5s. ${waitCount}`,
            )
            await sleep(5000)
            return await this.getOrder(data, waitCount <= 5, waitCount + 1)
          } else {
            return this.returnBad(timeProfile)(
              new Error('Coinbase order not found after execution.'),
            )
          }
        }
        return this.returnGood<CommonOrder>(timeProfile)(
          await this.convertOrder(res),
        )
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getOrder,
          data,
          wait,
          waitCount,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get user fee for given pair
   * @param {string} _symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} maker and taker fee for given symbol
   */
  async getUserFees(
    symbol: string,
  ): Promise<BaseReturn<UserFee & { pair: string }>> {
    const all = await this.getAllUserFees()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<UserFee & { pair: string }>(all.timeProfile)(
      all.data.find((a) => a.pair === symbol) ?? {
        pair: symbol,
        maker: 0.006,
        taker: 0.008,
      },
    )
  }

  /** Get the latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    this.getClientWithDefaultKeys()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<Product>(() =>
      this.client.rest.product.getProduct(symbol),
    )
      .then((price) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<number>(timeProfile)(parseFloat(price.price))
      })
      .catch(
        this.handleCoinbaseErrors(
          this.latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Open order function
   * @param {object} order Order data
   * @param count
   * @param {string} order.symbol pair
   * @param {OrderTypes} order.side BUY or SELL
   * @param {number} order.quantity quantity
   * @param {number} order.price limit price
   * @param {string} order.newClientOrderId order id, optional
   * @param {LIMIT | MARKET} order.type order type
   * @return {Promise<BaseReturn<CommonOrder>>}
   */
  async openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    const { symbol, side, quantity, price, newClientOrderId, type } = order
    const orderConfiguration: OrderConfiguration =
      type === 'LIMIT'
        ? {
            limit_limit_gtc: {
              base_size: `${quantity}`,
              limit_price: `${price}`,
              post_only: false,
            },
          }
        : {
            market_market_ioc:
              side === 'SELL'
                ? { base_size: `${quantity}` }
                : { quote_size: `${quantity}` },
          }
    const request: NewOrder = {
      product_id: symbol,
      side: side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
      order_configuration: orderConfiguration,
      client_order_id: newClientOrderId || '',
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<CreateOrderResponse>(() =>
      this.client.rest.order.placeOrder(request),
    )
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (type === 'MARKET') {
          await sleep(1000)
        }
        if (res.success && res.success_response) {
          return await this.getOrder({
            symbol,
            newClientOrderId: res.success_response.order_id,
          })
        }
        if (res.error_response) {
          return this.returnBad(timeProfile)(
            new CoinbaseError(
              `${res.error_response.error}: ${res.error_response.message}, ${res.error_response.error_details}`,
            ),
          )
        }
        return this.handleCoinbaseErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new CoinbaseError('No order response'))
      })
      .catch(async (e) => {
        if (e?.response?.success && e?.response?.success_response?.order_id) {
          Logger.warn(
            `Catch error, but order was created: ${e?.response?.success_response?.order_id}`,
          )
          return await this.getOrder({
            symbol,
            newClientOrderId: e?.response?.success_response?.order_id,
          })
        }
        return this.handleCoinbaseErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(e)
      })
  }

  private convertInterval(interval: ExchangeIntervals): CandleGranularity {
    return interval === ExchangeIntervals.eightH
      ? CandleGranularity.SIX_HOUR
      : interval === ExchangeIntervals.fifteenM
        ? CandleGranularity.FIFTEEN_MINUTE
        : interval === ExchangeIntervals.fiveM
          ? CandleGranularity.FIVE_MINUTE
          : interval === ExchangeIntervals.fourH
            ? CandleGranularity.SIX_HOUR
            : interval === ExchangeIntervals.oneD
              ? CandleGranularity.ONE_DAY
              : interval === ExchangeIntervals.oneH
                ? CandleGranularity.ONE_HOUR
                : interval === ExchangeIntervals.oneM
                  ? CandleGranularity.ONE_MINUTE
                  : interval === ExchangeIntervals.oneW
                    ? CandleGranularity.SIX_HOUR
                    : interval === ExchangeIntervals.thirtyM
                      ? CandleGranularity.THIRTY_MINUTE
                      : interval === ExchangeIntervals.threeM
                        ? CandleGranularity.ONE_MINUTE
                        : interval === ExchangeIntervals.twoH
                          ? CandleGranularity.TWO_HOUR
                          : CandleGranularity.ONE_MINUTE
  }

  private getIntervalLength(interval: ExchangeIntervals): number {
    return {
      [ExchangeIntervals.oneM]: 60 * 1000,
      [ExchangeIntervals.threeM]: 3 * 60 * 1000,
      [ExchangeIntervals.fiveM]: 5 * 60 * 1000,
      [ExchangeIntervals.fifteenM]: 15 * 60 * 1000,
      [ExchangeIntervals.thirtyM]: 30 * 60 * 1000,
      [ExchangeIntervals.oneH]: 60 * 60 * 1000,
      [ExchangeIntervals.twoH]: 2 * 60 * 60 * 1000,
      [ExchangeIntervals.fourH]: 4 * 60 * 60 * 1000,
      [ExchangeIntervals.eightH]: 8 * 60 * 60 * 1000,
      [ExchangeIntervals.oneD]: 24 * 60 * 60 * 1000,
      [ExchangeIntervals.oneW]: 7 * 24 * 60 * 60 * 1000,
    }[interval]
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    this.getClientWithDefaultKeys()
    if (from && to) {
      const tick = this.getIntervalLength(interval)
      const length = Math.floor((+to - +from) / tick)
      if (length > 300) {
        const newTo = +from + 300 * tick
        if (!isNaN(newTo) && isFinite(newTo)) {
          to = newTo
        }
      }
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<Candle[]>(() =>
      this.client.rest.product.getCandles(symbol, {
        start: from ? Math.floor(from / 1000) : 0,
        end: to ? Math.ceil(to / 1000) : Math.ceil(Date.now() / 1000),
        granularity: this.convertInterval(interval),
      }),
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<CandleResponse[]>(timeProfile)(
          res.map((k) => ({
            open: `${k.open}`,
            close: `${k.close}`,
            high: `${k.high}`,
            low: `${k.low}`,
            time: k.openTimeInMillis,
            volume: `${k.volume}`,
          })),
        )
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Get all prices
   */
  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    timeProfile =
      (await this.checkLimits('private', timeProfile)) || timeProfile
    this.getClientWithDefaultKeys()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.callWithTimeout<Product[]>(() =>
      this.client.rest.product.getProducts(),
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<AllPricesResponse[]>(timeProfile)(
          res.map((k) => ({
            pair: k.product_id,
            price: parseFloat(k.price),
          })),
        )
      })
      .catch(
        this.handleCoinbaseErrors(
          this.getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Convert Bybit order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private async convertOrder(order?: Order): Promise<CommonOrder> {
    const orderStatus = (): OrderStatusType => {
      const { status, completion_percentage } = order
      if ([OrderStatus.OPEN, OrderStatus.PENDING].includes(status)) {
        if (+completion_percentage > 0) {
          return 'PARTIALLY_FILLED'
        }
        return 'NEW'
      }
      if ([OrderStatus.FILLED].includes(status)) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: OrderType): OrderTypeT => {
      if (type === OrderType.LIMIT) {
        return 'LIMIT'
      }
      if (type === OrderType.MARKET) {
        return 'MARKET'
      }
      return 'MARKET'
    }
    const limitPrice = (order.order_configuration as LimitOrderGTC)
      ?.limit_limit_gtc?.limit_price
    const price =
      order.order_type === OrderType.MARKET
        ? order.average_filled_price
          ? `${+order.average_filled_price}`
          : '0'
        : order.average_filled_price && +order.average_filled_price
          ? +order.average_filled_price !== +limitPrice
            ? order.average_filled_price
            : limitPrice
          : limitPrice
    return {
      symbol: order.product_id,
      orderId: order.order_id,
      clientOrderId: order.client_order_id,
      transactTime: +new Date(order.created_time),
      //@ts-ignore
      updateTime: order.last_fill_time
        ? //@ts-ignore
          +new Date(order.last_fill_time)
        : +new Date(order.created_time),
      price,
      origQty:
        order.order_type === OrderType.MARKET
          ? order.side === OrderSide.BUY
            ? (order.order_configuration as MarketOrder).market_market_ioc
                .base_size
            : `${
                +(order.order_configuration as MarketOrder).market_market_ioc
                  .quote_size / +price
              }`
          : (order.order_configuration as LimitOrderGTC)?.limit_limit_gtc
              ?.base_size,
      executedQty: order.filled_size,
      cummulativeQuoteQty: order.filled_value,
      status: orderStatus(),
      type: orderType(order.order_type),
      side: order.side === OrderSide.SELL ? 'SELL' : 'BUY',
      fills: [],
    }
  }

  /**
   * Handle errors from Coinbase API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  private handleCoinbaseErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (e: CoinbaseErrorResponse | Error | AxiosError) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      const message = `${
        (typeof (e as AxiosError)?.response?.data === 'string'
          ? (e as AxiosError)?.response?.data
          : //@ts-ignore
            (e as AxiosError)?.response?.data?.error_details ||
            //@ts-ignore
            (e as AxiosError)?.response?.data?.message) ||
        (e as CoinbaseErrorResponse).message ||
        (e as AxiosError)?.message ||
        (e as Error)?.message
      }`.replace(/[\n\r]/g, '')
      const code = `${
        (e as CoinbaseErrorResponse).code || (e as AxiosError)?.response?.status
      }`
      const tooManyErrors = 'Too many errors'
      const tooManyVisits = 'Too many visits'
      const gatewayTimeout = 'Gateway Time-out'
      const socketHangUp = 'socket hang up'
      const internalSystemError = 'Internal System Error'
      const serverTimeout = 'Server Timeout'
      const possibleIpBlock = 'possible ip block'
      const timedOut = 'ETIMEDOUT'
      const connReset = 'ECONNRESET'
      const eai = 'EAI_AGAIN'
      const getAddrInfo = 'getaddrinfo'
      const fetchFailed = 'fetch failed'
      const timeout30 = 'timeout of 300000ms exceeded'
      const unauthorized = 'Unauthorized'
      const scopes = !this.useDefault ? '' : 'Missing required scopes'
      const siwc = !this.useDefault
        ? ''
        : 'Requests to the SIWC API with Cloud API keys are not supported'
      const internalTimeout = 'Internal timeout'
      const serviceUnavailabe = 'The service is unavailable'
      const something = 'Something went wrong'
      const html = '<html>'
      const goSg = 'go/sg'
      const unknown = 'UNKNOWN_FAILURE_REASON'
      const reasons = [
        internalSystemError,
        serverTimeout,
        fetchFailed,
        getAddrInfo,
        socketHangUp,
        tooManyVisits,
        tooManyErrors,
        possibleIpBlock,
        timedOut,
        connReset,
        eai,
        gatewayTimeout,
        timeout30,
        tls,
        scopes,
        siwc,
        internalTimeout,
        serviceUnavailabe,
        unauthorized,
        something,
        html,
        goSg,
        unknown,
      ]
      const isError = (text: string, reason: string) =>
        !!reason && text.toLowerCase().indexOf(reason.toLowerCase()) !== -1
      if (
        this.retryErrors.includes(`${code}`) ||
        reasons.some((r) => isError(message, r))
      ) {
        if (timeProfile.attempts < this.retry) {
          if (isError(message, internalTimeout)) {
            const time = 10000 + (timeProfile.attempts - 1) * 1000
            Logger.log(`Coinbase internal timeout ${timeProfile.attempts}`)
            await sleep(time)
          }
          if (isError(message, tooManyVisits)) {
            const time = 10000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase Too many visits wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, tooManyErrors)) {
            const time = 10000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase Too many errors wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, unknown)) {
            const time = 1000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase UNKNOWN_FAILURE_REASON wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, html)) {
            const time = 10000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase Firewall error wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, goSg) && message.startsWith(goSg)) {
            const time = 10000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase Go/SG error wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, something)) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase ${something} wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, scopes)) {
            const time = 2000
            Logger.log(
              `Coinbase Missing scopes wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, siwc)) {
            const time = 2000
            Logger.log(`Coinbase SIWC wait ${time}s ${timeProfile.attempts}`)
            await sleep(time)
          }
          if (isError(message, unauthorized)) {
            const time = 2000
            Logger.log(
              `Coinbase Unauthorized wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, serviceUnavailabe)) {
            const time = 5000
            Logger.log(
              `Coinbase Service unavailable wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, gatewayTimeout)) {
            Logger.log(
              `Coinbase Gateway Time-out wait 5s ${timeProfile.attempts}`,
            )
            await sleep(5000)
          }
          if (isError(message, socketHangUp)) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Coinbase socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (isError(message, internalSystemError)) {
            Logger.log(
              `Coinbase Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, serverTimeout)) {
            Logger.log(
              `Coinbase Server Timeout wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, possibleIpBlock)) {
            Logger.log(
              `Coinbase Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, timedOut)) {
            Logger.log(`Coinbase Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (isError(message, connReset)) {
            Logger.log(
              `Coinbase Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, eai)) {
            Logger.log(`Coinbase EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (isError(message, getAddrInfo)) {
            Logger.log(`Coinbase getaddrinfo wait 2s ${timeProfile.attempts}`)
            await sleep(2000)
          }
          if (isError(message, tls)) {
            Logger.log(
              `Coinbase Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, fetchFailed)) {
            Logger.log(
              `Coinbase Fetch failed wait 10s error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (isError(message, timeout30)) {
            Logger.log(
              `Coinbase Timeout 30s wait 10s error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(
              `${isError(message, unauthorized) ? '' : this.exchangeProblems}${
                isError(message, html) ? 'Firewall error' : message
              }`,
            ),
          )
        }
      } else {
        return this.returnBad(timeProfile)(new Error(message))
      }
    }
  }

  /**
   * Check info from binance provider about limits and set them to {@link BybitExchange#info}
   * If limits exceeded - call {@link BybitExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: 'private' | 'public',
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    let limit = 0
    if (request === 'public') {
      limit = limitHelper.publicMethod()
    } else {
      limit = limitHelper.publicMethod()
    }
    if (limit > 0) {
      Logger.warn(
        `Coinbase request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request)
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
  }

  getUsage() {
    return limitHelper.getUsage()
  }

  async getTrades(
    _symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.returnGood<TradeResponse[]>(this.getEmptyTimeProfile())([])
  }
}

export default CoinbaseExchange
