import BinanceExchange from '../exchanges/binance'
import KucoinExchange from '../exchanges/kucoin'
import BybitExchange from '../exchanges/bybit'
import OKXExchange from '../exchanges/okx'
import BitgetExchange from '../exchanges/bitget'
import CoinbaseExchange from '../exchanges/coinbase'
import HyperliquidExchange from '../exchanges/hyperliquid'
import { ExchangeDomain, ExchangeEnum, Futures } from '../types'
import { createExchangeFactory } from './createExchangeFactoryUtils'

class ExchangeChooser {
  static chooseExchangeFactory(exchange: ExchangeEnum) {
    if (exchange === ExchangeEnum.binance) {
      return createExchangeFactory(
        BinanceExchange,
        ...[ExchangeDomain.com, Futures.null],
      )
    }
    if (exchange === ExchangeEnum.binanceCoinm) {
      return createExchangeFactory(
        BinanceExchange,
        ...[ExchangeDomain.com, Futures.coinm],
      )
    }
    if (exchange === ExchangeEnum.binanceUsdm) {
      return createExchangeFactory(
        BinanceExchange,
        ...[ExchangeDomain.com, Futures.usdm],
      )
    }
    if (exchange === ExchangeEnum.binanceUS) {
      return createExchangeFactory(
        BinanceExchange,
        ...[ExchangeDomain.us, Futures.null],
      )
    }
    if (exchange === ExchangeEnum.kucoin) {
      return createExchangeFactory(KucoinExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.kucoinLinear) {
      return createExchangeFactory(KucoinExchange, ...[Futures.usdm])
    }
    if (exchange === ExchangeEnum.kucoinInverse) {
      return createExchangeFactory(KucoinExchange, ...[Futures.coinm])
    }
    if (exchange === ExchangeEnum.bybit) {
      return createExchangeFactory(BybitExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.bybitUsdm) {
      return createExchangeFactory(BybitExchange, ...[Futures.usdm])
    }
    if (exchange === ExchangeEnum.bybitCoinm) {
      return createExchangeFactory(BybitExchange, ...[Futures.coinm])
    }
    if (exchange === ExchangeEnum.okx) {
      return createExchangeFactory(OKXExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.okxLinear) {
      return createExchangeFactory(OKXExchange, ...[Futures.usdm])
    }
    if (exchange === ExchangeEnum.okxInverse) {
      return createExchangeFactory(OKXExchange, ...[Futures.coinm])
    }
    if (exchange === ExchangeEnum.bitget) {
      return createExchangeFactory(BitgetExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.bitgetUsdm) {
      return createExchangeFactory(BitgetExchange, ...[Futures.usdm])
    }
    if (exchange === ExchangeEnum.bitgetCoinm) {
      return createExchangeFactory(BitgetExchange, ...[Futures.coinm])
    }
    if (exchange === ExchangeEnum.coinbase) {
      return createExchangeFactory(CoinbaseExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.hyperliquid) {
      return createExchangeFactory(HyperliquidExchange, ...[Futures.null])
    }
    if (exchange === ExchangeEnum.hyperliquidInverse) {
      return createExchangeFactory(HyperliquidExchange, ...[Futures.coinm])
    }
  }
}

export default ExchangeChooser
