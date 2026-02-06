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
  OKXSource,
} from '../../types'
import {
  AccountPosition,
  InstrumentType,
  RestClient as OKXRestClient,
  OrderDetails,
  OrderRequest,
  SetLeverageRequest,
  type APICredentials,
  type RestClientOptions,
} from 'okx-api'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { RestClient as OKXOrderRestClient } from '../../../okx-custom/rest-client'
import { round } from '../../../utils/math'

class OKXError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

type PositionMode = 'long_short_mode' | 'net_mode'

export const timeIntervalMap = {
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
}

class OKXExchange extends AbstractExchange implements Exchange {
  /** OKX client */
  protected client: OKXRestClient
  /** OKX order client */
  private orderClient: OKXOrderRestClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]

  protected futures?: Futures

  private positionMode?: PositionMode

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    passphrase: string,
    _environment?: string,
    _keysType?: string,
    protected okxSource?: OKXSource,
    private code?: string,
    _subaccount?: boolean,
  ) {
    super({
      key,
      secret,
      passphrase,
      environment: process.env.ENV === 'live' ? 'live' : 'sandbox',
    })
    const options: APICredentials = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
      apiPass: this.passphrase ?? '',
    }
    const restOptions: RestClientOptions = {}
    if (this.okxSource === OKXSource.my) {
      restOptions.baseUrl = 'https://eea.okx.com'
    }
    if (this.okxSource === OKXSource.app) {
      restOptions.baseUrl = 'https://us.okx.com'
    }
    this.client = new OKXRestClient(
      this.key ? options : undefined,
      process.env.OKXENV === 'sandbox' ? 'demo' : 'prod',
      restOptions,
    )
    this.orderClient = new OKXOrderRestClient(
      this.key ? options : undefined,
      process.env.OKXENV === 'sandbox' ? 'demo' : 'prod',
      restOptions,
    )
    this.retry = 10
    this.retryErrors = [
      '1',
      '50001',
      '50004',
      '50005',
      '50011',
      '50013',
      '50026',
      '50057',
      '50102',
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

  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<string>> {
    timeProfile =
      (await this.checkLimits(
        'getAccountConfiguration',
        3000,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return await this.client
      .getAccountConfiguration()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res[0]) {
          return this.returnGood<string>(timeProfile)(res[0].uid)
        } else {
          return this.returnBad(timeProfile)(
            new OKXError('Account not found', 0),
          )
        }
      })
      .catch(
        this.handleOkxErrors(
          this.getUid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getAffiliate(
    uid: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (this.okxSource === OKXSource.my || this.okxSource === OKXSource.app) {
      return this.returnGood<boolean>(timeProfile)(false)
    }
    timeProfile =
      (await this.checkLimits('getAffiliate', 3000, 15, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return await this.client
      .getPrivate('/api/v5/affiliate/invitee/detail', { uid })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<boolean>(timeProfile)(!!res?.[0]?.level)
      })
      .catch(
        this.handleOkxErrors(
          this.getAffiliate,
          uid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  private async getPositionMode(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionMode>> {
    if (this.positionMode) {
      return this.returnGood<PositionMode>(timeProfile)(this.positionMode)
    }
    timeProfile =
      (await this.checkLimits(
        'getAccountConfiguration',
        3000,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return await this.client
      .getAccountConfiguration()
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res[0]) {
          this.positionMode = res[0].posMode as PositionMode
          return this.returnGood<PositionMode>(timeProfile)(this.positionMode)
        } else {
          return this.returnBad(timeProfile)(
            new OKXError('Account not found', 0),
          )
        }
      })
      .catch(
        this.handleOkxErrors(
          this.getPositionMode,
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
    const positionMode = await this.getPositionMode()
    let posMode: PositionMode = 'long_short_mode'
    if (positionMode.status === StatusEnum.ok && positionMode.data) {
      posMode = positionMode.data
    }
    const modes: SetLeverageRequest['mgnMode'][] = ['isolated', 'cross']
    const posModes: (SetLeverageRequest['posSide'] | 'none')[] =
      posMode === 'long_short_mode' ? ['long', 'short'] : ['none']
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    for (const m of modes) {
      for (const p of posModes) {
        timeProfile =
          (await this.checkLimits('setLeverage', 3000, 10, timeProfile)) ||
          timeProfile
        const res = await this.client
          .setLeverage({
            instId: this.updateSymbol(symbol),
            lever: `${leverage}`,
            mgnMode: m,
            posSide: p === 'none' || m === 'cross' ? undefined : p,
          })
          .then((result) => {
            if (result) {
              return this.returnGood<number>(timeProfile)(leverage)
            } else {
              timeProfile = this.endProfilerTime(timeProfile, 'exchange')
              return this.returnBad(timeProfile)(
                new OKXError('Cannot set leverage', 0),
              )
            }
          })
          .catch(
            this.handleOkxErrors(
              this.futures_changeLeverage,
              symbol,
              leverage,
              this.endProfilerTime(timeProfile, 'exchange'),
            ),
          )
        if (res.status === StatusEnum.notok) {
          return res
        }
      }
    }
    timeProfile = this.endProfilerTime(timeProfile, 'exchange')
    return this.returnGood<number>(timeProfile)(leverage)
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
    marginType?: MarginType
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
    const allPairs = await this.getAllExchangeInfo()
    const pairs = (allPairs.data ?? []).map((p) => p.pair)
    timeProfile =
      (await this.checkLimits('getPositions', 3000, 5, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getPositions({
        instType: 'SWAP',
        instId: symbol ? this.updateSymbol(symbol) : undefined,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const positions: PositionInfo[] = []
        for (const p of result.filter(
          (pos) =>
            pairs.includes(this.clearSymbol(pos.instId)) &&
            (symbol ? this.clearSymbol(pos.instId) === symbol : true),
        )) {
          positions.push(await this.convertPosition(p))
        }
        return this.returnGood<PositionInfo[]>(timeProfile)(positions)
      })
      .catch(
        this.handleOkxErrors(this.futures_getPositions, symbol, timeProfile),
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
    _symbol: string,
    margin: MarginType,
    _leverage: number,
    _count = 1,
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
    return await this.getPositionMode().then((res) => {
      if (res.status === StatusEnum.ok) {
        return this.returnGood<boolean>(res.timeProfile)(
          res.data === 'long_short_mode',
        )
      }
      return res
    })
  }

  async futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('setPositionMode', 3000, 3, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return (
      this.client
        //@ts-ignore
        .setPositionMode(value ? 'long_short_mode' : 'net_mode')
        .then((res) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (res.length) {
            return this.returnGood<boolean>(timeProfile)(value)
          }
          return this.handleOkxErrors(
            this.futures_setHedge,
            value,
            timeProfile,
          )(new OKXError('Cannot set hedge mode', 0))
        })
        .catch(
          this.handleOkxErrors(
            this.futures_setHedge,
            value,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
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

  async getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile =
      (await this.checkLimits(
        'getAccountConfiguration',
        3000,
        3,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getAccountConfiguration()
      .then((account) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (account.length) {
          const readWrite =
            //@ts-ignore
            account[0].perm.includes('trade')
          const permissions = this.futures
            ? ['2', '3', '4'].includes(account[0].acctLv)
            : true
          const result = readWrite && permissions
          if (result) {
            return this.returnGood<boolean>(timeProfile)(true)
          }
          return this.returnBad(timeProfile)(
            new OKXError('Check permissions', 0),
          )
        }
        return this.handleOkxErrors(
          this.getApiPermission,
          timeProfile,
        )(new OKXError('Cannot find user', 0))
      })
      .catch(
        this.handleOkxErrors(
          this.getApiPermission,
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

  private getCategory() {
    return this.futures ? (this.usdm ? 'linear' : 'inverse') : null
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
      (await this.checkLimits('cancelOrder', 3000, 25, timeProfile)) ||
      timeProfile
    const { newClientOrderId, symbol: _symbol } = order
    const symbol = this.updateSymbol(_symbol)
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrder({
        clOrdId: newClientOrderId,
        instId: symbol,
      })
      .then(async (res) => {
        if (res.length && res[0].sCode === '0') {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          timeProfile =
            (await this.checkLimits(
              'getOrderDetails',
              3000,
              25,
              timeProfile,
            )) || timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          const order = await this.client.getOrderDetails({
            clOrdId: res[0].clOrdId,
            instId: symbol,
          })
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (order.length === 0) {
            return this.returnBad(timeProfile)(
              new OKXError('Order not found', 0),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(order[0]),
          )
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.handleOkxErrors(
          this.cancelOrder,
          order,
          timeProfile,
        )(
          new OKXError(
            res?.[0]?.sMsg ?? 'Cannot cancel order',
            +(res?.[0]?.sCode ?? '0'),
          ),
        )
      })
      .catch(
        this.handleOkxErrors(
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
      (await this.checkLimits('cancelOrder', 3000, 25, timeProfile)) ||
      timeProfile
    const { orderId, symbol } = order
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .cancelOrder({
        ordId: orderId,
        instId: symbol,
      })
      .then(async (res) => {
        if (res.length && res[0].sCode === '0') {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          timeProfile =
            (await this.checkLimits(
              'getOrderDetails',
              3000,
              25,
              timeProfile,
            )) || timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          const order = await this.client.getOrderDetails({
            clOrdId: res[0].clOrdId,
            instId: symbol,
          })
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (order.length === 0) {
            return this.returnBad(timeProfile)(
              new OKXError('Order not found', 0),
            )
          }
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(order[0]),
          )
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.handleOkxErrors(
          this.cancelOrder,
          order,
          timeProfile,
        )(
          new OKXError(
            res?.[0]?.sMsg ?? 'Cannot cancel order',
            +(res?.[0]?.sCode ?? '0'),
          ),
        )
      })
      .catch(
        this.handleOkxErrors(
          this.cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */
  async getAllExchangeInfo(timeProfile = this.getEmptyTimeProfile()): Promise<
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
      (await this.checkLimits('getInstruments', 3000, 10, timeProfile)) ||
      timeProfile
    const category = this.getCategory()
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getInstruments({ instType: this.futures ? 'SWAP' : 'SPOT' })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res?.length) {
          return this.returnGood<
            (ExchangeInfo & { pair: string; maxLeverage?: string })[]
          >(timeProfile)(
            res
              .filter(
                (d) =>
                  d.state === 'live' &&
                  (category ? d.ctType === category : true),
              )
              .map((s) => {
                let minAmount = this.futures
                  ? category === 'linear'
                    ? round(+s.ctVal * +s.minSz, 10)
                    : 0.0001
                  : +s.minSz
                minAmount = isNaN(minAmount)
                  ? this.futures
                    ? category === 'linear'
                      ? +s.ctVal
                      : 0.0001
                    : +s.minSz
                  : minAmount
                const step = this.futures ? minAmount : +s.lotSz
                return {
                  pair: this.futures ? s.instFamily : s.instId,
                  baseAsset: {
                    minAmount,
                    maxAmount: +s.maxLmtSz,
                    step,
                    name: this.futures
                      ? category === 'linear'
                        ? s.ctValCcy
                        : //@ts-ignore
                          s.settleCcy
                      : s.baseCcy,
                    maxMarketAmount: +s.maxMktSz || +s.maxLmtSz,
                    multiplier: this.usdm ? +s.ctVal : undefined,
                  },
                  quoteAsset: {
                    minAmount: this.futures
                      ? category === 'linear'
                        ? +s.lotSz
                        : +s.ctVal
                      : +s.lotSz,
                    name: this.futures
                      ? category === 'linear'
                        ? //@ts-ignore
                          s.settleCcy
                        : s.ctValCcy
                      : s.quoteCcy,
                  },
                  maxOrders: 500,
                  priceAssetPrecision: this.getPricePrecision(s.tickSz),
                  maxLeverage: s.lever,
                }
              }),
          )
        }
        return this.returnBad(timeProfile)(new OKXError('No data', 0))
      })
      .catch(
        this.handleOkxErrors(
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
    const allPairs = await this.getAllExchangeInfo()
    const pairs = (allPairs.data ?? []).map((p) => p.pair)
    timeProfile =
      (await this.checkLimits('getOrderList', 3000, 25, timeProfile)) ||
      timeProfile
    const input: { instId?: string; instType: InstrumentType } = {
      instId: this.updateSymbol(symbol),
      instType: this.futures ? 'SWAP' : 'SPOT',
    }
    if (!symbol) {
      delete input.instId
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getOrderList(input)
      .then(async (orders) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (returnOrders) {
          const convertedOrders: CommonOrder[] = []
          for (const o of orders.filter(
            (o) =>
              pairs.includes(this.clearSymbol(o.instId)) &&
              (symbol ? this.clearSymbol(o.instId) === symbol : true),
          )) {
            const data = await this.convertOrder(o)
            convertedOrders.push(data)
          }
          return this.returnGood<CommonOrder[]>(timeProfile)(convertedOrders)
        }
        return this.returnGood<number>(timeProfile)(orders.length)
      })
      .catch(
        this.handleOkxErrors<BaseReturn<CommonOrder[] | number>>(
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
    let maker = 0
    let taker = 0
    const pairs = await this.getAllExchangeInfo()
    timeProfile =
      (await this.checkLimits('getFeeRates', 3000, 3, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    await this.client
      .getFeeRates({ instType: this.futures ? 'SWAP' : 'SPOT' })
      .then(async (fees) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (fees.length) {
          maker = +fees[0].maker * -1
          taker = +fees[0].taker * -1
          return
        }
        return this.handleOkxErrors(
          this.getAllUserFees,
          timeProfile,
        )(new OKXError('Cannot get fees', 0))
      })
      .catch(
        this.handleOkxErrors(
          this.getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
    timeProfile = this.endProfilerTime(timeProfile, 'exchange')
    return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
      (pairs.data ?? []).map((p) => ({ pair: p.pair, maker, taker })),
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
    timeProfile =
      (await this.checkLimits('getBalance', 3000, 5, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getBalance()
      .then((balances) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (balances.length) {
          return this.returnGood<FreeAsset>(timeProfile)(
            balances[0].details.map((b) => ({
              asset: b.ccy,
              free: +b.availBal,
              locked: +b.frozenBal,
            })),
          )
        }
        return this.handleOkxErrors(
          this.getBalance,
          timeProfile,
        )(new OKXError('Balances not found', 0))
      })
      .catch(
        this.handleOkxErrors(
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
      (await this.checkLimits('getOrderDetails', 3000, 25, timeProfile)) ||
      timeProfile

    const { newClientOrderId, symbol: _symbol } = data
    const symbol = this.updateSymbol(_symbol)
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getOrderDetails({ instId: symbol, clOrdId: newClientOrderId })
      .then(async (res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.length) {
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(res[0]),
          )
        }
        return this.handleOkxErrors(
          this.getOrder,
          data,
          timeProfile,
        )(new OKXError('Cannot find order', 0))
      })
      .catch(
        this.handleOkxErrors(
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
        maker: 0.0008,
        taker: 0.001,
      },
    )
  }

  /** Get the latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async latestPrice(symbol: string): Promise<BaseReturn<number>> {
    return await this.getAllPrices().then((res) => {
      if (res.status === StatusEnum.ok) {
        return this.returnGood<number>(res.timeProfile)(
          res.data.find((p) => p.pair === symbol)?.price,
        )
      }
      return res
    })
  }

  private updateSymbol(s: string) {
    return `${s}${this.futures ? '-SWAP' : ''}`
  }

  private clearSymbol(s: string) {
    return s.replace(/-SWAP$/, '')
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
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('openOrder', 3000, 25, timeProfile)) ||
      timeProfile
    const {
      symbol: _symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type,
      reduceOnly,
      positionSide,
      marginType,
    } = order
    const symbol = this.updateSymbol(_symbol)
    const request: OrderRequest = {
      instId: symbol,
      side: side === 'BUY' ? 'buy' : 'sell',
      sz: `${quantity}`,
      clOrdId: newClientOrderId || '',
      ordType: type === 'MARKET' ? 'market' : 'limit',
      tdMode: this.futures
        ? marginType === MarginType.CROSSED
          ? 'cross'
          : 'isolated'
        : 'cash',
      tgtCcy: 'base_ccy',
      tag: this.code,
    }
    if (this.futures && typeof reduceOnly !== 'undefined') {
      request.reduceOnly = reduceOnly
    }
    if (this.futures) {
      delete request.tgtCcy
    }
    if (this.futures) {
      request.posSide = positionSide
        ? positionSide === PositionSide.LONG
          ? 'long'
          : positionSide === PositionSide.SHORT
            ? 'short'
            : 'net'
        : 'net'
    }
    if (type === 'LIMIT') {
      request.px = this.convertNumberToString(price)
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.orderClient
      .submitOrder(request)
      .then(async () => {
        timeProfile =
          (await this.checkLimits('getOrderDetails', 3000, 25, timeProfile)) ||
          timeProfile
        const search = {
          clOrdId: order.newClientOrderId,
          instId: symbol,
        }
        let orderData = await this.client.getOrderDetails(search)

        if (!orderData.length) {
          Logger.warn(
            `OKX Order data not found for ${order.newClientOrderId}. Sleep 1s`,
          )
          await sleep(1000)
          timeProfile =
            (await this.checkLimits(
              'getOrderDetails',
              3000,
              25,
              timeProfile,
            )) || timeProfile
          orderData = await this.client.getOrderDetails(search)
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        }
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (orderData.length) {
          return this.returnGood<CommonOrder>(timeProfile)(
            await this.convertOrder(orderData[0]),
          )
        }

        return this.handleOkxErrors(
          this.getOrder,
          { symbol, newClientOrderId },
          timeProfile,
        )(new OKXError('Cannot find order', 0))
      })
      .catch(
        this.handleOkxErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  private convertInterval(interval: ExchangeIntervals): string {
    return interval === ExchangeIntervals.eightH
      ? '4H'
      : interval === ExchangeIntervals.fifteenM
        ? '15m'
        : interval === ExchangeIntervals.fiveM
          ? '5m'
          : interval === ExchangeIntervals.fourH
            ? '4H'
            : interval === ExchangeIntervals.oneD
              ? '1Dutc'
              : interval === ExchangeIntervals.oneH
                ? '1H'
                : interval === ExchangeIntervals.oneM
                  ? '1m'
                  : interval === ExchangeIntervals.oneW
                    ? '1Wutc'
                    : interval === ExchangeIntervals.thirtyM
                      ? '30m'
                      : interval === ExchangeIntervals.threeM
                        ? '3m'
                        : interval === ExchangeIntervals.twoH
                          ? '2H'
                          : '1m'
  }

  async getNewCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    timeProfile =
      (await this.checkLimits('getCandles', 3000, 30, timeProfile)) ||
      timeProfile
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout * 2) {
        Logger.error(
          `OKX Queue time is too long ${diff / 1000} getNewCandles ${
            this.futures ? 'spot' : this.usdm ? 'linear' : 'inverse'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    const data = {
      before: `${from}`,
      after: `${to}`,
    }
    if (typeof from === 'undefined') {
      delete data.before
    }
    if (typeof to === 'undefined') {
      delete data.after
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getCandles({
        instId: this.updateSymbol(symbol),
        bar: this.convertInterval(interval),
        before: data.before,
        after: data.after,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<CandleResponse[]>(timeProfile)(
          res.map((k) => ({
            open: k[1],
            close: k[4],
            high: k[2],
            low: k[3],
            time: +k[0],
            volume: k[5],
          })),
        )
      })
      .catch(
        this.handleOkxErrors(
          this.getNewCandles,
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
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const date = +new Date()
    if (from && date - from < timeIntervalMap[interval] * 1400) {
      return this.getNewCandles(
        symbol,
        interval,
        from,
        to,
        countData,
        timeProfile,
      )
    }
    timeProfile =
      (await this.checkLimits('getHistoricCandles', 3000, 10, timeProfile)) ||
      timeProfile
    if (timeProfile.inQueueStartTime && timeProfile.inQueueEndTime) {
      const diff = timeProfile.inQueueEndTime - timeProfile.inQueueStartTime
      if (diff >= this.timeout * 2) {
        Logger.error(
          `OKX Queue time is too long ${diff / 1000} getCandles ${
            this.futures ? 'spot' : this.usdm ? 'linear' : 'inverse'
          }`,
        )
        return this.returnBad(timeProfile)(new Error('Response timeout'))
      }
    }
    const data = {
      before: `${from}`,
      after: `${to}`,
    }
    if (typeof from === 'undefined') {
      delete data.before
    }
    if (typeof to === 'undefined') {
      delete data.after
    }
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getHistoricCandles({
        instId: this.updateSymbol(symbol),
        bar: this.convertInterval(interval),
        before: data.before,
        after: data.after,
      })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<CandleResponse[]>(timeProfile)(
          res.map((k) => ({
            open: k[1],
            close: k[4],
            high: k[2],
            low: k[3],
            time: +k[0],
            volume: k[5],
          })),
        )
      })
      .catch(
        this.handleOkxErrors(
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
      (await this.checkLimits('getTickers', 3000, 10, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getTickers({ instType: this.futures ? 'SWAP' : 'SPOT' })
      .then((res) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (res.length) {
          return this.returnGood<AllPricesResponse[]>(timeProfile)(
            res.map((k) => ({
              pair: this.clearSymbol(k.instId),
              price: +k.last,
            })),
          )
        }
        return this.handleOkxErrors(
          this.getAllPrices,
          timeProfile,
        )(new OKXError('Cannot found prices', 0))
      })
      .catch(
        this.handleOkxErrors(
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
  private async convertOrder(order?: OrderDetails): Promise<CommonOrder> {
    const orderStatus = (): OrderStatusType => {
      const { state } = order
      if (['live'].includes(state)) {
        return 'NEW'
      }
      if (['partially_filled'].includes(state)) {
        return 'PARTIALLY_FILLED'
      }
      if (state === 'filled') {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: OrderDetails['ordType']): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }
    const size = order.accFillSz || order.fillSz || order.sz
    const price = +(order.avgPx ?? order.px) || +order.px
    return {
      symbol: this.clearSymbol(order.instId),
      orderId: order.ordId,
      clientOrderId: order.clOrdId,
      transactTime: +order.cTime,
      updateTime: +order.uTime,
      price: `${price}`,
      origQty: order.sz,
      executedQty: size,
      cummulativeQuoteQty: `${price * +size}`,
      status: orderStatus(),
      type: orderType(order.ordType),
      side: order.side === 'sell' ? 'SELL' : 'BUY',
      fills: [],
      //@ts-ignore
      reduceOnly: order.reduceOnly,
      positionSide: this.futures
        ? order.posSide === 'long'
          ? PositionSide.LONG
          : order.posSide === 'short'
            ? PositionSide.SHORT
            : PositionSide.LONG
        : undefined,
    }
  }

  private async convertPosition(
    position: AccountPosition,
  ): Promise<PositionInfo> {
    const isolated = position.mgnMode === 'isolated'
    const im = isolated ? position.margin : position.imr
    const mm = isolated ? '0' : position.margin
    return {
      symbol: this.clearSymbol(position.instId),
      initialMargin: im,
      maintMargin: mm,
      unrealizedProfit: position.upl,
      positionInitialMargin: im,
      openOrderInitialMargin: mm,
      leverage: position.lever,
      isolated,
      entryPrice: position.avgPx,
      maxNotional: '',
      positionSide:
        position.posSide === 'long'
          ? PositionSide.LONG
          : position.posSide === 'short'
            ? PositionSide.SHORT
            : +position.pos > 0
              ? PositionSide.LONG
              : PositionSide.SHORT,
      positionAmt: position.pos,
      notional: '',
      isolatedWallet: '',
      updateTime: +position.uTime,
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Bybit API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleOkxErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (
      e: Error & {
        code: number
        response?: string
        msg?: string
        data?: any
      },
    ) => {
      if (!e.message && e.msg) {
        e.message = e.msg
      }
      if (e?.data?.[0]?.sCode) {
        e.message = e.data[0].sMsg
      }
      if (e?.data?.[0]?.sMsg) {
        e.code = e.data[0].sCode
      }
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      if (
        this.retryErrors.includes(`${e.code}`) ||
        e.response ||
        (e.message &&
          (e.message.toLowerCase().indexOf('fetch failed'.toLowerCase()) !==
            -1 ||
            e.message.toLowerCase().indexOf('socket hang up'.toLowerCase()) !==
              -1 ||
            e.message.toLowerCase().indexOf('getaddrinfo'.toLowerCase()) !==
              -1 ||
            e.message.toLowerCase().indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
            e.message.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !==
              -1 ||
            e.message.toLowerCase().indexOf('EAI_AGAIN'.toLowerCase()) !== -1 ||
            e.message.toLowerCase().indexOf(tls) !== -1))
      ) {
        if (timeProfile.attempts < this.retry) {
          if (
            e.message.toLowerCase().indexOf('socket hang up'.toLowerCase()) !==
            -1
          ) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(`OKX socket hang up wait ${time}s`)
            await sleep(time)
          }
          if (`${e.code}` === '50011') {
            const sleepTime = (timeProfile.attempts + 1) * 10000
            Logger.log(
              `OKX Too many requests sleep ${sleepTime / 1000}s, ${cb.name}`,
            )
            await sleep(sleepTime)
          }
          if (
            e.message
              .toLowerCase()
              .indexOf('Requests too frequent'.toLowerCase()) !== -1
          ) {
            Logger.log(`OKX Requests too frequent sleep 10s, ${cb.name}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('ECONNRESET'.toLowerCase()) !== -1
          ) {
            Logger.log(`OKX Connection reset wait 10s, ${cb.name}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('EAI_AGAIN'.toLowerCase()) !== -1
          ) {
            Logger.log(`OKX EAI_AGAIN wait 10s, ${cb.name}`)
            await sleep(10000)
          }
          if (
            e.message.toLowerCase().indexOf('getaddrinfo'.toLowerCase()) !== -1
          ) {
            Logger.log(`OKX getaddrinfo wait 2s, ${cb.name}`)
            await sleep(3000)
          }
          if (e.message.toLowerCase().indexOf(tls) !== -1) {
            Logger.log(`OKX Timeout wait 10s tls error, ${cb.name}`)
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
    id: string,
    frame: number,
    frameCount: number,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    const limitInstance = new limitHelper.Limit()
    const limit = await limitInstance.addMethod(id, frame, frameCount)
    if (limit > 0) {
      await sleep(limit)
      await this.checkLimits(id, frame, frameCount)
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

export default OKXExchange
