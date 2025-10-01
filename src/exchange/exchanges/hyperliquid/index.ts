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
import * as hl from '@nktkas/hyperliquid'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { IdMute, IdMutex } from '../../../utils/mutex'

type OrderResponseMissing = {
  status: 'unknownOid'
}

type OrderResponseFound = {
  status: 'order'
  order: {
    order: {
      coin: string
      side: string
      limitPx: string
      sz: string
      oid: number
      timestamp: number
      triggerCondition: string
      isTrigger: boolean
      triggerPx: string
      children: unknown[]
      isPositionTpsl: boolean
      reduceOnly: boolean
      orderType: string
      origSz: string
      tif: string
      cloid: string | null
    }
    status:
      | 'open'
      | 'filled'
      | 'canceled'
      | 'rejected'
      | 'marginCanceled'
      | 'vaultWithdrawalCanceled'
      | 'openInterestCapCanceled'
      | 'selfTradeCanceled'
      | 'reduceOnlyCanceled'
      | 'siblingFilledCanceled'
      | 'delistedCanceled'
      | 'liquidatedCanceled'
      | 'scheduledCancel'
      | 'tickRejected'
      | 'minTradeNtlRejected'
      | 'perpMarginRejected'
      | 'reduceOnlyRejected'
      | 'badAloPxRejected'
      | 'iocCancelRejected'
      | 'badTriggerPxRejected'
      | 'marketOrderNoLiquidityRejected'
      | 'positionIncreaseAtOpenInterestCapRejected'
      | 'positionFlipAtOpenInterestCapRejected'
      | 'tooAggressiveAtOpenInterestCapRejected'
      | 'openInterestIncreaseRejected'
      | 'insufficientSpotBalanceRejected'
      | 'oracleRejected'
      | 'perpMaxPositionRejected'
    statusTimestamp: number
  }
}

type OrderResponse = OrderResponseMissing | OrderResponseFound

type PlaceOrderResponseScheduled = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          resting: {
            oid: number
          }
        },
      ]
    }
  }
}

type PalceOrderResponseError = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          error: string
        },
      ]
    }
  }
}

type PlaceOrderResponseFilled = {
  status: 'ok'
  response: {
    type: 'order'
    data: {
      statuses: [
        {
          filled: {
            totalSz: string
            avgPx: string
            oid: number
          }
        },
      ]
    }
  }
}

type PlaceOrderResponse =
  | PlaceOrderResponseScheduled
  | PalceOrderResponseError
  | PlaceOrderResponseFilled

type CancelOrderResponseSuccess = {
  status: 'ok'
  response: {
    type: 'cancel'
    data: {
      statuses: ['success']
    }
  }
}

type CancelOrderResponseError = {
  status: 'ok'
  response: {
    type: 'cancel'
    data: {
      statuses: [
        {
          error: 'Order was never placed, already canceled, or filled.'
        },
      ]
    }
  }
}

type CancelOrderResponse = CancelOrderResponseSuccess | CancelOrderResponseError

const mutex = new IdMutex()

class HyperliquidError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

type Market = 'spot' | 'futures'

class HyperliquidAssets {
  static HyperliquidAssetsInstance: HyperliquidAssets
  static getInstance() {
    if (!HyperliquidAssets.HyperliquidAssetsInstance) {
      HyperliquidAssets.HyperliquidAssetsInstance = new HyperliquidAssets()
    }
    return HyperliquidAssets.HyperliquidAssetsInstance
  }

  private assetsSpot: Map<string, number> = new Map()
  private pairsSpot: Map<number, string> = new Map()
  private assetsInverse: Map<string, number> = new Map()
  private pairsInverse: Map<number, string> = new Map()
  private lastUpdate = 0
  private updateInterval = 20 * 60000
  private client: hl.InfoClient = new hl.InfoClient({
    transport: new hl.HttpTransport({
      isTestnet: process.env.HYPERLIQUIDENV === 'demo',
    }),
  })

  @IdMute(mutex, () => 'getCoinByPair')
  public async getCoinByPair(pair: string, market: Market) {
    const assets = market === 'spot' ? this.assetsSpot : this.assetsInverse
    if (
      assets.size === 0 ||
      this.lastUpdate + this.updateInterval < Date.now()
    ) {
      await this.updateAssets(market)
    }
    return `${(market === 'futures' ? 0 : 10000) + (assets.get(pair) ?? 0)}`
  }

  @IdMute(mutex, () => 'getCoinNameByPair')
  public async getCoinNameByPair(pair: string, market: Market) {
    if (market === 'futures') {
      return pair.split('-')[0]
    }
    const assets = this.assetsSpot
    if (
      assets.size === 0 ||
      this.lastUpdate + this.updateInterval < Date.now()
    ) {
      await this.updateAssets(market)
    }
    const code = assets.get(pair)
    if (typeof code === 'undefined') {
      return pair
    }
    return `${code === 0 ? 'PURR/USDC' : `@${code}`}`
  }

  @IdMute(mutex, () => 'getCoinByPair')
  public async getPairByCoin(coin: string, market: Market) {
    const pairs = market === 'spot' ? this.pairsSpot : this.pairsInverse
    if (
      pairs.size === 0 ||
      this.lastUpdate + this.updateInterval < Date.now()
    ) {
      await this.updateAssets(market)
    }
    if (coin === 'PURR/USDC') {
      return 'PURR-USDC'
    }
    return pairs.get(+coin.replace('@', '')) ?? coin
  }

  protected async checkLimits(request: string, count?: number): Promise<void> {
    const limit = await limitHelper.addWeight(count)
    if (limit > 0) {
      Logger.warn(
        `Hyperliquid Assets request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, count)
    }
    return
  }

  @IdMute(mutex, () => 'updateAssets')
  private async updateAssets(market: Market) {
    if (
      this.lastUpdate + this.updateInterval > Date.now() &&
      (market === 'spot' ? this.pairsSpot.size > 0 : this.pairsInverse.size > 0)
    ) {
      return
    }
    try {
      if (market === 'spot') {
        await this.checkLimits('spotMeta', 20)
        const assets = await this.client.spotMeta()
        const { tokens, universe } = assets
        universe.forEach((u) => {
          const base = tokens.find((tk) => tk.index === u.tokens[0])
          const quote = tokens.find((tk) => tk.index === u.tokens[1])
          if (base && quote) {
            base.name = base.name === 'UBTC' ? 'BTC' : base.name
            const pair = `${base.name}-${quote.name}`
            this.assetsSpot.set(pair, u.index)
            this.pairsSpot.set(u.index, pair)
          }
        })
      }
      if (market === 'futures') {
        await this.checkLimits('meta', 20)
        const futures = await this.client.meta()
        futures.universe.forEach((u, i) => {
          const pair = `${u.name}-USDC`
          this.assetsInverse.set(pair, i)
          this.pairsInverse.set(i, pair)
        })
      }
      this.lastUpdate = Date.now()
    } catch (e) {
      Logger.error(`Error updating Hyperliquid assets: ${e.message}`)
      return
    }
  }
}

class HyperliquidExchange extends AbstractExchange implements Exchange {
  /** Hyperliquid info client */
  protected infoClient: hl.InfoClient
  /** Hyperliquid exchange client */
  protected exchangeClient: hl.ExchangeClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures
  private demo = process.env.HYPERLIQUIDENV === 'demo'
  constructor(
    futures: Futures,
    key: string,
    secret: string,
    passphrase?: string,
    _environment?: string,
    _keysType?: string,
    _okxSource?: string,
    _code?: string,
  ) {
    super({ key, secret, passphrase })
    this.infoClient = new hl.InfoClient({
      transport: new hl.HttpTransport({ isTestnet: this.demo }),
    })
    this.exchangeClient = new hl.ExchangeClient({
      transport: new hl.HttpTransport({ isTestnet: this.demo }),
      wallet: this.secret as `0x${string}`,
      isTestnet: this.demo,
    })
    this.retry = 10
    this.retryErrors = ['429']
    this.futures = futures === Futures.null ? this.futures : futures
  }

  private methodNotSupported() {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  async getRebateOverview(
    _timestamp: number,
  ): Promise<BaseReturn<RebateOverview>> {
    return this.methodNotSupported()
  }

  async getRebateRecords(
    _timestamp: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>> {
    return this.methodNotSupported()
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return false
  }

  get _key() {
    return this.key as `0x${string}`
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async getUid() {
    return this.methodNotSupported()
  }

  async getAffiliate(_uid: string | number) {
    return this.methodNotSupported()
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
        (await this.checkLimits('updateLeverage', 1, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      return await this.exchangeClient
        .updateLeverage({
          asset: +(await this.getCoinByPair(symbol, true)),
          isCross: false,
          leverage,
        })
        .then(() => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          return this.returnGood<number>(timeProfile)(leverage)
        })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_changeLeverage,
        symbol,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: FreeAsset = []
    try {
      timeProfile =
        (await this.checkLimits('getClearinghouseState', 2, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.infoClient.clearinghouseState({
        user: this._key,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')

      const data = get.marginSummary

      res.push({
        asset: 'USDC',
        free: +data.totalRawUsd - +data.totalMarginUsed,
        locked: +data.totalMarginUsed,
      })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  private async getCoinByPair(pair: string, force = false) {
    return this.futures && !force
      ? pair.split('-')[0]
      : await HyperliquidAssets.getInstance().getCoinByPair(
          pair,
          this.futures ? 'futures' : 'spot',
        )
  }

  private async getCoinNameByPair(pair: string, force = false) {
    return this.futures && !force
      ? pair.split('-')[0]
      : await HyperliquidAssets.getInstance().getCoinNameByPair(
          pair,
          this.futures ? 'futures' : 'spot',
        )
  }

  private async getPairByCoin(coin: string) {
    return this.futures
      ? `${coin}-USDC`
      : await HyperliquidAssets.getInstance().getPairByCoin(
          coin,
          this.futures ? 'futures' : 'spot',
        )
  }

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
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('placeOrder', 1, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const pricePrecision = `${order.price}`.includes('.')
      ? `${order.price}`.split('.')[1].length
      : 0
    const orders: hl.OrderParams = {
      a: +(await this.getCoinByPair(order.symbol, true)),
      b: order.side === 'BUY',
      s: `${order.quantity}`,
      p: `${order.type === 'MARKET' ? (order.side === 'BUY' ? (order.price * 1.1).toFixed(pricePrecision) : (order.price * 0.9).toFixed(pricePrecision)) : order.price}`,
      t: {
        limit: { tif: 'Gtc' },
      },
      r: !!order.reduceOnly,
      c: order.newClientOrderId as `0x${string}`,
    }
    if (!this.futures) {
      orders.r = false
    }
    return this.exchangeClient
      .order(
        {
          orders: [orders],
          grouping: 'na',
        },
        { vaultAddress: null },
      )
      .then(async (r: any) => {
        const result: PlaceOrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if ('error' in result.response.data.statuses[0]) {
          return this.handleHyperliquidErrors(
            this.openOrder,
            order,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new HyperliquidError(result.response.data.statuses[0].error, 0))
        }
        const getOrderPayload = {
          symbol: order.symbol,
          newClientOrderId: order.newClientOrderId,
        }
        if (order.type === 'MARKET') {
          await sleep(500)
        }
        const price =
          'filled' in result.response.data.statuses[0]
            ? result.response.data.statuses[0].filled.avgPx
            : `${order.price}`
        try {
          return await this.getOrder(getOrderPayload, timeProfile, price, true)
        } catch (e) {
          return this.handleHyperliquidErrors(
            this.getOrder,
            getOrderPayload,
            this.endProfilerTime(timeProfile, 'exchange'),
            price,
            true,
          )(e)
        }
      })
      .catch(
        this.handleHyperliquidErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getOrder(
    data: { symbol: string; newClientOrderId: string },
    timeProfile = this.getEmptyTimeProfile(),
    price = '',
    useRetry = false,
    retryCount = 0,
  ) {
    timeProfile =
      (await this.checkLimits('getOrderStatus', 1, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.infoClient
      .orderStatus({
        user: this._key,
        oid: data.newClientOrderId as `0x${string}`,
      })
      .then(async (r: any) => {
        const result: OrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.status === 'unknownOid') {
          if (useRetry && retryCount < 2) {
            await sleep(500)
            Logger.warn(
              `Retrying getOrder for ${data.symbol} with OID ${data.newClientOrderId}, attempt ${retryCount + 1}`,
            )
            return this.getOrder(
              data,
              timeProfile,
              price,
              useRetry,
              retryCount + 1,
            )
          }
          return this.returnBad(timeProfile)(
            new HyperliquidError(result.status, 0),
          )
        }
        return this.returnGood<CommonOrder>(timeProfile)(
          await this.convertOrder(
            result.order.order,
            result.order.status,
            result.order.statusTimestamp,
            price,
          ),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 1, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const cancel = {
      asset: +(await this.getCoinByPair(order.symbol, true)),
      cloid: order.newClientOrderId as `0x${string}`,
    }
    return this.exchangeClient
      .cancelByCloid({
        cancels: [cancel],
      })
      .then(async (r: any) => {
        const result: CancelOrderResponse = r
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.response.data.statuses[0] === 'success') {
          return await this.getOrder(order, timeProfile, '', true)
        }
        return this.handleHyperliquidErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new HyperliquidError(result.response.data.statuses[0].error, 1))
      })
      .catch(
        this.handleHyperliquidErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async latestPrice(symbol: string) {
    const res = await this.getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<number>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol)?.price ?? 0,
    )
  }

  async getExchangeInfo(symbol: string) {
    const res = await this.getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<ExchangeInfo>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol),
    )
  }

  async getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    let res: CommonOrder[] = []
    timeProfile =
      (await this.checkLimits('getFuturesOpenOrders', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.infoClient.frontendOpenOrders({
        user: this._key,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')

      const data = result.filter((r) =>
        this.futures
          ? !r.coin.includes('/') && !r.coin.startsWith('@')
          : r.coin.startsWith('@') || r.coin.includes('/'),
      )
      await Promise.all(
        (data ?? []).map(async (o) =>
          res.push(await this.convertOrder(o, 'open')),
        ),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.getAllOpenOrders,
        symbol,
        returnOrders,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    res = res.filter((s) => (symbol ? s.symbol === symbol : true))

    return {
      timeProfile,
      usage: limitHelper.getUsage(),
      status: StatusEnum.ok as StatusEnum.ok,
      data: returnOrders ? res : res.length,
    }
  }

  async getUserFees(symbol: string) {
    const res = await this.getAllUserFees()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<UserFee>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol) ?? {
        maker: 0,
        taker: 0,
        pair: symbol,
      },
    )
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    const allPairs = await this.getAllExchangeInfo()
    if (allPairs.status === StatusEnum.notok) {
      return allPairs
    }
    timeProfile =
      (await this.checkLimits('placeOrder', 1, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.infoClient
      .userFees({ user: this._key })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          allPairs.data.map((p) => ({
            pair: p.pair,
            maker: +(this.futures
              ? result.userAddRate
              : result.userSpotAddRate),
            taker: +(this.futures
              ? result.userCrossRate
              : result.userSpotCrossRate),
          })),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getAllUserFees,
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
    const res: PositionInfo[] = []
    timeProfile =
      (await this.checkLimits('getClearinghouseState', 2, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.infoClient.clearinghouseState({
        user: this._key,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')

      const data = result.assetPositions
      await Promise.all(
        data.map(async (o) => res.push(await this.convertPosition(o))),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getPositions,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<PositionInfo[]>(timeProfile)(res)
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    _countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('candleSnapshot', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.infoClient
      .candleSnapshot({
        coin: await this.getCoinNameByPair(symbol),
        interval,
        startTime: +from,
        endTime: +to,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const data = result
        return this.returnGood<CandleResponse[]>(timeProfile)(
          data.map((d) => ({
            open: `${d.o}`,
            high: `${d.h}`,
            low: `${d.l}`,
            close: `${d.c}`,
            volume: `${d.v}`,
            time: +d.t,
          })),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          _countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    const res: AllPricesResponse[] = []
    timeProfile =
      (await this.checkLimits('getAllMids', 2, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.infoClient.allMids()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      const data = Object.entries(result).filter(([n]) =>
        this.futures
          ? !n.includes('/') && !n.startsWith('@')
          : n.startsWith('@') || n.includes('/'),
      )
      await Promise.all(
        data.map(async (o) =>
          res.push({
            pair: await this.getPairByCoin(o[0]),
            price: +o[1],
          }),
        ),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.getAllPrices,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<AllPricesResponse[]>(timeProfile)(
      res.filter((p) => !p.pair.startsWith('@')),
    )
  }

  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    try {
      if (!this.futures) {
        return this.errorFutures(timeProfile)
      }
      timeProfile =
        (await this.checkLimits('updateLeverage', 1, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      return await this.exchangeClient
        .updateLeverage({
          asset: +(await this.getCoinByPair(symbol, true)),
          isCross: margin === MarginType.CROSSED,
          leverage,
        })
        .then(() => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          return this.returnGood<MarginType>(timeProfile)(margin)
        })
    } catch (e) {
      this.handleHyperliquidErrors(
        this.futures_changeMarginType,
        symbol,
        margin,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    //Hedge is not supported on Hyperliquid yet, always false
    return this.returnGood<boolean>(timeProfile)(false)
  }

  async futures_setHedge(
    _value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    //Hedge is not supported on Hyperliquid yet, always false
    return this.returnGood<boolean>(timeProfile)(false)
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
    return this.returnGood<boolean>(timeProfile)(true)
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

  async cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return await this.cancelOrder({
      symbol: order.symbol,
      newClientOrderId: order.orderId,
    })
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
      })[]
    >
  > {
    const res: (ExchangeInfo & {
      pair: string
      maxLeverage?: string
      stepLeverage?: string
      minLeverage?: string
    })[] = []

    try {
      timeProfile =
        (await this.checkLimits('getMeta', 20, timeProfile)) || timeProfile
      const allPrices = await this.getAllPrices(timeProfile)
      if (allPrices.status === StatusEnum.notok) {
        return allPrices
      }
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.infoClient.meta()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      const data = get.universe
      data
        .filter((d) => !d.isDelisted)
        .map((d) => {
          const minAmount =
            d.szDecimals === 0 ? 1 : +`0.${'0'.repeat(d.szDecimals - 1)}1`
          let priceAssetPrecision = Math.min(5, Math.max(0, 6 - d.szDecimals))
          const find = allPrices.data.find((p) => p.pair === `${d.name}-USDC`)
          if (find && find.price > 0) {
            const crop = `${find.price}`.slice(0, 6)
            priceAssetPrecision = Math.min(
              5,
              crop.includes('.') ? crop.split('.')[1].length : 0,
            )
          }
          const r: (typeof res)[0] = {
            code: d.name,
            pair: `${d.name}-USDC`,
            baseAsset: {
              minAmount,
              maxAmount: 0,
              step: minAmount,
              name: d.name,
              maxMarketAmount: 0,
            },
            quoteAsset: {
              minAmount: 10,
              name: 'USDC',
            },
            maxOrders: 200,
            priceAssetPrecision,
            minLeverage: '1',
            maxLeverage: `${d.maxLeverage}`,
          }
          res.push(r)
        })
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getAllExchangeInfo,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<typeof res>(timeProfile)(res)
  }
  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
      })[]
    >
  > {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const allPrices = await this.getAllPrices(timeProfile)
    if (allPrices.status === StatusEnum.notok) {
      return allPrices
    }
    timeProfile =
      (await this.checkLimits('getSpotMeta', 20, timeProfile)) || timeProfile
    return this.infoClient
      .spotMeta()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const pairs = result.universe
        const tokens = result.tokens

        return this.returnGood<
          (ExchangeInfo & {
            pair: string
          })[]
        >(timeProfile)(
          pairs.map((d) => {
            const base = tokens.find((t) => t.index === d.tokens[0])
            const quote = tokens.find((t) => t.index === d.tokens[1])
            if (!base || !quote) {
              return null
            }

            base.name = base.name === 'UBTC' ? 'BTC' : base.name
            const minAmountBase =
              base.szDecimals === 0
                ? 1
                : +`0.${'0'.repeat(base.szDecimals - 1)}1`
            let pricePrecision = Math.min(
              5,
              Math.max(0, 8 - base.szDecimals - 1),
            )
            const find = allPrices.data.find(
              (p) => p.pair === `${base.name}-${quote.name}`,
            )
            if (find && find.price > 0) {
              const crop = `${find.price}`.slice(0, 6)
              pricePrecision = Math.min(
                5,
                crop.includes('.') ? crop.split('.')[1].length : 0,
              )
            }

            const res = {
              code: d.name,
              pair: `${base.name}-${quote.name}`,
              baseAsset: {
                minAmount: minAmountBase,
                maxAmount: 0,
                step: minAmountBase,
                name: base.name,
                maxMarketAmount: 0,
              },
              quoteAsset: {
                minAmount: 10,
                name: quote.name,
                precision: quote.szDecimals,
              },
              maxOrders: 200,
              priceAssetPrecision: pricePrecision,
            }
            return res
          }),
        )
      })
      .catch(
        this.handleHyperliquidErrors(
          this.spot_getAllExchangeInfo,
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
        (await this.checkLimits('getSpotClearinghouseState', 2, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.infoClient.spotClearinghouseState({
        user: this._key,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')

      const data = get.balances
      data.map((b) =>
        res.push({
          asset: b.coin,
          free: +b.total - +b.hold,
          locked: +b.hold,
        }),
      )
    } catch (e) {
      return this.handleHyperliquidErrors(
        this.futures_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new HyperliquidError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  /**
   * Convert Hyperliquid order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private async convertOrder(
    order?: OrderResponseFound['order']['order'],
    status?: OrderResponseFound['order']['status'],
    timestamp?: number,
    filledPrice?: string,
  ): Promise<CommonOrder> {
    const orderStatus: OrderStatusType =
      status === 'open' ? 'NEW' : status === 'filled' ? 'FILLED' : 'CANCELED'

    const orderType: OrderTypeT =
      order.orderType === 'Market' ? 'MARKET' : 'LIMIT'
    let quote = +order.limitPx * +order.sz
    if (isNaN(quote) || !isFinite(quote)) {
      quote = 0
    }
    const response: CommonOrder = {
      symbol: await this.getPairByCoin(order.coin),
      orderId: order.oid,
      clientOrderId: order.cloid,
      transactTime: order.timestamp,
      updateTime: timestamp || order.timestamp,
      price: filledPrice || order.limitPx,
      origQty: order.origSz,
      executedQty: `${+order.origSz - +order.sz}`,
      cummulativeQuoteQty: `${quote}`,
      status: orderStatus,
      type: orderType,
      side: order.side === 'A' ? 'SELL' : 'BUY',
      fills: [],
    }
    return response
  }

  private async convertPosition(
    position: hl.AssetPosition,
  ): Promise<PositionInfo> {
    return {
      symbol: await this.getPairByCoin(position.position.coin),
      initialMargin: position.position.marginUsed,
      maintMargin: position.position.marginUsed,
      unrealizedProfit: position.position.unrealizedPnl,
      positionInitialMargin: position.position.marginUsed,
      openOrderInitialMargin: position.position.marginUsed,
      leverage: `${position.position.leverage.value}`,
      isolated: position.position.leverage.type === 'isolated',
      entryPrice: position.position.entryPx,
      maxNotional: '',
      positionSide:
        +position.position.szi > 0 ? PositionSide.LONG : PositionSide.SHORT,
      positionAmt: `${Math.abs(+position.position.szi)}`,
      notional: '',
      isolatedWallet: '',
      updateTime: +new Date(),
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Hyperliquid API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleHyperliquidErrors<T>(
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
              `Hyperliquid Rest API trading is not enabled sleep 10s ${timeProfile.attempts}`,
            )
            await sleep(10 * 1000)
          }
          if (msg.indexOf(unknownError) !== -1) {
            Logger.warn(
              `Hyperliquid Unknown Error sleep 3s ${timeProfile.attempts}`,
            )
            await sleep(3 * 1000)
          }
          if (msg.indexOf('request timestamp expired') !== -1) {
            Logger.warn(
              `Hyperliquid Request timestamp sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (msg.indexOf('recv_window') !== -1) {
            Logger.warn(
              `Hyperliquid recv_window sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (
            msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
            `${e.code}` === '429'
          ) {
            const time = 1000
            Logger.log(
              `Hyperliquid Too many visits wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('too many requests'.toLowerCase()) !== -1) {
            const time = 1000
            if (timeProfile.attempts > 1) {
              Logger.log(
                `Hyperliquid too many requests wait ${time}ms ${
                  timeProfile.attempts
                } ${cb.name} ${this.key}`,
              )
            }
            await sleep(time)
          }
          if (`${e.code}` === '403') {
            const time = 60000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Hyperliquid 403 block wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Gateway Time-out wait 5s ${timeProfile.attempts}`,
            )
            await sleep(5000)
          }
          if (msg.indexOf(bad) !== -1) {
            Logger.log(
              `Hyperliquid Bad Request wait 0.1s ${timeProfile.attempts}`,
            )
            await sleep(100)
          }
          if (msg.indexOf('socket hang up'.toLowerCase()) !== -1) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Hyperliquid socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Internal System Error'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Server Timeout wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server error'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Server error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid Forbidden wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('possible ip block'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('ECONNRESET'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1) {
            Logger.log(`Hyperliquid EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('getaddrinfo'.toLowerCase()) !== -1) {
            Logger.log(
              `Hyperliquid getaddrinfo wait 2s ${timeProfile.attempts}`,
            )
            await sleep(2000)
          }
          if (msg.indexOf(tls) !== -1) {
            Logger.log(
              `Hyperliquid Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf(cannotCancel) !== -1) {
            Logger.log(
              `Hyperliquid Cannot cancel order wait 10s ${timeProfile.attempts}`,
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
    const limit = await limitHelper.addWeight(count)
    if (limit > 0) {
      Logger.warn(
        `Hyperliquid request must sleep for ${limit / 1000}s. Method: ${request}`,
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

export default HyperliquidExchange
