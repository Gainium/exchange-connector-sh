import { MainClient } from 'binance'
import Kucoin from '../exchanges/kucoin'
import Bitget from '../exchanges/bitget'
import Bybit from '../exchanges/bybit'
import OKX from '../exchanges/okx'
import Coinbase from '../exchanges/coinbase'
import Hyperliquid from '../exchanges/hyperliquid'
import Kraken from '../exchanges/kraken'
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

// The `binance` client throws an Error-like object whose useful payload
// (Binance's `{ code, msg }`) lives on `.body` / `.response.data` / `.message`.
// Interpolating it directly (`${e}`) renders "[object Object]" and discards the
// real rejection reason, so verify failures were unreadable in the logs. Extract
// the meaningful fields defensively.
const errStr = (e: any): string => {
  if (e == null) return String(e)
  const body = e.body ?? e.response?.data
  const msg = e.message ?? e.msg
  const bits: string[] = []
  if (e.code !== undefined) bits.push(`code=${e.code}`)
  if (body !== undefined) {
    try {
      bits.push(typeof body === 'string' ? body : JSON.stringify(body))
    } catch {
      /* non-serializable body — skip */
    }
  }
  if (msg) bits.push(String(msg))
  if (bits.length) return bits.join(' ')
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const verifyBinance = async (
  tradeType: TradeTypeEnum,
  apiKey: string,
  apiSecret: string,
  domain: ExchangeDomain = ExchangeDomain.com,
): Promise<VerifyResponse> => {
  try {
    const prepared = apiSecret
      .replace(/-----BEGIN PRIVATE KEY----- /g, '-----BEGIN PRIVATE KEY-----\n')
      .replace(/ -----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----')
    const client = new MainClient({
      api_key: apiKey,
      api_secret: prepared,
      baseUrl: getBinanceBase(domain),
    })
    if (domain === ExchangeDomain.us) {
      // Binance.US only implements the spot `GET /api/v3/account`
      // (getAccountInformation); the `.com`-only `GET /sapi/v1/account/info`
      // that getAccountInfo() hits 404s on Binance.US, which made every
      // Binance.US key verification fail regardless of the key's validity.
      return client
        .getAccountInformation()
        .then(() => ({ status: true, reason: '' }))
        .catch((e) => ({
          status: false,
          reason: `Binance us catch ${errStr(e)}`,
        }))
    } else {
      return client
        .getApiKeyPermissions()
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
        .catch((e) => ({
          status: false,
          reason: `Binance catch ${errStr(e)}`,
        }))
    }
  } catch (e) {
    return { status: false, reason: `Binance catch global ${errStr(e)}` }
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

const verifyHyperliquid = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
  subaccount?: boolean,
): Promise<VerifyResponse> => {
  const client = new Hyperliquid(
    tradeType === TradeTypeEnum.spot ? Futures.null : Futures.usdm,
    key,
    secret,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    subaccount,
  )
  return await client
    .getBalance()
    .then((res) => ({
      status: res.status === StatusEnum.ok && !!res.data,
      reason: res.status === StatusEnum.ok ? '' : JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Hyperliquid catch ${e}` }))
}

const verifyKraken = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
): Promise<VerifyResponse> => {
  const client = new Kraken(
    tradeType === TradeTypeEnum.spot ? Futures.null : Futures.usdm,
    key,
    secret,
  )
  return await client
    .getBalance()
    .then((res) => ({
      status: res.status === StatusEnum.ok,
      reason: JSON.stringify(res),
    }))
    .catch((e) => ({ status: false, reason: `Kraken catch ${e}` }))
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
  subaccount?: boolean,
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
  if (
    [ExchangeEnum.hyperliquid, ExchangeEnum.hyperliquidLinear].includes(
      provider,
    )
  ) {
    return verifyHyperliquid(tradeType, key, secret, subaccount)
  }
  if ([ExchangeEnum.kraken, ExchangeEnum.krakenUsdm].includes(provider)) {
    return verifyKraken(tradeType, key, secret)
  }
  return { status: false, reason: 'Exchange not supported' }
}

const verifiers = {
  binance: verifyBinance,
  kucoin: verifyKucoin,
  bybit: verifyBybit,
  kraken: verifyKraken,
  verifyExchange,
  verifyPaper,
  verifyCoinbase,
}

export default verifiers
