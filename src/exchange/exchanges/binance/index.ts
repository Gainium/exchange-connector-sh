import AbstractExchange, { Exchange } from '../../abstractExchange'
import type {
  Binance as BinanceType,
  CandlesOptions,
  NewOrderSpot,
  NewFuturesOrder,
  Order,
  OrderStatus_LT,
  OrderType,
  OrderType_LT,
  SymbolLotSizeFilter,
  SymbolMaxNumOrdersFilter,
  SymbolMinNotionalFilter,
  SymbolPriceFilter,
  FuturesOrder,
  FuturesOrderType_LT,
  SymbolPercentPriceFilter,
  TradeFee,
  QueryOrderResult,
  LeverageBracketResult,
  TradesOptions,
  SymbolMarketLotSizeFilter,
} from 'binance-api-node'
import Binance, { ErrorCodes } from 'binance-api-node'
import limitHelper from './limit'
import {
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  FreeAsset,
  MarginType,
  OrderStatusType,
  OrderTypes,
  OrderTypeT,
  UserFee,
  PositionSide,
  LeverageBracket,
  PositionInfo,
  TradeResponse,
  TimeProfile,
  RebateRecord,
  RebateOverview,
} from '../../types'
import {
  AllPricesResponse,
  ExchangeDomain,
  ExchangeIntervals,
  StatusEnum,
  Futures,
} from '../../types'
import { getBinanceBase } from '../../helpers/exchaneUtils'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'

export enum HttpMethod {
  GET = 'GET',
  HEAD = 'HEAD',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
  CONNECT = 'CONNECT',
  OPTIONS = 'OPTIONS',
  TRACE = 'TRACE',
  PATCH = 'PATCH',
}

class BinanceExchange extends AbstractExchange implements Exchange {
  /** Binance client */
  protected client?: BinanceType
  /** recvWindow binance parameter. Default 30000 */
  protected recvWindow: number
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retyr atttemp is executed */
  private retryErrors: number[]

  protected domain: ExchangeDomain

  protected futures?: Futures

  /** Constructor method
   * @param {string} domain us or com
   * @param {string} key api key
   * @param {string} secret api secret
   * @param _passphrase
   * @param _environment
   * @returns {BinanceExchange} self
   */
  constructor(
    domain: ExchangeDomain,
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: string,
    _code?: string,
    _bybitHost?: string,
  ) {
    super({ key, secret })
    try {
      this.client = Binance({
        apiKey: this.key ?? '',
        apiSecret: this.secret ?? '',
        httpBase: getBinanceBase(domain),
      })
    } catch (e) {
      Logger.warn(
        `Error connectinng Binance (${getBinanceBase(domain)}), message: ${
          (e as Error)?.message ?? ''
        }`,
      )
    }
    this.domain = domain
    this.recvWindow = 30000
    this.retry = 10
    this.retryErrors = [
      ErrorCodes.INVALID_TIMESTAMP,
      ErrorCodes.UNKNOWN,
      ErrorCodes.DISCONNECTED,
      ErrorCodes.TOO_MANY_REQUESTS,
      -1004,
      ErrorCodes.UNEXPECTED_RESP,
      ErrorCodes.TIMEOUT,
      ErrorCodes.TOO_MANY_ORDERS,
      -1099,
      502,
    ]
    this.futures = futures === Futures.null ? this.futures : futures
  }

  get isNewLimit() {
    return !this.isUs && +new Date() >= 1692921600000
  }

  get isUs() {
    return this.domain === ExchangeDomain.us
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

  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<string | number>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getUid', 'request', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.client
        //@ts-ignore
        .accountInfo({ recvWindow: this.recvWindow })
        .then((accountInfo) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          return this.returnGood<number>(timeProfile)(
            //@ts-ignore
            accountInfo?.uid ?? -1,
          )
        })
        .catch(
          this.handleBinanceErrors(
            this.getUid,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    )
  }
  async getRebateRecords(
    timestamp: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<RebateRecord[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getRebateRecords',
        'request',
        100,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const params = {
      recvWindow: this.recvWindow,
      startTime,
      endTime,
      limit: 500,
      timestamp,
    }
    if (!params.startTime) {
      delete params.startTime
    }
    if (!params.endTime) {
      delete params.endTime
    }
    return this.client
      .privateRequest(
        HttpMethod.GET,
        '/sapi/v1/apiReferral/rebate/recentRecord',
        params,
      )
      .then((data) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<RebateRecord[]>(timeProfile)(
          data as RebateRecord[],
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.getRebateRecords,
          timestamp,
          startTime,
          endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getRebateOverview(
    timestamp: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<RebateOverview>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getRebateOverview',
        'request',
        100,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const params = {
      recvWindow: this.recvWindow,
      timestamp,
      type: this.coinm ? 2 : 1,
      startTime,
      endTime,
      limit: 1000,
    }
    if (!params.startTime) {
      delete params.startTime
    }
    if (!params.endTime) {
      delete params.endTime
    }
    return this.client
      .privateRequest(HttpMethod.GET, '/fapi/v1/apiReferral/rebateVol', params)
      .then((data) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<RebateOverview>(timeProfile)(
          data as RebateOverview,
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.getRebateOverview,
          timestamp,
          startTime,
          endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getAffiliate(_uid: string | number): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>(this.getEmptyTimeProfile())(false)
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

  /** Binance get balance
   * get user account info from binance and look for necessery balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    if (this.futures) {
      return await this.futures_getBalance()
    }
    return await this.spot_getBalance()
  }

  async spot_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getBalance',
        'request',
        this.isNewLimit ? 20 : 10,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.client
        //@ts-ignore
        .accountInfo({ recvWindow: this.recvWindow })
        .then((accountInfo) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          const { balances } = accountInfo
          return this.returnGood<FreeAsset>(timeProfile)(
            balances.map((balance) => ({
              asset: balance.asset,
              free: parseFloat(balance.free),
              locked: parseFloat(balance.locked),
            })),
          )
        })
        .catch(
          this.handleBinanceErrors(
            this.spot_getBalance,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    )
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getBalance', 'request', 5, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresAccountInfo({ recvWindow: this.recvWindow })
        : this.client.deliveryAccountInfo({ recvWindow: this.recvWindow })
    )
      .then((accountInfo) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<FreeAsset>(timeProfile)(
          accountInfo.assets.map((balance) => ({
            asset: balance.asset,
            free: parseFloat(balance.maxWithdrawAmount),
            locked:
              parseFloat(balance.walletBalance) > 0
                ? parseFloat(balance.walletBalance) -
                  parseFloat(balance.maxWithdrawAmount)
                : 0,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Open order abstract function
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
  async openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    positionSide?: PositionSide
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_openOrder(order)
    }
    return await this.spot_openOrder(order)
  }

  async spot_openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('openOrder', 'order', 1, timeProfile)) ||
      timeProfile
    const { symbol, side, quantity, price, newClientOrderId, type } = order
    let orderData: NewOrderSpot = {
      symbol,
      side,
      quantity: `${quantity}`,
      price: this.convertNumberToString(price),
      type: 'LIMIT' as OrderType.LIMIT,
      newClientOrderId,
      recvWindow: this.recvWindow,
    }
    if (type && type === 'MARKET') {
      orderData = {
        symbol,
        side,
        quantity: `${quantity}`,
        type: 'MARKET' as OrderType.MARKET,
        newClientOrderId,
        recvWindow: this.recvWindow,
      }
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .order({ ...orderData, newOrderRespType: 'RESULT' })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_openOrder(
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
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('openOrder', 'order', 1, timeProfile)) ||
      timeProfile
    const {
      symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type,
      positionSide,
      reduceOnly,
    } = order
    let orderData: NewFuturesOrder = {
      symbol,
      side,
      quantity: `${quantity}`,
      price: this.convertNumberToString(price),
      type: 'LIMIT' as OrderType.LIMIT,
      newClientOrderId,
      recvWindow: this.recvWindow,
      timeInForce: 'GTC',
    }
    if (type && type === 'MARKET') {
      orderData = {
        symbol,
        side,
        quantity: `${quantity}`,
        type: 'MARKET' as OrderType.MARKET,
        newClientOrderId,
        recvWindow: this.recvWindow,
      }
    }
    if (
      typeof reduceOnly !== 'undefined' &&
      positionSide === PositionSide.BOTH
    ) {
      orderData.reduceOnly = `${!!reduceOnly}`
    }
    if (typeof positionSide !== 'undefined') {
      orderData.positionSide = positionSide
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresOrder({ ...orderData, newOrderRespType: 'RESULT' })
        : this.client.deliveryOrder({
            ...orderData,
            newOrderRespType: 'RESULT',
          })
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.futures_convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.futures_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get order abstract function
   * @param {object} data Order info
   * @param count
   * @param {string} data.symbol pair
   * @param {string} data.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_getOrder({ symbol, newClientOrderId })
    }
    return await this.spot_getOrder({ symbol, newClientOrderId })
  }

  async spot_getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        `getOrder-${data.newClientOrderId}@${data.symbol}`,
        'request',
        this.isNewLimit ? 4 : 2,
        timeProfile,
      )) || timeProfile
    const { symbol, newClientOrderId } = data
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getOrder({
        symbol,
        origClientOrderId: newClientOrderId,
        //@ts-ignore
        recvWindow: this.recvWindow,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.spot_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getOrder', 'request', 1, timeProfile)) ||
      timeProfile
    const { symbol, newClientOrderId } = data
    const input = {
      symbol,
      origClientOrderId: newClientOrderId,
      recvWindow: this.recvWindow,
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresGetOrder(input)
        : this.client.deliveryGetOrder(input)
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.futures_convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.futures_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async latestPrice(symbol: string): Promise<BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_latestPrice(symbol)
    }
    return await this.spot_latestPrice(symbol)
  }

  async spot_latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'latestPrice',
        'request',
        this.isNewLimit ? 2 : 1,
        timeProfile,
      )) || timeProfile
    return this.client
      .prices({
        symbol,
      })
      .then((price) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<number>(timeProfile)(parseFloat(price[symbol]))
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'latestPrice',
        'request',
        this.usdm ? 10 : 10,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresMarkPrice()
        : this.client.deliveryMarkPrice()
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const find = res.find((r) => r.symbol === symbol)
        if (find) {
          return this.returnGood<number>(timeProfile)(+find.markPrice)
        }
        return this.returnGood<number>(timeProfile)(0)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Cancel order
   * @param {object} order Order info
   * @param count
   * @param {string} order.symbol pair
   * @param {string} order.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_cancelOrder({ symbol, newClientOrderId })
    }
    return await this.spot_cancelOrder({ symbol, newClientOrderId })
  }

  async spot_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        `cancelOrder-${order.newClientOrderId}@${order.symbol}`,
        'request',
        1,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const { symbol, newClientOrderId } = order
    return this.client
      .cancelOrder({
        symbol,
        origClientOrderId: newClientOrderId,
        //@ts-ignore
        recvWindow: this.recvWindow,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.convertOrder({
          ...res,
          isWorking: false,
          time: -1,
          updateTime: -1,
          status: 'CANCELED',
          timeInForce: 'GTC',
        })
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.spot_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_cancelOrderByOrderIdAndSymbol(order)
    }
    return await this.spot_cancelOrderByOrderIdAndSymbol(order)
  }

  async spot_cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        `cancelOrder-${order.orderId}@${order.symbol}`,
        'request',
        1,
        timeProfile,
      )) || timeProfile
    const { symbol, orderId } = order

    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrder({
        symbol,
        orderId: +orderId,
        //@ts-ignore
        recvWindow: this.recvWindow,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.convertOrder({
          ...res,
          isWorking: false,
          time: -1,
          updateTime: -1,
          status: 'CANCELED',
          timeInForce: 'GTC',
        })
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('cancelOrder', 'request', 1, timeProfile)) ||
      timeProfile
    const { symbol, orderId } = order
    const input = {
      symbol,
      orderId: +orderId,
      recvWindow: this.recvWindow,
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresCancelOrder(input)
        : this.client.deliveryCancelOrder(input)
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.futures_convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('cancelOrder', 'request', 1, timeProfile)) ||
      timeProfile
    const { symbol, newClientOrderId } = order
    const input = {
      symbol,
      origClientOrderId: newClientOrderId,
      recvWindow: this.recvWindow,
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresCancelOrder(input)
        : this.client.deliveryCancelOrder(input)
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.futures_convertOrder(res)
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Cancel all orders
   * @param {object} data Order info
   * @param count
   * @param {string} data.symbol pair
   * @return {Promise<BaseReturn<CommonOrder[]>>} Order data
   */
  async cancelAllOrders(
    data: { symbol: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('cancelAllOrders', 'request', 1, timeProfile)) ||
      timeProfile
    const { symbol } = data
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOpenOrders({
        symbol, //@ts-ignore
        recvWindow: this.recvWindow,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return res.map((o) =>
          this.convertOrder({
            ...o,
            isWorking: false,
            time: -1,
            updateTime: -1,
            status: 'CANCELED',
            timeInForce: 'GTC',
          }),
        )
      })
      .then(this.returnGood(timeProfile))
      .catch(
        this.handleBinanceErrors(
          this.cancelAllOrders,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Websocket stream
   * @param {string} channel channel to subscribe
   * @return {function} function to subscribe
   */

  wsStream(channel: string) {
    if (!this.client) {
      return this.errorClient(this.getEmptyTimeProfile())
    }
    switch (channel) {
      case 'user': {
        return this.client.ws.user
      }
      default: {
        return
      }
    }
  }

  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<ExchangeInfo>>} Exchange info about pair
   */
  async getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>> {
    if (this.futures) {
      return await this.futures_getExchangeInfo(symbol)
    }
    return await this.spot_getExchangeInfo(symbol)
  }

  async spot_getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<ExchangeInfo>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getExchangeInfo',
        'request',
        this.isNewLimit ? 20 : 10,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .exchangeInfo()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const find = res.symbols.find(
          (symbolInfo) => symbolInfo.symbol === symbol,
        )
        const baseAssetLot = find?.filters.find(
          (filt) => filt.filterType === 'LOT_SIZE',
        ) as SymbolLotSizeFilter | undefined
        const quoteAssetFilter = find?.filters.find(
          (filt) =>
            //@ts-ignore
            filt.filterType === 'NOTIONAL' ||
            filt.filterType === 'MIN_NOTIONAL',
        )
        const orderFilter = find?.filters.find(
          (filt) => filt.filterType === 'MAX_NUM_ORDERS',
        ) as SymbolMaxNumOrdersFilter | undefined
        const priceFilter = find?.filters.find(
          (filt) => filt.filterType === 'PRICE_FILTER',
        ) as SymbolPriceFilter | undefined
        const marketFilter = find?.filters.find(
          (filt) => filt.filterType === 'MARKET_LOT_SIZE',
        ) as SymbolMarketLotSizeFilter | undefined
        const baseAsset = {
          minAmount: parseFloat(baseAssetLot.minQty),
          step: parseFloat(baseAssetLot.stepSize),
          maxAmount: parseFloat(baseAssetLot.maxQty),
          name: find?.baseAsset || '',
          maxMarketAmount: parseFloat(
            marketFilter?.maxQty || baseAssetLot?.stepSize || '0',
          ),
        }
        const quoteAsset = {
          //@ts-ignore
          minAmount: parseFloat(quoteAssetFilter.minNotional),
          name: find?.quoteAsset || '',
        }
        const maxOrders = orderFilter.maxNumOrders
        return this.returnGood<ExchangeInfo>(timeProfile)({
          quoteAsset,
          baseAsset,
          maxOrders,
          priceAssetPrecision: this.getPricePrecision(
            `${priceFilter?.tickSize || '0.1'}`,
          ),
        })
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getExchangeInfo,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<ExchangeInfo>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getExchangeInfo', 'request', 1, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresExchangeInfo()
        : this.client.deliveryExchangeInfo()
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const find = res.symbols.find(
          (symbolInfo) => symbolInfo.symbol === symbol,
        )
        const baseAssetLot = find?.filters.find(
          (filt) => filt.filterType === 'LOT_SIZE',
        ) as SymbolLotSizeFilter | undefined
        const quoteAssetFilter = find?.filters.find(
          (filt) =>
            //@ts-ignore
            filt.filterType === 'NOTIONAL' ||
            filt.filterType === 'MIN_NOTIONAL',
        ) as SymbolMinNotionalFilter | undefined
        const orderFilter = find?.filters.find(
          (filt) => filt.filterType === 'MAX_NUM_ORDERS',
        ) as SymbolMaxNumOrdersFilter | undefined
        const priceFilter = find?.filters.find(
          (filt) => filt.filterType === 'PRICE_FILTER',
        ) as SymbolPriceFilter | undefined
        const multiplierFilter = find?.filters.find(
          (filt) => filt.filterType === 'PERCENT_PRICE',
        ) as SymbolPercentPriceFilter | undefined
        const marketFilter = find?.filters.find(
          (filt) => filt.filterType === 'MARKET_LOT_SIZE',
        ) as SymbolMarketLotSizeFilter | undefined
        const baseAsset = {
          minAmount: this.usdm ? parseFloat(baseAssetLot.minQty) : 0,
          step: this.usdm
            ? parseFloat(baseAssetLot.stepSize)
            : Number(`1e-${+(find.equalQtyPrecision ?? '1')}`),
          maxAmount: parseFloat(baseAssetLot.maxQty),
          name: find?.baseAsset || '',
          maxMarketAmount: parseFloat(
            marketFilter?.maxQty || baseAssetLot?.stepSize || '0',
          ),
        }
        const quoteAsset = {
          minAmount: this.usdm
            ? parseFloat(
                quoteAssetFilter?.notional ??
                  quoteAssetFilter?.minNotional ??
                  '0',
              )
            : +(find.contractSize ?? '1'),
          name: find?.quoteAsset || '',
        }
        const maxOrders = orderFilter.limit ?? orderFilter.maxNumOrders
        return this.returnGood<ExchangeInfo>(timeProfile)({
          quoteAsset,
          baseAsset,
          maxOrders,
          priceAssetPrecision: this.getPricePrecision(
            `${priceFilter?.tickSize || '0.1'}`,
          ),
          priceMultiplier: multiplierFilter
            ? {
                up: parseFloat(multiplierFilter.multiplierUp || '2'),
                down: parseFloat(multiplierFilter.multiplierDown || '0'),
                decimals: parseFloat(
                  `${multiplierFilter.multiplierDecimal || 8}`,
                ),
              }
            : undefined,
        })
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getExchangeInfo,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */
  async getAllExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  > {
    if (this.futures) {
      return await this.futures_getAllExchangeInfo()
    }
    return await this.spot_getAllExchangeInfo()
  }

  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getAllExchangeInfo',
        'request',
        this.isNewLimit ? 20 : 10,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .exchangeInfo()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<(ExchangeInfo & { pair: string })[]>(
          timeProfile,
        )(
          res.symbols
            .filter(
              (pair) => pair.isSpotTradingAllowed && pair.status === 'TRADING',
            )
            .map((pair) => {
              const baseAssetLot = pair.filters.find(
                (filt) => filt.filterType === 'LOT_SIZE',
              ) as SymbolLotSizeFilter | undefined
              const quoteAssetFilter = pair.filters.find(
                (filt) =>
                  //@ts-ignore
                  filt.filterType === 'NOTIONAL' ||
                  filt.filterType === 'MIN_NOTIONAL',
              ) as SymbolMinNotionalFilter | undefined
              const orderFilter = pair.filters.find(
                (filt) => filt.filterType === 'MAX_NUM_ORDERS',
              ) as SymbolMaxNumOrdersFilter | undefined
              const priceFilter = pair.filters.find(
                (filt) => filt.filterType === 'PRICE_FILTER',
              ) as SymbolPriceFilter | undefined
              const marketFilter = pair.filters.find(
                (filt) => filt.filterType === 'MARKET_LOT_SIZE',
              ) as SymbolMarketLotSizeFilter | undefined
              const baseAsset = {
                minAmount: parseFloat(baseAssetLot?.minQty || '0'),

                step: parseFloat(baseAssetLot?.stepSize || '0'),

                maxAmount: parseFloat(baseAssetLot?.maxQty || '0'),
                name: pair.baseAsset,
                maxMarketAmount: parseFloat(
                  marketFilter?.maxQty || baseAssetLot?.stepSize || '0',
                ),
              }
              const quoteAsset = {
                minAmount: parseFloat(quoteAssetFilter?.minNotional || '0'),
                name: pair.quoteAsset,
              }
              const maxOrders = orderFilter?.maxNumOrders || 200
              return {
                pair: pair.symbol,
                quoteAsset,
                baseAsset,
                maxOrders,
                priceAssetPrecision: this.getPricePrecision(
                  `${priceFilter?.tickSize || '0.1'}`,
                ),
              }
            }),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getAllExchangeInfo',
        'request',
        1,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresExchangeInfo()
        : this.client.deliveryExchangeInfo()
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<(ExchangeInfo & { pair: string })[]>(
          timeProfile,
        )(
          res.symbols
            .filter(
              (pair) =>
                pair.contractStatus === 'TRADING' || pair.status === 'TRADING',
            )
            .map((pair) => {
              const baseAssetLot = pair.filters.find(
                (filt) => filt.filterType === 'LOT_SIZE',
              ) as SymbolLotSizeFilter | undefined
              const quoteAssetFilter = pair.filters.find(
                (filt) =>
                  //@ts-ignore
                  filt.filterType === 'NOTIONAL' ||
                  filt.filterType === 'MIN_NOTIONAL',
              ) as SymbolMinNotionalFilter | undefined
              const orderFilter = pair.filters.find(
                (filt) => filt.filterType === 'MAX_NUM_ORDERS',
              ) as SymbolMaxNumOrdersFilter | undefined
              const priceFilter = pair.filters.find(
                (filt) => filt.filterType === 'PRICE_FILTER',
              ) as SymbolPriceFilter | undefined
              const multiplierFilter = pair.filters.find(
                (filt) => filt.filterType === 'PERCENT_PRICE',
              ) as SymbolPercentPriceFilter | undefined
              const marketFilter = pair.filters.find(
                (filt) => filt.filterType === 'MARKET_LOT_SIZE',
              ) as SymbolMarketLotSizeFilter | undefined
              const baseAsset = {
                minAmount: this.usdm
                  ? parseFloat(baseAssetLot?.minQty || '0')
                  : 0,

                step: this.usdm
                  ? parseFloat(baseAssetLot?.stepSize || '0')
                  : Number(`1e-${+(pair.equalQtyPrecision ?? '1')}`),

                maxAmount: parseFloat(baseAssetLot?.maxQty || '0'),
                name: pair.baseAsset,
                maxMarketAmount: parseFloat(
                  marketFilter?.maxQty || baseAssetLot?.stepSize || '0',
                ),
              }
              const quoteAsset = {
                minAmount: this.usdm
                  ? parseFloat(
                      quoteAssetFilter?.notional ??
                        quoteAssetFilter?.minNotional ??
                        '0',
                    )
                  : +(pair.contractSize ?? '1'),
                name: pair.quoteAsset,
              }
              const maxOrders =
                orderFilter?.limit ?? orderFilter?.maxNumOrders ?? 0
              return {
                pair: pair.symbol,
                quoteAsset,
                baseAsset,
                maxOrders,
                priceAssetPrecision: this.getPricePrecision(
                  `${priceFilter?.tickSize || '0.1'}`,
                ),
                priceMultiplier: multiplierFilter
                  ? {
                      up: parseFloat(multiplierFilter.multiplierUp || '2'),
                      down: parseFloat(multiplierFilter.multiplierDown || '0'),
                      decimals: parseFloat(
                        `${multiplierFilter.multiplierDecimal || 8}`,
                      ),
                    }
                  : undefined,
              }
            }),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
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
  ): Promise<BaseReturn<CommonOrder[]> | BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_getAllOpenOrders(symbol, returnOrders)
    }
    return await this.spot_getAllOpenOrders(symbol, returnOrders)
  }

  async spot_getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getAllOpenOrders',
        'request',
        this.isNewLimit ? 80 : 40,
        timeProfile,
      )) || timeProfile
    const input: { symbol?: string; recvWindow: number } = {
      symbol,
      recvWindow: this.recvWindow,
    }
    if (!symbol) {
      delete input.symbol
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.domain === ExchangeDomain.us
        ? this.client.privateRequest(
            HttpMethod.GET,
            '/api/v3/openOrders',
            input,
          )
        : this.client.openOrders(input)
    )
      .then((orders: QueryOrderResult[]) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return {
          timeProfile,
          usage: limitHelper.getUsage(),
          status: StatusEnum.ok as StatusEnum.ok,
          data: returnOrders
            ? orders
                .filter((order) =>
                  ['NEW', 'PARTIALLY_FILLED'].includes(order.status),
                )
                .map((o) => this.convertOrder(o))
            : orders
                .map((order) =>
                  ['NEW', 'PARTIALLY_FILLED'].includes(order.status),
                )
                .filter((o) => o).length,
        }
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async futures_getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async futures_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getAllOpenOrders',
        'request',
        this.usdm ? 5 : 20,
        timeProfile,
      )) || timeProfile
    const input: { symbol?: string; recvWindow: number } = {
      symbol,
      recvWindow: this.recvWindow,
    }
    if (!symbol) {
      delete input.symbol
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresAllOrders(input)
        : this.client.deliveryAllOrders(input)
    )
      .then((orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return {
          timeProfile,
          usage: limitHelper.getUsage(),
          status: StatusEnum.ok as StatusEnum.ok,
          data: returnOrders
            ? orders
                .filter((order) =>
                  ['NEW', 'PARTIALLY_FILLED'].includes(order.status),
                )
                .map((o) => this.futures_convertOrder(o))
            : orders
                .map((order) =>
                  ['NEW', 'PARTIALLY_FILLED'].includes(order.status),
                )
                .filter((o) => o).length,
        }
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get user fee for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<{maker: number, taker: number}>>} maker and taker fee for given symbol
   */
  async getUserFees(symbol: string): Promise<BaseReturn<UserFee>> {
    if (this.futures) {
      return await this.futures_getUserFees(symbol)
    }
    return await this.spot_getUserFees(symbol)
  }

  async spot_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<{ maker: number; taker: number }>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getUserFees', 'request', 1, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.domain === ExchangeDomain.us
        ? this.client.privateRequest(
            HttpMethod.GET,
            '/sapi/v1/asset/query/trading-fee',
            { symbol },
          )
        : this.client
            //@ts-ignore
            .tradeFee({ recvWindow: this.recvWindow })
    )
      .then((fees: TradeFee[]) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        let find = false
        let maker = 0
        let taker = 0
        fees.map((fee) => {
          if (fee.symbol === symbol) {
            find = true
            maker = +fee.makerCommission
            taker = +fee.takerCommission
          }
        })
        if (find) {
          return this.returnGood<{ maker: number; taker: number }>(timeProfile)(
            {
              maker,
              taker,
            },
          )
        }
        return this.returnBad(timeProfile)(new Error('Symbol not found'))
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<{ maker: number; taker: number }>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getUserFees', 'request', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.privateRequest(
            'GET' as HttpMethod.GET,
            '/fapi/v1/commissionRate',
            {
              symbol,
              recvWindow: this.recvWindow,
            },
          )
        : this.client.privateRequest(
            'GET' as HttpMethod.GET,
            '/dapi/v1/commissionRate',
            {
              symbol,
              recvWindow: this.recvWindow,
            },
          )
    )
      .then(
        (fee?: {
          symbol: string
          makerCommissionRate: string
          takerCommissionRate: string
        }) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (fee) {
            const maker = +fee.makerCommissionRate
            const taker = +fee.takerCommissionRate
            return this.returnGood<{ maker: number; taker: number }>(
              timeProfile,
            )({
              maker,
              taker,
            })
          }
          return this.returnBad(timeProfile)(new Error('Symbol not found'))
        },
      )
      .catch(
        this.handleBinanceErrors(
          this.futures_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get user fee for all pairs
   * @return {Promise<BaseReturn<{maker: number, taker: number, pair: string}[]>>} maker and taker fee all pairs
   */
  async getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (this.futures) {
      return await this.futures_getAllUserFees()
    }
    return await this.spot_getAllUserFees()
  }

  async spot_getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getAllUserFees', 'request', 1, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.domain === ExchangeDomain.us
        ? this.client.privateRequest(
            HttpMethod.GET,
            '/sapi/v1/asset/query/trading-fee',
            {},
          )
        : this.client
            //@ts-ignore
            .tradeFee({ recvWindow: this.recvWindow })
    )
      .then((fees: TradeFee[]) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          fees.map((fee) => ({
            pair: fee.symbol,
            maker: +fee.makerCommission,
            taker: +fee.takerCommission,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const pairs = await this.futures_getAllExchangeInfo()
    if (pairs.status === StatusEnum.notok) {
      return pairs
    }
    if (pairs.data.length === 0) {
      return this.returnBad(pairs.timeProfile)(
        new Error('No trading pairs found'),
      )
    }
    const fee = await this.futures_getUserFees(pairs.data[0]?.pair ?? 'BTCUSDT')
    if (fee.status === StatusEnum.notok) {
      return fee
    }
    const result = pairs.data.map((p) => ({
      pair: p.pair,
      maker: fee.data.maker,
      taker: fee.data.taker,
    }))
    return this.returnGood<(UserFee & { pair: string })[]>(fee.timeProfile)(
      result,
    )
  }

  /**
   * Get candles data
   */
  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>> {
    if (this.futures) {
      return await this.futures_getCandles(symbol, interval, from, to, count)
    }
    return await this.spot_getCandles(symbol, interval, from, to, count)
  }

  async spot_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getCandles',
        'request',
        this.isNewLimit ? 2 : 1,
        timeProfile,
      )) || timeProfile
    const options: CandlesOptions = {
      symbol,
      interval,
    }
    if (from) {
      options.startTime = from
    }
    if (to) {
      options.endTime = to
    }
    if (countData) {
      options.limit = countData
    } else if (!countData) {
      options.limit = 1000
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .candles(options)
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<CandleResponse[]>(timeProfile)(
          res.map((k) => ({
            open: k.open,
            close: k.close,
            high: k.high,
            low: k.low,
            time: k.openTime,
            volume: k.volume,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }

    const options: CandlesOptions = {
      symbol,
      interval,
    }
    if (from) {
      options.startTime = +from
    }
    if (to) {
      options.endTime = +to
    }
    if (countData) {
      options.limit = countData
    } else if (!countData) {
      options.limit = 1000
    }
    const limit = countData
      ? countData < 100
        ? 1
        : countData >= 100 && countData < 500
          ? 2
          : countData >= 500 && countData < 1000
            ? 5
            : 10
      : 5
    if (this.coinm) {
      if (
        options.startTime &&
        options.endTime &&
        options.endTime - options.startTime > 200 * 24 * 60 * 60 * 1000
      ) {
        const candles: CandleResponse[] = []

        for (
          let start = options.startTime;
          start < options.endTime;
          start += 200 * 24 * 60 * 60 * 1000
        ) {
          const end = Math.min(
            start + 200 * 24 * 60 * 60 * 1000,
            options.endTime,
          )
          timeProfile =
            (await this.checkLimits(
              'futures_getCandles',
              'request',
              limit,
              timeProfile,
            )) || timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          await this.client
            .deliveryCandles({
              ...options,
              startTime: start,
              endTime: end,
            })
            .then((res) => {
              timeProfile = this.endProfilerTime(timeProfile, 'exchange')
              candles.push(
                ...res.map((k) => ({
                  open: k.open,
                  close: k.close,
                  high: k.high,
                  low: k.low,
                  time: k.openTime,
                  volume: k.volume,
                })),
              )
            })
            .catch(
              this.handleBinanceErrors(
                this.futures_getCandles,
                symbol,
                interval,
                from,
                to,
                countData,
                this.endProfilerTime(timeProfile, 'exchange'),
              ),
            )
          await sleep(0)
        }

        return this.returnGood<CandleResponse[]>(timeProfile)(candles)
      }
    }

    timeProfile =
      (await this.checkLimits(
        'futures_getCandles',
        'request',
        limit,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `BINANCE Queue time is too long ${diff / 1000} futures_getCandles ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return (
      this.usdm
        ? this.client.futuresCandles(options)
        : this.client.deliveryCandles(options)
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<CandleResponse[]>(timeProfile)(
          res.map((k) => ({
            open: k.open,
            close: k.close,
            high: k.high,
            low: k.low,
            time: k.openTime,
            volume: k.volume,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    if (this.futures) {
      return await this.futures_getTrades(symbol, fromId, startTime, endTime)
    }
    return await this.spot_getTrades(symbol, fromId, startTime, endTime)
  }

  async spot_getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<TradeResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'getCandles',
        'request',
        this.isNewLimit ? 2 : 1,
        timeProfile,
      )) || timeProfile
    const options: TradesOptions = {
      symbol,
      limit: 1000,
    }
    if (fromId) {
      options.fromId = `${fromId}`
    }
    if (startTime) {
      options.startTime = startTime
    }
    if (endTime) {
      options.endTime = endTime
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .aggTrades(options)
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<TradeResponse[]>(timeProfile)(
          res.map((k) => ({
            aggId: `${k.aggId}`,
            symbol: k.symbol,
            price: k.price,
            quantity: k.quantity,
            firstId: k.firstId,
            lastId: k.lastId,
            timestamp: k.timestamp,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getTrades,
          symbol,
          fromId,
          startTime,
          endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<TradeResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getTrades', 'request', 20, timeProfile)) ||
      timeProfile
    const options: TradesOptions = {
      symbol,
      limit: 1000,
    }
    if (fromId) {
      options.fromId = `${fromId}`
    }
    if (startTime) {
      options.startTime = startTime
    }
    if (endTime) {
      options.endTime = endTime
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresAggTrades(options)
        : this.client.deliveryAggTrades(options)
    )
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<TradeResponse[]>(timeProfile)(
          res.map((k) => ({
            aggId: `${k.aggId}`,
            symbol: k.symbol,
            price: k.price,
            quantity: k.quantity,
            firstId: k.firstId,
            lastId: k.lastId,
            timestamp: k.timestamp,
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getTrades,
          symbol,
          fromId,
          startTime,
          endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get all prices
   */
  async getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.futures) {
      return await this.futures_getAllPrices()
    }
    return await this.spot_getAllPrices()
  }

  async spot_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'latestPrices',
        'request',
        this.isNewLimit ? 4 : 2,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .prices()
      .then((prices) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<AllPricesResponse[]>(timeProfile)(
          Object.keys(prices).map((p) => ({
            pair: p,
            price: parseFloat(prices[p]),
          })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.spot_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getAllPrices',
        'request',
        this.usdm ? 10 : 10,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout) {
        Logger.error(
          `BINANCE Queue time is too long ${diff / 1000} futures_getAllPrices ${
            this.usdm ? 'usdm' : 'coinm'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    return (
      this.usdm
        ? this.client.futuresMarkPrice()
        : this.client.deliveryMarkPrice()
    )
      .then((prices) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<AllPricesResponse[]>(timeProfile)(
          prices.map((p) => ({ pair: p.symbol, price: +p.markPrice })),
        )
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_changeLeverage',
        'request',
        1,
        timeProfile,
      )) || timeProfile
    const input = { symbol, leverage, recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresLeverage(input)
        : this.client.deliveryLeverage(input)
    )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<number>(timeProfile)(result.leverage)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_changeLeverage,
          symbol,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getHedge',
        'request',
        30,
        timeProfile,
      )) || timeProfile
    const input = { recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresPositionMode(input)
        : this.client.deliveryPositionMode(input)
    )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<boolean>(timeProfile)(result.dualSidePosition)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getHedge,
          _symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futures_setHedge', 'request', 1, timeProfile)) ||
      timeProfile
    const input = { dualSidePosition: `${value}`, recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresPositionModeChange(input)
        : this.client.deliveryPositionModeChange(input)
    )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<boolean>(timeProfile)(result.code === 200)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    _leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('latestPrices', 'request', 1, timeProfile)) ||
      timeProfile
    const input = { symbol, marginType: margin, recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresMarginType(input)
        : this.client.deliveryMarginType(input)
    )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return result.code === 200
          ? this.returnGood<MarginType>(timeProfile)(margin)
          : this.returnBad(timeProfile)(new Error(result.msg))
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          _leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getPositions(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getPositions',
        'request',
        5,
        timeProfile,
      )) || timeProfile
    const input = { recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresAccountInfo(input)
        : this.client.deliveryAccountInfo(input)
    )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<PositionInfo[]>(timeProfile)(result.positions)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_getPositions,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Check info from binance provider about limis and set them to {@link BinanceExchange#info}
   * If limits exceede - call {@link BinanceExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: string,
    type: 'order' | 'request',
    weight = 1,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    let limit = 0
    if (this.domain === ExchangeDomain.us) {
      if (type === 'order') {
        limit = await limitHelper.addOrderUS(this.key)
      }
      if (type === 'request') {
        limit = await limitHelper.addWeightUS(weight)
      }
    } else {
      if (type === 'order') {
        limit = this.usdm
          ? await limitHelper.addOrderUsdm(this.key)
          : this.coinm
            ? await limitHelper.addOrderCoinm(this.key)
            : await limitHelper.addOrder(this.key)
      }
      if (type === 'request') {
        limit = this.usdm
          ? await limitHelper.addWeightUsdm(weight)
          : this.coinm
            ? await limitHelper.addWeightCoinm(weight)
            : await limitHelper.addWeight(weight)
      }
    }
    if (limit > 0) {
      Logger.log(
        `Binance request must sleep for ${limit / 1000}s. Method: ${request}`,
      )

      await sleep(limit)
      if (type === 'order') {
        await this.checkLimits(request, type)
      }
      if (type === 'request') {
        await this.checkLimits(request, type, weight)
      }
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return this.futures === Futures.coinm
  }

  /**
   * Handle errors from Binance API<br/>
   *
   * If error code is in {@link BinanceExchange#retryErrors} and attemp is less than {@link BinanceExchange#retry} - retry action
   */
  protected handleBinanceErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (
      e: Error & { code?: number; response?: string; responseText?: string },
    ) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const overloaded =
        'Server is currently overloaded with other requests. Please try again in a few minutes'.toLowerCase()
      const restApiNotEnabled = 'Rest API trading is not enabled'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      if (
        this.retryErrors.includes(e.code || 0) ||
        e.response ||
        e.message.toLowerCase().indexOf('fetch failed'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf(overloaded) !== -1 ||
        e.message
          .toLowerCase()
          .indexOf('outside of the recvWindow'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('Not Found'.toLowerCase()) !== -1 ||
        e.message
          .toLowerCase()
          .indexOf(
            'Unknown error, please check your request or try again later'.toLowerCase(),
          ) !== -1 ||
        e.message.toLowerCase().indexOf(tls) !== -1 ||
        e.message.toLowerCase().indexOf(restApiNotEnabled) !== -1
      ) {
        if (timeProfile.attempts < this.retry) {
          if (
            e.message
              .toLowerCase()
              .indexOf(
                'Unknown error, please check your request or try again later'.toLowerCase(),
              ) !== -1
          ) {
            Logger.warn(`${args}`)
          }
          if (e.message.toLowerCase().indexOf('fetch failed') !== -1) {
            Logger.warn(`fetch failed sleep 5s`)
            await sleep(5 * 1000)
          }
          if (e.message.toLowerCase().indexOf(overloaded) !== -1) {
            Logger.warn(`Binance overloaded ${overloaded}. Wait 10s`)
            await sleep(10 * 1000)
          }
          if (e.message.toLowerCase().indexOf(tls) !== -1) {
            Logger.warn(`Tls sleep 10s`)
            await sleep(10 * 1000)
          }
          if (e.message.toLowerCase().indexOf(restApiNotEnabled) !== -1) {
            Logger.warn(`Rest API trading is not enabled sleep 10s`)
            await sleep(10 * 1000)
          }
          if (e.code === ErrorCodes.TOO_MANY_ORDERS) {
            const time = this.coinm ? 61000 : 11000
            Logger.warn(`Too many new order ${this.key}, sleep ${time / 1000}s`)
            await sleep(time)
          }
          if (e.code === ErrorCodes.TOO_MANY_REQUESTS) {
            if (!this.isUs) {
              limitHelper.setLimits({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
              limitHelper.setLimitsCoinm({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
              limitHelper.setLimitsUsdm({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
            } else {
              limitHelper.setLimitsUS({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
            }

            const bannedTime = e.message.toLowerCase().match(/\d{13,13}/)?.[0]
            if (
              bannedTime &&
              !isNaN(+bannedTime) &&
              +new Date(+bannedTime) > +new Date()
            ) {
              if (this.futures) {
                if (this.coinm) {
                  limitHelper.setBannedTime(+bannedTime, 'coinm')
                } else {
                  limitHelper.setBannedTime(+bannedTime, 'usdm')
                }
              } else {
                if (this.isUs) {
                  limitHelper.setBannedTime(+bannedTime, 'us')
                } else {
                  limitHelper.setBannedTime(+bannedTime, 'com')
                }
              }
              Logger.warn(
                `Get ${e.message}, bannedTime: ${bannedTime}, ${
                  !this.futures ? 'spot' : this.coinm ? 'coinm' : 'futures'
                }`,
              )
              await sleep(+bannedTime + 1 - +new Date())
            } else {
              Logger.warn(
                `Get ${e.message}, sleep 30s, ${
                  !this.futures ? 'spot' : this.coinm ? 'coinm' : 'futures'
                }`,
              )
              await sleep(30 * 1000)
            }
          }
          if (e.responseText && e.responseText.indexOf('403') !== -1) {
            if (this.domain === ExchangeDomain.com) {
              // don't retry 403 error
              limitHelper.setLimits({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
              limitHelper.setLimitsCoinm({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
              limitHelper.setLimitsUsdm({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
            }
            if (this.domain === ExchangeDomain.us) {
              limitHelper.setLimitsUS({
                orderCount10s: '100000',
                usedWeight1m: '100000',
              })
            }

            return this.returnBad(timeProfile)(e)
          }
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(`${this.exchangeProblems}${e.message}`),
          )
        }
      } else {
        return this.returnBad(timeProfile)(e)
      }
    }
  }

  /**
   * Convert Binance order to Common order
   *
   * @param {Order} order to convert
   * @returns {CommonOrder} Common order result
   */
  private convertOrder(order: Order): CommonOrder {
    const orderStatus = (status: OrderStatus_LT): OrderStatusType => {
      if (
        status === 'FILLED' ||
        status === 'CANCELED' ||
        status === 'NEW' ||
        status === 'PARTIALLY_FILLED'
      ) {
        return status
      }
      return 'CANCELED'
    }
    const orderType = (type: OrderType_LT): OrderTypeT => {
      if (type === 'LIMIT' || type === 'MARKET') {
        return type
      }
      return 'MARKET'
    }
    return {
      symbol: order.symbol,
      orderId: `${order.orderId}`,
      clientOrderId: order.clientOrderId,
      transactTime: order.transactTime || order.time || -1,
      updateTime: order.updateTime,
      price: order.price,
      origQty: order.origQty,
      executedQty: order.executedQty,
      cummulativeQuoteQty: order.cummulativeQuoteQty,
      status: orderStatus(order.status),
      type: orderType(order.type),
      side: order.side,
      fills:
        order.fills?.map((f) => ({
          price: f.price,
          qty: f.qty,
          commission: f.commission,
          commissionAsset: f.commissionAsset,
          tradeId: `${f.tradeId}`,
        })) || [],
    }
  }

  private futures_convertOrder(
    order: Omit<FuturesOrder, 'orderId' | 'cumQty' | 'activatePrice'> & {
      orderId: string | number
      cumBase?: string
      cumQuote?: string
      cumQty?: string
    },
  ): CommonOrder {
    const orderStatus = (status: OrderStatus_LT): OrderStatusType => {
      if (
        status === 'FILLED' ||
        status === 'CANCELED' ||
        status === 'NEW' ||
        status === 'PARTIALLY_FILLED'
      ) {
        return status
      }
      return 'CANCELED'
    }
    const orderType = (type: FuturesOrderType_LT): OrderTypeT => {
      if (type === 'LIMIT' || type === 'MARKET') {
        return type
      }
      return 'MARKET'
    }
    return {
      positionSide: order.positionSide,
      reduceOnly: order.reduceOnly,
      closePosition: order.closePosition,
      timeInForce: order.timeInForce,
      cumQuote: order.cumQuote,
      cumBase: order.cumBase,
      cumQty: order.cumQty,
      avgPrice: order.avgPrice,
      symbol: order.symbol,
      orderId: order.orderId.toString(),
      clientOrderId: order.clientOrderId,
      updateTime: order.updateTime,
      status: orderStatus(order.status),
      type: orderType(order.type),
      price:
        order.avgPrice &&
        +order.avgPrice &&
        !isNaN(+order.avgPrice) &&
        isFinite(+order.avgPrice)
          ? order.avgPrice
          : order.price,
      origQty: order.origQty,
      executedQty: order.executedQty,
      side: order.side,
    }
  }

  protected errorClient(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Cannot connect to Binance'))
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  getUsage() {
    return limitHelper.getUsage()
  }

  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    if (!this.client) {
      return this.errorClient(timeProfile)
    }
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('leverageBracket', 'request', 1, timeProfile)) ||
      timeProfile
    const input = { recvWindow: this.recvWindow }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.usdm
        ? this.client.futuresLeverageBracket(input)
        : this.client.privateRequest(
            HttpMethod.GET,
            '/dapi/v2/leverageBracket',
            input,
          )
    )
      .then((result: LeverageBracketResult[]) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.map((r) => ({
          symbol: r.symbol,
          leverage: r.brackets[0].initialLeverage,
          step: 1,
          min: 1,
        }))
        return this.returnGood<LeverageBracket[]>(timeProfile)(data)
      })
      .catch(
        this.handleBinanceErrors(
          this.futures_leverageBracket,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
}

export default BinanceExchange
