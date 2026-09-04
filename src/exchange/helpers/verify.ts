import { MainClient } from 'binance'
import Kucoin from '../exchanges/kucoin'
import Bitget from '../exchanges/bitget'
import Bybit from '../exchanges/bybit'
import OKX from '../exchanges/okx'
import Coinbase from '../exchanges/coinbase'
import Hyperliquid from '../exchanges/hyperliquid'
import Kraken from '../exchanges/kraken'
import Whitebit from '../exchanges/whitebit'
import {
  BybitHost,
  CoinbaseKeysType,
  ExchangeDomain,
  ExchangeEnum,
  Futures,
  OKXSource,
  KeyPermissions,
  StatusEnum,
  TradeTypeEnum,
  VerifyResponse,
} from '../types'
import { getBinanceBase } from './exchaneUtils'
import { parseBinanceRestrictions, unknownPermissions } from './keyPermissions'
import { safeStringify } from '../../utils/redact'
import fetch from 'isomorphic-unfetch'

// The `binance` client throws an Error-like object whose useful payload
// (Binance's `{ code, msg }`) lives on `.body` / `.response.data` / `.message`.
// Interpolating it directly (`${e}`) renders "[object Object]" and discards the
// real rejection reason, so verify failures were unreadable in the logs. Extract
// the meaningful fields defensively.
//
// This runs on the one path that is *always* holding live credentials — key
// verification — and the fallback serializes the whole thrown object, which for
// several SDKs includes the signed request. Everything goes through
// `safeStringify`; the returned string becomes `VerifyResponse.reason`, which is
// logged here and stored/surfaced by main-app.
const errStr = (e: any): string => {
  if (e == null) return String(e)
  const body = e.body ?? e.response?.data
  const msg = e.message ?? e.msg
  const bits: string[] = []
  if (e.code !== undefined) bits.push(`code=${e.code}`)
  if (body !== undefined) {
    bits.push(typeof body === 'string' ? body : safeStringify(body))
  }
  if (msg) bits.push(String(msg))
  if (bits.length) return bits.join(' ')
  return safeStringify(e)
}

/**
 * Run a verifier and its key-permission probe together, and staple the
 * permissions onto the result.
 *
 * Concurrent on purpose: `addExchange` already fans out several serial exchange
 * round trips per leg (bug #216 measured 18.9s worst case), so the probe must
 * not add another one to the critical path.
 *
 * The probe can never change the verdict. `getKeyPermissions()` resolves to
 * `unknown` rather than throwing, but the extra `.catch` is deliberate belt and
 * braces: a credential that is fine must never fail verification because a
 * permissions lookup broke. Deciding what to *do* about a withdrawal-enabled
 * key belongs to main-app, which knows whether the connection is new.
 */
const withPermissions = async (
  client: { getKeyPermissions: () => Promise<KeyPermissions> },
  verify: () => Promise<VerifyResponse>,
): Promise<VerifyResponse> => {
  const [result, permissions] = await Promise.all([
    verify(),
    client
      .getKeyPermissions()
      .catch((e) =>
        unknownPermissions(`Permission probe failed: ${e?.message ?? e}`),
      ),
  ])
  return { ...result, permissions }
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
            // Same payload, no extra round trip: apiRestrictions already
            // carries enableWithdrawals and ipRestrict, we simply never looked.
            permissions:
              parseBinanceRestrictions(res) ??
              unknownPermissions(
                'Unrecognised Binance apiRestrictions response',
              ),
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
  return await withPermissions(client, () =>
    client
      .getBalance()
      .then((res) => ({
        status: res.status === StatusEnum.ok,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Kucoin catch ${e}` })),
  )
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
  return await withPermissions(client, () =>
    client
      .getApiPermission()
      .then((res) => ({
        status: res.status === StatusEnum.ok,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Bitget catch ${e}` })),
  )
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
  return await withPermissions(client, () =>
    client
      .getApiPermission()
      .then((res) => ({
        status: res.status === StatusEnum.ok,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Bybit catch ${e}` })),
  )
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
  return await withPermissions(client, () =>
    client
      .getApiPermission()
      .then((res) => ({
        status: res.status === StatusEnum.ok,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `OKX catch ${e}` })),
  )
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
  return await withPermissions(client, () =>
    client
      .getApiPermission()
      .then((res) => ({
        status: res.status === StatusEnum.ok && res.data,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Coinbase catch ${e}` })),
  )
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
  // Guard against the common onboarding mistake of entering the Hyperliquid
  // API/agent wallet address instead of the main account address. HL executes
  // orders (signed by the agent key) on the master, but every info request
  // targets the entered address — so an agent address verifies "fine" (empty
  // balance is a valid response) while the bot is blind to its own positions
  // and fills. Reject it with the correct address to use.
  const roleInfo = await client.getAccountRole()
  if (roleInfo.role === 'agent') {
    return {
      status: false,
      reason:
        `This is a Hyperliquid API wallet (agent) address, which is only used ` +
        `for signing. Enter your main account's public address` +
        `${roleInfo.master ? ` (${roleInfo.master})` : ''} instead.`,
    }
  }
  return await withPermissions(client, () =>
    client
      .getBalance()
      .then((res) => ({
        status: res.status === StatusEnum.ok && !!res.data,
        reason: res.status === StatusEnum.ok ? '' : JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Hyperliquid catch ${e}` })),
  )
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
  return await withPermissions(client, () =>
    client
      .getBalance()
      .then(async (res) => {
        if (res.status !== StatusEnum.ok) {
          return { status: false, reason: JSON.stringify(res) }
        }
        // REST works — but a key without the "WebSocket interface" permission
        // still can't feed the realtime user stream (fills degrade to delayed
        // reconcile sweeps with no error anywhere). Reject it here with the
        // exact toggle to flip, like the Hyperliquid agent-address guard above.
        const ws = await client.verifyWebsocketPermission()
        if (!ws.ok) {
          return {
            status: false,
            reason:
              `Your Kraken API key is missing the "WebSocket interface" ` +
              `permission, which Gainium needs for realtime order updates. ` +
              `On Kraken go to Settings → API, edit this key, enable ` +
              `"WebSocket interface" and save — then verify again.`,
          }
        }
        return { status: true, reason: JSON.stringify(res) }
      })
      .catch((e) => ({ status: false, reason: `Kraken catch ${e}` })),
  )
}

/**
 * WhiteBit key verification — spec 002 §2.7.
 *
 * A successful `getBalance()` is the whole check, deliberately: unlike Kraken,
 * WhiteBit exposes no probe that distinguishes a scope-limited key from a full
 * one (spec §3.7 — keys *can* be endpoint-restricted by the user, but nothing
 * in the docs says how to detect a too-narrow key from a call's shape). This is
 * the same floor `verifyKraken` starts from before its extra WS-permission
 * check; add an equivalent probe here if WhiteBit ever documents one.
 *
 * Both variants share one credential and one balance call — WhiteBit has no
 * separate futures account (spec §2.2), so `tradeType` only picks which wallet
 * (trade-account vs collateral-account) the balance is read from.
 */
const verifyWhitebit = async (
  tradeType: TradeTypeEnum,
  key: string,
  secret: string,
): Promise<VerifyResponse> => {
  const client = new Whitebit(
    tradeType === TradeTypeEnum.spot ? Futures.null : Futures.usdm,
    key,
    secret,
  )
  return await withPermissions(client, () =>
    client
      .getBalance()
      .then((res) => ({
        status: res.status === StatusEnum.ok && !!res.data,
        reason: JSON.stringify(res),
      }))
      .catch((e) => ({ status: false, reason: `Whitebit catch ${errStr(e)}` })),
  )
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
  if ([ExchangeEnum.whitebit, ExchangeEnum.whitebitUsdm].includes(provider)) {
    return verifyWhitebit(tradeType, key, secret)
  }
  return { status: false, reason: 'Exchange not supported' }
}

const verifiers = {
  binance: verifyBinance,
  kucoin: verifyKucoin,
  bybit: verifyBybit,
  kraken: verifyKraken,
  whitebit: verifyWhitebit,
  verifyExchange,
  verifyPaper,
  verifyCoinbase,
}

export default verifiers
