import Kucoin from '../exchanges/kucoin'
import {
  Futures,
  ExchangeDomain,
  ExchangeEnum,
  ExchangeIntervals,
} from '../types'
import Bitget from '../exchanges/bitget'
import Binance from '../exchanges/binance'
import Bybit from '../exchanges/bybit'
import OKX from '../exchanges/okx'
import Coinbase from '../exchanges/coinbase'

export const getPrices = (exchange: ExchangeEnum) => {
  switch (exchange) {
    case ExchangeEnum.binance:
      const binance = new Binance(ExchangeDomain.com, Futures.null, '', '')
      return binance.getAllPrices()
    case ExchangeEnum.binanceCoinm:
      const binanceCoinm = new Binance(
        ExchangeDomain.com,
        Futures.coinm,
        '',
        '',
      )
      return binanceCoinm.getAllPrices()
    case ExchangeEnum.binanceUsdm:
      const binanceUsdm = new Binance(ExchangeDomain.com, Futures.usdm, '', '')
      return binanceUsdm.getAllPrices()
    case ExchangeEnum.binanceUS:
      const binanceUs = new Binance(ExchangeDomain.us, Futures.null, '', '')
      return binanceUs.getAllPrices()
    case ExchangeEnum.bybit:
      const bybit = new Bybit(Futures.null, '', '')
      return bybit.getAllPrices()
    case ExchangeEnum.bybitUsdm:
      const bybitUsdm = new Bybit(Futures.usdm, '', '')
      return bybitUsdm.getAllPrices()
    case ExchangeEnum.bybitCoinm:
      const bybitCoinm = new Bybit(Futures.coinm, '', '')
      return bybitCoinm.getAllPrices()
    case ExchangeEnum.kucoin:
      const kucoin = new Kucoin(Futures.null, '', '')
      return kucoin.getAllPrices()
    case ExchangeEnum.kucoinInverse:
      const kucoinCoinm = new Kucoin(Futures.coinm, '', '')
      return kucoinCoinm.getAllPrices()
    case ExchangeEnum.kucoinLinear:
      const kucoinUsdm = new Kucoin(Futures.usdm, '', '')
      return kucoinUsdm.getAllPrices()
    case ExchangeEnum.okx:
      const okx = new OKX(Futures.null, '', '', '')
      return okx.getAllPrices()
    case ExchangeEnum.okxLinear:
      const okxUsdm = new OKX(Futures.usdm, '', '', '')
      return okxUsdm.getAllPrices()
    case ExchangeEnum.okxInverse:
      const okxCoinm = new OKX(Futures.coinm, '', '', '')
      return okxCoinm.getAllPrices()
    case ExchangeEnum.bitget:
      const bitget = new Bitget(Futures.null, '', '', '')
      return bitget.getAllPrices()
    case ExchangeEnum.bitgetUsdm:
      const bitgetUsdm = new Bitget(Futures.usdm, '', '', '')
      return bitgetUsdm.getAllPrices()
    case ExchangeEnum.bitgetCoinm:
      const bitgetCoinm = new Bitget(Futures.coinm, '', '', '')
      return bitgetCoinm.getAllPrices()
    case ExchangeEnum.coinbase:
      const coinbase = new Coinbase(Futures.null, '', '')
      return coinbase.getAllPrices()
    default:
      throw new Error(`getPrices is not supported for ${exchange}`)
  }
}

export const getCandles = (
  exchange: ExchangeEnum,
  params: {
    symbol: string
    type: string
    startAt: number
    endAt: number
  },
) => {
  switch (exchange) {
    case ExchangeEnum.binance:
      const binance = new Binance(ExchangeDomain.com, Futures.null, '', '')
      return binance.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.binanceCoinm:
      const binanceCoinm = new Binance(
        ExchangeDomain.com,
        Futures.coinm,
        '',
        '',
      )
      return binanceCoinm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.binanceUsdm:
      const binanceUsdm = new Binance(ExchangeDomain.com, Futures.usdm, '', '')
      return binanceUsdm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.binanceUS:
      const binanceUs = new Binance(ExchangeDomain.us, Futures.null, '', '')
      return binanceUs.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.ftxUS:
    case ExchangeEnum.bybit:
      const bybit = new Bybit(Futures.null, '', '')
      return bybit.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.bybitUsdm:
      const bybitUsdm = new Bybit(Futures.usdm, '', '')
      return bybitUsdm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.bybitCoinm:
      const bybitCoinm = new Bybit(Futures.coinm, '', '')
      return bybitCoinm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.okx:
      const okx = new OKX(Futures.null, '', '', '')
      return okx.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.okxLinear:
      const okxUsdm = new OKX(Futures.usdm, '', '', '')
      return okxUsdm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.okxInverse:
      const okxCoinm = new OKX(Futures.coinm, '', '', '')
      return okxCoinm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.bitget:
      const bitget = new Bitget(Futures.null, '', '', '')
      return bitget.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        200,
      )
    case ExchangeEnum.bitgetUsdm:
      const bitgetUsdm = new Bitget(Futures.usdm, '', '', '')
      return bitgetUsdm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        200,
      )
    case ExchangeEnum.bitgetCoinm:
      const bitgetCoinm = new Bitget(Futures.coinm, '', '', '')
      return bitgetCoinm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        200,
      )
    case ExchangeEnum.coinbase:
      const coinbase = new Coinbase(Futures.null, '', '')
      return coinbase.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
        1000,
      )
    case ExchangeEnum.kucoin:
      const kucoin = new Kucoin(Futures.null, '', '', '')
      return kucoin.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.kucoinLinear:
      const kucoinUsdm = new Kucoin(Futures.usdm, '', '', '')
      return kucoinUsdm.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    case ExchangeEnum.kucoinInverse:
      const kucoinInverse = new Kucoin(Futures.coinm, '', '', '')
      return kucoinInverse.getCandles(
        params.symbol,
        params.type as ExchangeIntervals,
        params.startAt,
        params.endAt,
      )
    default:
      throw new Error(`getCandles is not supported for ${exchange}`)
  }
}
