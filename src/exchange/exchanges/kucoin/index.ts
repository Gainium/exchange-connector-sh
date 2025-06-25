import type {
  Fill,
  KucoinOrder,
  OrderType,
  Position,
} from '@gainium/kucoin-api/dist/types'
import Kucoin from '@gainium/kucoin-api'
import AbstractExchange, { Exchange } from '../../abstractExchange'
import limitHelper, { LimitType } from './limit'
import {
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  FreeAsset,
  OrderStatusType,
  OrderTypes,
  OrderTypeT,
  UserFee,
  LeverageBracket,
  TradeResponse,
  PositionInfo,
  MarginType,
  TimeProfile,
  RebateOverview,
  RebateRecord,
} from '../../types'
import {
  AllPricesResponse,
  ExchangeIntervals,
  StatusEnum,
  Futures,
  PositionSide,
} from '../../types'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { round } from '../../../utils/math'

class KucoinError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const intervalMap: { [x in ExchangeIntervals]: string } = {
  '1m': '1min',
  '3m': '3min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1hour',
  '2h': '2hour',
  '4h': '4hour',
  '8h': '8hour',
  '1d': '1day',
  '1w': '1week',
}
const intervalTimeMap: { [x in ExchangeIntervals]: number } = {
  '1m': 60,
  '3m': 3 * 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
}

class KucoinExchange extends AbstractExchange implements Exchange {
  /** Kucoin client */
  protected client: Kucoin
  /** Retry count. Default 10 */
  private retry: number
  protected futures?: Futures
  /** Array of error codes, after which retyr atttemp is executed */
  private retryErrors: string[]
  /** Constructor method
   * @param {string} key api key
   * @param {string} secret api secret
   * @param passphrase
   * @returns {Kucoin} self
   */
  constructor(
    futures: Futures,
    key?: string,
    secret?: string,
    passphrase?: string,
    _environment?: string,
    _keysType?: unknown,
    _okxSource?: string,
    code?: string,
  ) {
    super({ key, secret, passphrase })
    this.client = new Kucoin(
      {
        key: this.key ?? '',
        secret: this.secret ?? '',
        passphrase: this.passphrase ?? '',
      },
      {
        spot: { id: 'Gainium', secret: code },
        futures: {
          id: 'Gainiumfutures',
          secret: code,
        },
      },
    )
    this.retry = 10
    this.retryErrors = [
      '429',
      '403',
      '500',
      '503',
      '502',
      '429000',
      '200004',
      '400000',
      '500000',
      '504',
      '524',
      '-104',
      '200002',
      '503000',
      '400002',
      '524',
      '1015',
      '520',
      '530',
    ]
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
    timestamp: number,
    startTime?: number,
    endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<RebateRecord[]>> {
    timeProfile =
      (await this.checkLimits(
        'getRebateRecords',
        LimitType.spot,
        30,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAffiliateUserRebateInformation({
        date: `${timestamp}`,
        offset: startTime ?? 0,
      })
      .then((data) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        console.log(data)
        return this.returnGood<RebateRecord[]>(timeProfile)(
          [] as RebateRecord[],
        )
      })
      .catch(
        this.handleKucoinErrors(
          this.getRebateRecords,
          timestamp,
          startTime,
          endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    timeProfile =
      (await this.checkLimits(
        'getUid',
        LimitType.management,
        5,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getApiKey()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          return this.returnGood<number>(timeProfile)(res.data.uid)
        }
        return this.handleKucoinErrors(
          this.getUid,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.getUid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile =
      (await this.checkLimits(
        'getUid',
        LimitType.management,
        5,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const date = new Date()
    return this.client
      .getAffiliateUserRebateInformation({
        date: `${date.getFullYear}${date.getMonth()}${date.getDate()}`,
      })
      .then((res) => {
        console.log(res)
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          return this.returnGood<boolean>(timeProfile)(false)
        }
        return this.handleKucoinErrors(
          this.getAffiliate,
          uid,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.getAffiliate,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  private convertXBTtoBTC(symbol: string) {
    return symbol.replace(/^XBT/, 'BTC')
  }

  private convertBTCtoXBT(symbol: string) {
    return symbol.replace(/^BTC/, 'XBT')
  }

  private convertQuoteAssetToUsd(symbol: string) {
    return symbol
      .replace(/USDTM$/, 'USDT')
      .replace(/USDCM$/, 'USDC')
      .replace(/USDM$/, 'USD')
  }

  private convertQuoteAssetToKucoin(symbol: string) {
    return symbol
      .replace(/USDT$/, 'USDTM')
      .replace(/USDC$/, 'USDCM')
      .replace(/USD$/, 'USDM')
  }

  private convertSymbol(symbol: string) {
    return this.convertXBTtoBTC(this.convertQuoteAssetToUsd(symbol))
  }

  private convertSymbolToKucoin(symbol: string) {
    return this.convertBTCtoXBT(this.convertQuoteAssetToKucoin(symbol))
  }

  private convertMultiplier(multiplier: number) {
    return Math.max(multiplier, 1)
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return this.futures === Futures.coinm
  }

  override returnGood<T>(timeProfile: TimeProfile, usage = this.getUsage()) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  override returnBad(timeProfile: TimeProfile, usage = this.getUsage()) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async futures_changeLeverage(
    _symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    return this.returnGood<number>(timeProfile)(leverage)
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const pairs = await this.futures_getAllExchangeInfo()
    if (pairs.status !== StatusEnum.ok) {
      return pairs
    }
    const currenciesSet: Set<string> = new Set()
    pairs.data.forEach((p) => {
      if (this.coinm) {
        currenciesSet.add(this.convertBTCtoXBT(p.baseAsset.name))
      } else {
        currenciesSet.add(p.quoteAsset.name)
      }
    })
    const balances: FreeAsset = []

    for (const c of currenciesSet) {
      timeProfile =
        (await this.checkLimits(
          'futures_getBalance',
          LimitType.futures,
          5,
          timeProfile,
        )) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const balance = await this.client.getFuturesAccounts({ currency: c })
      if (balance.status === StatusEnum.ok) {
        if (balance.data) {
          const b = balance.data
          balances.push({
            asset: this.coinm ? this.convertXBTtoBTC(b.currency) : b.currency,
            free: b.availableBalance,
            locked: b.positionMargin + b.orderMargin + b.frozenFunds,
          })
        }
      } else {
        return this.handleKucoinErrors(
          this.futures_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new KucoinError(balance.reason, balance.reasonCode))
      }
    }
    timeProfile = this.endProfilerTime(timeProfile, 'exchange')
    return this.returnGood<FreeAsset>(timeProfile)(balances)
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
      leverage: number
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_openOrder',
        LimitType.futures,
        2,
        timeProfile,
      )) || timeProfile
    const {
      side,
      quantity,
      price,
      newClientOrderId,
      type,
      leverage,
      reduceOnly,
      marginType,
    } = order
    const symbol = this.convertSymbolToKucoin(order.symbol)
    let request: ReturnType<typeof this.client.placeFuturesOrder>
    const marginMode = marginType === MarginType.ISOLATED ? 'ISOLATED' : 'CROSS'
    if (!type || type === 'LIMIT') {
      request = this.client.placeFuturesOrder({
        symbol,
        side: side === 'BUY' ? 'buy' : 'sell',
        size: `${quantity}`,
        clientOid: newClientOrderId || '',
        type: 'limit',
        price: this.convertNumberToString(price),
        leverage,
        reduceOnly,
        marginMode,
      })
    } else {
      request = this.client.placeFuturesOrder({
        symbol,
        side: side === 'BUY' ? 'buy' : 'sell',
        size: `${quantity}`,
        clientOid: newClientOrderId || '',
        type: 'market',
        leverage,
        reduceOnly,
        marginMode,
      })
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return request
      .then(async (res) => {
        if (res.status === StatusEnum.ok) {
          await sleep(500)
          const orderData = await this.getFuturesOrderAfterExecution(
            res.data.orderId,
          )
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (orderData.status === StatusEnum.ok) {
            return this.returnGood<CommonOrder>(timeProfile)(
              await this.convertOrder(orderData.data),
            )
          }
          return this.handleKucoinErrors(
            this.futures_getOrder,
            { symbol, newClientOrderId },
            timeProfile,
          )(new KucoinError(orderData.reason, orderData.reasonCode))
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.handleKucoinErrors(
          this.futures_openOrder,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_openOrder,
          order,
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
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getOrder',
        LimitType.futures,
        5,
        timeProfile,
      )) || timeProfile
    const { newClientOrderId } = data
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesOrderById({
        id: newClientOrderId,
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(res.data),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getOrder,
          data,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  private async getFuturesOrderAfterExecution(
    id: string,
    tries = 0,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits(
        'futures_getOrder',
        LimitType.futures,
        5,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client.getFuturesOrderById({ id }).then(async (res) => {
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (res.reasonCode === '100001' && tries < 5) {
        const sleepTime = tries <= 2 ? 500 : 1000
        Logger.warn(
          `Cannot find KUCOIN order ${id} after execution wait ${
            sleepTime / 1000
          }s`,
        )
        await sleep(sleepTime)
        return this.getFuturesOrderAfterExecution(id, tries + 1)
      }
      if (res.status === StatusEnum.ok) {
        return this.returnGood<KucoinOrder>(timeProfile)(res.data)
      }
      return this.handleKucoinErrors(
        this.getFuturesOrderAfterExecution,
        id,
        tries,
        timeProfile,
      )(new KucoinError(res.reason, res.reasonCode))
    })
  }

  async futures_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_cancelOrder',
        LimitType.futures,
        1,
        timeProfile,
      )) || timeProfile
    const { newClientOrderId } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelFuturesOrderByOrderId({
        id: newClientOrderId,
      })
      .then(async (res) => {
        if (res.status === StatusEnum.ok) {
          await sleep(500)
          const orderData =
            await this.getFuturesOrderAfterExecution(newClientOrderId)
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (orderData.status === StatusEnum.notok) {
            return this.handleKucoinErrors(
              this.futures_getOrder,
              order,
              timeProfile,
            )(new KucoinError(orderData.reason, orderData.reasonCode))
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(orderData.data),
          )
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.handleKucoinErrors(
          this.futures_cancelOrder,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_cancelOrderByOrderIdAndSymbol',
        LimitType.futures,
        1,
        timeProfile,
      )) || timeProfile
    const { orderId, symbol } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelFuturesOrderByClientId({
        id: orderId,
        symbol: this.convertSymbolToKucoin(symbol),
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          await this.checkLimits(
            'futures_getOrder',
            LimitType.futures,
            5,
            timeProfile,
          )
          const ord = await this.client.getFuturesOrderById({
            id: orderId,
          })
          if (ord.status === StatusEnum.notok) {
            return this.returnBad(timeProfile)(
              new KucoinError(ord.reason, ord.reasonCode),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(ord.data),
          )
        }
        return this.handleKucoinErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_latestPrice',
        LimitType.public,
        2,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesTicker({ symbol: this.convertSymbolToKucoin(symbol) })
      .then((price) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (price.status === StatusEnum.ok) {
          return this.returnGood<number>(timeProfile)(
            parseFloat(price.data.price),
          )
        }
        return this.handleKucoinErrors(
          this.futures_latestPrice,
          symbol,
          timeProfile,
        )(new KucoinError(price.reason, price.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getPositions',
        LimitType.futures,
        2,
        timeProfile,
      )) || timeProfile
    if (symbol) {
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      return this.client
        .getFuturesPositionBySymbol({
          symbol: this.convertSymbolToKucoin(symbol),
        })
        .then((positions) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (positions.status === StatusEnum.ok) {
            return this.returnGood<PositionInfo[]>(timeProfile)(
              positions.data ? [this.convertPosition(positions.data)] : [],
            )
          }
          return this.handleKucoinErrors(
            this.futures_getPositions,
            symbol,
            timeProfile,
          )(new KucoinError(positions.reason, positions.reasonCode))
        })
        .catch(
          this.handleKucoinErrors(
            this.futures_getPositions,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesPositions()
      .then((positions) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (positions.status === StatusEnum.ok) {
          return this.returnGood<PositionInfo[]>(timeProfile)(
            positions.data.map((p) => this.convertPosition(p)),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getPositions,
          symbol,
          timeProfile,
        )(new KucoinError(positions.reason, positions.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_getPositions,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getExchangeInfo(symbol: string) {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    const symbols = await this.futures_getAllExchangeInfo()
    if (symbols.status === StatusEnum.notok) {
      return symbols
    }
    const symbolData = symbols.data.find((s) => s.pair === symbol)
    if (!symbolData) {
      return this.returnBad(symbols.timeProfile)(new Error('Symbol not found'))
    }
    return this.returnGood<ExchangeInfo>(symbols.timeProfile)(symbolData)
  }

  async futures_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getAllExchangeInfo',
        LimitType.public,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesSymbols()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === 'OK') {
          return this.returnGood<(ExchangeInfo & { pair: string })[]>(
            timeProfile,
          )(
            res.data
              .filter((d) => this.coinm === d.isInverse)
              .map((d) => ({
                pair: this.convertSymbol(d.symbol),
                maxOrders: 200,
                baseAsset: {
                  name: this.convertXBTtoBTC(d.baseCurrency),
                  minAmount: this.coinm ? 0.00000001 : d.multiplier,
                  maxAmount:
                    d.maxOrderQty * this.convertMultiplier(d.multiplier),
                  step: this.coinm ? 0.00000001 : d.multiplier,
                  maxMarketAmount:
                    d.maxOrderQty * this.convertMultiplier(d.multiplier),
                },
                quoteAsset: {
                  name: this.convertQuoteAssetToUsd(d.quoteCurrency),
                  minAmount: d.lotSize,
                },
                priceAssetPrecision: this.getPricePrecision(`${d.tickSize}`),
                crossAvailable: d.supportCross,
              })),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getAllExchangeInfo,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.futures_getAllExchangeInfo,
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
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getAllOpenOrders',
        LimitType.futures,
        2,
        timeProfile,
      )) || timeProfile
    const input: { symbol?: string; status: 'active' } = {
      symbol: symbol ? this.convertSymbolToKucoin(symbol) : '',
      status: 'active',
    }
    if (!symbol) {
      delete input.symbol
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesOrders(input)
      .then(async (orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (orders.status === StatusEnum.ok) {
          if (returnOrders) {
            const convertedOrders: CommonOrder[] = []
            for (const o of orders.data.items) {
              const data = await this.convertOrder(o)
              convertedOrders.push(data)
            }
            return {
              status: StatusEnum.ok as StatusEnum.ok,
              data: convertedOrders,
              reason: null,
              timeProfile,
              usage: this.getUsage(),
            }
          }
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            data: orders.data.totalNum,
            reason: null,
            usage: this.getUsage(),
            timeProfile,
          }
        }
        return this.handleKucoinErrors(
          this.futures_getAllOpenOrders,
          symbol,
          returnOrders,
          timeProfile,
        )(new KucoinError(orders.reason, orders.reasonCode))
      })
      .catch(
        this.handleKucoinErrors<BaseReturn<CommonOrder[] | number>>(
          this.futures_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const result = await this.futures_getAllUserFees()
    const find = result.data.find((s) => s.pair === symbol)
    if (find) {
      return this.returnGood<UserFee>(result.timeProfile)({
        maker: find.maker,
        taker: find.taker,
      })
    }
    return this.returnBad(result.timeProfile)(new Error('Fee not found'))
  }

  async futures_getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    timeProfile =
      (await this.checkLimits(
        'futures_getAllUserFees',
        LimitType.public,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesSymbols()
      .then(async (symbols) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (symbols.status === StatusEnum.ok) {
          return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
            symbols.data
              .filter((d) => this.coinm === d.isInverse)
              .map((d) => ({
                pair: this.convertSymbol(d.symbol),
                maker: d.makerFeeRate,
                taker: d.takerFeeRate,
              })),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getAllUserFees,
          timeProfile,
        )(new KucoinError(symbols.reason, symbols.reasonCode))
      })

      .catch(
        this.handleKucoinErrors(
          this.futures_getAllUserFees,
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
    const options: {
      symbol: string
      from?: number
      to?: number
      granularity: number
    } = {
      symbol: this.convertSymbolToKucoin(symbol),
      granularity: intervalTimeMap[interval] / 60,
    }

    if (from) {
      options.from = Math.floor(parseFloat(`${from}`))
      if (`${options.from}`.length < `${+new Date()}`.length) {
        return this.returnGood<CandleResponse[]>(timeProfile)([])
      }
    }
    if (to) {
      options.to = Math.floor(parseFloat(`${to}`))
      if (`${options.to}`.length < `${+new Date()}`.length) {
        return this.returnGood<CandleResponse[]>(timeProfile)([])
      }
    }
    timeProfile =
      (await this.checkLimits(
        'futures_getCandles',
        LimitType.public,
        3,
        timeProfile,
      )) || timeProfile
    if (countData) {
      options.to = Math.floor(new Date().getTime())
      options.from = options.to - intervalTimeMap[interval] * 1000 * countData
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesKlines(options)
      .then((res) => {
        if (res.status === StatusEnum.ok) {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          return this.returnGood<CandleResponse[]>(timeProfile)(
            res.data.map((k) => ({
              open: k[1],
              high: k[2],
              low: k[3],
              close: k[4],
              time: parseFloat(k[0]),
              volume: k[5],
            })),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
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

  async futures_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    timeProfile =
      (await this.checkLimits(
        'futures_getAllPrices',
        LimitType.public,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesSymbols()
      .then(async (symbols) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (symbols.status === StatusEnum.ok) {
          return this.returnGood<AllPricesResponse[]>(timeProfile)(
            symbols.data
              .filter((d) => this.coinm === d.isInverse)
              .map((d) => ({
                pair: this.convertSymbol(d.symbol),
                price: d.markPrice,
              })),
          )
        }
        return this.handleKucoinErrors(
          this.futures_getAllPrices,
          timeProfile,
        )(new KucoinError(symbols.reason, symbols.reasonCode))
      })

      .catch(
        this.handleKucoinErrors(
          this.futures_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_changeMarginType(
    _symbol: string,
    margin: MarginType,
    _leverage: number,
  ): Promise<BaseReturn<MarginType>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.returnGood<MarginType>(this.getEmptyTimeProfile())(margin)
  }

  async futures_getHedge(_symbol?: string): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.returnGood<boolean>(this.getEmptyTimeProfile())(false)
  }

  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    timeProfile =
      (await this.checkLimits('futures_getAllPrices', LimitType.public, 3)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFuturesSymbols()
      .then(async (symbols) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (symbols.status === StatusEnum.ok) {
          return this.returnGood<LeverageBracket[]>(timeProfile)(
            symbols.data
              .filter((d) => this.coinm === d.isInverse)
              .map((d) => ({
                symbol: this.convertSymbol(d.symbol),
                leverage: d.maxLeverage,
                step: 1,
                min: 1,
              })),
          )
        }
        return this.handleKucoinErrors(
          this.futures_leverageBracket,
          timeProfile,
        )(new KucoinError(symbols.reason, symbols.reasonCode))
      })

      .catch(
        this.handleKucoinErrors(
          this.futures_leverageBracket,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_setHedge(): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.returnGood<boolean>(this.getEmptyTimeProfile())(false)
  }
  /**
   * Check info from binance provider about limis and set them to {@link KucoinExchange#info}
   * If limits exceede - call {@link KucoinExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: string,
    type: LimitType,
    weight: number,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    const limit = await limitHelper.getInstance().addWeight(type, weight)
    if (limit > 0) {
      Logger.warn(
        `Kucoin request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, type, weight)
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
  }
  /**
   * Handle errors from Kucoin API<br/>
   *
   * If error code is in {@link KucoinExchange#retryErrors} and attemp is less than {@link KucoinExchange#retry} - retry action
   */
  protected handleKucoinErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (e: Error & { code?: string; response?: string }) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      const ts =
        e.message.toLowerCase().indexOf('KC-API-TIMESTAMP'.toLowerCase()) !== -1
      // sleep 10 seconds if too many requests received
      if (
        ['429', '200002', '403', '1015', '530'].includes(`${e.code}`) ||
        e.message.indexOf('too many request') !== -1
      ) {
        const wait =
          `${e.code}` === '429' ||
          `${e.code === '429000'}` ||
          `${e.code === '530'}`
            ? 30 * 1000
            : `${e.code}` === '1015'
              ? 50 * 1000
              : 10e3 * (1 + 0.5 * ((timeProfile.attempts || 1) - 1))
        Logger.warn(`Kucoin Get ${e.code} error. Waiting ${wait / 1e3} seconds`)
        await limitHelper.getInstance().fillLimits()
        await sleep(wait)
      }
      if (
        e.message.toLowerCase().indexOf('Request Timeout'.toLowerCase()) !== -1
      ) {
        Logger.warn(`Kucoin Get Request Timeout error. Waiting 5s seconds`)
        await sleep(5000)
      }
      if (
        ['524', '520'].includes(`${e.code}`) ||
        e.message.indexOf('524 code') !== -1
      ) {
        const wait = 10e3
        Logger.warn(`Kucoin Get ${e.code} error. Waiting ${wait / 1e3} seconds`)
        await sleep(wait)
      }
      // retry on 504
      if (['504', '524'].includes(`${e.code}`)) {
        Logger.warn(`Kucoin Get ${e.code} error. Retry in 2s`)
        await sleep(2e3)
      }
      // retry on 502
      if (['502'].includes(`${e.code}`)) {
        Logger.warn(`Kucoin Get ${e.code} error. Retry in 10s`)
        await sleep(10e3)
      }
      if (
        e.message.toLowerCase().indexOf('fetch failed'.toLowerCase()) !== -1 ||
        ['-104'].includes(`${e.code}`)
      ) {
        Logger.warn(`Kucoin Get fetch failed error. Retry in 2s`)
        await sleep(2e3)
      }
      if (ts) {
        const time = timeProfile.attempts * 2
        Logger.warn(`Kucoin Get KC-API-TIMESTAMP error. Retry in ${time}s`)
        await sleep(time * 1000)
      }
      if (
        e.message
          .toLowerCase()
          .indexOf('Connect Timeout Error'.toLowerCase()) !== -1
      ) {
        Logger.warn(`Kucoin Get Connect Timeout Error error. Retry in 5s`)
        await sleep(5e3)
      }
      if (['500'].includes(`${e.code}`)) {
        Logger.warn(`Kucoin Get 500 error. Retry in 10s`)
        await sleep(10e3)
      }
      if (['500000'].includes(`${e.code}`)) {
        Logger.warn(`Kucoin Get 500000 error. Retry in 5s`)
        await sleep(5e3)
      }
      if (['503000', '503'].includes(`${e.code}`)) {
        Logger.warn(`Kucoin Get 503000 error. Retry in 10s`)
        await sleep(10e3)
      }

      if (
        this.retryErrors.includes(e.code || '0') ||
        e.response ||
        e.message.toLowerCase().indexOf('fetch failed'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('Request Timeout'.toLowerCase()) !==
          -1 ||
        ts ||
        e.message
          .toLowerCase()
          .indexOf('Connect Timeout Error'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('too many request'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf('internal error'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf(tls.toLowerCase()) !== -1
      ) {
        if (timeProfile.attempts < this.retry * (ts ? 2 : 1)) {
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(`${this.exchangeProblems}${e.message} | ${e.code}`),
          )
        }
      } else {
        return this.returnBad(timeProfile)(
          new Error(`${e.message} | ${e.code}`),
        )
      }
    }
  }
  /**
   * Convert Binance order to Common order
   *
   * @param {Order} order to convert
   * @param needFills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private async convertOrder(
    order: KucoinOrder,
    needFills?: boolean,
  ): Promise<CommonOrder> {
    const orderStatus = (): OrderStatusType => {
      if (order.isActive) {
        if (`${order.dealSize}` === '0') {
          return 'NEW'
        }
        if (`${order.size}` !== `${order.dealSize}`) {
          return 'PARTIALLY_FILLED'
        }
      }
      if (!order.cancelExist) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: OrderType): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }
    const fills: Fill[] = []
    if (needFills) {
      await this.checkLimits('convertOrder', LimitType.spot, 10)
      const fillsRequest = await this.client.listFills({ orderId: order.id })
      if (fillsRequest.status === StatusEnum.ok) {
        fillsRequest.data.items.map((f) => fills.push(f))
      }
    }
    const updateTime =
      fills.sort((a, b) => b.createdAt - a.createdAt)[0]?.createdAt ??
      order.createdAt
    const status = orderStatus()
    const type = orderType(order.type)
    const price =
      status === 'FILLED' || status === 'PARTIALLY_FILLED'
        ? +order.dealFunds > 0 && +order.dealSize > 0
          ? `${+order.dealFunds / +order.dealSize}`
          : order.dealValue && +order.dealValue > 0 && +order.dealSize > 0
            ? !this.coinm
              ? `${+order.dealValue / +order.dealSize}`
              : `${+order.dealSize / +order.dealValue}`
            : order.price
        : order.price
    return {
      symbol: this.convertSymbol(order.symbol),
      orderId: order.id,
      clientOrderId: order.clientOid,
      transactTime: order.createdAt,
      updateTime,
      price,
      origQty: order.size,
      executedQty: order.dealSize,
      cummulativeQuoteQty: order.dealFunds,
      status,
      type,
      side: order.side === 'buy' ? 'BUY' : 'SELL',
      fills:
        fills.map((f) => ({
          price: f.price,
          qty: f.size,
          commission: f.fee,
          commissionAsset: f.feeCurrency,
          tradeId: f.tradeId,
        })) || [],
      reduceOnly: order.reduceOnly,
    }
  }
  /** Binance get balance
   * get user account info from binance and look for necessery balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async spot_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getBalance',
        LimitType.management,
        5,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAccounts()
      .then((accountInfo) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (accountInfo.status === StatusEnum.ok) {
          const balances = accountInfo.data
          return this.returnGood<FreeAsset>(timeProfile)(
            balances
              .filter((b) => b.type === 'trade')
              .map((balance) => ({
                asset: balance.currency,
                free: parseFloat(balance.available),
                locked: parseFloat(balance.holds),
              })),
          )
        }
        return this.handleKucoinErrors(
          this.spot_getBalance,
          timeProfile,
        )(new KucoinError(accountInfo.reason, accountInfo.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    if (this.futures) {
      return await this.futures_getBalance()
    }
    return await this.spot_getBalance()
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
    timeProfile =
      (await this.checkLimits(
        'spot_openOrder',
        LimitType.spot,
        2,
        timeProfile,
      )) || timeProfile
    const { symbol, side, quantity, price, newClientOrderId, type } = order
    let request: ReturnType<typeof this.client.placeOrder>
    if (!type || type === 'LIMIT') {
      request = this.client.placeOrder({
        symbol,
        side: side === 'BUY' ? 'buy' : 'sell',
        size: `${quantity}`,
        clientOid: newClientOrderId || '',
        type: 'limit',
        price: this.convertNumberToString(price),
      })
    } else {
      request = this.client.placeOrder({
        symbol,
        side: side === 'BUY' ? 'buy' : 'sell',
        size: `${quantity}`,
        clientOid: newClientOrderId || '',
        type: 'market',
      })
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return request
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          const { orderId } = res.data
          await sleep(100)
          await this.checkLimits(
            'spot_getOrder',
            LimitType.spot,
            2,
            timeProfile,
          )
          let orderData = await this.client.getOrderById({
            id: orderId,
          })
          if (orderData.status === StatusEnum.ok) {
            return this.returnGood<CommonOrder>(timeProfile)(
              await this.convertOrder(orderData.data, true),
            )
          }
          if (
            orderData.status === StatusEnum.notok &&
            (orderData.reason ?? '')
              .toLowerCase()
              .indexOf('The order does not exist'.toLowerCase()) !== -1
          ) {
            await sleep(500)
            await this.checkLimits(
              'spot_getOrder',
              LimitType.spot,
              2,
              timeProfile,
            )
            orderData = await this.client.getOrderById({
              id: orderId,
            })
            if (orderData.status === StatusEnum.ok) {
              return this.returnGood<CommonOrder>(timeProfile)(
                await this.convertOrder(orderData.data, true),
              )
            }
          }
          if (
            orderData.status === StatusEnum.notok &&
            (orderData.reason ?? '')
              .toLowerCase()
              .indexOf('The order does not exist'.toLowerCase()) !== -1
          ) {
            await sleep(1500)
            await this.checkLimits(
              'spot_getOrder',
              LimitType.spot,
              2,
              timeProfile,
            )
            orderData = await this.client.getOrderById({
              id: orderId,
            })
            if (orderData.status === StatusEnum.ok) {
              return this.returnGood<CommonOrder>(timeProfile)(
                await this.convertOrder(orderData.data, true),
              )
            }
          }
          if (
            orderData.status === StatusEnum.notok &&
            (orderData.reason ?? '')
              .toLowerCase()
              .indexOf('The order does not exist'.toLowerCase()) !== -1
          ) {
            await sleep(5000)
            await this.checkLimits(
              'spot_getOrder',
              LimitType.spot,
              2,
              timeProfile,
            )
            orderData = await this.client.getOrderById({
              id: orderId,
            })
            if (orderData.status === StatusEnum.ok) {
              return this.returnGood<CommonOrder>(timeProfile)(
                await this.convertOrder(orderData.data, true),
              )
            }
          }
          return this.handleKucoinErrors(
            this.spot_getOrder,
            { symbol, newClientOrderId },
            timeProfile,
          )(new KucoinError(orderData.reason, orderData.reasonCode))
        }
        return this.handleKucoinErrors(
          this.spot_openOrder,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: 'LIMIT' | 'MARKET'
    leverage?: number
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_openOrder({
        ...order,
        leverage: order.leverage ?? 1,
        marginType: order.marginType ?? MarginType.ISOLATED,
      })
    }
    return await this.spot_openOrder(order)
  }
  /** Get order abstract function
   * @param {object} data Order info
   * @param count
   * @param {string} data.symbol pair
   * @param {string} data.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async spot_getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getOrder',
        LimitType.spot,
        3,
        timeProfile,
      )) || timeProfile
    const { newClientOrderId } = data
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getOrderByClientId({
        id: newClientOrderId,
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(res.data, true),
          )
        }
        return this.handleKucoinErrors(
          this.spot_getOrder,
          data,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getOrder(data: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_getOrder(data)
    }
    return await this.spot_getOrder(data)
  }
  /** Get latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async spot_latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    timeProfile =
      (await this.checkLimits(
        'spot_latestPrice',
        LimitType.public,
        15,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAllTickers()
      .then((price) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (price.status === StatusEnum.ok) {
          const find = price.data.ticker.find((t) => t.symbol === symbol)
          if (find) {
            return this.returnGood<number>(timeProfile)(parseFloat(find.last))
          }
          return this.returnBad(timeProfile)(new Error('Symbol not found'))
        }
        return this.handleKucoinErrors(
          this.spot_latestPrice,
          symbol,
          timeProfile,
        )(new KucoinError(price.reason, price.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async latestPrice(symbol: string): Promise<BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_latestPrice(symbol)
    }
    return await this.spot_latestPrice(symbol)
  }
  /** Cancel order
   * @param {object} order Order info
   * @param count
   * @param {string} order.symbol pair
   * @param {string} order.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async spot_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits(
        'spot_cancelOrder',
        LimitType.spot,
        5,
        timeProfile,
      )) || timeProfile
    const { newClientOrderId } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrderByClientId({
        id: newClientOrderId,
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          const id = res.data.cancelledOrderId
          await sleep(100)
          await this.checkLimits(
            'spot_getOrder',
            LimitType.spot,
            2,
            timeProfile,
          )
          const ord = await this.client.getOrderById({
            id,
          })
          if (ord.status === StatusEnum.notok) {
            return this.handleKucoinErrors(
              this.spot_getOrder,
              order,
              timeProfile,
            )(new KucoinError(ord.reason, ord.reasonCode))
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(ord.data, true),
          )
        }
        return this.handleKucoinErrors(
          this.spot_cancelOrder,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrder(order: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return this.futures_cancelOrder(order)
    }
    return this.spot_cancelOrder(order)
  }

  async spot_cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits(
        'spot_cancelOrderByOrderIdAndSymbol',
        LimitType.spot,
        5,
        timeProfile,
      )) || timeProfile
    const { orderId } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrderByClientId({
        id: orderId,
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (
          res.status === StatusEnum.notok &&
          (res.reason ?? '')
            .toLowerCase()
            .includes('order_not_exist_or_not_allow_to_cancel')
        ) {
          await this.checkLimits(
            'spot_cancelOrder',
            LimitType.spot,
            3,
            timeProfile,
          )
          res = await this.client.cancelOrder({ id: orderId }).then((r) =>
            r.status === StatusEnum.ok
              ? {
                  ...r,
                  data: {
                    cancelledOrderId: r?.data?.cancelledOrderIds?.[0],
                    clientOid: r?.data?.cancelledOrderIds?.[0],
                  },
                }
              : {
                  status: r.status,
                  reason: r.reason,
                  data: null,
                  reasonCode: r.reasonCode,
                },
          )
        }
        if (res.status === StatusEnum.ok) {
          const id = res.data.cancelledOrderId
          await this.checkLimits(
            'spot_getOrder',
            LimitType.spot,
            2,
            timeProfile,
          )
          const ord = await this.client.getOrderById({
            id,
          })
          if (ord.status === StatusEnum.notok) {
            return this.returnBad(timeProfile)(
              new KucoinError(ord.reason, ord.reasonCode),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(ord.data, true),
          )
        }

        return this.handleKucoinErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
          order,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
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
      return this.futures_cancelOrderByOrderIdAndSymbol(order)
    }
    return this.spot_cancelOrderByOrderIdAndSymbol(order)
  }

  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<ExchangeInfo>>} Exchange info about pair
   */
  async spot_getExchangeInfo(
    symbol: string,
  ): Promise<BaseReturn<ExchangeInfo>> {
    const symbols = await this.getAllExchangeInfo()
    if (symbols.status === StatusEnum.notok) {
      return symbols
    }
    const symbolData = symbols.data.find((s) => s.pair === symbol)
    if (!symbolData) {
      return this.returnBad(symbols.timeProfile)(new Error('Symbol not found'))
    }
    return this.returnGood<ExchangeInfo>(symbols.timeProfile)(symbolData)
  }
  async getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>> {
    if (this.futures) {
      return await this.futures_getExchangeInfo(symbol)
    }
    return await this.spot_getExchangeInfo(symbol)
  }
  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */
  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getAllExchangeInfo',
        LimitType.public,
        4,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSymbols()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === 'OK') {
          return this.returnGood<(ExchangeInfo & { pair: string })[]>(
            timeProfile,
          )(
            res.data.map((d) => ({
              pair: d.symbol,
              maxOrders: 200,
              baseAsset: {
                name: d.baseCurrency,
                minAmount: parseFloat(d.baseMinSize),
                maxAmount: parseFloat(d.baseMaxSize),
                step: parseFloat(d.baseIncrement),
                maxMarketAmount: parseFloat(d.baseMaxSize),
              },
              quoteAsset: {
                name: d.quoteCurrency,
                minAmount: Math.max(
                  round(
                    +d.quoteIncrement + parseFloat(d.quoteMinSize),
                    this.getPricePrecision(`${d.quoteIncrement}`),
                  ),
                  round(
                    parseFloat(d.minFunds ?? d.quoteMinSize) +
                      +d.quoteIncrement,
                    this.getPricePrecision(`${d.quoteIncrement}`),
                  ),
                ),
              },
              priceAssetPrecision: this.getPricePrecision(
                `${d.priceIncrement}`,
              ),
            })),
          )
        }
        return this.handleKucoinErrors(
          this.spot_getAllExchangeInfo,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getAllExchangeInfo(): Promise<
    BaseReturn<(ExchangeInfo & { pair: string })[]>
  > {
    if (this.futures) {
      return await this.futures_getAllExchangeInfo()
    }
    return await this.spot_getAllExchangeInfo()
  }
  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} [returnOrders] return orders or orders count. Default = false
   * @return {Promise<BaseReturn<CommonOrder[]>> | Promise<BaseReturn<number>>} Array of opened orders or orders count if returnOrders set to true
   */
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<number>>
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits(
        'spot_getAllOpenOrders',
        LimitType.spot,
        2,
        timeProfile,
      )) || timeProfile
    const input: { symbol?: string; status: 'active'; tradeType: 'TRADE' } = {
      symbol,
      status: 'active',
      tradeType: 'TRADE',
    }
    if (!symbol) {
      delete input.symbol
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getOrders(input)
      .then(async (orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (orders.status === StatusEnum.ok) {
          if (returnOrders) {
            const convertedOrders: CommonOrder[] = []
            for (const o of orders.data.items) {
              const data = await this.convertOrder(o)
              convertedOrders.push(data)
            }
            return {
              status: StatusEnum.ok as StatusEnum.ok,
              data: convertedOrders,
              reason: null,
              timeProfile,
              usage: this.getUsage(),
            }
          }
          return {
            status: StatusEnum.ok as StatusEnum.ok,
            data: orders.data.totalNum,
            reason: null,
            timeProfile,
            usage: this.getUsage(),
          }
        }
        return this.handleKucoinErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          timeProfile,
        )(new KucoinError(orders.reason, orders.reasonCode))
      })
      .catch(
        this.handleKucoinErrors<BaseReturn<CommonOrder[] | number>>(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(symbol?: string, returnOrders = false) {
    if (this.futures) {
      return await this.futures_getAllOpenOrders(symbol, returnOrders)
    }
    return await this.spot_getAllOpenOrders(symbol, returnOrders)
  }
  /** Get user fee for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<UserFee>>} maker and taker fee for given symbol
   */
  async spot_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getUserFees',
        LimitType.spot,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getFees([symbol])
      .then((fees) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (fees.status === StatusEnum.ok) {
          if (fees.data[0]) {
            return this.returnGood<UserFee>(timeProfile)({
              maker: parseFloat(fees.data[0].makerFeeRate || '1'),
              taker: parseFloat(fees.data[0].takerFeeRate || '1'),
            })
          }
          return this.returnBad(timeProfile)(new Error('Symbol not found'))
        }
        return this.handleKucoinErrors(
          this.spot_getUserFees,
          symbol,
          timeProfile,
        )(new KucoinError(fees.reason, fees.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getUserFees(symbol: string): Promise<BaseReturn<UserFee>> {
    if (this.futures) {
      return await this.futures_getUserFees(symbol)
    }
    return await this.spot_getUserFees(symbol)
  }
  /** Get user fee for all pairs
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} maker and taker fee all pairs
   */
  async spot_getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getAllUserFees',
        LimitType.spot,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getBaseFees()
      .then(async (fees) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (fees.status === StatusEnum.ok) {
          const tickers = await this.client.getAllTickers()
          if (tickers.status === StatusEnum.ok) {
            const baseMaker =
              fees.data.makerFeeRate === '0'
                ? 0
                : parseFloat(fees.data.makerFeeRate)
            const baseTaker =
              fees.data.takerFeeRate === '0'
                ? 0
                : parseFloat(fees.data.takerFeeRate)
            const data = tickers.data.ticker.map((t) => ({
              pair: t.symbol,
              maker:
                t.makerCoefficient === '0'
                  ? 0
                  : parseFloat(t.makerCoefficient) * baseMaker,
              taker:
                t.takerCoefficient === '0'
                  ? 0
                  : parseFloat(t.takerCoefficient) * baseTaker,
            }))
            return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
              data,
            )
          }
          return this.returnBad(timeProfile)(new Error(tickers.reason))
        }
        return this.handleKucoinErrors(
          this.spot_getAllUserFees,
          timeProfile,
        )(new KucoinError(fees.reason, fees.reasonCode))
      })

      .catch(
        this.handleKucoinErrors(
          this.spot_getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (this.futures) {
      return await this.futures_getAllUserFees()
    }
    return await this.spot_getAllUserFees()
  }
  /**
   * Get candles data
   */
  async spot_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getCandles',
        LimitType.public,
        3,
        timeProfile,
      )) || timeProfile

    const options: any = {
      symbol,
      type: intervalMap[interval],
    }
    if (from) {
      options.startAt = Math.floor(parseFloat(`${from}`) / 1000)
    }
    if (to) {
      options.endAt = Math.floor(parseFloat(`${to}`) / 1000)
    }
    if (countData) {
      options.endAt = Math.floor(new Date().getTime() / 1000)
      options.startAt = options.endAt - intervalTimeMap[interval] * countData
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getKlines(options)
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.status === StatusEnum.ok) {
          return this.returnGood<CandleResponse[]>(timeProfile)(
            res.data.map((k) => ({
              open: k[1],
              close: k[2],
              high: k[3],
              low: k[4],
              time: parseFloat(k[0]) * 1000,
              volume: k[5],
            })),
          )
        }
        return this.handleKucoinErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          timeProfile,
        )(new KucoinError(res.reason, res.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
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

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
  ): Promise<BaseReturn<CandleResponse[]>> {
    if (this.futures) {
      return await this.futures_getCandles(
        symbol,
        interval,
        from,
        to,
        countData,
      )
    }
    return await this.spot_getCandles(symbol, interval, from, to, countData)
  }
  /** Get all prices
   */
  async spot_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    timeProfile =
      (await this.checkLimits(
        'spot_getAllPrices',
        LimitType.public,
        15,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAllTickers()
      .then((price) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (price.status === StatusEnum.ok) {
          return this.returnGood<AllPricesResponse[]>(timeProfile)(
            price.data.ticker.map((p) => ({
              pair: p.symbol,
              price: parseFloat(p.last),
            })),
          )
        }
        return this.handleKucoinErrors(
          this.spot_getAllPrices,
          timeProfile,
        )(new KucoinError(price.reason, price.reasonCode))
      })
      .catch(
        this.handleKucoinErrors(
          this.spot_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.futures) {
      return await this.futures_getAllPrices()
    }
    return await this.spot_getAllPrices()
  }

  getUsage() {
    return limitHelper.getInstance().getLimits()
  }

  async getTrades(
    _symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.returnGood<TradeResponse[]>(this.getEmptyTimeProfile())([])
  }

  private convertPosition(position: Position): PositionInfo {
    return {
      symbol: this.convertSymbol(position.symbol),
      initialMargin: `${position.maintMargin}`,
      maintMargin: `${position.maintMargin}`,
      unrealizedProfit: `${position.unrealisedPnl}`,
      positionInitialMargin: `${position.maintMargin}`,
      openOrderInitialMargin: `${position.maintMargin}`,
      leverage: `${Math.round(position.realLeverage)}`,
      isolated: !position.crossMode,
      entryPrice: `${position.avgEntryPrice}`,
      maxNotional: '',
      positionSide: PositionSide.BOTH,
      positionAmt: `${position.currentQty}`,
      notional: '',
      isolatedWallet: '',
      updateTime: position.currentTimestamp,
      bidNotional: '',
      askNotional: '',
    }
  }
}

export default KucoinExchange
