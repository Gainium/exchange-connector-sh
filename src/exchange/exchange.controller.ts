import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Post,
  Query,
} from '@nestjs/common'
import {
  ExchangeEnum,
  ExchangeIntervals,
  OrderTypes,
  OrderTypeT,
  MarginType,
  TradeTypeEnum,
  CoinbaseKeysType,
  OKXSource,
  BybitHost,
} from './types'
import { ExchangeService } from './exchange.service'

export type AuthData = {
  key: string
  secret: string
  passphrase?: string
  exchange: ExchangeEnum
  keystype?: CoinbaseKeysType
  okxsource?: OKXSource
  code?: string
  bybithost?: BybitHost
}

export type CreateOrderDto = {
  symbol: string
  side: OrderTypes
  quantity: number
  price: number
  newClientOrderId?: string
  type?: OrderTypeT
  reduceOnly?: boolean
  marginType?: MarginType
  leverage?: number
}

export type ChangeLeverageDto = { symbol: string; leverage: number }

export type ChangeMarginDto = {
  symbol: string
  margin: MarginType
  leverage: number
}

@Controller()
export class ExchangeController {
  constructor(
    @Inject(ExchangeService) protected exchangeService: ExchangeService,
  ) {}

  @Get('/latestPrice')
  async getLatestPrice(
    @Query('symbol') symbol: string,
    @Query('exchange') exchange: ExchangeEnum,
  ) {
    return this.exchangeService.getLatestPriceInExchange(exchange, symbol)
  }

  @Get('/exchange')
  async getExchangeInfo(
    @Query('symbol') symbol: string,
    @Query('exchange') exchange: ExchangeEnum,
  ) {
    return this.exchangeService.getExchangeInfo(symbol, exchange)
  }

  @Get('/exchange/all')
  async getAllExchangeInfo(@Query('exchange') exchange: ExchangeEnum) {
    return this.exchangeService.getAllExchangeInfo(exchange)
  }

  @Get('/candles')
  async getCandles(
    @Query('exchange') exchange: ExchangeEnum,
    @Query('interval') interval: ExchangeIntervals,
    @Query('symbol') symbol: ExchangeIntervals,
    @Query('from') from: number = null,
    @Query('to') to: number = null,
    @Query('count') count: number = null,
  ) {
    return this.exchangeService.getCandles(
      exchange,
      interval,
      symbol,
      from,
      to,
      count,
    )
  }

  @Get('/trades')
  async getTrades(
    @Query('exchange') exchange: ExchangeEnum,
    @Query('symbol') symbol: ExchangeIntervals,
    @Query('fromId') fromId: number = null,
    @Query('startTime') startTime: number = null,
    @Query('endTime') endTime: number = null,
  ) {
    return this.exchangeService.getTrades(
      exchange,
      symbol,
      fromId,
      startTime,
      endTime,
    )
  }

  @Get('/prices')
  async getAllPrices(@Query('exchange') exchange: ExchangeEnum) {
    return this.exchangeService.getAllPrices(exchange)
  }

  @Post('/order')
  async createOrder(
    @Body() body: CreateOrderDto,
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.createOrder(body, headers)
  }

  @Get('/order')
  async getOrder(
    @Query('newClientOrderId') newClientOrderId: string,
    @Query('symbol') symbol: string,
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.getOrder({ newClientOrderId, symbol }, headers)
  }

  @Get('/open/all')
  async getAllOpenOrders(
    @Headers() headers: AuthData,
    @Query('symbol') symbol?: string,
    @Query('returnOrders') returnOrders = false,
  ) {
    return this.exchangeService.getAllOpenOrders(
      { symbol, returnOrders },
      headers,
    )
  }

  @Delete('/order')
  async cancelOrder(
    @Body()
    body: {
      newClientOrderId: string
      symbol: string
    },
    @Headers() headers: AuthData,
  ) {
    return await this.exchangeService.cancelOrder(body, headers)
  }

  @Get('/fees/all')
  async getAllUserFees(@Headers() headers: AuthData) {
    return this.exchangeService.getAllUserFees(headers)
  }

  @Get('/fees')
  async getUserFees(
    @Query('symbol') symbol: string,
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.getUserFees(symbol, headers)
  }

  @Get('/balance')
  async getUserBalance(@Headers() headers: AuthData) {
    return this.exchangeService.getUserBalance(headers)
  }

  @Get('/accountType')
  async accountType(@Headers() headers: AuthData) {
    const result = await this.exchangeService.accountType(headers)
    return result
  }

  @Get('/verify')
  async verifyUser(
    @Headers() headers: AuthData,
    @Query('tradeType') tradeType?: TradeTypeEnum,
  ) {
    return this.exchangeService.verifyUser(tradeType, headers)
  }

  @Get('datafeed/prices')
  async getDatafeedPrices(@Query('exchange') exchange: ExchangeEnum) {
    return this.exchangeService.getDatafeedPrices(exchange)
  }

  @Get('datafeed/candles')
  async getDatafeedCandles(
    @Query('exchange') exchange: ExchangeEnum,
    @Query('symbol') symbol: string,
    @Query('type') type: string,
    @Query('startAt') startAt: number,
    @Query('endAt') endAt: number,
  ) {
    return this.exchangeService.getDatafeedCandles(
      exchange,
      symbol,
      type,
      startAt,
      endAt,
    )
  }

  @Get('kucoin/ws')
  async getKucoinWS() {
    return this.exchangeService.getKucoinWS()
  }

  @Get('usage')
  async getUsage(@Query('exchange') exchange: ExchangeEnum) {
    return this.exchangeService.getUsage(exchange)
  }

  @Post('/leverage')
  async changeLeverage(
    @Body() body: ChangeLeverageDto,
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.futures_changeLeverage(body, headers)
  }

  @Post('/hedge')
  async changeHedge(
    @Body() body: { value: boolean },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.futures_setHedge(body, headers)
  }

  @Get('/hedge')
  async getHedge(
    @Body() body: { symbol?: string },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.futures_getHedge(body, headers)
  }

  @Get('/leverageBracket')
  async getLeverageBracket(@Headers() headers: AuthData) {
    return this.exchangeService.futures_leverageBracket(headers)
  }

  @Post('/margin')
  async changeMargin(
    @Body() body: ChangeMarginDto,
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.futures_changeMarginType(body, headers)
  }

  @Get('/positions')
  async getPositions(
    @Body() body: { symbol?: string },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.futures_getPositions(body, headers)
  }

  @Get('/uid')
  async getUid(@Headers() headers: AuthData) {
    return this.exchangeService.getUid(headers)
  }

  @Get('/affiliate')
  async getAffiliate(
    @Body() body: { uid: string | number },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.getAffiliate(body.uid, headers)
  }

  @Get('/rebateRecords')
  async getRebateRecords(
    @Headers() headers: AuthData,
    @Body() body: { timestamp: number; startTime?: number; endTime?: number },
  ) {
    return this.exchangeService.getRebateRecords(
      headers,
      body.timestamp,
      body.startTime,
      body.endTime,
    )
  }

  @Get('/rebateOverview')
  async getRebateOverview(
    @Body() body: { timestamp: number; startTime?: number; endTime?: number },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.getRebateOverview(headers, body.timestamp)
  }

  @Delete('/orders/byId')
  async cancelOrderByOrderId(
    @Body() body: { symbol: string; orderId: string },
    @Headers() headers: AuthData,
  ) {
    return this.exchangeService.cancelOrderByOrderId(body, headers)
  }
}
