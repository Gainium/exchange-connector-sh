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
  TimeProfile,
  RebateOverview,
  RebateRecord,
} from '../../types'
import {
  RestClientV2 as BitgetClient,
  FuturesKlineInterval,
  FuturesOrderDetailV2 as _FuturesOrderDetailV2,
  SpotKlineInterval,
  SpotOrderInfoV2 as _SpotOrderInfoV2,
  type RestClientOptions,
} from 'bitget-api'
import { RestClientV2 as BitgetOrderClient } from '../../../bitget-custom/rest-client-v2'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import {
  FuturesAssets,
  FuturesSubmitOrderResponse,
  SpotAccountType,
  FuturesPosition,
  FuturesSingleAccount,
} from './types'

type SpotOrderInfoV2 = _SpotOrderInfoV2 & {
  basePrice?: string
}

type FuturesOrderDetailV2 = _FuturesOrderDetailV2 & {
  status: 'live' | 'partially_filled' | 'filled' | 'canceled'
}

class BitgetError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

class BitgetExchange extends AbstractExchange implements Exchange {
  /** Bybit client */
  protected client: BitgetClient
  /** Bybit order client */
  private orderClient: BitgetOrderClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures
  private demo = process.env.BITGETENV === 'demo'
  constructor(
    futures: Futures,
    key: string,
    secret: string,
    passphrase: string,
    _environment?: string,
    _keysType?: string,
    _okxSource?: string,
    code?: string,
    _subaccount?: boolean,
  ) {
    super({ key, secret, passphrase })
    const options: RestClientOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
      apiPass: this.passphrase ?? '',
      recvWindow: 30000,
    }
    this.client = new BitgetClient(options)
    this.orderClient = new BitgetOrderClient(options, undefined, code)
    this.retry = 10
    this.retryErrors = [
      '10006',
      '12816',
      '12146',
      '12147',
      '5004',
      '10000',
      '10016',
      '502',
      '12149',
      '429',
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

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async getUid(timeProfile = this.getEmptyTimeProfile()) {
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotAccount()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data as SpotAccountType
        return this.returnGood<number | string>(timeProfile)(
          result.code === '00000' ? (data?.userId ?? -1) : -1,
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.getUid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotAccount()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data as SpotAccountType
        return this.returnGood<boolean>(timeProfile)(
          `${data?.inviterId}` === `${uid}`,
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.getAffiliate,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  get productTypes() {
    return this.usdm
      ? this.demo
        ? (['SUSDT-FUTURES', 'SUSDC-FUTURES'] as const)
        : (['USDT-FUTURES', 'USDC-FUTURES'] as const)
      : this.demo
        ? (['SCOIN-FUTURES'] as const)
        : (['COIN-FUTURES'] as const)
  }

  private getProductTypeBySymbol(symbol: string) {
    return this.coinm
      ? this.demo
        ? 'SCOIN-FUTURES'
        : 'COIN-FUTURES'
      : symbol.endsWith('USDT')
        ? this.demo
          ? 'SUSDT-FUTURES'
          : 'USDT-FUTURES'
        : this.demo
          ? 'SUSDC-FUTURES'
          : 'USDC-FUTURES'
  }

  private getMarginCoinBySymbolAndProductType(
    symbol: string,
    productType: string,
  ) {
    return productType === 'USDT-FUTURES' || productType === 'SUSDT-FUTURES'
      ? this.demo
        ? 'SUSDT'
        : 'USDT'
      : productType === 'USDC-FUTURES' || productType === 'SUSDC-FUTURES'
        ? this.demo
          ? 'SUSDC'
          : 'USDC'
        : this.demo
          ? 'SBTC'
          : this.demo
            ? symbol.replace(/S?USD?\w+/gm, '')
            : symbol.replace(/USD?\w+/gm, '')
  }

  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    try {
      if (!this.futures) {
        return this.errorFutures(timeProfile)
      }
      timeProfile =
        (await this.checkLimits('setFuturesLeverage', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const productType = this.getProductTypeBySymbol(symbol)
      const marginCoin = this.getMarginCoinBySymbolAndProductType(
        symbol,
        productType,
      )
      timeProfile =
        (await this.checkLimits('getFuturesAccountAsset', 0, timeProfile)) ||
        timeProfile
      const account = await this.client
        .getFuturesAccountAsset({
          symbol,
          productType,
          marginCoin,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code === '00000') {
            return this.returnGood<FuturesSingleAccount>(timeProfile)(
              result.data as FuturesSingleAccount,
            )
          }
          throw new BitgetError(result.msg, +result.code)
        })
      const isolatedHedge =
        account?.data?.marginMode === 'isolated' &&
        account?.data?.posMode === 'hedge_mode'
      if (isolatedHedge) {
        for (const holdSide of ['long', 'short'] as const) {
          timeProfile =
            (await this.checkLimits('setFuturesLeverage', 0, timeProfile)) ||
            timeProfile
          this.client
            .setFuturesLeverage({
              symbol,
              productType,
              leverage: `${leverage}`,
              marginCoin,
              holdSide,
            })
            .catch(
              this.handleBitgetErrors(
                this.futures_changeLeverage,
                symbol,
                leverage,
                this.endProfilerTime(timeProfile, 'exchange'),
              ),
            )
        }
        return this.returnGood<number>(timeProfile)(leverage)
      }
      return this.client
        .setFuturesLeverage({
          symbol,
          productType,
          leverage: `${leverage}`,
          marginCoin,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code === '00000') {
            return this.returnGood<number>(timeProfile)(leverage)
          }
          return this.handleBitgetErrors(
            this.futures_changeLeverage,
            symbol,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        })
        .catch(
          this.handleBitgetErrors(
            this.futures_changeLeverage,
            symbol,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    } catch (e) {
      this.handleBitgetErrors(
        this.futures_changeLeverage,
        symbol,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: FreeAsset = []
    for (const productType of this.productTypes) {
      try {
        timeProfile =
          (await this.checkLimits('getFuturesAccountAssets', 0, timeProfile)) ||
          timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')
        const get = await this.client.getFuturesAccountAssets({ productType })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (get.code === '00000') {
          const data = get.data as FuturesAssets[]
          data.map((d) => {
            const im = +((d as any)?.isolatedMargin ?? 0)
            res.push({
              asset: d.marginCoin,
              free: +d.available - +d.locked,
              locked: +d.locked + im,
            })
          })
        } else {
          return this.handleBitgetErrors(
            this.futures_getBalance,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(get.msg, 0))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<FreeAsset>(timeProfile)(res)
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
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresSubmitOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    const options = {
      symbol: order.symbol,
      productType,
      marginCoin: this.getMarginCoinBySymbolAndProductType(
        order.symbol,
        productType,
      ),
      marginMode:
        order.marginType === MarginType.ISOLATED ? 'isolated' : 'crossed',
      size: order.quantity,
      price: order.price,
      side:
        order.positionSide === PositionSide.BOTH
          ? order.side === 'BUY'
            ? 'buy'
            : 'sell'
          : order.positionSide === PositionSide.LONG
            ? 'buy'
            : 'sell',
      tradeSide:
        order.positionSide === PositionSide.BOTH
          ? undefined
          : order.positionSide === PositionSide.LONG
            ? order.side === 'BUY'
              ? 'open'
              : 'close'
            : order.side === 'SELL'
              ? 'open'
              : 'close',
      orderType: order.type === 'LIMIT' ? 'limit' : 'market',
      clientOid: order.newClientOrderId,
      reduceOnly:
        order.positionSide === PositionSide.BOTH
          ? undefined
          : order.reduceOnly
            ? 'YES'
            : 'NO',
    }
    if (options.tradeSide === undefined) {
      delete options.tradeSide
    }
    if (options.reduceOnly === undefined) {
      delete options.reduceOnly
    }
    return this.orderClient
      .futuresSubmitOrder(options)
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data as FuturesSubmitOrderResponse
          if (options.orderType === 'market') {
            await sleep(1000)
          }
          return await this.futures_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.futures_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getOrder(
    data: { symbol: string; newClientOrderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getFuturesOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(data.symbol)
    return this.client
      .getFuturesOrder({
        symbol: data.symbol,
        productType,
        clientOid: data.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<CommonOrder>(timeProfile)(
            this.convertFuturesOrder(data as unknown as FuturesOrderDetailV2),
          )
        }
        if (
          result.msg.indexOf('the data of the order cannot be found') !== -1
        ) {
          Logger.warn(
            `Order not found ${data.newClientOrderId}. Wait 1s and retry`,
          )
          await sleep(1000)
          timeProfile.attempts = timeProfile.attempts + 1
          return this.futures_getOrder(data, timeProfile)
        }
        return this.handleBitgetErrors(
          this.futures_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_getOrder,
          data,
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
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    return this.client
      .futuresCancelOrder({
        symbol: order.symbol,
        productType,
        clientOid: order.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return await this.futures_getOrder(order, timeProfile)
        }
        return this.handleBitgetErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    return this.client
      .futuresCancelOrder({
        symbol: order.symbol,
        productType,
        orderId: order.orderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return await this.futures_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_latestPrice(symbol: string) {
    const res = await this.futures_getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<number>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol)?.price ?? 0,
    )
  }

  async futures_getExchangeInfo(symbol: string) {
    const res = await this.futures_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<ExchangeInfo>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol),
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

    const productTypes = symbol
      ? ([this.getProductTypeBySymbol(symbol)] as const)
      : this.productTypes
    const res: CommonOrder[] = []
    for (const productType of productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesOpenOrders', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesOpenOrders({
          productType,
          symbol,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          ;(data.entrustedList ?? []).map((o) =>
            res.push(
              this.convertFuturesOrder(o as unknown as FuturesOrderDetailV2),
            ),
          )
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllOpenOrders,
            symbol,
            returnOrders,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return {
      timeProfile,
      usage: limitHelper.getInstance().getLimits(),
      status: StatusEnum.ok as StatusEnum.ok,
      data: returnOrders ? res : res.length,
    }
  }

  async futures_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    try {
      timeProfile =
        (await this.checkLimits('getTradeRate', 0, timeProfile)) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getTradeRate({
        businessType: 'mix',
        symbol,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data as { makerFeeRate: string; takerFeeRate: string }
        return this.returnGood<UserFee>(timeProfile)({
          maker: +data.makerFeeRate,
          taker: +data.takerFeeRate,
        })
      } else {
        return this.handleBitgetErrors(
          this.futures_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.futures_getUserFees,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getAllUserFees(): Promise<
    BaseReturn<(UserFee & { pair: string })[]>
  > {
    const res = await this.futures_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const fees: (UserFee & { pair: string })[] = []
    const chunks: (typeof res.data)[] = []
    for (let i = 0; i < res.data.length; i += 8) {
      chunks.push(res.data.slice(i, i + 8))
    }
    for (const ch of chunks) {
      await Promise.all(
        ch.map(async (p) => {
          const f = await this.futures_getUserFees(p.pair)
          if (f.status === StatusEnum.notok) {
            Logger.warn(`Error getting futures fees for ${p.pair} ${f.reason}`)
            fees.push({ pair: p.pair, maker: p.makerFee, taker: p.takerFee })
          } else {
            fees.push({
              pair: p.pair,
              maker: f.data.maker,
              taker: f.data.taker,
            })
          }
        }),
      )
    }

    return this.returnGood<(UserFee & { pair: string })[]>(res.timeProfile)(
      fees,
    )
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const productTypes = symbol
      ? ([this.getProductTypeBySymbol(symbol)] as const)
      : this.productTypes
    const res: PositionInfo[] = []
    for (const productType of productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesPositions', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesPositions({
          productType,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          data.map((o) => res.push(this.convertPosition(o)))
        } else {
          return this.handleBitgetErrors(
            this.futures_getPositions,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getPositions,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<PositionInfo[]>(timeProfile)(res)
  }

  private convertInterval(
    interval: ExchangeIntervals,
  ): FuturesKlineInterval | SpotKlineInterval {
    return interval === ExchangeIntervals.oneW
      ? '1Wutc'
      : interval === ExchangeIntervals.oneD
        ? '1Dutc'
        : interval === ExchangeIntervals.eightH
          ? '6Hutc'
          : interval === ExchangeIntervals.fourH
            ? this.futures
              ? '4H'
              : '4h'
            : interval === ExchangeIntervals.twoH
              ? this.futures
                ? '1H'
                : '1h'
              : interval === ExchangeIntervals.oneH
                ? this.futures
                  ? '1H'
                  : '1h'
                : interval === ExchangeIntervals.thirtyM
                  ? this.futures
                    ? '30m'
                    : '30min'
                  : interval === ExchangeIntervals.fifteenM
                    ? this.futures
                      ? '15m'
                      : '15min'
                    : interval === ExchangeIntervals.fiveM
                      ? this.futures
                        ? '5m'
                        : '5min'
                      : interval === ExchangeIntervals.threeM
                        ? this.futures
                          ? '1m'
                          : '1min'
                        : interval === ExchangeIntervals.oneM
                          ? this.futures
                            ? '1m'
                            : '1min'
                          : interval
  }

  async futures_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    _countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getFuturesHistoricCandles', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(symbol)
    return this.client
      .getFuturesHistoricCandles({
        symbol,
        productType,
        startTime: `${from}`,
        endTime: `${to}`,
        limit: '200',
        granularity: this.convertInterval(interval) as FuturesKlineInterval,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data as string[][]
          return this.returnGood<CandleResponse[]>(timeProfile)(
            data.map((d) => ({
              open: d[1],
              high: d[2],
              low: d[3],
              close: d[4],
              volume: d[6],
              time: +d[0],
            })),
          )
        }
        return this.handleBitgetErrors(
          this.futures_getCandles,
          symbol,
          interval,
          from,
          to,
          _countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_getCandles,
          symbol,
          interval,
          from,
          to,
          _countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: AllPricesResponse[] = []
    for (const productType of this.productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesAllTickers', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesAllTickers({
          productType,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          data.map((o) =>
            res.push({
              pair: o.symbol,
              price: +o.lastPr,
            }),
          )
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<AllPricesResponse[]>(timeProfile)(res)
  }

  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('setFuturesMarginMode', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(symbol)
    return this.client
      .setFuturesMarginMode({
        symbol,
        productType,
        marginMode: margin === MarginType.ISOLATED ? 'isolated' : 'crossed',
        marginCoin: this.getMarginCoinBySymbolAndProductType(
          symbol,
          productType,
        ),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return this.returnGood<MarginType>(timeProfile)(margin)
        }
        return this.handleBitgetErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getHedge(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getFuturesAccountAsset', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (!symbol) {
      const ex = await this.futures_getAllExchangeInfo()
      if (ex.status === StatusEnum.notok) {
        return ex
      }
      symbol = ex.data[0].pair
    }
    const productType = this.getProductTypeBySymbol(symbol)
    return this.client
      .getFuturesAccountAsset({
        symbol,
        productType,
        marginCoin: this.getMarginCoinBySymbolAndProductType(
          symbol,
          productType,
        ),
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<boolean>(timeProfile)(
            data.posMode === 'hedge_mode',
          )
        }
        return this.handleBitgetErrors(
          this.futures_getHedge,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_getHedge,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    for (const productType of this.productTypes) {
      timeProfile =
        (await this.checkLimits('setFuturesPositionMode', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.setFuturesPositionMode({
          productType,
          posMode: value ? 'hedge_mode' : 'one_way_mode',
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code !== '00000') {
          return this.handleBitgetErrors(
            this.futures_setHedge,
            value,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<boolean>(timeProfile)(value)
  }

  async futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<LeverageBracket[]>(all.timeProfile)(
      all.data.map((a) => ({
        symbol: a.pair,
        leverage: a.maxLeverage ? +a.maxLeverage : 100,
        step: a.stepLeverage ? +a.stepLeverage : 1,
        min: a.minLeverage ? +a.minLeverage : 1,
      })),
    )
  }

  async getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    return this.client
      .getSpotAccount()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data
        return this.returnGood<boolean>(timeProfile)(
          this.futures
            ? data.authorities.includes('coow')
            : data.authorities.includes('stow'),
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.getApiPermission,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  override returnGood<T>(
    timeProfile: TimeProfile,
    usage = limitHelper.getInstance().getLimits(),
  ) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  override returnBad(
    timeProfile: TimeProfile,
    usage = limitHelper.getInstance().getLimits(),
  ) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

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
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('spotCancelOrder', 0, timeProfile)) || timeProfile
    return this.client
      .spotCancelOrder({
        symbol: order.symbol,
        clientOid: order.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return await this.spot_getOrder(order, timeProfile)
        }
        return this.handleBitgetErrors(
          this.spot_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
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
    timeProfile =
      (await this.checkLimits('spotCancelOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .spotCancelOrder({
        symbol: order.symbol,
        orderId: order.orderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return await this.spot_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */

  async getAllExchangeInfo(): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
      })[]
    >
  > {
    if (this.futures) {
      return this.futures_getAllExchangeInfo()
    }
    return this.spot_getAllExchangeInfo()
  }

  async futures_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
        makerFee: number
        takerFee: number
        marginCoins?: string[]
      })[]
    >
  > {
    const res: (ExchangeInfo & {
      pair: string
      maxLeverage?: string
      stepLeverage?: string
      minLeverage?: string
      makerFee: number
      takerFee: number
      marginCoins?: string[]
    })[] = []
    for (const productType of this.productTypes) {
      try {
        timeProfile =
          (await this.checkLimits('getAllExchangeInfo', 20, timeProfile)) ||
          timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')
        const get = await this.client.getFuturesContractConfig({ productType })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (get.code === '00000') {
          const data = get.data
          data
            .filter((d) => d.symbolStatus === 'normal')
            .map((d) => {
              const r: (typeof res)[0] = {
                pair: d.symbol,
                baseAsset: {
                  minAmount: +d.minTradeNum,
                  maxAmount: 0,
                  step:
                    +d.volumePlace === 0
                      ? 1
                      : +`0.${'0'.repeat(+d.volumePlace - 1)}1`,
                  name: d.baseCoin,
                  maxMarketAmount: 0,
                  multiplier: +d.sizeMultiplier,
                },
                quoteAsset: {
                  minAmount: +d.minTradeUSDT,
                  name: d.quoteCoin,
                },
                maxOrders: +d.maxSymbolOrderNum,
                priceAssetPrecision: +d.pricePlace,
                minLeverage: d.minLever,
                maxLeverage: d.maxLever,
                makerFee: +d.makerFeeRate,
                takerFee: +d.takerFeeRate,
                priceMultiplier: {
                  up: +d.sellLimitPriceRatio,
                  down: +d.buyLimitPriceRatio,
                  decimals:
                    +d.pricePlace > 0
                      ? +`0.${'0'.repeat(+d.pricePlace - 1)}${+d.priceEndStep}`
                      : +`${+d.priceEndStep}${'0'.repeat(-+d.pricePlace)}`,
                },
              }
              if (this.coinm) {
                r.marginCoins = d.supportMarginCoins
              }
              res.push(r)
            })
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(get.msg, 0))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<typeof res>(timeProfile)(res)
  }
  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        makerFee: number
        takerFee: number
      })[]
    >
  > {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotSymbolInfo', 20, timeProfile)) ||
      timeProfile
    const prices = await this.spot_getAllPrices()
    return this.client
      .getSpotSymbolInfo()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<
            (ExchangeInfo & {
              pair: string
              makerFee: number
              takerFee: number
            })[]
          >(timeProfile)(
            data
              .filter((d) => d.status === 'online')
              .map((d) => {
                const p = prices?.data?.find(
                  (p) => p.pair === `${d.quoteCoin}USDT`,
                )
                const q =
                  d.quoteCoin === 'USDT' || d.quoteCoin === 'USDC'
                    ? +d.minTradeUSDT
                    : +d.minTradeUSDT / +(p?.price ?? 1)
                const res = {
                  pair: d.symbol,
                  baseAsset: {
                    minAmount: +d.minTradeAmount,
                    maxAmount: +d.maxTradeAmount,
                    step:
                      +d.quantityPrecision === 0
                        ? 1
                        : +`0.${'0'.repeat(+d.quantityPrecision - 1)}1`,
                    name: d.baseCoin,
                    maxMarketAmount: 0,
                  },
                  quoteAsset: {
                    minAmount: +q,
                    name: d.quoteCoin,
                    precision: +d.quotePrecision,
                  },
                  maxOrders: +d.orderQuantity,
                  priceAssetPrecision: +d.pricePrecision,
                  makerFee: +d.makerFeeRate,
                  takerFee: +d.takerFeeRate,
                  priceMultiplier: {
                    up: +d.sellLimitPriceRatio,
                    down: +d.buyLimitPriceRatio,
                    decimals: 0,
                  },
                }
                return res
              }),
          )
        }
        return this.handleBitgetErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getAllExchangeInfo,
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
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]> | BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_getAllOpenOrders(symbol, returnOrders)
    }
    return await this.spot_getAllOpenOrders(symbol, returnOrders)
  }

  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} [returnOrders] return orders or orders count. Default = false
   * @return {Promise<BaseReturn<CommonOrder[]>> | Promise<BaseReturn<number>>} Array of opened orders or orders count if returnOrders set to true
   */
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
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotOpenOrders', 0, timeProfile)) ||
      timeProfile
    return this.client
      .getSpotOpenOrders({ symbol })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return {
            timeProfile,
            usage: limitHelper.getInstance().getLimits(),
            status: StatusEnum.ok as StatusEnum.ok,
            data: returnOrders
              ? data.map((d) =>
                  this.convertSpotOrder(d as unknown as SpotOrderInfoV2),
                )
              : data.length,
          }
        }
        return this.handleBitgetErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
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

  /** Get user fee for all pairs
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} maker and taker fee all pairs
   */
  async spot_getAllUserFees(): Promise<
    BaseReturn<(UserFee & { pair: string })[]>
  > {
    const res = await this.spot_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const fees: (UserFee & { pair: string })[] = []
    const chunks: (typeof res.data)[] = []
    for (let i = 0; i < res.data.length; i += 8) {
      chunks.push(res.data.slice(i, i + 8))
    }
    for (const ch of chunks) {
      await Promise.all(
        ch.map(async (p) => {
          const f = await this.spot_getUserFees(p.pair)
          if (f.status === StatusEnum.notok) {
            Logger.warn(`Error getting spot fees for ${p.pair} ${f.reason}`)
            fees.push({ pair: p.pair, maker: p.makerFee, taker: p.takerFee })
          } else {
            fees.push({
              pair: p.pair,
              maker: f.data.maker,
              taker: f.data.taker,
            })
          }
        }),
      )
    }
    return this.returnGood<(UserFee & { pair: string })[]>(res.timeProfile)(
      fees,
    )
  }

  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    if (this.futures) {
      return await this.futures_getBalance()
    }
    return await this.spot_getBalance()
  }

  /** Bybit get balance
   * get user account info from bybit and look for necessary balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async spot_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const res: FreeAsset = []

    try {
      timeProfile =
        (await this.checkLimits('getSpotAccountAssets', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getSpotAccountAssets()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data
        data.map((d) => {
          res.push({
            asset: d.coin,
            free: +d.available,
            locked: +d.locked + +d.frozen,
          })
        })
      } else {
        return this.handleBitgetErrors(
          this.spot_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
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
  ): Promise<BaseReturn<ExchangeInfo>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<ExchangeInfo>(all.timeProfile)(
      all.data.find((s) => s.pair === symbol),
    )
  }

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
    timeProfile =
      (await this.checkLimits('getSpotOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotOrder({
        clientOid: data.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          let _data = result.data?.[0]
          if (!_data) {
            timeProfile =
              (await this.checkLimits('getSpotOrder', 0, timeProfile)) ||
              timeProfile
            timeProfile = this.startProfilerTime(timeProfile, 'exchange')
            _data = (
              await this.client.getSpotHistoricOrders({
                symbol: data.symbol,
                orderId: data.newClientOrderId,
              })
            )?.data?.[0]
            timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          }
          if (_data) {
            return this.returnGood<CommonOrder>(timeProfile)(
              this.convertSpotOrder(_data),
            )
          } else {
            return this.returnBad(timeProfile)(
              new BitgetError('Order not found', -1),
            )
          }
        }
        return this.handleBitgetErrors(
          this.spot_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getOrder,
          data,
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
  /** Get user fee for given pair
   * @param {string} _symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} maker and taker fee for given symbol
   */
  async spot_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    try {
      timeProfile =
        (await this.checkLimits('getTradeRate', 0, timeProfile)) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getTradeRate({
        businessType: 'spot',
        symbol,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data as { makerFeeRate: string; takerFeeRate: string }
        return this.returnGood<UserFee>(timeProfile)({
          maker: +data.makerFeeRate,
          taker: +data.takerFeeRate,
        })
      } else {
        return this.handleBitgetErrors(
          this.spot_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getUserFees,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async latestPrice(symbol: string): Promise<BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_latestPrice(symbol)
    }
    return await this.spot_latestPrice(symbol)
  }

  /** Get the latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async spot_latestPrice(symbol: string): Promise<BaseReturn<number>> {
    const res = await this.spot_getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<number>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol)?.price ?? 0,
    )
  }

  async openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    positionSide?: PositionSide
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>> {
    if (this.futures) {
      return await this.futures_openOrder(order)
    }
    return await this.spot_openOrder(order)
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
  async spot_openOrder(
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
      (await this.checkLimits('spotSubmitOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const options = {
      symbol: order.symbol,
      orderType: order.type === 'LIMIT' ? 'limit' : 'market',
      size: order.quantity,
      price: order.price,
      side: order.side === 'BUY' ? 'buy' : 'sell',
      clientOid: order.newClientOrderId,
      force: order.type === 'LIMIT' ? 'gtc' : undefined,
    }
    if (!options.force) {
      delete options.force
    }
    return this.orderClient
      .spotSubmitOrder(options)
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          if (options.orderType === 'market') {
            await sleep(1000)
          }
          return await this.spot_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

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
    timeProfile =
      (await this.checkLimits('getSpotHistoricCandles', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      to
        ? this.client.getSpotHistoricCandles({
            symbol,
            endTime: `${to}`,
            limit: '200',
            granularity: this.convertInterval(interval) as SpotKlineInterval,
          })
        : this.client.getSpotCandles({
            symbol,
            //@ts-ignore
            startTime: from,
            //@ts-ignore
            endTime: to,
            //@ts-ignore
            limit: 200,
            //@ts-ignore
            granularity: this.convertInterval(interval),
          })
    )
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data as string[][]
          return this.returnGood<CandleResponse[]>(timeProfile)(
            data.map((d) => ({
              open: d[1],
              high: d[2],
              low: d[3],
              close: d[4],
              volume: d[7],
              time: +d[0],
            })),
          )
        }
        return this.handleBitgetErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
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

  async getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.futures) {
      return await this.futures_getAllPrices()
    }
    return await this.spot_getAllPrices()
  }

  /**
   * Get all prices
   */
  async spot_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    const res: AllPricesResponse[] = []
    timeProfile =
      (await this.checkLimits('getSpotTicker', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.client.getSpotTicker()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (result.code === '00000') {
        const data = result.data
        data.map((o) =>
          res.push({
            pair: o.symbol,
            price: +o.lastPr,
          }),
        )
      } else {
        return this.handleBitgetErrors(
          this.spot_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getAllPrices,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<AllPricesResponse[]>(timeProfile)(res)
  }

  /**
   * Convert Bybit order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private convertFuturesOrder(order?: FuturesOrderDetailV2): CommonOrder {
    const orderStatus = (): OrderStatusType => {
      const { state, status } = order
      if (['live'].includes(state || status)) {
        return 'NEW'
      }
      if (['partially_filled'].includes(state || status)) {
        return 'PARTIALLY_FILLED'
      }
      if (['filled'].includes(state || status)) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: string): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }

    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOid,
      transactTime: +order.uTime,
      updateTime: +order.cTime,
      price:
        order.orderType === 'market'
          ? order.priceAvg
            ? `${+order.priceAvg || +order.price}`
            : order.price
          : order.price,
      origQty: order.size,
      executedQty: order.baseVolume,
      cummulativeQuoteQty: order.quoteVolume,
      status: orderStatus(),
      type: orderType(order.orderType),
      side:
        order.posSide === 'net'
          ? order.side === 'sell'
            ? 'SELL'
            : 'BUY'
          : order.tradeSide === 'open'
            ? order.side === 'sell'
              ? 'SELL'
              : 'BUY'
            : order.side === 'buy'
              ? 'SELL'
              : 'BUY',
      fills: [],
      reduceOnly: order.reduceOnly === 'yes',
      positionSide:
        order.posSide === 'net'
          ? PositionSide.BOTH
          : order.posSide === 'long'
            ? PositionSide.LONG
            : PositionSide.SHORT,
    }
  }

  private convertSpotOrder(order?: SpotOrderInfoV2): CommonOrder {
    const orderStatus = (): OrderStatusType => {
      const { status } = order
      if (['live'].includes(status)) {
        return 'NEW'
      }
      if (['partially_filled'].includes(status)) {
        return 'PARTIALLY_FILLED'
      }
      if (['filled'].includes(status)) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: string): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }
    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOid,
      transactTime: +order.uTime,
      updateTime: +order.cTime,
      price:
        order.orderType === 'market'
          ? order.basePrice
            ? `${+order.basePrice || +order.priceAvg}`
            : order.priceAvg
          : order.priceAvg,
      origQty: order.size,
      executedQty: order.baseVolume,
      cummulativeQuoteQty: order.quoteVolume,
      status: orderStatus(),
      type: orderType(order.orderType),
      side: order.side === 'sell' ? 'SELL' : 'BUY',
      fills: [],
    }
  }

  private convertPosition(position: FuturesPosition): PositionInfo {
    return {
      symbol: position.symbol,
      initialMargin: position.marginSize,
      maintMargin: position.marginSize,
      unrealizedProfit: position.unrealizedPL,
      positionInitialMargin: position.marginSize,
      openOrderInitialMargin: position.marginSize,
      leverage: position.leverage,
      isolated: position.marginMode === 'isolated',
      entryPrice: position.openPriceAvg,
      maxNotional: '',
      positionSide:
        position.posMode === 'hedge_mode'
          ? position.holdSide === 'long'
            ? PositionSide.LONG
            : PositionSide.SHORT
          : +position.total > 0
            ? PositionSide.LONG
            : PositionSide.SHORT,
      positionAmt: position.total,
      notional: '',
      isolatedWallet: '',
      updateTime: +position.uTime,
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Bitget API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleBitgetErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (
      e: Error & {
        code: number
        response?: string
      },
    ) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      const restApiNotEnabled = 'Rest API trading is not enabled'.toLowerCase()
      const cannotCancel =
        'Can not cancel order, please try again later'.toLowerCase()
      const unknownError = 'unknown error'.toLowerCase()
      const bad = 'Bad Request'.toLowerCase()
      const msg = `${
        (e as { body?: { msg?: string } })?.body?.msg || e.message
      }`.toLowerCase()
      if (
        this.retryErrors.includes(`${e.code}`) ||
        e.response ||
        msg.indexOf('request timestamp expired') !== -1 ||
        msg.indexOf('Internal System Error'.toLowerCase()) !== -1 ||
        msg.indexOf('Forbidden') !== -1 ||
        msg.indexOf(bad) !== -1 ||
        msg.indexOf('Server Timeout'.toLowerCase()) !== -1 ||
        msg.indexOf('Server error'.toLowerCase()) !== -1 ||
        msg.indexOf('fetch failed'.toLowerCase()) !== -1 ||
        msg.indexOf('getaddrinfo'.toLowerCase()) !== -1 ||
        msg.indexOf('outside of the recvWindow'.toLowerCase()) !== -1 ||
        msg.indexOf('recv_window'.toLowerCase()) !== -1 ||
        msg.indexOf('socket hang up'.toLowerCase()) !== -1 ||
        msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
        msg.indexOf('too many requests'.toLowerCase()) !== -1 ||
        msg.indexOf('possible ip block'.toLowerCase()) !== -1 ||
        msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
        msg.indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
        msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1 ||
        msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1 ||
        msg.indexOf(tls) !== -1 ||
        msg.indexOf('timeout of 300000ms exceeded'.toLowerCase()) !== -1 ||
        msg.indexOf(restApiNotEnabled) !== -1 ||
        msg.indexOf(cannotCancel) !== -1 ||
        msg.indexOf(unknownError) !== -1
      ) {
        if (timeProfile.attempts < this.retry) {
          if (msg.indexOf(restApiNotEnabled) !== -1) {
            Logger.warn(
              `Bitget Rest API trading is not enabled sleep 10s ${timeProfile.attempts}`,
            )
            await sleep(10 * 1000)
          }
          if (msg.indexOf(unknownError) !== -1) {
            Logger.warn(`Bitget Unknown Error sleep 3s ${timeProfile.attempts}`)
            await sleep(3 * 1000)
          }
          if (msg.indexOf('request timestamp expired') !== -1) {
            Logger.warn(
              `Bitget Request timestamp sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (msg.indexOf('recv_window') !== -1) {
            Logger.warn(`Bitget recv_window sleep 5s ${timeProfile.attempts}`)
            await sleep(5 * 1000)
          }
          if (
            msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
            `${e.code}` === '429'
          ) {
            const time = 1000
            Logger.log(
              `Bitget Too many visits wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('too many requests'.toLowerCase()) !== -1) {
            const time = 1000
            if (timeProfile.attempts > 1) {
              Logger.log(
                `Bitget too many requests wait ${time}ms ${
                  timeProfile.attempts
                } ${cb.name} ${this.key}`,
              )
            }
            await sleep(time)
          }
          if (`${e.code}` === '403') {
            const time = 60000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Bitget 403 block wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Gateway Time-out wait 5s ${timeProfile.attempts}`,
            )
            await sleep(5000)
          }
          if (msg.indexOf(bad) !== -1) {
            Logger.log(`Bitget Bad Request wait 0.1s ${timeProfile.attempts}`)
            await sleep(100)
          }
          if (msg.indexOf('socket hang up'.toLowerCase()) !== -1) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Bitget socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Internal System Error'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Server Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('Server error'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Server error wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Forbidden wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('possible ip block'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('ECONNRESET'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1) {
            Logger.log(`Bitget EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('getaddrinfo'.toLowerCase()) !== -1) {
            Logger.log(`Bitget getaddrinfo wait 2s ${timeProfile.attempts}`)
            await sleep(2000)
          }
          if (msg.indexOf(tls) !== -1) {
            Logger.log(
              `Bitget Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf(cannotCancel) !== -1) {
            Logger.log(
              `Bitget Cannot cancel order wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(`${this.exchangeProblems}${msg}`),
          )
        }
      } else {
        const message = msg
        return this.returnBad(timeProfile)(new Error(message))
      }
    }
  }

  /**
   * Check info from binance provider about limits and set them to {@link BybitExchange#info}
   * If limits exceeded - call {@link BybitExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: string,
    count?: number,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    const limit = await limitHelper
      .getInstance()
      .addLimit(count ? { name: request, count } : undefined)
    if (limit > 0) {
      Logger.warn(
        `Bitget request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, count)
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
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
}

export default BitgetExchange
