import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeEnum,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  UserFee,
  MarginType,
  TradeTypeEnum,
  LeverageBracket,
  PositionInfo,
  TradeResponse,
  Futures,
  CoinbaseKeysType,
  VerifyResponse,
  RebateRecord,
  RebateOverview,
  OKXSource,
  BybitHost,
} from './types'
import AbstractExchange from './abstractExchange'
import ExchangeChooser from './helpers/exchangeChooser'
import {
  AuthData,
  CreateOrderDto,
  ChangeLeverageDto,
  ChangeMarginDto,
} from './exchange.controller'
import verifiers from './helpers/verify'
import { getCandles, getPrices } from './helpers/additionalApis'
import { HttpException } from '@nestjs/common'
import kucoinMethods from './exchanges/kucoin/api'
import Bybit from './exchanges/bybit'

export class ExchangeService {
  async getLatestPriceInExchange(
    exchange: ExchangeEnum,
    symbol: string,
  ): Promise<BaseReturn<number>> {
    return this.getExchange(exchange).latestPrice(symbol)
  }

  async getAllPrices(
    exchange: ExchangeEnum,
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    return this.getExchange(exchange).getAllPrices()
  }

  async getExchangeInfo(
    symbol: string,
    exchange: ExchangeEnum,
  ): Promise<BaseReturn<ExchangeInfo>> {
    return this.getExchange(exchange).getExchangeInfo(symbol)
  }

  async getAllExchangeInfo(
    exchange: ExchangeEnum,
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    return this.getExchange(exchange).getAllExchangeInfo()
  }

  getCandles(
    exchange: ExchangeEnum,
    interval: ExchangeIntervals,
    symbol: string,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>> {
    return this.getExchange(exchange).getCandles(
      symbol,
      interval,
      from,
      to,
      count,
    )
  }

  getTrades(
    exchange: ExchangeEnum,
    symbol: string,
    fromId?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.getExchange(exchange).getTrades(
      symbol,
      fromId,
      startTime,
      endTime,
    )
  }

  cancelOrder(
    body: {
      symbol: string
      newClientOrderId: string
    },
    auth: AuthData,
  ): Promise<BaseReturn<CommonOrder>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).cancelOrder(body)
  }

  getOrder(
    data: { symbol: string; newClientOrderId: string },
    auth: AuthData,
  ): Promise<BaseReturn<CommonOrder>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getOrder({ symbol: data.symbol, newClientOrderId: data.newClientOrderId })
  }

  getAllOpenOrders(
    data: { symbol?: string; returnOrders: boolean },
    auth: AuthData,
  ): Promise<BaseReturn<CommonOrder[] | number>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getAllOpenOrders(data.symbol, data.returnOrders)
  }

  createOrder(
    body: CreateOrderDto,
    auth: AuthData,
  ): Promise<BaseReturn<CommonOrder>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).openOrder(body)
  }

  getAllUserFees(
    auth: AuthData,
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getAllUserFees()
  }

  getUserFees(symbol: string, auth: AuthData): Promise<BaseReturn<UserFee>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getUserFees(symbol)
  }

  getUserBalance(auth: AuthData): Promise<BaseReturn<FreeAsset>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getBalance()
  }

  verifyUser(
    tradeType: TradeTypeEnum,
    auth: AuthData,
  ): Promise<VerifyResponse> {
    return verifiers.verifyExchange(
      tradeType,
      auth.exchange,
      auth.key ?? '',
      auth.secret ?? '',
      auth.passphrase ?? '',
      auth.keystype,
      auth.okxsource,
      auth.bybithost,
    )
  }

  async accountType(auth: AuthData): Promise<{ type: number }> {
    const key = auth.key ?? ''
    const secret = auth.secret ?? ''
    const bybit = new Bybit(Futures.null, key, secret)
    return { type: await bybit.getAccountType().then((res) => res.data ?? 1) }
  }

  protected getExchange(
    exchange: ExchangeEnum,
    key?: string,
    secret?: string,
    passphrase?: string,
    keysType?: CoinbaseKeysType,
    okxSource?: OKXSource,
    code?: string,
    bybitHost?: BybitHost,
  ): AbstractExchange {
    const factory = ExchangeChooser.chooseExchangeFactory(exchange)
    if (!factory) {
      throw new HttpException(`Exchange is not supported`, 200)
    }
    return factory(
      key,
      secret,
      passphrase,
      undefined,
      keysType,
      okxSource,
      code,
      bybitHost,
    )
  }

  async getDatafeedPrices(exchange: ExchangeEnum) {
    return getPrices(exchange).catch((e: Error) => {
      throw new HttpException(e.message, 400)
    })
  }

  getDatafeedCandles(
    exchange: ExchangeEnum,
    symbol: string,
    type: string,
    startAt: number,
    endAt: number,
  ) {
    return getCandles(exchange, { symbol, type, startAt, endAt }).catch(
      (e: Error) => {
        throw new HttpException(e.message, 400)
      },
    )
  }

  async getKucoinWS() {
    return kucoinMethods.getWSKucoin()
  }

  async getUsage(exchange: ExchangeEnum) {
    return this.getExchange(exchange).getUsage()
  }

  async futures_changeLeverage(
    data: ChangeLeverageDto,
    auth: AuthData,
  ): Promise<BaseReturn<number>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_changeLeverage(data.symbol, data.leverage)
  }

  async futures_setHedge(
    data: { value: boolean },
    auth: AuthData,
  ): Promise<BaseReturn<boolean>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_setHedge(data.value)
  }

  async futures_getHedge(
    data: { symbol?: string },
    auth: AuthData,
  ): Promise<BaseReturn<boolean>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_getHedge(data.symbol)
  }

  async futures_changeMarginType(
    data: ChangeMarginDto,
    auth: AuthData,
  ): Promise<BaseReturn<MarginType>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_changeMarginType(data.symbol, data.margin, data.leverage)
  }

  async futures_leverageBracket(
    auth: AuthData,
  ): Promise<BaseReturn<LeverageBracket[]>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_leverageBracket()
  }

  async futures_getPositions(
    body: { symbol?: string },
    auth: AuthData,
  ): Promise<BaseReturn<PositionInfo[]>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).futures_getPositions(body.symbol)
  }

  async getUid(auth: AuthData): Promise<BaseReturn<string | number>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getUid()
  }

  async getAffiliate(
    uid: string | number,
    auth: AuthData,
  ): Promise<BaseReturn<boolean>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getAffiliate(uid)
  }

  async getRebateRecords(
    auth: AuthData,
    timestamp: number,
    startTime?: number,
    endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getRebateRecords(timestamp, startTime, endTime)
  }

  async getRebateOverview(
    auth: AuthData,
    timestamp: number,
  ): Promise<BaseReturn<RebateOverview>> {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).getRebateOverview(timestamp)
  }

  async cancelOrderByOrderId(
    body: { symbol: string; orderId: string },
    auth: AuthData,
  ) {
    return this.getExchange(
      auth.exchange,
      auth.key,
      auth.secret,
      auth.passphrase,
      auth.keystype,
      auth.okxsource,
      auth.code,
      auth.bybithost,
    ).cancelOrderByOrderIdAndSymbol(body)
  }
}
