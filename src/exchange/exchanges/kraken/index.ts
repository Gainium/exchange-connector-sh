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
import { SpotClient, DerivativesClient } from '@siebly/kraken-api'
import limitHelper from './limit'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'

class KrakenError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

// Interval mapping for Kraken
const intervalMap: { [x in ExchangeIntervals]: number } = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '1d': 1440,
  '1w': 10080,
}

class KrakenExchange extends AbstractExchange implements Exchange {
  /** Kraken Spot client */
  protected spotClient?: SpotClient
  /** Kraken Derivatives/Futures client */
  protected derivativesClient?: DerivativesClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: string,
    _keysType?: unknown,
    _okxSource?: string,
    _code?: string,
    _bybitHost?: unknown,
    _subaccount?: boolean,
  ) {
    super({ key, secret })

    const isDemo = process.env.KRAKEN_ENV === 'demo'

    const spotOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
    }

    const derivativesOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
      testnet: isDemo,
    }

    this.futures = futures === Futures.null ? this.futures : futures

    // Initialize appropriate client based on futures type
    if (this.usdm) {
      this.derivativesClient = new DerivativesClient(derivativesOptions)
    } else {
      this.spotClient = new SpotClient(spotOptions)
    }

    this.retry = 10
    this.retryErrors = [
      'EAPI:Rate limit exceeded',
      'EService:Timeout',
      'EService:Unavailable',
      'EService:Busy',
      'EGeneral:Temporary lockout',
      '500',
      '502',
      '503',
      '504',
      '520',
      '521',
      '522',
    ]
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return this.futures === Futures.coinm
  }

  private errorClient(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Client not initialized'))
  }

  /**
   * Handle Kraken API errors with retry logic
   */
  private handleKrakenErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (e: Error): Promise<any> => {
      const errorObj = e as any
      const timeProfile: TimeProfile = args[args.length - 1]

      // Extract error information from different possible locations
      const httpStatus = errorObj.code || errorObj.response?.status || ''
      const errorBody = errorObj.body
      const errorResponse = errorObj.response
      const requestParams = errorObj.requestParams || {}

      // Kraken API errors are in body.error or body.errors array
      let actualError: string
      let errorDetails: any = {}

      if (errorBody?.errors && Array.isArray(errorBody.errors)) {
        // Kraken Futures API error format with errors array
        const errors = errorBody.errors.map(
          (e: any) => `[${e.code}] ${e.message}`,
        )
        actualError = errors.join(', ')
        errorDetails = {
          status: errorBody.status,
          result: errorBody.result,
          errors: errorBody.errors,
          serverTime: errorBody.serverTime,
          httpStatus,
        }
      } else if (errorBody?.error) {
        // Kraken Futures API error format with single error
        actualError = errorBody.error
        errorDetails = {
          result: errorBody.result,
          error: errorBody.error,
          serverTime: errorBody.serverTime,
          httpStatus,
          ...(errorBody.errorCode && { errorCode: errorBody.errorCode }),
          ...(errorBody.message && { message: errorBody.message }),
        }
      } else if (errorResponse?.data) {
        // Alternative error format
        actualError =
          errorResponse.data.error || errorResponse.data.message || e.message
        errorDetails = errorResponse.data
      } else {
        // Fallback to basic error message
        actualError = e.message
        errorDetails = { message: e.message, httpStatus }
      }

      // Log comprehensive error information including request details
      Logger.error(
        `[${httpStatus || 'NO_STATUS'}] Kraken API error: ${actualError}`,
        `Details: ${JSON.stringify(errorDetails, null, 2)}`,
      )

      // Check if error is retryable
      const shouldRetry = this.retryErrors.some(
        (code) =>
          actualError.includes(code) ||
          e.message.includes(code) ||
          (httpStatus && String(httpStatus).includes(code)),
      )

      if (shouldRetry && timeProfile.attempts < this.retry) {
        const waitTime = Math.min(
          1000 * Math.pow(2, timeProfile.attempts),
          10000,
        )
        Logger.warn(
          `Retrying after ${waitTime}ms (attempt ${timeProfile.attempts + 1}/${this.retry})`,
        )
        await sleep(waitTime)

        timeProfile.attempts++
        return cb.call(this, ...args)
      }

      return this.returnBad(timeProfile)(
        new KrakenError(actualError, String(httpStatus)),
      )
    }
  }

  /**
   * Check rate limits before making API call
   */
  protected async checkLimits(
    method: string,
    symbol?: string,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | undefined> {
    const isOrderMethod = ['submitOrder', 'cancelOrder', 'amendOrder'].includes(
      method,
    )
    const isHeavyMethod = ['getLedgersInfo', 'getTradesHistory'].includes(
      method,
    )

    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }

    let waitTime = 0
    if (isOrderMethod && symbol) {
      const orderType =
        method === 'submitOrder'
          ? 'add'
          : method === 'cancelOrder'
            ? 'cancel'
            : 'amend'
      waitTime = await limitHelper.addOrderCall(symbol, orderType)
    } else {
      waitTime = await limitHelper.addRestCall(isHeavyMethod)
    }

    if (waitTime > 0) {
      await sleep(waitTime)
    }

    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
      return timeProfile
    }
    return undefined
  }

  getUsage() {
    return limitHelper.getUsage()
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

  /**
   * Map Kraken order status to common format
   */
  private mapOrderStatus(status: string): OrderStatusType {
    const statusMap: Record<string, OrderStatusType> = {
      pending: 'NEW',
      open: 'NEW',
      closed: 'FILLED',
      canceled: 'CANCELED',
      cancelled: 'CANCELED',
      expired: 'CANCELED',
      filled: 'FILLED',
      'partially filled': 'PARTIALLY_FILLED',
    }
    return statusMap[status.toLowerCase()] || 'NEW'
  }

  /**
   * Map Kraken order type to common format
   */
  private mapOrderType(type: string): OrderTypeT {
    return type.toLowerCase() === 'market' ? 'MARKET' : 'LIMIT'
  }

  /**
   * Normalize Kraken symbol format (XXBTZUSD -> BTCUSDT)
   */
  private normalizeSymbol(krakenSymbol: string): string {
    // Remove leading X's and Z's (Kraken's asset naming convention)
    return krakenSymbol
      .replace(/^X+/, '')
      .replace(/^Z+/, '')
      .replace('XBT', 'BTC')
  }

  /**
   * Convert common symbol to Kraken format
   */
  private toKrakenSymbol(symbol: string): string {
    // Basic conversion - may need refinement
    return symbol.replace('BTC', 'XBT')
  }

  /**
   * Convert Kraken spot order to common format
   */
  private convertOrder(order: {
    orderId: string
    symbol: string
    clientOrderId?: string
    price: string
    origQty: string
    executedQty: string
    status: string
    type: string
    side: string
    updateTime?: number
    transactTime?: number
  }): CommonOrder {
    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId || '',
      transactTime: order.transactTime || Date.now(),
      updateTime: order.updateTime || Date.now(),
      price: order.price,
      origQty: order.origQty,
      executedQty: order.executedQty,
      status: this.mapOrderStatus(order.status),
      type: this.mapOrderType(order.type),
      side: order.side as OrderSideType,
    }
  }

  /**
   * Convert Kraken futures order to common format
   */
  private futures_convertOrder(order: {
    orderId: string
    symbol: string
    clientOrderId?: string
    price?: number
    origQty?: number
    executedQty?: number
    status: string
    type: string
    side: string
    updateTime?: number
    transactTime?: number
  }): CommonOrder {
    return {
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId || '',
      transactTime: order.transactTime || Date.now(),
      updateTime: order.updateTime || Date.now(),
      price: order.price?.toString() || '0',
      origQty: order.origQty?.toString() || '0',
      executedQty: order.executedQty?.toString() || '0',
      status: this.mapOrderStatus(order.status),
      type: this.mapOrderType(order.type),
      side: order.side.toUpperCase() as OrderSideType,
    }
  }

  /**
   * Convert Kraken futures position to common format
   */
  private futures_convertPosition(pos: {
    symbol: string
    side: 'long' | 'short'
    size: number
    price: number
    unrealizedFunding: number | null
  }): PositionInfo {
    return {
      symbol: pos.symbol,
      initialMargin: '0',
      maintMargin: '0',
      unrealizedProfit: pos.unrealizedFunding?.toString() || '0',
      positionInitialMargin: '0',
      openOrderInitialMargin: '0',
      leverage: '1',
      isolated: false,
      entryPrice: pos.price.toString(),
      maxNotional: '0',
      positionSide: pos.side === 'long' ? 'LONG' : 'SHORT',
      positionAmt: pos.size.toString(),
      notional: '0',
      isolatedWallet: '0',
      updateTime: Date.now(),
      bidNotional: '0',
      askNotional: '0',
    }
  }

  // ===========================
  // Account & Authentication
  // ===========================

  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<string | number>> {
    // Kraken doesn't have a direct UID endpoint, return -1
    return this.returnGood<number>(timeProfile)(-1)
  }

  async getAffiliate(
    _uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    // Not supported by Kraken API
    return this.returnGood<boolean>(timeProfile)(false)
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

  async getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getAccountBalance', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getAccounts()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.accounts) {
            const errorDetails = {
              result: result.result,
              hasAccounts: !!result.accounts,
              serverTime: result.serverTime,
              fullResponse: result,
            }
            throw new Error(
              `Failed to get balance. Details: ${JSON.stringify(errorDetails)}`,
            )
          }

          const balances: FreeAsset = []
          const accounts = result.accounts

          // Handle flex account
          if (accounts.flex) {
            for (const [currency, summary] of Object.entries(
              accounts.flex.currencies,
            )) {
              balances.push({
                asset: currency,
                free: summary.quantity || 0,
                locked: 0,
              })
            }
          }

          // Handle margin accounts
          for (const [key, account] of Object.entries(accounts)) {
            if (
              key !== 'flex' &&
              key !== 'cash' &&
              account &&
              'type' in account &&
              account.type === 'marginAccount'
            ) {
              const marginAccount = account as any
              balances.push({
                asset: marginAccount.currency || 'UNKNOWN',
                free: parseFloat(marginAccount.auxiliary?.af || '0'),
                locked: parseFloat(marginAccount.marginRequirements?.im || '0'),
              })
            }
          }

          return this.returnGood<FreeAsset>(timeProfile)(balances)
        })
        .catch(
          this.handleKrakenErrors(
            this.getBalance,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAccountBalance', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getAccountBalance()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result) {
          throw new Error('Failed to get balance')
        }

        const balances: FreeAsset = []
        for (const [asset, balance] of Object.entries(result.result)) {
          balances.push({
            asset: this.normalizeSymbol(asset),
            free: parseFloat(balance as string),
            locked: 0, // Kraken's basic balance doesn't separate locked
          })
        }

        return this.returnGood<FreeAsset>(timeProfile)(balances)
      })
      .catch(
        this.handleKrakenErrors(
          this.getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Orders
  // ===========================

  async openOrder(
    order: {
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
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const {
      symbol,
      side,
      quantity,
      price,
      newClientOrderId,
      type = 'LIMIT',
    } = order

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('submitOrder', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      // Map order type to Kraken format
      const krakenOrderType =
        type === 'LIMIT'
          ? 'lmt'
          : type === 'MARKET'
            ? 'mkt'
            : (type as string).toLowerCase()

      const orderParams = {
        orderType: krakenOrderType as 'lmt' | 'mkt',
        symbol,
        side: side.toLowerCase() as 'buy' | 'sell',
        size: quantity,
        limitPrice: type === 'LIMIT' ? price : undefined,
        cliOrdId: newClientOrderId,
      }

      return this.derivativesClient
        .submitOrder(orderParams)
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.sendStatus) {
            throw new Error(
              `Failed to create order. Result: ${result.result || 'undefined'}, SendStatus: ${!!result.sendStatus}`,
            )
          }

          const orderData = result.sendStatus

          return this.returnGood<CommonOrder>(timeProfile)(
            this.futures_convertOrder({
              orderId: orderData.order_id || '',
              symbol,
              clientOrderId: newClientOrderId || orderData.cliOrdId || '',
              price,
              origQty: quantity,
              executedQty: 0,
              status: orderData.status || 'NEW',
              type,
              side,
            }),
          )
        })
        .catch(
          this.handleKrakenErrors(
            this.openOrder,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('submitOrder', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .submitOrder({
        ordertype: type.toLowerCase() as 'limit' | 'market',
        type: side.toLowerCase() as 'buy' | 'sell',
        pair: this.toKrakenSymbol(symbol),
        volume: quantity.toString(),
        price: type === 'LIMIT' ? price.toString() : undefined,
        userref: newClientOrderId
          ? parseInt(newClientOrderId.substring(0, 8), 16)
          : undefined,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to create order')
        }

        const orderIds = result.result.txid || []
        const orderId = orderIds[0] || ''

        return this.returnGood<CommonOrder>(timeProfile)(
          this.convertOrder({
            orderId,
            symbol,
            clientOrderId: newClientOrderId || '',
            price: price.toString(),
            origQty: quantity.toString(),
            executedQty: '0',
            status: 'NEW',
            type,
            side,
          }),
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.openOrder,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getOrders', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getOrderStatus({
          cliOrdIds: [newClientOrderId],
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (
            result.result !== 'success' ||
            !result.orders ||
            result.orders.length === 0
          ) {
            throw new Error('Order not found')
          }

          const orderInfo = result.orders[0]
          const order = orderInfo.order

          return this.returnGood<CommonOrder>(timeProfile)(
            this.futures_convertOrder({
              orderId: order.orderId || '',
              symbol: order.symbol || symbol,
              clientOrderId: newClientOrderId,
              price: order.limitPrice,
              origQty: order.quantity,
              executedQty: order.filled,
              status: orderInfo.status || 'NEW',
              type: order.type || 'lmt',
              side: order.side || 'buy',
            }),
          )
        })
        .catch(
          this.handleKrakenErrors(
            this.getOrder,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getOrders', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    // Kraken doesn't support querying by client order ID directly for spot
    // We need to use userref if it was set, or fetch all open orders
    return this.spotClient
      .getOpenOrders()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get orders')
        }

        // Find order by client order ID (userref)
        const orders = result.result.open || {}
        for (const [orderId, orderData] of Object.entries(orders)) {
          if (orderData.userref?.toString() === newClientOrderId) {
            return this.returnGood<CommonOrder>(timeProfile)(
              this.convertOrder({
                orderId,
                symbol: this.normalizeSymbol(orderData.descr?.pair || symbol),
                clientOrderId: newClientOrderId,
                price: orderData.descr?.price || '0',
                origQty: orderData.vol || '0',
                executedQty: orderData.vol_exec || '0',
                status: orderData.status || 'NEW',
                type: orderData.descr?.ordertype || 'limit',
                side: orderData.descr?.type?.toUpperCase() || 'BUY',
              }),
            )
          }
        }

        throw new Error('Order not found')
      })
      .catch(
        this.handleKrakenErrors(
          this.getOrder,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId?: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!newClientOrderId) {
      return this.returnBad(timeProfile)(new Error('Client order ID required'))
    }

    // First get the order to find its exchange ID
    const orderResult = await this.getOrder(
      { symbol, newClientOrderId },
      timeProfile,
    )

    if (orderResult.status !== StatusEnum.ok) {
      return orderResult as BaseReturn<CommonOrder>
    }

    const orderId = orderResult.data.orderId

    return this.cancelOrderByOrderIdAndSymbol(
      { symbol, orderId: orderId.toString() },
      timeProfile,
    )
  }

  async cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const { symbol, orderId } = order

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('cancelOrder', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .cancelOrder({
          order_id: orderId,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success') {
            throw new Error(
              `Failed to cancel order. Result: ${result.result || 'undefined'}`,
            )
          }

          return this.returnGood<CommonOrder>(timeProfile)(
            this.futures_convertOrder({
              orderId,
              symbol,
              clientOrderId: '',
              status: 'CANCELED',
              type: 'LIMIT',
              side: 'BUY',
            }),
          )
        })
        .catch(
          this.handleKrakenErrors(
            this.cancelOrderByOrderIdAndSymbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('cancelOrder', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .cancelOrder({
        txid: orderId,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to cancel order')
        }

        return this.returnGood<CommonOrder>(timeProfile)(
          this.convertOrder({
            orderId,
            symbol,
            clientOrderId: '',
            price: '0',
            origQty: '0',
            executedQty: '0',
            status: 'CANCELED',
            type: 'LIMIT',
            side: 'BUY',
          }),
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.cancelOrderByOrderIdAndSymbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol: string,
    returnOrders: true,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol: string,
    returnOrders: boolean = false,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number> | BaseReturn<CommonOrder[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getOpenOrders', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getOpenOrders()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.openOrders) {
            const errorDetails = {
              result: result.result,
              hasOpenOrders: !!result.openOrders,
              serverTime: result.serverTime,
              fullResponse: result,
            }
            throw new Error(
              `Failed to get open orders. Details: ${JSON.stringify(errorDetails)}`,
            )
          }

          const filteredOrders = result.openOrders.filter(
            (o) => o.symbol === symbol,
          )

          if (!returnOrders) {
            return this.returnGood<number>(timeProfile)(filteredOrders.length)
          }

          const commonOrders: CommonOrder[] = filteredOrders.map((order) =>
            this.futures_convertOrder({
              orderId: order.order_id || '',
              symbol: order.symbol || symbol,
              clientOrderId: order.cliOrdId || '',
              price: order.limitPrice,
              origQty: order.filledSize + (order.unfilledSize || 0),
              executedQty: order.filledSize,
              status: order.status || 'NEW',
              type: order.orderType || 'lmt',
              side: order.side || 'buy',
            }),
          )

          return this.returnGood<CommonOrder[]>(timeProfile)(commonOrders)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllOpenOrders,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getOpenOrders', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getOpenOrders()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get open orders')
        }

        const orders = result.result.open || {}
        const krakenSymbol = this.toKrakenSymbol(symbol)
        const filteredOrders = Object.entries(orders).filter(
          ([_, order]) => order.descr?.pair === krakenSymbol,
        )

        if (!returnOrders) {
          return this.returnGood<number>(timeProfile)(filteredOrders.length)
        }

        const commonOrders: CommonOrder[] = filteredOrders.map(
          ([orderId, order]) =>
            this.convertOrder({
              orderId,
              symbol: this.normalizeSymbol(order.descr?.pair || symbol),
              clientOrderId: order.userref?.toString() || '',
              price: order.descr?.price || '0',
              origQty: order.vol || '0',
              executedQty: order.vol_exec || '0',
              status: order.status || 'NEW',
              type: order.descr?.ordertype || 'limit',
              side: order.descr?.type?.toUpperCase() || 'BUY',
            }),
        )

        return this.returnGood<CommonOrder[]>(timeProfile)(commonOrders)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllOpenOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Market Data
  // ===========================

  async latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getTicker', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTicker({ symbol })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.ticker) {
            throw new Error(
              `Failed to get ticker. Result: ${result.result || 'undefined'}, Ticker: ${!!result.ticker}`,
            )
          }

          const price = result.ticker.last || 0
          return this.returnGood<number>(timeProfile)(price)
        })
        .catch(
          this.handleKrakenErrors(
            this.latestPrice,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTicker', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTicker({ pair: this.toKrakenSymbol(symbol) })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get ticker')
        }

        const tickers = result.result
        const ticker = Object.values(tickers)[0]
        const price = parseFloat(ticker?.c?.[0] || '0')

        return this.returnGood<number>(timeProfile)(price)
      })
      .catch(
        this.handleKrakenErrors(
          this.latestPrice,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getTickers', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTickers()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.tickers) {
            throw new Error(
              `Failed to get tickers. Result: ${result.result || 'undefined'}, Tickers: ${!!result.tickers}`,
            )
          }

          const prices: AllPricesResponse[] = result.tickers
            .filter((t) => t.tag === 'perpetual')
            .map((ticker) => ({
              pair: ticker.symbol || '',
              price: ticker.last || 0,
            }))

          return this.returnGood<AllPricesResponse[]>(timeProfile)(prices)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTicker', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTicker()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get tickers')
        }

        const prices: AllPricesResponse[] = Object.entries(result.result).map(
          ([pair, ticker]) => ({
            pair: this.normalizeSymbol(pair),
            price: parseFloat(ticker.c?.[0] || '0'),
          }),
        )

        return this.returnGood<AllPricesResponse[]>(timeProfile)(prices)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<ExchangeInfo>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getInstruments', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getInstruments()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.instruments) {
            throw new Error(
              `Failed to get instruments. Result: ${result.result || 'undefined'}, Instruments: ${!!result.instruments}`,
            )
          }

          const instrument = result.instruments.find((i) => i.symbol === symbol)
          if (!instrument) {
            throw new Error(`Instrument ${symbol} not found`)
          }

          const info: ExchangeInfo = {
            baseAsset: {
              name: instrument.underlying || symbol,
              minAmount: 0.001, // Default min
              maxAmount: instrument.maxPositionSize || 999999999,
              step: instrument.tickSize || 0.01,
              maxMarketAmount: instrument.maxPositionSize || 999999999,
            },
            quoteAsset: {
              name: 'USD',
              minAmount: 0,
            },
            maxOrders: 200,
            priceAssetPrecision: 8,
          }

          return this.returnGood<ExchangeInfo>(timeProfile)(info)
        })
        .catch(
          this.handleKrakenErrors(
            this.getExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAssetPairs', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getAssetPairs({ pair: this.toKrakenSymbol(symbol) })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get asset pairs')
        }

        const pairs = result.result
        const pairInfo = Object.values(pairs)[0]

        if (!pairInfo) {
          throw new Error(`Pair ${symbol} not found`)
        }

        const info: ExchangeInfo = {
          baseAsset: {
            name: this.normalizeSymbol(pairInfo.base || ''),
            minAmount: parseFloat(pairInfo.ordermin || '0'),
            maxAmount: 999999999,
            step: Math.pow(10, -(pairInfo.lot_decimals || 8)),
            maxMarketAmount: 999999999,
          },
          quoteAsset: {
            name: this.normalizeSymbol(pairInfo.quote || ''),
            minAmount: 0,
            precision: pairInfo.pair_decimals,
          },
          maxOrders: 60, // Starter tier
          priceAssetPrecision: pairInfo.pair_decimals || 8,
        }

        return this.returnGood<ExchangeInfo>(timeProfile)(info)
      })
      .catch(
        this.handleKrakenErrors(
          this.getExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getInstruments', undefined, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getInstruments()
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.instruments) {
            throw new Error(
              `Failed to get all instruments. Result: ${result.result || 'undefined'}, Instruments: ${!!result.instruments}`,
            )
          }

          const infos: (ExchangeInfo & { pair: string })[] = result.instruments
            .filter((i) => i.tradeable)
            .map((instrument) => ({
              pair: instrument.symbol || '',
              baseAsset: {
                name: instrument.underlying || '',
                minAmount: 0.001,
                maxAmount: instrument.maxPositionSize || 999999999,
                step: instrument.tickSize || 0.01,
                maxMarketAmount: instrument.maxPositionSize || 999999999,
              },
              quoteAsset: {
                name: 'USD',
                minAmount: 0,
              },
              maxOrders: 200,
              priceAssetPrecision: 8,
            }))

          return this.returnGood<(ExchangeInfo & { pair: string })[]>(
            timeProfile,
          )(infos)
        })
        .catch(
          this.handleKrakenErrors(
            this.getAllExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getAssetPairs', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getAssetPairs()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get asset pairs')
        }

        const infos: (ExchangeInfo & { pair: string })[] = Object.entries(
          result.result,
        ).map(([pair, pairInfo]) => ({
          pair: this.normalizeSymbol(pair),
          baseAsset: {
            name: this.normalizeSymbol(pairInfo.base || ''),
            minAmount: parseFloat(pairInfo.ordermin || '0'),
            maxAmount: 999999999,
            step: Math.pow(10, -(pairInfo.lot_decimals || 8)),
            maxMarketAmount: 999999999,
          },
          quoteAsset: {
            name: this.normalizeSymbol(pairInfo.quote || ''),
            minAmount: 0,
            precision: pairInfo.pair_decimals,
          },
          maxOrders: 60,
          priceAssetPrecision: pairInfo.pair_decimals || 8,
        }))

        return this.returnGood<(ExchangeInfo & { pair: string })[]>(
          timeProfile,
        )(infos)
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    if (this.usdm) {
      // Kraken Futures has different fee structure, using defaults
      return this.returnGood<UserFee>(timeProfile)({
        maker: 0.0002, // 0.02%
        taker: 0.0005, // 0.05%
      })
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTradingVolume', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTradingVolume({ pair: this.toKrakenSymbol(symbol) })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get trading volume')
        }

        const fees = result.result.fees?.[this.toKrakenSymbol(symbol)]
        const fee: UserFee = {
          maker: fees?.fee ? parseFloat(fees.fee) / 100 : 0.0016,
          taker: fees?.fee ? parseFloat(fees.fee) / 100 : 0.0026,
        }

        return this.returnGood<UserFee>(timeProfile)(fee)
      })
      .catch(
        this.handleKrakenErrors(
          this.getUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (this.usdm) {
      // Return default fees for futures
      const allPairsResult = await this.getAllExchangeInfo(timeProfile)
      if (allPairsResult.status !== StatusEnum.ok) {
        return allPairsResult as any
      }

      const fees: (UserFee & { pair: string })[] = allPairsResult.data.map(
        (info) => ({
          pair: info.pair,
          maker: 0.0002,
          taker: 0.0005,
        }),
      )

      return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(fees)
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getTradingVolume', undefined, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getTradingVolume()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get trading volume')
        }

        const feeData = result.result.fees || {}
        const fees: (UserFee & { pair: string })[] = Object.entries(
          feeData,
        ).map(([pair, fee]) => ({
          pair: this.normalizeSymbol(pair),
          maker: fee?.fee ? parseFloat(fee.fee) / 100 : 0.0016,
          taker: fee?.fee ? parseFloat(fee.fee) / 100 : 0.0026,
        }))

        return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
          fees,
        )
      })
      .catch(
        this.handleKrakenErrors(
          this.getAllUserFees,
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
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const intervalMinutes = intervalMap[interval]

    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getCandles', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getCandles({
          tickType: 'trade',
          symbol,
          resolution: `${intervalMinutes}m` as any,
          from: from ? Math.floor(from / 1000) : undefined,
          to: to ? Math.floor(to / 1000) : undefined,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (!result.candles) {
            throw new Error(
              `Failed to get candles. Candles: ${!!result.candles}`,
            )
          }

          const candles: CandleResponse[] = result.candles.map((candle) => ({
            time: new Date(candle.time).getTime(),
            open: candle.open.toString(),
            high: candle.high.toString(),
            low: candle.low.toString(),
            close: candle.close.toString(),
            volume: candle.volume.toString(),
          }))

          return this.returnGood<CandleResponse[]>(timeProfile)(candles)
        })
        .catch(
          this.handleKrakenErrors(
            this.getCandles,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getCandles', symbol, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getCandles({
        pair: this.toKrakenSymbol(symbol),
        interval: intervalMinutes as
          | 1
          | 5
          | 15
          | 30
          | 60
          | 240
          | 1440
          | 10080
          | 21600,
        since: from ? Math.floor(from / 1000) : undefined,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get candles')
        }

        const krakenPair = Object.keys(result.result)[0]
        const ohlcData = result.result[krakenPair]

        if (!Array.isArray(ohlcData)) {
          throw new Error('Invalid candle data format')
        }

        let candles: CandleResponse[] = ohlcData.map((candle) => ({
          time: candle[0] * 1000,
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[6],
        }))

        // Filter by time range if specified
        if (from) {
          candles = candles.filter((c) => c.time >= from)
        }
        if (to) {
          candles = candles.filter((c) => c.time <= to)
        }

        // Limit count if specified
        if (count && candles.length > count) {
          candles = candles.slice(0, count)
        }

        return this.returnGood<CandleResponse[]>(timeProfile)(candles)
      })
      .catch(
        this.handleKrakenErrors(
          this.getCandles,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getTrades(
    symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<TradeResponse[]>> {
    if (this.usdm) {
      if (!this.derivativesClient) {
        return this.errorClient(timeProfile)
      }

      timeProfile =
        (await this.checkLimits('getTradeHistory', symbol, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')

      return this.derivativesClient
        .getTradeHistory({ symbol })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')

          if (result.result !== 'success' || !result.history) {
            throw new Error(
              `Failed to get trades. Result: ${result.result || 'undefined'}, History: ${!!result.history}`,
            )
          }

          const trades: TradeResponse[] = result.history.map(
            (trade, index) => ({
              aggId: index.toString(),
              symbol,
              price: trade.price?.toString() || '0',
              quantity: trade.size?.toString() || '0',
              firstId: index,
              lastId: index,
              timestamp: new Date(trade.time || 0).getTime(),
            }),
          )

          return this.returnGood<TradeResponse[]>(timeProfile)(trades)
        })
        .catch(
          this.handleKrakenErrors(
            this.getTrades,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    if (!this.spotClient) {
      return this.errorClient(timeProfile)
    }

    timeProfile =
      (await this.checkLimits('getRecentTrades', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.spotClient
      .getRecentTrades({ pair: this.toKrakenSymbol(symbol) })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result.result || result.error?.length) {
          throw new Error(result.error?.[0] || 'Failed to get trades')
        }

        const krakenPair = Object.keys(result.result)[0]
        const tradesData = result.result[krakenPair]

        if (!Array.isArray(tradesData)) {
          throw new Error('Invalid trades data format')
        }

        const trades: TradeResponse[] = tradesData.map((trade, index) => ({
          aggId: index.toString(),
          symbol,
          price: trade[0],
          quantity: trade[1],
          firstId: index,
          lastId: index,
          timestamp: Math.floor(trade[2] * 1000),
        }))

        return this.returnGood<TradeResponse[]>(timeProfile)(trades)
      })
      .catch(
        this.handleKrakenErrors(
          this.getTrades,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Futures-specific methods
  // ===========================

  /**
   * Change leverage for a futures symbol
   *
   * IMPORTANT - Kraken Leverage Handling:
   * Kraken Futures has a unique margin system:
   *
   * 1. ISOLATED MARGIN (with fixed leverage):
   *    - Call setLeverageSettings with maxLeverage parameter
   *    - Example: { symbol: 'PF_XBTUSD', maxLeverage: 10 }
   *    - This sets 10x leverage in isolated mode
   *
   * 2. CROSS MARGIN (dynamic leverage):
   *    - Call setLeverageSettings without maxLeverage (or pass undefined)
   *    - Example: { symbol: 'PF_XBTUSD' }
   *    - In cross margin mode, leverage is DYNAMICALLY calculated based on:
   *      * Your total account balance
   *      * Your position size
   *      * Market conditions
   *    - You cannot "set" a fixed leverage in cross mode
   *    - The system automatically uses maximum available leverage based on account equity
   *
   * 3. Sending Orders:
   *    - submitOrder() does NOT have a leverage parameter
   *    - Leverage must be set BEFORE placing orders using setLeverageSettings
   *    - The order will use whatever leverage/margin mode is currently configured
   *
   * See: https://docs.kraken.com/api/docs/futures-api/trading/set-leverage-setting
   */
  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.usdm || !this.derivativesClient) {
      return this.returnBad(timeProfile)(
        new Error('Leverage change only supported for futures'),
      )
    }

    timeProfile =
      (await this.checkLimits('setLeveragePreference', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .setLeverageSettings({
        symbol,
        maxLeverage: leverage,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success') {
          throw new Error(
            `Failed to set leverage. Result: ${result.result || 'undefined'}, Error: ${result.error || 'none'}`,
          )
        }

        return this.returnGood<number>(timeProfile)(leverage)
      })
      .catch(
        this.handleKrakenErrors(
          this.futures_changeLeverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Change margin type for a futures symbol
   *
   * Kraken handles margin type through the leverage setting:
   * - ISOLATED: Set by calling setLeverageSettings WITH maxLeverage
   * - CROSS: Set by calling setLeverageSettings WITHOUT maxLeverage
   *
   * This method calls setLeverageSettings appropriately based on margin type.
   */
  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (!this.usdm || !this.derivativesClient) {
      return this.returnBad(timeProfile)(
        new Error('Margin type change only supported for futures'),
      )
    }

    timeProfile =
      (await this.checkLimits('setLeverageSettings', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .setLeverageSettings({
        symbol,
        // Pass maxLeverage only for isolated mode
        // For cross margin, omit maxLeverage to enable dynamic leverage
        maxLeverage: margin === MarginType.ISOLATED ? leverage : undefined,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success') {
          throw new Error(
            `Failed to set margin type. Result: ${result.result || 'undefined'}, Error: ${result.error || 'none'}`,
          )
        }

        return this.returnGood<MarginType>(timeProfile)(margin)
      })
      .catch(
        this.handleKrakenErrors(
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
    // Kraken Futures supports hedge mode by default
    return this.returnGood<boolean>(timeProfile)(true)
  }

  async futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    // Kraken Futures hedge mode is always enabled
    return this.returnGood<boolean>(timeProfile)(value)
  }

  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    if (!this.usdm || !this.derivativesClient) {
      return this.returnBad(timeProfile)(
        new Error('Leverage brackets only available for futures'),
      )
    }

    // Kraken Futures doesn't provide a detailed leverage bracket API
    // Return default structure
    const brackets: LeverageBracket[] = [
      {
        symbol: '',
        leverage: 50,
        step: 1,
        min: 0,
      },
    ]

    return this.returnGood<LeverageBracket[]>(timeProfile)(brackets)
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.usdm || !this.derivativesClient) {
      return this.returnBad(timeProfile)(
        new Error('Positions only available for futures'),
      )
    }

    timeProfile =
      (await this.checkLimits('getOpenPositions', symbol, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.derivativesClient
      .getOpenPositions()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.result !== 'success' || !result.openPositions) {
          throw new Error(
            `Failed to get positions. Result: ${result.result || 'undefined'}, OpenPositions: ${!!result.openPositions}`,
          )
        }

        let positions = result.openPositions
        if (symbol) {
          positions = positions.filter((p) => p.symbol === symbol)
        }

        const positionInfos: PositionInfo[] = positions.map((pos) =>
          this.futures_convertPosition({
            symbol: pos.symbol || '',
            side: pos.side,
            size: pos.size,
            price: pos.price,
            unrealizedFunding: pos.unrealizedFunding,
          }),
        )

        return this.returnGood<PositionInfo[]>(timeProfile)(positionInfos)
      })
      .catch(
        this.handleKrakenErrors(
          this.futures_getPositions,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
}

export default KrakenExchange

// Type guard to ensure proper type inference
type OrderSideType = 'BUY' | 'SELL'
