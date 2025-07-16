import Binance from 'binance-api-node'
import Kucoin from '../exchanges/kucoin'
import Bitget from '../exchanges/bitget'
import Bybit from '../exchanges/bybit'
import OKX from '../exchanges/okx'
import Coinbase from '../exchanges/coinbase'
import {
  BybitHost,
  CoinbaseKeysType,
  ExchangeDomain,
  ExchangeEnum,
  Futures,
  OKXSource,
  StatusEnum,
  TradeTypeEnum,
  VerifyResponse,
} from '../types'
import { getBinanceBase } from './exchaneUtils'
import fetch from 'isomorphic-unfetch'

const verifyBinance = async (
  tradeType: TradeTypeEnum,
  apiKey: string,
  apiSecret: string,
  domain: ExchangeDomain = ExchangeDomain.com,
): Promise<VerifyResponse> => {
  try {
    const client = Binance({
      apiKey,
      apiSecret,
      httpBase: getBinanceBase(domain),
    })
    if (domain === ExchangeDomain.us) {
      return client
        .accountInfo()
        .then(() => ({ status: true, reason: '' }))
        .catch((e) => ({ status: false, reason: `Binance us catch ${e}` }))
    } else {
      return client
        .apiPermission()
        .then((res) => {
          return {
            status:
              tradeType === TradeTypeEnum.futures
                ? res.enableFutures
                : tradeType === TradeTypeEnum.margin
                  ? res.enableMargin
                  : tradeType === TradeTypeEnum.spot
                    ? res.enableSpotAndMarginTrading
                    : false,
            reason: JSON.stringify(res),
          }
        })
        .catch((e) => ({ status: false, reason: `Binance catch ${e}` }))
    }
  } catch (e) {
    return { status: false, reason: `Binance catch global ${e}` }
  }
}

const verifyKucoin = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  pass: string,
): Promise<VerifyResponse> => {
  const client = new Kucoin(
    tradeType === TradeTypeEnum.spot
      ? Futures.null
      : tradeType === TradeTypeEnum.futures
        ? Futures.usdm
        : Futures.coinm,
    key,
    secret,
    pass,
  )
  return await client
    .getBalance()
    .then((res) => ({
      status: res.status === StatusEnum.ok,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Kucoin catch ${e}` }))
}

const verifyBitget = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  pass: string,
): Promise<VerifyResponse> => {
  const client = new Bitget(
    tradeType === TradeTypeEnum.spot
      ? Futures.null
      : tradeType === TradeTypeEnum.futures
        ? Futures.usdm
        : Futures.coinm,
    key,
    secret,
    pass,
  )
  return await client
    .getApiPermission()
    .then((res) => ({
      status: res.status === StatusEnum.ok,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Bitget catch ${e}` }))
}

const verifyBybit = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  bybitHost?: BybitHost,
): Promise<VerifyResponse> => {
  const client = new Bybit(
    tradeType === TradeTypeEnum.spot
      ? Futures.null
      : tradeType === TradeTypeEnum.futures
        ? Futures.usdm
        : Futures.coinm,
    key,
    secret,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    bybitHost,
  )
  return await client
    .getApiPermission()
    .then((res) => ({
      status: res.status === StatusEnum.ok,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Bybit catch ${e}` }))
}

const verifyOKX = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  pass: string,
  okxSource?: OKXSource,
): Promise<VerifyResponse> => {
  const client = new OKX(
    tradeType === TradeTypeEnum.spot
      ? Futures.null
      : tradeType === TradeTypeEnum.futures
        ? Futures.usdm
        : Futures.coinm,
    key,
    secret,
    pass,
    undefined,
    undefined,
    okxSource,
  )
  return await client
    .getApiPermission()
    .then((res) => ({
      status: res.status === StatusEnum.ok,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `OKX catch ${e}` }))
}

const verifyCoinbase = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  keysType?: CoinbaseKeysType,
): Promise<VerifyResponse> => {
  const client = new Coinbase(
    tradeType === TradeTypeEnum.spot
      ? Futures.null
      : tradeType === TradeTypeEnum.futures
        ? Futures.usdm
        : Futures.coinm,
    key,
    secret,
    undefined,
    undefined,
    keysType,
  )
  return await client
    .getApiPermission()
    .then((res) => ({
      status: res.status === StatusEnum.ok && res.data,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Coinbase catch ${e}` }))
}

const verifyPaper = async (
  key: string,
  secret: string,
): Promise<VerifyResponse> => {
  const result: VerifyResponse = await fetch(
    `${process.env.PAPER_TRADING_API_URL}/user/verify?key=${key}&secret=${secret}`,
    {
      method: 'GET',
      headers: {
        'Content-type': 'application/json',
      },
    },
  )
    .then((res) => res.json())
    .then((res) => ({ status: !!res?.verified, reason: '' }))
    .catch((e) => ({
      status: false,
      reason: `Error in verifying paper trading account ${e}`,
    }))
  return result
}

const verifyExchange = async (
  tradeType: TradeTypeEnum,
  provider: ExchangeEnum,
  key: string,
  secret: string,
  passphrase?: string,
  keysType?: CoinbaseKeysType,
  okxSource?: OKXSource,
  bybitHost?: BybitHost,
): Promise<VerifyResponse> => {
  if (
    [
      ExchangeEnum.binance,
      ExchangeEnum.binanceCoinm,
      ExchangeEnum.binanceUsdm,
    ].includes(provider)
  ) {
    return verifyBinance(tradeType, key, secret)
  }
  if (
    [
      ExchangeEnum.kucoin,
      ExchangeEnum.kucoinLinear,
      ExchangeEnum.kucoinInverse,
    ].includes(provider)
  ) {
    return verifyKucoin(tradeType, key, secret, passphrase || '')
  }
  if (
    [
      ExchangeEnum.bybit,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.bybitUsdm,
    ].includes(provider)
  ) {
    return verifyBybit(tradeType, key, secret, bybitHost)
  }
  if (
    [
      ExchangeEnum.okx,
      ExchangeEnum.okxInverse,
      ExchangeEnum.okxLinear,
    ].includes(provider)
  ) {
    return verifyOKX(tradeType, key, secret, passphrase || '', okxSource)
  }
  if (
    [
      ExchangeEnum.bitget,
      ExchangeEnum.bitgetCoinm,
      ExchangeEnum.bitgetUsdm,
    ].includes(provider)
  ) {
    return verifyBitget(tradeType, key, secret, passphrase || '')
  }
  if (provider === ExchangeEnum.binanceUS) {
    return verifyBinance(TradeTypeEnum.spot, key, secret, ExchangeDomain.us)
  }
  if (provider === ExchangeEnum.coinbase) {
    return verifyCoinbase(TradeTypeEnum.spot, key, secret, keysType)
  }
  return { status: false, reason: 'Exchange not supported' }
}

const verifiers = {
  binance: verifyBinance,
  kucoin: verifyKucoin,
  bybit: verifyBybit,
  verifyExchange,
  verifyPaper,
  verifyCoinbase,
}

export default verifiers
