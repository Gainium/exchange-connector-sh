import type {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  FreeAsset,
  OrderTypes,
  OrderTypeT,
  ReturnBad,
  ReturnGood,
  UserFee,
  ExchangeLimitUsage,
  MarginType,
  PositionSide,
  LeverageBracket,
  TradeResponse,
  TimeProfile,
  RebateRecord,
  RebateOverview,
} from './types'
import { ExchangeIntervals, StatusEnum, PositionInfo } from './types'
import { convertNumberToString } from '../utils/math'

export interface Exchange {
  returnGood<T>(
    timeProfile: TimeProfile,
    usage: ExchangeLimitUsage,
  ): (r: T) => ReturnGood<T>

  returnBad(
    timeProfile: TimeProfile,
    usage: ExchangeLimitUsage,
  ): (e: Error) => ReturnBad

  getBalance(): Promise<BaseReturn<FreeAsset>>

  openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    positionSide?: PositionSide
    marginType?: MarginType
    leverage?: number
  }): Promise<BaseReturn<CommonOrder>>

  getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>>

  cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>>

  latestPrice(symbol: string): Promise<BaseReturn<number>>

  getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>>

  getAllExchangeInfo(): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>>

  getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>

  getAllOpenOrders(
    symbol: string,
    returnOrders: true,
  ): Promise<BaseReturn<CommonOrder[]>>

  getAllOpenOrders(
    symbol: string,
    returnOrders: boolean,
  ): Promise<BaseReturn<number> | BaseReturn<CommonOrder[]>>

  getUserFees(symbol: string): Promise<BaseReturn<UserFee>>

  getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>>

  getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>>

  getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>>

  getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>>

  futures_changeLeverage(
    symbols: string,
    leverage: number,
  ): Promise<BaseReturn<number>>

  futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
  ): Promise<BaseReturn<MarginType>>

  futures_getHedge(_symbol?: string): Promise<BaseReturn<boolean>>

  futures_setHedge(value: boolean): Promise<BaseReturn<boolean>>

  futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>>

  futures_getPositions(symbol?: string): Promise<BaseReturn<PositionInfo[]>>

  getUid(): Promise<BaseReturn<string | number>>

  getAffiliate(uid: string | number): Promise<BaseReturn<boolean>>

  getRebateRecords(
    timestamp: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>>

  getRebateOverview(timestamp: number): Promise<BaseReturn<RebateOverview>>
}

/** Abstract class for exchange. Every supported exchange must extends this class */
abstract class AbsctractExchange implements Exchange {
  public timeout = 5 * 60 * 1000
  public key?: string
  public secret?: string
  public passphrase?: string
  public environment?: string
  public exchangeProblems = 'Exchange connector | '
  /** Constructor method
   * @param {string} key api key
   * @param {string} secret api secret
   * @param passphrase
   * @param environment
   */
  constructor(input: {
    key?: string
    secret?: string
    passphrase?: string
    environment?: 'live' | 'sandbox'
  }) {
    this.key = input?.key
    this.secret = input?.secret
    this.passphrase = input?.passphrase
    this.environment = input?.environment
  }

  /** Convert number to string for qty and price */
  convertNumberToString(number: number) {
    return convertNumberToString(number)
  }

  /** Function to handle and format success result */
  returnGood<T>(timeProfile: TimeProfile, usage: ExchangeLimitUsage) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile,
    })
  }

  /** Function to handle and format error result */
  returnBad(timeProfile: TimeProfile, usage: ExchangeLimitUsage) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile,
    })
  }

  getEmptyTimeProfile(): TimeProfile {
    return {
      attempts: 1,
      incomingTime: +new Date(),
      outcomingTime: 0,
      inQueueStartTime: 0,
      inQueueEndTime: 0,
      exchangeRequestStartTime: 0,
      exchangeRequestEndTime: 0,
    }
  }

  startProfilerTime(
    profiler: TimeProfile,
    type: 'exchange' | 'queue',
  ): TimeProfile {
    if (type === 'exchange') {
      if (
        profiler.exchangeRequestStartTime &&
        profiler.exchangeRequestEndTime
      ) {
        profiler.exchangeRequestStartTime =
          +new Date() -
          (profiler.exchangeRequestEndTime - profiler.exchangeRequestStartTime)
      } else {
        profiler.exchangeRequestStartTime = +new Date()
      }
    }
    if (type === 'queue') {
      if (profiler.inQueueStartTime && profiler.inQueueEndTime) {
        profiler.inQueueStartTime =
          +new Date() - (profiler.inQueueEndTime - profiler.inQueueStartTime)
      } else {
        profiler.inQueueStartTime = +new Date()
      }
    }
    return profiler
  }

  endProfilerTime(
    profiler: TimeProfile,
    type: 'exchange' | 'queue',
  ): TimeProfile {
    if (type === 'exchange') {
      profiler.exchangeRequestEndTime = +new Date()
    }
    if (type === 'queue') {
      profiler.inQueueEndTime = +new Date()
    }
    return profiler
  }

  /** Count price precision */
  getPricePrecision(price: string) {
    let use = price
    // if price exp fromat, 1e-7
    if (price.indexOf('e-') !== -1) {
      use = Number(price).toFixed(parseFloat(price.split('e-')[1]))
    }
    // if price have no 1, 0.00025
    if (use.indexOf('1') === -1) {
      const dec = use.replace('0.', '')
      const numbers = dec.replace(/0/g, '')
      const place = dec.indexOf(numbers)
      if (place <= 1) {
        return place
      }
      //0.0000025
      use = `0.${'0'.repeat(place - 1)}1`
    }
    return use.indexOf('1') === 0 ? 0 : use.replace('0.', '').indexOf('1') + 1
  }

  /**
   * Get Balance abstract function
   *
   * @returns {Promise<BaseReturn>} {asset: string; free: number; locked: number }[] balances array
   */
  abstract getBalance(): Promise<BaseReturn<FreeAsset>>

  /** Open order abstract function
   * @param {OrderTypes} order.side BUY or SELL
   * @param {number} order.quantity quantity
   * @param {number} order.price limit price
   * @param {string} order.newClientOrderId order id
   * @return {Promise<BaseReturn<Order>>} Order data
   */
  abstract openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>>

  /** Open order abstract function
   * @param {string} symbol pair
   * @param {string} newClientOrderId order id
   * @return {Promise<BaseReturn<Order>>}  order data
   */
  abstract getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>>

  /** Cancel order
   * @param {string} symbol pair
   * @param {string} newClientOrderId order id
   * @return {<BaseReturn<Order>>}  order data
   */
  abstract cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>>

  /** Get latest price for a given pair
   * @param {string} symbol symbol to look for
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  abstract latestPrice(symbol: string): Promise<BaseReturn<number>>

  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @return {Promise<ExchangeInfo>} Promise\<EchangeInfo> for quoted asset: min order, min step, max order, for base asset: min order and for pair max orders
   */
  abstract getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>>

  /** Get exchange info for all pair
   * @return {Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>>} for quoted asset: min order, min step, max order, for base asset: min order and for pair max orders
   */
  abstract getAllExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  >

  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} returnOrders return orders or orders count
   * @return {Promise<BaseReturn<number>> | Promise<BaseReturn<Order>>} Promise\<BaseReturn> array of opened orders
   */
  abstract getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  abstract getAllOpenOrders(
    symbol: string,
    returnOrders: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  abstract getAllOpenOrders(
    symbol: string,
    returnOrders: boolean,
  ): Promise<BaseReturn<number> | BaseReturn<CommonOrder[]>>

  /** Get user fees for given pair
   * @param {string} symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} Promise\<BaseReturn> object of maker and taker fees {maker: number; taker: number}
   */
  abstract getUserFees(symbol: string): Promise<BaseReturn<UserFee>>

  /** Get user fees for all pair
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} Promise\<BaseReturn> object of maker and taker fees {maker: number; taker: number}
   */
  abstract getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>>

  /**
   * Get candles data for given interval
   * @param {string} symbol Symbol
   * @param {ExchangeIntervals} interval Interval
   * @param {number} from From time in ms
   * @param {number} [to] To time in ms
   * @param {number} [count] Data count
   */
  abstract getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>>

  abstract getTrades(
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>>

  /**
   * Get all prices
   */
  abstract getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>>

  /**
   * Update leverage
   */
  abstract futures_changeLeverage(
    symbol: string,
    leverage: number,
  ): Promise<BaseReturn<number>>

  /**
   * Update margin type
   * @param {MarginType} margin Margin type
   */
  abstract futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
  ): Promise<BaseReturn<MarginType>>

  /**
   * Get usage
   */
  abstract getUsage(): { type: string; value: number }[]

  abstract futures_getHedge(_symbol?: string): Promise<BaseReturn<boolean>>

  abstract futures_setHedge(value: boolean): Promise<BaseReturn<boolean>>

  abstract futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>>

  abstract futures_getPositions(
    symbol?: string,
  ): Promise<BaseReturn<PositionInfo[]>>

  abstract cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>>

  abstract getUid(): Promise<BaseReturn<string | number>>

  abstract getAffiliate(uid: string | number): Promise<BaseReturn<boolean>>

  abstract getRebateRecords(
    timestamp: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>>

  abstract getRebateOverview(
    timestamp: number,
  ): Promise<BaseReturn<RebateOverview>>
}

export default AbsctractExchange
