import { ExchangeDomain, ExchangeEnum } from '../types'

export const getBinanceBase = (domain: ExchangeDomain) => {
  return domain === ExchangeDomain.us
    ? 'https://api.binance.us'
    : (process.env.BINANCE_DOMAIN ?? 'https://api.binance.com')
}

export const getExchangeDomain = (exchange: ExchangeEnum) => {
  if ([ExchangeEnum.ftxUS, ExchangeEnum.binanceUS].includes(exchange)) {
    return ExchangeDomain.us
  }
  return ExchangeDomain.com
}
