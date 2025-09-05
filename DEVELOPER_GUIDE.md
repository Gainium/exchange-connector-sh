# Developer Guide - Exchange Connector

This comprehensive guide covers the architecture, implementation details, and advanced usage of the Exchange Connector service based on the actual codebase.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [Exchange Implementation](#exchange-implementation)
- [API Design Patterns](#api-design-patterns)
- [Utility Systems](#utility-systems)
- [Advanced Features](#advanced-features)
- [Debugging and Monitoring](#debugging-and-monitoring)
- [API Reference](#api-reference)

## Architecture Overview

The Exchange Connector is built as a NestJS microservice that provides a unified API for interacting with multiple cryptocurrency exchanges while maintaining consistent interfaces and error handling patterns.

### Core Architecture

```
┌─────────────────────────────────────────┐
│            REST API Layer               │
│         (exchange.controller.ts)        │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│          Service Layer                  │
│        (exchange.service.ts)            │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│        Abstract Exchange                │
│      (abstractExchange.ts)              │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│       Exchange Implementations          │
│  ┌─────────┐ ┌─────────┐ ┌─────────────┐│
│  │ Binance │ │ Bybit   │ │   KuCoin    ││
│  │ Bitget  │ │ OKX     │ │  Coinbase   ││
│  └─────────┘ └─────────┘ └─────────────┘│
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│          Utility Layer                  │
│  • Rate Limiting  • Cryptography       │
│  • Math Helpers   • Redis Caching      │
│  • Mutex/Locking  • Monitoring         │
└─────────────────────────────────────────┘
```

### Key Components

1. **NestJS Framework** - Provides dependency injection, decorators, and HTTP handling
2. **Abstract Exchange** - Defines the unified interface all exchanges must implement
3. **Exchange Implementations** - Specific integrations for each supported exchange
4. **Utility Layer** - Shared functionality for rate limiting, caching, and monitoring
5. **Type System** - Comprehensive TypeScript definitions for all exchange operations

## Core Concepts

### Abstract Exchange Pattern

All exchanges inherit from the `AbstractExchange` base class and implement the `Exchange` interface:

```typescript
export interface Exchange {
  // Balance Management
  getBalance(): Promise<BaseReturn<FreeAsset>>
  
  // Order Management
  openOrder(order: OrderRequest): Promise<BaseReturn<CommonOrder>>
  getOrder(params: OrderQuery): Promise<BaseReturn<CommonOrder>>
  cancelOrder(params: CancelOrderRequest): Promise<BaseReturn<CommonOrder>>
  getAllOrders(params: OrderHistoryRequest): Promise<BaseReturn<CommonOrder[]>>
  
  // Market Data
  getLatestPrice(symbol: string): Promise<BaseReturn<number>>
  getAllPrices(): Promise<BaseReturn<AllPricesResponse>>
  getCandles(params: CandleRequest): Promise<BaseReturn<CandleResponse[]>>
  
  // Exchange Information
  getExchangeInfo(): Promise<BaseReturn<ExchangeInfo>>
  getUserFees(symbol?: string): Promise<BaseReturn<UserFee>>
  
  // Advanced Features
  getTrades(params: TradeRequest): Promise<BaseReturn<TradeResponse[]>>
  getPositions(): Promise<BaseReturn<PositionInfo[]>>
  getRebateRecords(params: RebateRequest): Promise<BaseReturn<RebateRecord[]>>
}
```

### Standardized Return Pattern

All exchange methods use a standardized return pattern:

```typescript
// Success Response
interface ReturnGood<T> {
  status: StatusEnum.success
  data: T
  timeProfile: TimeProfile
  usage: ExchangeLimitUsage
}

// Error Response
interface ReturnBad {
  status: StatusEnum.error
  error: string
  timeProfile: TimeProfile
  usage: ExchangeLimitUsage
}

type BaseReturn<T> = ReturnGood<T> | ReturnBad
```

### Time Profiling and Rate Limiting

Every exchange operation tracks execution time and rate limit usage:

```typescript
abstract class AbstractExchange {
  protected startTimeProfile(): TimeProfile {
    return { start: Date.now() }
  }
  
  protected returnGood<T>(
    timeProfile: TimeProfile,
    usage: ExchangeLimitUsage
  ): (result: T) => ReturnGood<T> {
    return (result: T) => ({
      status: StatusEnum.success,
      data: result,
      timeProfile: { ...timeProfile, end: Date.now() },
      usage
    })
  }
  
  protected returnBad(
    timeProfile: TimeProfile,
    usage: ExchangeLimitUsage
  ): (error: Error) => ReturnBad {
    return (error: Error) => ({
      status: StatusEnum.error,
      error: error.message,
      timeProfile: { ...timeProfile, end: Date.now() },
      usage
    })
  }
}
```

## Exchange Implementation

### Binance Implementation Example

The Binance exchange implementation shows the complete pattern:

```typescript
class BinanceExchange extends AbstractExchange implements Exchange {
  private client: BinanceType
  
  constructor() {
    super('Binance')
    this.client = Binance({
      apiKey: process.env.BINANCE_API_KEY,
      apiSecret: process.env.BINANCE_API_SECRET,
      // ... other config
    })
  }
  
  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    const timeProfile = this.startTimeProfile()
    const usage = limitHelper.getUsage('account')
    
    try {
      const accountInfo = await this.client.accountInfo()
      const assets = accountInfo.balances
        .filter(balance => parseFloat(balance.free) > 0)
        .map(balance => ({
          asset: balance.asset,
          free: parseFloat(balance.free),
          locked: parseFloat(balance.locked)
        }))
      
      return this.returnGood(timeProfile, usage)({ assets })
    } catch (error) {
      return this.returnBad(timeProfile, usage)(error as Error)
    }
  }
  
  async openOrder(order: OrderRequest): Promise<BaseReturn<CommonOrder>> {
    const timeProfile = this.startTimeProfile()
    const usage = limitHelper.getUsage('order')
    
    try {
      // Validate order parameters
      await this.validateOrder(order)
      
      // Create exchange-specific order format
      const binanceOrder: NewOrderSpot = {
        symbol: order.symbol,
        side: this.mapSide(order.side),
        type: this.mapOrderType(order.type),
        quantity: convertNumberToString(order.quantity),
        price: convertNumberToString(order.price),
        newClientOrderId: order.newClientOrderId,
        // ... other parameters
      }
      
      const result = await this.client.order(binanceOrder)
      const commonOrder = this.mapToCommonOrder(result)
      
      return this.returnGood(timeProfile, usage)(commonOrder)
    } catch (error) {
      return this.returnBad(timeProfile, usage)(error as Error)
    }
  }
  
  // Helper methods for data mapping
  private mapSide(side: OrderTypes): 'BUY' | 'SELL' {
    return side === OrderTypes.buy ? 'BUY' : 'SELL'
  }
  
  private mapToCommonOrder(binanceOrder: Order): CommonOrder {
    return {
      orderId: binanceOrder.orderId.toString(),
      clientOrderId: binanceOrder.clientOrderId,
      symbol: binanceOrder.symbol,
      side: binanceOrder.side === 'BUY' ? OrderTypes.buy : OrderTypes.sell,
      type: this.mapOrderTypeFromBinance(binanceOrder.type),
      quantity: parseFloat(binanceOrder.origQty),
      price: parseFloat(binanceOrder.price),
      executedQty: parseFloat(binanceOrder.executedQty),
      status: this.mapOrderStatus(binanceOrder.status),
      transactTime: binanceOrder.transactTime
    }
  }
}
```

### Rate Limiting Implementation

Each exchange implements specific rate limiting:

```typescript
// binance/limit.ts
const limitHelper = {
  getUsage(endpoint: string): ExchangeLimitUsage {
    const limits: Record<string, ExchangeLimitUsage> = {
      'account': {
        weight: 10,
        type: 'REQUEST_WEIGHT',
        intervalNum: 60,
        interval: 'SECOND',
        count: 1200
      },
      'order': {
        weight: 1,
        type: 'ORDERS',
        intervalNum: 10,
        interval: 'SECOND',
        count: 100
      },
      'ticker': {
        weight: 1,
        type: 'REQUEST_WEIGHT',
        intervalNum: 60,
        interval: 'SECOND',
        count: 1200
      }
      // ... more endpoints
    }
    
    return limits[endpoint] || {
      weight: 1,
      type: 'REQUEST_WEIGHT',
      intervalNum: 60,
      interval: 'SECOND',
      count: 1200
    }
  }
}

export default limitHelper
```

## API Design Patterns

### Controller Layer

The NestJS controller provides RESTful endpoints:

```typescript
@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchangeService: ExchangeService) {}
  
  @Get(':exchange/balance')
  async getBalance(@Param('exchange') exchange: string) {
    return this.exchangeService.getBalance(exchange)
  }
  
  @Post(':exchange/order')
  async createOrder(
    @Param('exchange') exchange: string,
    @Body() orderData: CreateOrderDto
  ) {
    return this.exchangeService.openOrder(exchange, orderData)
  }
  
  @Get(':exchange/order/:orderId')
  async getOrder(
    @Param('exchange') exchange: string,
    @Param('orderId') orderId: string,
    @Query() query: GetOrderDto
  ) {
    return this.exchangeService.getOrder(exchange, {
      orderId,
      ...query
    })
  }
}
```

### Service Layer

The service layer handles exchange instantiation and method delegation:

```typescript
@Injectable()
export class ExchangeService {
  private readonly exchanges = new Map<string, Exchange>()
  
  private getExchange(exchangeName: string): Exchange {
    const normalizedName = exchangeName.toLowerCase()
    
    if (!this.exchanges.has(normalizedName)) {
      const exchange = this.createExchange(normalizedName)
      this.exchanges.set(normalizedName, exchange)
    }
    
    return this.exchanges.get(normalizedName)!
  }
  
  private createExchange(exchangeName: string): Exchange {
    switch (exchangeName) {
      case 'binance':
        return new BinanceExchange()
      case 'bybit':
        return new BybitExchange()
      case 'bitget':
        return new BitgetExchange()
      case 'kucoin':
        return new KucoinExchange()
      case 'okx':
        return new OkxExchange()
      case 'coinbase':
        return new CoinbaseExchange()
      default:
        throw new Error(`Unsupported exchange: ${exchangeName}`)
    }
  }
  
  async getBalance(exchangeName: string): Promise<BaseReturn<FreeAsset>> {
    const exchange = this.getExchange(exchangeName)
    return exchange.getBalance()
  }
  
  async openOrder(exchangeName: string, order: OrderRequest): Promise<BaseReturn<CommonOrder>> {
    const exchange = this.getExchange(exchangeName)
    return exchange.openOrder(order)
  }
}
```

## Utility Systems

### Mathematical Utilities

Precise number handling for financial operations:

```typescript
// utils/math.ts
export function convertNumberToString(num: number, precision?: number): string {
  if (precision !== undefined) {
    return num.toFixed(precision)
  }
  
  // Handle scientific notation
  if (num.toString().includes('e')) {
    return num.toFixed(20).replace(/\.?0+$/, '')
  }
  
  return num.toString()
}

export function roundToPrecision(num: number, precision: number): number {
  const factor = Math.pow(10, precision)
  return Math.round(num * factor) / factor
}

export function calculatePercentage(value: number, total: number): number {
  if (total === 0) return 0
  return (value / total) * 100
}
```

### Cryptographic Utilities

Secure signature generation for exchange APIs:

```typescript
// utils/crypto.ts
import CryptoJS from 'crypto-js'

export function createHmacSha256(message: string, secret: string): string {
  return CryptoJS.HmacSHA256(message, secret).toString()
}

export function createSignature(
  method: string,
  path: string,
  queryString: string,
  body: string,
  secret: string,
  timestamp?: string
): string {
  const message = `${timestamp || Date.now()}${method}${path}${queryString}${body}`
  return createHmacSha256(message, secret)
}

export function encodeBase64(str: string): string {
  return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(str))
}
```

### Mutex and Concurrency Control

Handle concurrent operations safely:

```typescript
// utils/mutex.ts
export class Mutex {
  private locks = new Map<string, Promise<void>>()
  
  async acquire(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key)
    }
    
    let release: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    
    this.locks.set(key, promise)
    
    return () => {
      this.locks.delete(key)
      release()
    }
  }
  
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key)
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

// Usage in exchange implementations
const mutex = new Mutex()

async function criticalOperation(symbol: string) {
  return mutex.withLock(`order-${symbol}`, async () => {
    // Perform critical operation
  })
}
```

## Advanced Features

### Multi-Exchange Portfolio Management

Handle operations across multiple exchanges:

```typescript
class PortfolioService {
  constructor(private exchangeService: ExchangeService) {}
  
  async getAggregatedBalance(exchanges: string[]): Promise<AggregatedBalance> {
    const balances = await Promise.all(
      exchanges.map(exchange => 
        this.exchangeService.getBalance(exchange)
      )
    )
    
    return this.aggregateBalances(balances)
  }
  
  async executeArbitrageOrder(
    buyExchange: string,
    sellExchange: string,
    symbol: string,
    quantity: number
  ): Promise<ArbitrageResult> {
    const [buyResult, sellResult] = await Promise.all([
      this.exchangeService.openOrder(buyExchange, {
        symbol,
        side: OrderTypes.buy,
        quantity,
        type: OrderTypeT.MARKET
      }),
      this.exchangeService.openOrder(sellExchange, {
        symbol,
        side: OrderTypes.sell,
        quantity,
        type: OrderTypeT.MARKET
      })
    ])
    
    return { buyResult, sellResult }
  }
}
```

### Real-time Price Monitoring

Monitor price changes across exchanges:

```typescript
class PriceMonitor {
  private priceCache = new Map<string, Map<string, number>>()
  private subscribers = new Map<string, Set<(price: number) => void>>()
  
  async startMonitoring(exchanges: string[], symbols: string[]) {
    setInterval(async () => {
      for (const exchange of exchanges) {
        for (const symbol of symbols) {
          try {
            const result = await this.exchangeService.getLatestPrice(exchange, symbol)
            
            if (result.status === StatusEnum.success) {
              this.updatePrice(exchange, symbol, result.data)
            }
          } catch (error) {
            console.error(`Price update failed for ${exchange}:${symbol}`, error)
          }
        }
      }
    }, 1000)
  }
  
  private updatePrice(exchange: string, symbol: string, price: number) {
    const key = `${exchange}:${symbol}`
    
    if (!this.priceCache.has(exchange)) {
      this.priceCache.set(exchange, new Map())
    }
    
    this.priceCache.get(exchange)!.set(symbol, price)
    
    // Notify subscribers
    this.subscribers.get(key)?.forEach(callback => callback(price))
  }
  
  subscribe(exchange: string, symbol: string, callback: (price: number) => void) {
    const key = `${exchange}:${symbol}`
    
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set())
    }
    
    this.subscribers.get(key)!.add(callback)
  }
}
```

## Debugging and Monitoring

### Logging and Observability

Implement comprehensive logging:

```typescript
import { Logger } from '@nestjs/common'

class ExchangeLogger {
  private logger = new Logger('ExchangeConnector')
  
  logRequest(exchange: string, method: string, params: any) {
    this.logger.log(
      `${exchange}.${method} - Request: ${JSON.stringify(params)}`
    )
  }
  
  logResponse(exchange: string, method: string, response: BaseReturn<any>) {
    if (response.status === StatusEnum.success) {
      this.logger.log(
        `${exchange}.${method} - Success: ${response.timeProfile.end - response.timeProfile.start}ms`
      )
    } else {
      this.logger.error(
        `${exchange}.${method} - Error: ${response.error}`
      )
    }
  }
  
  logRateLimit(exchange: string, endpoint: string, usage: ExchangeLimitUsage) {
    this.logger.warn(
      `${exchange} - Rate limit usage: ${usage.weight}/${usage.count} ${usage.type}`
    )
  }
}
```

### Health Checks

Monitor exchange connectivity:

```typescript
@Injectable()
export class HealthService {
  constructor(private exchangeService: ExchangeService) {}
  
  async checkExchangeHealth(exchange: string): Promise<HealthStatus> {
    try {
      const start = Date.now()
      const result = await this.exchangeService.getExchangeInfo(exchange)
      const latency = Date.now() - start
      
      return {
        exchange,
        status: result.status === StatusEnum.success ? 'healthy' : 'unhealthy',
        latency,
        lastChecked: new Date().toISOString(),
        error: result.status === StatusEnum.error ? result.error : undefined
      }
    } catch (error) {
      return {
        exchange,
        status: 'unhealthy',
        latency: -1,
        lastChecked: new Date().toISOString(),
        error: error.message
      }
    }
  }
  
  async checkAllExchanges(): Promise<HealthStatus[]> {
    const exchanges = ['binance', 'bybit', 'bitget', 'kucoin', 'okx', 'coinbase']
    
    return Promise.all(
      exchanges.map(exchange => this.checkExchangeHealth(exchange))
    )
  }
}
```

## API Reference

### Core Data Types

#### Order Types

```typescript
interface OrderRequest {
  symbol: string
  side: OrderTypes
  quantity: number
  price?: number
  type?: OrderTypeT
  newClientOrderId?: string
  reduceOnly?: boolean
  positionSide?: PositionSide
  marginType?: MarginType
  leverage?: number
}

interface CommonOrder {
  orderId: string
  clientOrderId?: string
  symbol: string
  side: OrderTypes
  type: OrderTypeT
  quantity: number
  price: number
  executedQty: number
  status: OrderStatusType
  transactTime: number
}

enum OrderTypes {
  buy = 'buy',
  sell = 'sell'
}

enum OrderTypeT {
  LIMIT = 'LIMIT',
  MARKET = 'MARKET',
  STOP_LOSS = 'STOP_LOSS',
  STOP_LOSS_LIMIT = 'STOP_LOSS_LIMIT',
  TAKE_PROFIT = 'TAKE_PROFIT',
  TAKE_PROFIT_LIMIT = 'TAKE_PROFIT_LIMIT'
}
```

#### Balance Types

```typescript
interface FreeAsset {
  assets: Asset[]
}

interface Asset {
  asset: string
  free: number
  locked: number
}
```

#### Market Data Types

```typescript
interface AllPricesResponse {
  [symbol: string]: number
}

interface CandleResponse {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime: number
  quoteAssetVolume: number
  numberOfTrades: number
  takerBuyBaseAssetVolume: number
  takerBuyQuoteAssetVolume: number
}

enum ExchangeIntervals {
  '1m' = '1m',
  '3m' = '3m',
  '5m' = '5m',
  '15m' = '15m',
  '30m' = '30m',
  '1h' = '1h',
  '2h' = '2h',
  '4h' = '4h',
  '6h' = '6h',
  '8h' = '8h',
  '12h' = '12h',
  '1d' = '1d',
  '3d' = '3d',
  '1w' = '1w',
  '1M' = '1M'
}
```

### REST API Endpoints

#### Balance Endpoints

```
GET /exchange/{exchange}/balance
```

#### Order Endpoints

```
POST /exchange/{exchange}/order
GET /exchange/{exchange}/order/{orderId}
DELETE /exchange/{exchange}/order/{orderId}
GET /exchange/{exchange}/orders
```

#### Market Data Endpoints

```
GET /exchange/{exchange}/price/{symbol}
GET /exchange/{exchange}/prices
GET /exchange/{exchange}/candles/{symbol}
GET /exchange/{exchange}/info
```

This developer guide provides comprehensive coverage of the Exchange Connector's architecture and implementation patterns. For specific exchange implementations, refer to the individual exchange directories and their respective test files.