import { AxiosRequestConfig } from 'axios'
import {
  NewFuturesOrderParams,
  RestClientOptions,
  USDMClient as USDMClientCore,
  CoinMClient as CoinMClientCore,
  MainClient as MainClientCore,
  NewSpotOrderParams,
} from 'binance'
import { parseBinanceResponse } from './losslessOrderId'

/**
 * Give the vendor client a response parser that keeps venue order ids exact.
 *
 * axios's default `transformResponse` is a bare `JSON.parse`, which rounds any
 * integer above 2^53 to the nearest double — so a 19-digit USDM order id reached
 * this connector with its low digits already gone, and distinct orders collapsed
 * onto one id (spec `004.binance-order-id-precision-loss.md`).
 *
 * Injecting it here rather than at each `new USDMClient(...)` call site means every
 * client this module exports is covered, including any added later.
 */
function withLosslessOrderIds(
  requestOptions: AxiosRequestConfig = {},
): AxiosRequestConfig {
  // A caller that has already chosen its own parser wins — we only supply the default.
  if (requestOptions.transformResponse) return requestOptions
  return { ...requestOptions, transformResponse: [parseBinanceResponse] }
}

//@ts-expect-error override private method
class USDMClient extends USDMClientCore {
  constructor(
    restClientOptions?: RestClientOptions,
    requestOptions?: AxiosRequestConfig,
  ) {
    super(restClientOptions, withLosslessOrderIds(requestOptions))
  }

  override validateOrderId(
    _params: NewFuturesOrderParams,
    _orderIdProperty: string,
  ): void {
    return
  }
}

//@ts-expect-error override private method
class CoinMClient extends CoinMClientCore {
  constructor(
    restClientOptions?: RestClientOptions,
    requestOptions?: AxiosRequestConfig,
  ) {
    super(restClientOptions, withLosslessOrderIds(requestOptions))
  }

  override validateOrderId(
    _params: NewFuturesOrderParams,
    _orderIdProperty: string,
  ): void {
    return
  }
}

//@ts-expect-error override private method
class MainClient extends MainClientCore {
  constructor(
    restClientOptions?: RestClientOptions,
    requestOptions?: AxiosRequestConfig,
  ) {
    super(restClientOptions, withLosslessOrderIds(requestOptions))
  }

  override validateOrderId(
    _params: NewSpotOrderParams<'LIMIT', 'RESULT'>,
    _orderIdProperty: string,
  ): void {
    return
  }
}

export { USDMClient, CoinMClient, MainClient }
