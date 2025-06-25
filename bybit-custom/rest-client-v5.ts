import {
  APIResponseV3WithTime,
  OrderParamsV5,
  OrderResultV5,
  REST_CLIENT_TYPE_ENUM,
} from 'bybit-api'
import BaseRestClient from './BaseRestClient'

/**
 * REST API client for V5 REST APIs
 *
 * https://bybit-exchange.github.io/docs/v5/intro
 */
export class RestClientV5 extends BaseRestClient {
  getClientType() {
    return REST_CLIENT_TYPE_ENUM.v3
  }

  async fetchServerTime(): Promise<number> {
    const res = await this.getServerTime()
    return Number(res.time) / 1000
  }

  getServerTime(): Promise<
    APIResponseV3WithTime<{ timeSecond: string; timeNano: string }>
  > {
    return this.get('/v3/public/time')
  }
  /**
   *
   ****** Trade APIs
   *
   */

  submitOrder(
    params: OrderParamsV5,
  ): Promise<APIResponseV3WithTime<OrderResultV5>> {
    return this.postPrivate('/v5/order/create', params)
  }
}
