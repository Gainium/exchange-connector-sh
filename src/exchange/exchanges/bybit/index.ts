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
  BybitHost,
  bybitHostMap,
} from '../../types'
import {
  RestClientV5 as BybitClient,
  AccountOrderV5,
  OrderParamsV5,
  KlineIntervalV3,
  OrderTypeV5,
  APIResponseV3WithTime,
  FeeRateV5,
  CategoryV5,
  SpotInstrumentInfoV5,
  LinearInverseInstrumentInfoV5,
  GetKlineParamsV5,
  SetLeverageParamsV5,
  PositionV5,
  SwitchIsolatedMarginParamsV5,
  AccountMarginModeV5,
  CategoryCursorListV5,
  InstrumentStatusV5,
} from 'bybit-api'
import { RestClientV5 as BybitOrderClient } from '../../../bybit-custom/rest-client-v5'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'

class BybitError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

class BybitExchange extends AbstractExchange implements Exchange {
  /** Bybit client */
  protected client: BybitClient
  /** Bybit order client */
  private orderClient: BybitOrderClient
  /** Retry count. Default 10 */
  protected retry: number
  /** Array of error codes, after which retry attempt is executed */
  protected retryErrors: string[]
  private makerFee: number
  private takerFee: number
  protected futures?: Futures
  private accountType?: number
  private marginMode?: AccountMarginModeV5

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: string,
    _keysType?: string,
    _okxSource?: string,
    code?: string,
    bybitHost?: BybitHost,
    _subaccount?: boolean,
  ) {
    super({ key, secret })
    const options = {
      key: this.key ?? '',
      secret: this.secret ?? '',
      testnet: process.env.ENV === 'sandbox',
      recv_window: 30000,
      baseUrl: bybitHostMap[bybitHost ?? BybitHost.com] || bybitHostMap.com,
    }
    this.client = new BybitClient(options)
    this.orderClient = new BybitOrderClient(options, {
      headers: { referer: code },
    })
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
    ]
    this.makerFee = 0.001
    this.takerFee = 0.001
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
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getQueryApiKey()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        //@ts-ignore
        if (result.retCode === 0 && !result.result.isMaster) {
          return this.returnGood<number>(timeProfile)(
            //@ts-ignore
            result.result.parentUid ?? -1,
          )
        }
        return this.returnGood<number>(timeProfile)(
          result.retCode === 0 ? result.result.userID : -1,
        )
      })
      .catch(
        this.handleBybitErrors(
          this.getUid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getPrivate('/v5/user/aff-customer-info', { uid })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<boolean>(timeProfile)(result.retCode === 0)
      })
      .catch(
        this.handleBybitErrors(
          this.getAffiliate,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .setLeverage({
        category: this.getCategory() as SetLeverageParamsV5['category'],
        symbol,
        buyLeverage: `${leverage}`,
        sellLeverage: `${leverage}`,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (
          result.retMsg === 'OK' ||
          result.retMsg.toLowerCase().indexOf('leverage not modified') !== -1
        ) {
          return this.returnGood<number>(timeProfile)(leverage)
        }
        return this.handleBybitErrors(
          this.futures_changeLeverage,
          symbol,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(result.retMsg, result.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.futures_changeLeverage,
          symbol,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getBalance() {
    return this.getBalance()
  }

  async futures_openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: 'LIMIT' | 'MARKET'
    reduceOnly?: boolean
    positionSide?: PositionSide
  }) {
    return this.openOrder(order)
  }

  async futures_getOrder(data: { symbol: string; newClientOrderId: string }) {
    return this.getOrder(data)
  }

  async futures_cancelOrder(order: {
    symbol: string
    newClientOrderId: string
  }) {
    return this.cancelOrder(order)
  }

  async futures_cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }) {
    return this.cancelOrderByOrderIdAndSymbol(order)
  }

  async futures_latestPrice(symbol: string) {
    return this.latestPrice(symbol)
  }

  async futures_getExchangeInfo(symbol: string) {
    return this.getExchangeInfo(symbol)
  }

  async futures_getAllExchangeInfo() {
    return this.getAllExchangeInfo()
  }

  async futures_getAllOpenOrders(symbol?: string, returnOrders?: false) {
    return this.getAllOpenOrders(symbol, returnOrders)
  }

  async futures_getUserFees(symbol: string) {
    return this.getUserFees(symbol)
  }

  async futures_getAllUserFees() {
    return this.getAllUserFees()
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futures_getPositions', 'get', timeProfile)) ||
      timeProfile
    const category = this.getCategory()
    if (category === 'linear' && !symbol) {
      const data: PositionInfo[] = []
      const allPairs = await this.getAllExchangeInfo()
      if (allPairs.status === StatusEnum.notok) {
        return allPairs
      }
      const coins = new Set(allPairs.data.map((p) => p.quoteAsset.name))
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const coin of coins) {
        await this.client
          .getPositionInfo({ category, limit: 200, settleCoin: coin })
          .then(async (result) => {
            if (result.retMsg === 'OK') {
              for (const p of result.result.list.filter(
                (pos) => pos.positionStatus === 'Normal',
              )) {
                data.push(await this.convertPosition(p))
              }
            }
          })
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      return this.returnGood<PositionInfo[]>(timeProfile)(data)
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getPositionInfo({ category, limit: 200, symbol })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.retMsg === 'OK') {
          const positions: PositionInfo[] = []
          for (const p of result.result.list.filter(
            (pos) => pos.positionStatus === 'Normal',
          )) {
            positions.push(await this.convertPosition(p))
          }
          return this.returnGood<PositionInfo[]>(timeProfile)(positions)
        }
        return this.handleBybitErrors(
          this.futures_getPositions,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(result.retMsg, result.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.futures_getPositions,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    _countData?: number,
  ) {
    return this.getCandles(symbol, interval, from, to, _countData)
  }

  async futures_getAllPrices() {
    return this.getAllPrices()
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
    const accountType = await this.getAccountType()
    timeProfile =
      (await this.checkLimits(
        'futures_changeMarginType',
        'get',
        timeProfile,
      )) || timeProfile
    if (accountType.data === 1 || (this.coinm && accountType.data < 5)) {
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      return await this.client
        .switchIsolatedMargin({
          category:
            this.getCategory() as SwitchIsolatedMarginParamsV5['category'],
          symbol,
          tradeMode: margin === MarginType.CROSSED ? 0 : 1,
          buyLeverage: `${leverage}`,
          sellLeverage: `${leverage}`,
        })
        .then(async (result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.retMsg === 'OK') {
            return this.returnGood<MarginType>(timeProfile)(margin)
          }
          if (result.retMsg === 'Cross/isolated margin mode is not modified') {
            return this.returnGood<MarginType>(timeProfile)(margin)
          }
          return this.handleBybitErrors(
            this.futures_changeMarginType,
            symbol,
            margin,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BybitError(result.retMsg, result.retCode))
        })
        .catch(
          this.handleBybitErrors(
            this.futures_changeMarginType,
            symbol,
            margin,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .setMarginMode(
        //@ts-ignore
        margin === MarginType.CROSSED ? 'REGULAR_MARGIN' : 'ISOLATED_MARGIN',
      )
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.retCode === 0) {
          return this.returnGood<MarginType>(timeProfile)(margin)
        }
        return this.handleBybitErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(result.retMsg, result.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('futures_getHedge', 'get', timeProfile)) ||
      timeProfile
    let symbol = _symbol
    const category = this.getCategory()
    if (!symbol) {
      const all = await this.getAllExchangeInfo()
      if (all.status === StatusEnum.notok) {
        return all
      }
      symbol = (
        !this.usdm
          ? all.data
              .filter((p) => p.type === 'InverseFutures')
              .map((p) => p.pair)
          : all.data
              .filter((p) => p.type === 'LinearPerpetual')
              .map((p) => p.pair)
      )[0]
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getPositionInfo({ category, symbol })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.retMsg === 'OK') {
          return this.returnGood<boolean>(timeProfile)(
            result.result.list[0].positionIdx !== 0,
          )
        }
        return this.handleBybitErrors(
          this.futures_getHedge,
          _symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(result.retMsg, result.retCode))
      })
      .catch(
        this.handleBybitErrors(
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
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futures_setHedge', 'get', timeProfile)) ||
      timeProfile
    if (this.coinm) {
      const all = await this.getAllExchangeInfo()
      if (all.status === StatusEnum.notok) {
        return all
      }
      const base = new Set(
        all.data
          .filter((e) => e.type === 'InverseFutures')
          .map((e) => e.baseAsset.name),
      )
      let requestResult = true
      let message = ''
      let code = 0
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const b of base) {
        this.client
          .switchPositionMode({
            coin: b,
            category: 'inverse',
            mode: value ? 3 : 0,
          })
          .then((res) => {
            if (res.retMsg !== 'OK') {
              requestResult = false
              message = res.retMsg
              code = res.retCode
            }
          })
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (requestResult) {
        return this.returnGood<boolean>(timeProfile)(value)
      }
      return this.returnBad(timeProfile)(new BybitError(message, code))
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .switchPositionMode({
        coin: 'USDT',
        category: 'linear',
        mode: value ? 3 : 0,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.retCode === 0) {
          return this.returnGood<boolean>(timeProfile)(value)
        }
        return this.handleBybitErrors(
          this.futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
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

  async getAccountMargin(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AccountMarginModeV5>> {
    if (this.marginMode) {
      return this.returnGood<AccountMarginModeV5>(timeProfile)(this.marginMode)
    }
    timeProfile =
      (await this.checkLimits('getAccountMargin', 'get', timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAccountInfo()
      .then((account) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (account.retMsg === 'OK') {
          this.marginMode = account.result.marginMode
          this.accountType = account.result.unifiedMarginStatus
          return this.returnGood<AccountMarginModeV5>(timeProfile)(
            account.result.marginMode,
          )
        }
        return this.handleBybitErrors(
          this.getAccountMargin,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(account.retMsg, account.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.getAccountMargin,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile =
      (await this.checkLimits('getApiPermission', 'get', timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getQueryApiKey()
      .then((account) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (account.retCode === 0) {
          const readWrite = `${account.result.readOnly}` === '0'
          const permissions = this.futures
            ? (account.result.permissions.ContractTrade.includes('Order') &&
                account.result.permissions.ContractTrade.includes(
                  'Position',
                )) ||
              account.result.permissions.Options.includes('OptionsTrade')
            : account.result.permissions.Spot.includes('SpotTrade')
          const result = readWrite && permissions
          if (result) {
            return this.returnGood<boolean>(timeProfile)(true)
          }
          return this.returnBad(timeProfile)(
            new BybitError('Check permissions', 0),
          )
        }
        return this.handleBybitErrors(
          this.getApiPermission,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(account.retMsg, account.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.getApiPermission,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAccountType(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (this.accountType) {
      return this.returnGood<number>(timeProfile)(this.accountType)
    }
    timeProfile =
      (await this.checkLimits('getAccountType', 'get', timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAccountInfo()
      .then((account) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (account.retMsg === 'OK') {
          this.marginMode = account.result.marginMode
          this.accountType = account.result.unifiedMarginStatus
          return this.returnGood<number>(timeProfile)(
            account.result.unifiedMarginStatus,
          )
        }
        return this.handleBybitErrors(
          this.getAccountType,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(account.retMsg, account.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.getAccountType,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
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

  private getCategory(): CategoryV5 {
    return this.futures ? (this.usdm ? 'linear' : 'inverse') : 'spot'
  }

  private async getBybitOrder(
    {
      category,
      orderId,
      symbol,
      newClientOrderId,
    }: {
      category: CategoryV5
      orderId: string
      symbol: string
      newClientOrderId: string
    },
    tries = 0,
    cancel = false,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<APIResponseV3WithTime<CategoryCursorListV5<AccountOrderV5[]>>>
  > {
    timeProfile.attempts = tries + 1
    if (tries === 0) {
      await sleep(100)
    }
    timeProfile =
      (await this.checkLimits('getOrder', 'get', timeProfile)) || timeProfile
    const order =
      (cancel && tries > 2) || (!cancel && tries >= 4)
        ? await this.client.getHistoricOrders({
            orderId,
            category,
            symbol,
          })
        : await this.client.getActiveOrders({
            orderId,
            category,
            symbol,
          })
    if (order.retMsg !== 'OK') {
      return this.handleBybitErrors(
        this.getBybitOrder,
        {
          category,
          symbol,
          orderId,
          newClientOrderId,
        },
        tries,
        cancel,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BybitError(order.retMsg, order.retCode))
    }
    if (order.result.list.length === 0) {
      if (tries < 5) {
        const sleepTime = tries <= 2 ? 500 : tries === 3 ? 1000 : 3000
        Logger.warn(
          `Cannot find BYBIT order ${newClientOrderId} ${orderId} after execution. Sleep ${
            sleepTime / 1000
          }s`,
        )
        await sleep(sleepTime)
        return this.getBybitOrder(
          { category, orderId, newClientOrderId, symbol },
          tries + 1,
          cancel,
          this.endProfilerTime(timeProfile, 'exchange'),
        )
      } else {
        return this.returnBad(timeProfile)(
          new BybitError('Order not found after execution', 0),
        )
      }
    }
    return this.returnGood<
      APIResponseV3WithTime<CategoryCursorListV5<AccountOrderV5[]>>
    >(timeProfile)(order)
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
      (await this.checkLimits('cancelOrder', 'post', timeProfile)) ||
      timeProfile
    const { newClientOrderId, symbol } = order
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrder({
        orderLinkId: newClientOrderId,
        category,
        symbol,
      })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.retMsg === 'OK') {
          await sleep(100)
          await this.checkLimits('getOrder', 'get', timeProfile)
          const order = await this.getBybitOrder(
            {
              category,
              orderId: res.result.orderId,
              symbol,
              newClientOrderId,
            },
            0,
            true,
          )
          if (order.status === StatusEnum.notok) {
            return order
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(order.data.result.list[0]),
          )
        }
        return this.handleBybitErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('cancelOrder', 'post', timeProfile)) ||
      timeProfile
    const { orderId, symbol } = order
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrder({ orderId, symbol, category })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.retMsg === 'OK') {
          await this.checkLimits('getOrder', 'get', timeProfile)
          const order = await this.client.getActiveOrders({
            orderId: res.result.orderId,
            category,
            symbol,
          })
          if (order.retMsg !== 'OK') {
            return this.returnBad(timeProfile)(
              new BybitError(res.retMsg, res.retCode),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(order.result.list[0]),
          )
        }
        return this.handleBybitErrors(
          this.cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */
  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
    cursor?: string,
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
    timeProfile =
      (await this.checkLimits('getAllExchangeInfo', 'get', timeProfile)) ||
      timeProfile
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const result: Map<string, ExchangeInfo & { pair: string }> = new Map()
    for (const status of (this.futures
      ? ['Trading', 'PreLaunch']
      : ['Trading']) as InstrumentStatusV5[]) {
      await this.client
        .getInstrumentsInfo({ category, cursor, status })
        .then(async (res) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (res.retMsg === 'OK') {
            let more = []
            if (res.result.nextPageCursor) {
              more =
                (
                  await this.getAllExchangeInfo(
                    timeProfile,
                    res.result.nextPageCursor,
                  )
                )?.data ?? []
            }
            ;(res.result.category === category ? res.result.list : [])
              .map((s) => {
                if (category === 'spot') {
                  const d = s as SpotInstrumentInfoV5
                  const { basePrecision } = d.lotSizeFilter
                  return {
                    pair: d.symbol,
                    maxOrders: 500,
                    baseAsset: {
                      name: d.baseCoin,
                      minAmount: parseFloat(d.lotSizeFilter.minOrderQty),
                      maxAmount: parseFloat(d.lotSizeFilter.maxOrderQty),
                      step: parseFloat(basePrecision),
                      maxMarketAmount: parseFloat(d.lotSizeFilter.maxOrderQty),
                    },
                    quoteAsset: {
                      name: d.quoteCoin,
                      minAmount:
                        d.quoteCoin === 'USDC' || d.quoteCoin === 'USDT'
                          ? 1
                          : parseFloat(d.lotSizeFilter.minOrderAmt),
                    },
                    priceAssetPrecision: this.getPricePrecision(
                      d.priceFilter.tickSize,
                    ),
                  }
                } else {
                  const d = s as LinearInverseInstrumentInfoV5
                  const inverse = category === 'inverse'
                  return {
                    pair: d.symbol,
                    maxOrders: 500,
                    baseAsset: {
                      name: d.baseCoin,
                      minAmount: inverse
                        ? 0.00000001
                        : parseFloat(d.lotSizeFilter.minOrderQty),
                      maxAmount: parseFloat(d.lotSizeFilter.maxOrderQty),
                      maxMarketAmount: parseFloat(d.lotSizeFilter.maxOrderQty),
                      step: inverse
                        ? 0.00000001
                        : parseFloat(d.lotSizeFilter.qtyStep),
                    },
                    quoteAsset: {
                      name: d.quoteCoin,
                      minAmount: !inverse
                        ? 0
                        : //@ts-ignore
                          1 /* +`${d.lotSizeFilter.minNotionalValue || 1}` */,
                    },
                    priceAssetPrecision: this.getPricePrecision(
                      d.priceFilter.tickSize,
                    ),
                    type: d.contractType,
                    maxLeverage: d.leverageFilter.maxLeverage,
                    stepLeverage: d.leverageFilter.leverageStep,
                    minLeverage: d.leverageFilter.minLeverage,
                  }
                }
              })
              .concat(more)
              .forEach((p) => result.set(p.pair, p))
            return
          } else {
            return this.handleBybitErrors(
              this.getAllExchangeInfo,
              this.endProfilerTime(timeProfile, 'exchange'),
            )(new BybitError(res.retMsg, res.retCode))
          }
        })
        .catch(
          this.handleBybitErrors(
            this.getAllExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }
    return this.returnGood<(ExchangeInfo & { pair: string })[]>(timeProfile)([
      ...result.values(),
    ])
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
      (await this.checkLimits('getAllOpenOrders', 'get', timeProfile)) ||
      timeProfile
    const input: { symbol?: string; category: CategoryV5 } = {
      symbol,
      category: this.getCategory(),
    }
    if (!symbol) {
      delete input.symbol
    }
    if (this.futures && !input.symbol && input.category === 'linear') {
      const allPairs = await this.getAllExchangeInfo()
      if (allPairs.status === StatusEnum.notok) {
        return allPairs
      }
      const coins = new Set(allPairs.data.map((p) => p.quoteAsset.name))
      const resultOrders: CommonOrder[] = []
      let errorMessage = ''
      let errorCode = 0
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      for (const c of coins) {
        await this.client
          .getActiveOrders({ ...input, settleCoin: c })
          .then(async (orders) => {
            if (orders.retMsg === 'OK') {
              if (returnOrders) {
                for (const o of orders.result.list) {
                  const data = await this.convertOrder(o)
                  resultOrders.push(data)
                }
              }
            } else {
              errorMessage = orders.retMsg
              errorCode = orders.retCode
            }
          })
      }
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (!errorMessage) {
        if (returnOrders) {
          return this.returnGood<CommonOrder[]>(timeProfile)(resultOrders)
        }
        return this.returnGood<number>(timeProfile)(resultOrders.length)
      }
      return this.returnBad(timeProfile)(
        new BybitError(errorMessage, errorCode),
      )
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getActiveOrders(input)
      .then(async (orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (orders.retMsg === 'OK') {
          if (returnOrders) {
            const convertedOrders: CommonOrder[] = []
            for (const o of orders.result.list) {
              const data = await this.convertOrder(o)
              convertedOrders.push(data)
            }
            return this.returnGood<CommonOrder[]>(timeProfile)(convertedOrders)
          }
          return this.returnGood<number>(timeProfile)(orders.result.list.length)
        }
        return this.handleBybitErrors(
          this.getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(orders.retMsg, orders.retCode))
      })
      .catch(
        this.handleBybitErrors<BaseReturn<CommonOrder[] | number>>(
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
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getPrivate('/v5/account/fee-rate', { category: this.getCategory() })
      .then(
        async (
          fees: APIResponseV3WithTime<{
            list: FeeRateV5[]
          }>,
        ) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (fees.retMsg === 'OK') {
            const data = fees.result.list.map((t) => ({
              pair: t.symbol,
              maker: +t.makerFeeRate,
              taker: +t.takerFeeRate,
            }))
            return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
              data,
            )
          }
          return this.handleBybitErrors(
            this.getAllUserFees,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BybitError(fees.retMsg, fees.retCode))
        },
      )
      .catch(
        this.handleBybitErrors(
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
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    const accountType = await this.getAccountType()
    if (accountType.status === StatusEnum.notok) {
      return accountType
    }
    timeProfile =
      (await this.checkLimits('getBalance', 'get', timeProfile)) || timeProfile
    const accType =
      accountType.data >= 5
        ? 'UNIFIED'
        : accountType.data === 1
          ? this.futures
            ? 'CONTRACT'
            : 'SPOT'
          : this.futures
            ? this.usdm
              ? 'UNIFIED'
              : 'CONTRACT'
            : 'UNIFIED'
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getWalletBalance({
        accountType: accType,
      })
      .then((balances) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (balances.retMsg === 'OK') {
          return this.returnGood<FreeAsset>(timeProfile)(
            balances.result.list
              .filter((acc) => acc.accountType === accType)
              .flatMap((balance) =>
                balance.coin.map((b) => {
                  const locked =
                    parseFloat(b.locked || '0') +
                    parseFloat(b.totalOrderIM || '0') +
                    parseFloat(b.totalPositionIM || '0')
                  return {
                    asset: b.coin,
                    free:
                      accountType.data === 1 && !this.futures
                        ? parseFloat(b.free || '0')
                        : parseFloat(b.walletBalance || '0') - locked,
                    locked,
                  }
                }),
              ),
          )
        }
        return this.handleBybitErrors(
          this.getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(balances.retMsg, balances.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.getBalance,
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
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('getOrder', 'get', timeProfile)) || timeProfile
    const { newClientOrderId, symbol } = data
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getActiveOrders({ category, orderLinkId: newClientOrderId, symbol })
      .then(async (res) => {
        if (res.retMsg === 'OK') {
          if (res.result.list.length === 0) {
            await sleep(500)
            let getOld = await this.client.getHistoricOrders({
              category,
              orderLinkId: newClientOrderId,
            })
            if (getOld.retMsg === 'OK') {
              if (getOld.result.list.length) {
                timeProfile = this.endProfilerTime(timeProfile, 'exchange')
                return this.returnGood<CommonOrder>(timeProfile)(
                  await this.convertOrder(getOld.result.list[0]),
                )
              }
              await sleep(1500)
              getOld = await this.client.getHistoricOrders({
                category,
                orderLinkId: newClientOrderId,
              })
              if (getOld.retMsg === 'OK') {
                if (getOld.result.list.length) {
                  timeProfile = this.endProfilerTime(timeProfile, 'exchange')
                  return this.returnGood<CommonOrder>(timeProfile)(
                    await this.convertOrder(getOld.result.list[0]),
                  )
                }
              }
            }
            return this.handleBybitErrors(
              this.getOrder,
              data,
              this.endProfilerTime(timeProfile, 'exchange'),
            )(new BybitError(getOld.retMsg, getOld.retCode))
          }
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(res.result.list[0]),
          )
        }
        return this.handleBybitErrors(
          this.getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get user fee for given pair
   * @param {string} _symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} maker and taker fee for given symbol
   */
  async getUserFees(symbol: string): Promise<BaseReturn<UserFee>> {
    const all = await this.getAllUserFees()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<UserFee>(all.timeProfile)(
      all.data.find((a) => a.pair === symbol) ?? {
        pair: symbol,
        maker: this.makerFee,
        taker: this.takerFee,
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
      (await this.checkLimits('latestPrice', 'get', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.client
        //@ts-ignore
        .getTickers({ category: this.getCategory(), symbol })
        .then((price) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (price.retMsg === 'OK') {
            return this.returnGood<number>(timeProfile)(
              parseFloat(price.result.list[0]?.lastPrice || '0'),
            )
          }
          return this.handleBybitErrors(
            this.latestPrice,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BybitError(price.retMsg, price.retCode))
        })
        .catch(
          this.handleBybitErrors(
            this.latestPrice,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
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
      (await this.checkLimits('openOrder', 'post', timeProfile)) || timeProfile
    const {
      symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type,
      reduceOnly,
      positionSide,
    } = order
    const category = this.getCategory()
    const request: OrderParamsV5 = {
      symbol: symbol,
      side: side === 'BUY' ? 'Buy' : 'Sell',
      qty: `${quantity}`,
      orderLinkId: newClientOrderId || '',
      orderType: type === 'MARKET' ? 'Market' : 'Limit',
      category,
    }
    if (this.futures && typeof reduceOnly !== 'undefined') {
      request.reduceOnly = reduceOnly
    }
    if (this.futures) {
      request.positionIdx = positionSide
        ? positionSide === PositionSide.LONG
          ? 1
          : positionSide === PositionSide.SHORT
            ? 2
            : 0
        : 0
    }
    if (type === 'LIMIT') {
      request.price = this.convertNumberToString(price)
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.orderClient
      .submitOrder(request)
      .then(async (res) => {
        if (res.retMsg.indexOf('position idx not match position mode') !== -1) {
          const reduce = typeof reduceOnly !== 'undefined' ? reduceOnly : false
          const positionIdx =
            request.positionIdx === 0
              ? side === 'BUY' && reduce
                ? 2
                : side === 'BUY' && !reduce
                  ? 1
                  : side === 'SELL' && reduce
                    ? 1
                    : 2
              : 0
          if (positionIdx !== request.positionIdx) {
            await this.checkLimits('openOrder', 'post', timeProfile)
            res = await this.orderClient.submitOrder({
              ...request,
              positionIdx,
            })
            timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          }
        }
        if (res.retMsg === 'OK') {
          const { orderId } = res.result
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          try {
            const order = await this.getBybitOrder({
              category,
              orderId,
              symbol,
              newClientOrderId,
            })
            if (order.status === StatusEnum.notok) {
              return order
            }
            return this.returnGood<CommonOrder>(timeProfile)(
              await this.convertOrder(order.data.result.list[0]),
            )
          } catch (e) {
            Logger.warn(
              `Bybit error after place order ${newClientOrderId} ${orderId} ${e?.message}, try again after 2s`,
            )
            await sleep(2000)
            const order = await this.getBybitOrder({
              category,
              orderId,
              symbol,
              newClientOrderId,
            })
            if (order.status === StatusEnum.notok) {
              return order
            }
            return this.returnGood<CommonOrder>(timeProfile)(
              await this.convertOrder(order.data.result.list[0]),
            )
          }
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.handleBybitErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  private convertInterval(interval: ExchangeIntervals): KlineIntervalV3 {
    return interval === ExchangeIntervals.eightH
      ? '360'
      : interval === ExchangeIntervals.fifteenM
        ? '15'
        : interval === ExchangeIntervals.fiveM
          ? '5'
          : interval === ExchangeIntervals.fourH
            ? '240'
            : interval === ExchangeIntervals.oneD
              ? 'D'
              : interval === ExchangeIntervals.oneH
                ? '60'
                : interval === ExchangeIntervals.oneM
                  ? '1'
                  : interval === ExchangeIntervals.oneW
                    ? 'W'
                    : interval === ExchangeIntervals.thirtyM
                      ? '30'
                      : interval === ExchangeIntervals.threeM
                        ? '3'
                        : interval === ExchangeIntervals.twoH
                          ? '120'
                          : '1'
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
      (await this.checkLimits('getCandles', 'get', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getKline({
        category: this.getCategory() as GetKlineParamsV5['category'],
        symbol,
        interval: this.convertInterval(interval),
        start: from,
        end: to,
        limit: countData || 200,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.retMsg === 'OK') {
          return this.returnGood<CandleResponse[]>(timeProfile)(
            res.result.list.map((k) => ({
              open: k[1],
              close: k[4],
              high: k[2],
              low: k[3],
              time: +k[0],
              volume: k[5],
            })),
          )
        }
        return this.handleBybitErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BybitError(res.retMsg, res.retCode))
      })
      .catch(
        this.handleBybitErrors(
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
      (await this.checkLimits('getAllPrices', 'get', timeProfile)) ||
      timeProfile
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.client
        //@ts-ignore
        .getTickers({ category })
        .then((res) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (res.retMsg === 'OK') {
            return this.returnGood<AllPricesResponse[]>(timeProfile)(
              (res.result.category === category ? res.result.list : []).map(
                (k) => ({
                  pair: k.symbol,
                  price: parseFloat(k.lastPrice),
                }),
              ),
            )
          }
          return this.handleBybitErrors(
            this.getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BybitError(res.retMsg, res.retCode))
        })
        .catch(
          this.handleBybitErrors(
            this.getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    )
  }

  /**
   * Convert Bybit order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private async convertOrder(order?: AccountOrderV5): Promise<CommonOrder> {
    const orderStatus = (): OrderStatusType => {
      const { orderStatus } = order
      if (['New', 'Created', 'Untriggered'].includes(orderStatus)) {
        return 'NEW'
      }
      if (['PartiallyFilled'].includes(orderStatus)) {
        return 'PARTIALLY_FILLED'
      }
      if (['Filled'].includes(orderStatus)) {
        return 'FILLED'
      }
      if (
        orderStatus === 'PartiallyFilledCanceled' &&
        order.orderType === 'Market' &&
        order.side === 'Buy'
      ) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: OrderTypeV5): OrderTypeT => {
      if (type === 'Limit') {
        return 'LIMIT'
      }
      if (type === 'Market') {
        return 'MARKET'
      }
      return 'MARKET'
    }

    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.orderLinkId,
      transactTime: +order.createdTime,
      updateTime: +order.updatedTime,
      price:
        order.orderType === 'Market'
          ? order.avgPrice
            ? `${+order.avgPrice || +order.price}`
            : order.price
          : order.price,
      origQty: order.qty,
      executedQty: order.cumExecQty,
      cummulativeQuoteQty: this.futures
        ? undefined
        : `${+order.cumExecQty * +order.avgPrice}`,
      status: orderStatus(),
      type: orderType(order.orderType),
      side: order.side === 'Sell' ? 'SELL' : 'BUY',
      fills: [],
      reduceOnly: order.reduceOnly,
      positionSide: this.futures
        ? order.positionIdx === 0
          ? PositionSide.BOTH
          : order.positionIdx === 1
            ? PositionSide.LONG
            : PositionSide.SHORT
        : undefined,
    }
  }

  private async convertPosition(position: PositionV5): Promise<PositionInfo> {
    const accountType = await this.getAccountType()
    const old = accountType?.data === 1 || this.coinm
    let isolated = false
    if (!old) {
      const marginMode = await this.getAccountMargin()
      //@ts-ignore
      isolated = marginMode.data === 'ISOLATED_MARGIN'
    }
    isolated =
      isolated || (old ? (position.tradeMode === 0 ? false : true) : false)
    return {
      symbol: position.symbol,
      initialMargin: position.positionIM,
      maintMargin: position.positionMM,
      unrealizedProfit: position.unrealisedPnl,
      positionInitialMargin: position.positionIM,
      openOrderInitialMargin: position.positionIM,
      leverage: position.leverage,
      isolated,
      entryPrice: position.avgPrice,
      maxNotional: '',
      positionSide:
        position.side === 'Buy' ? PositionSide.LONG : PositionSide.SHORT,
      positionAmt: position.size,
      notional: '',
      isolatedWallet: '',
      updateTime: +position.updatedTime,
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Bybit API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleBybitErrors<T>(
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
      if (
        this.retryErrors.includes(`${e.code}`) ||
        e.response ||
        e.message
          .toLowerCase()
          .indexOf('Internal System Error'.toLowerCase()) !== -1 ||
        e.message.indexOf('Forbidden') !== -1 ||
        e.message.toLowerCase().indexOf('Server Timeout'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf('Server error'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('fetch failed'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('getaddrinfo'.toLowerCase()) !== -1 ||
        e.message
          .toLowerCase()
          .indexOf('outside of the recvWindow'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('recv_window'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('socket hang up'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf('Too many visits'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf('possible ip block'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('EAI_AGAIN'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf('Gateway Time-out'.toLowerCase()) !==
          -1 ||
        e.message.toLowerCase().indexOf(tls) !== -1 ||
        e.message
          .toLowerCase()
          .indexOf('timeout of 300000ms exceeded'.toLowerCase()) !== -1 ||
        e.message.toLowerCase().indexOf(restApiNotEnabled) !== -1 ||
        e.message.toLowerCase().indexOf(cannotCancel) !== -1
      ) {
        if (timeProfile.attempts < this.retry) {
          if (e.message.toLowerCase().indexOf(restApiNotEnabled) !== -1) {
            Logger.warn(
              `Bybit Rest API trading is not enabled sleep 10s ${timeProfile.attempts}`,
            )
            await sleep(10 * 1000)
          }
          if (e.message.toLowerCase().indexOf('recv_window') !== -1) {
            Logger.warn(`Bybit recv_window sleep 5s ${timeProfile.attempts}`)
            await sleep(5 * 1000)
          }
          if (
            e.message.toLowerCase().indexOf('Too many visits'.toLowerCase()) !==
            -1
          ) {
            const time = 1000
            Logger.log(
              `Bybit Too many visits wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } ${this.key}`,
            )
            await sleep(time)
          }
          if (
            e.message
              .toLowerCase()
              .indexOf('Gateway Time-out'.toLowerCase()) !== -1
          ) {
            Logger.log(`Bybit Gateway Time-out wait 5s ${timeProfile.attempts}`)
            await sleep(5000)
          }
          if (
            e.message.toLowerCase().indexOf('socket hang up'.toLowerCase()) !==
            -1
          ) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Bybit socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (
            e.message
              .toLowerCase()
              .indexOf('Internal System Error'.toLowerCase()) !== -1
          ) {
            Logger.log(
              `Bybit Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('Server Timeout'.toLowerCase()) !==
            -1
          ) {
            Logger.log(`Bybit Server Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('Server error'.toLowerCase()) !== -1
          ) {
            Logger.log(`Bybit Server error wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('Server Timeout'.toLowerCase()) !==
            -1
          ) {
            Logger.log(`Forbidden wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (
            e.message
              .toLowerCase()
              .indexOf('possible ip block'.toLowerCase()) !== -1
          ) {
            Logger.log(
              `Bybit Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('ETIMEDOUT'.toLowerCase()) !== -1
          ) {
            Logger.log(`Bybit Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !== -1
          ) {
            Logger.log(
              `Bybit Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('EAI_AGAIN'.toLowerCase()) !== -1
          ) {
            Logger.log(`Bybit EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('getaddrinfo'.toLowerCase()) !== -1
          ) {
            Logger.log(`Bybit getaddrinfo wait 2s ${timeProfile.attempts}`)
            await sleep(2000)
          }
          if (e.message.toLowerCase().indexOf(tls) !== -1) {
            Logger.log(
              `Bybit Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (e.message.toLowerCase().indexOf(cannotCancel) !== -1) {
            Logger.log(
              `Bybit Cannot cancel order wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
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
        const message = e.message
        return this.returnBad(timeProfile)(new Error(message))
      }
    }
  }

  /**
   * Check info from binance provider about limits and set them to {@link BybitExchange#info}
   * If limits exceeded - call {@link BybitExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request:
      | 'cancelOrder'
      | 'openOrder'
      | 'getAllOpenOrders'
      | 'getAllOrders'
      | 'getBalance'
      | 'getOrder'
      | string,
    type: 'post' | 'get' | 'delete',
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }

    const limit = limitHelper.addRequest()
    if (limit > 0) {
      Logger.warn(
        `Bybit request must sleep for ${limit / 1000}s. Method: ${request}`,
      )

      await sleep(limit)
      await this.checkLimits(request, type)
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

export default BybitExchange
