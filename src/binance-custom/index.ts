import {
  NewFuturesOrderParams,
  USDMClient as USDMClientCore,
  CoinMClient as CoinMClientCore,
  MainClient as MainClientCore,
  NewSpotOrderParams,
} from 'binance'

//@ts-expect-error override private method
class USDMClient extends USDMClientCore {
  override validateOrderId(
    _params: NewFuturesOrderParams,
    _orderIdProperty: string,
  ): void {
    return
  }
}

//@ts-expect-error override private method
class CoinMClient extends CoinMClientCore {
  override validateOrderId(
    _params: NewFuturesOrderParams,
    _orderIdProperty: string,
  ): void {
    return
  }
}

//@ts-expect-error override private method
class MainClient extends MainClientCore {
  override validateOrderId(
    _params: NewSpotOrderParams<'LIMIT', 'RESULT'>,
    _orderIdProperty: string,
  ): void {
    return
  }
}

export { USDMClient, CoinMClient, MainClient }
