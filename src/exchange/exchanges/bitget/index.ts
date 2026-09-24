import AbstractExchange, { Exchange } from '../../abstractExchange'
import {
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  FundingRateResponse,
  CommonOrder,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  LeverageBracket,
  OrderStatusType,
  OrderTypes,
  OrderTypeT,
  StatusEnum,
  UserFee,
  TradeResponse,
  Futures,
  PositionSide,
  PositionInfo,
  MarginType,
  TimeProfile,
  RebateOverview,
  RebateRecord,
  KeyPermissions,
} from '../../types'
import {
  parseBitgetAccountInfo,
  parseBitgetUtaAccountInfo,
  unknownPermissions,
} from '../../helpers/keyPermissions'
import {
  BitgetAccountMode,
  REALITY_NEEDS_UTA,
  UTA_COINM_UNSUPPORTED,
  UTA_MISSING_PERMISSIONS,
  UtaAsset,
  UtaCategory,
  UtaOrder,
  UtaPosition,
  accountModeFromSettings,
  convertUtaAssets,
  pooledMarginFromUta,
  utaCollateralIsPooled,
  convertUtaOrder,
  convertUtaPosition,
  getCachedAccountMode,
  getRealitySymbols,
  isKeyRefusal,
  isUnifiedModeRefusal,
  isUtaPermissionRefusal,
  isUtaBasicModeRefusal,
  UTA_BASIC_MODE_UNSUPPORTED,
  utaCoinmSymbol,
  platformCoinmSymbol,
  coinmContracts,
  COINM_PERP_NEEDS_UTA,
  aggregateCandles,
  bitgetBaseInterval,
  realityBaseInterval,
  realityGranularity,
  setCachedAccountMode,
  setRealitySymbols,
  utaFuturesCategory,
} from './uta'
import {
  RestClientV2 as BitgetClient,
  FuturesKlineInterval,
  FuturesOrderDetailV2 as _FuturesOrderDetailV2,
  SpotKlineInterval,
  SpotOrderInfoV2 as _SpotOrderInfoV2,
  type RestClientOptions,
} from 'bitget-api'
import { RestClientV2 as BitgetOrderClient } from '../../../bitget-custom/rest-client-v2'
import limitHelper from './limit'
import { normalizeOrderFee } from '../../helpers/orderFee'
import { bitgetSpotFeeDetail } from './fees'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { keyFingerprint } from '../../../utils/keyFingerprint'
import {
  FuturesAssets,
  FuturesSubmitOrderResponse,
  SpotAccountType,
  FuturesPosition,
  FuturesSingleAccount,
} from './types'
import { timeIntervalMap } from '../okx'

/**
 * The SDK's `SpotKlineInterval` still carries the v1 documentation's set,
 * which has no `3min`. The live endpoints serve it and name it in their own
 * `400171` text — `[1min,3min,5min,15min,30min,1h,...]`, measured 2026-09-22
 * on both `/spot/market/candles` and `/spot/market/history-candles`. Widened
 * here, once, rather than cast at the call site: a cast at the call site is
 * what let `3m` be sent as `1min` unnoticed (bug #913).
 */
type BitgetSpotGranularity = SpotKlineInterval | '3min'

/**
 * The widest `[startTime, endTime]` window `/api/v2/mix/market/history-candles`
 * will accept, whatever the granularity. Wider is refused outright with
 * `40017 "Parameter verification failed startTime || endTime"` — not truncated,
 * so the page yields nothing at all (bug #914).
 *
 * MEASURED against the live API, not taken from the docs, which do not mention
 * it. On BTCUSDT / USDT-FUTURES, 2026-09-23, bisected to ~90.27 days and
 * identical at `1H`, `4H`, `1Dutc` and `1Wutc` and for windows entirely in the
 * past; 90d is accepted and 91d is refused at every one of them. Held one day
 * inside the real cliff so a page can never land on the wrong side of it. The
 * numbers drift — re-measure by walking a window wider per granularity.
 */
const BITGET_FUTURES_MAX_SPAN_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Monthly bars. `ExchangeIntervals` has no monthly member, but market-archive
 * and the chart ask for `1M` by that string, and every reader below priced
 * its pages with `timeIntervalMap[interval]` — undefined for `1M` — so the
 * window came out NaN and the read returned OK with nothing, on every Bitget
 * market. Months are not a fixed width, so they are read by their own path
 * (`futures_getMonthlyCandles`, and the spot branch in `spot_getCandles`)
 * rather than through the bar-count pagers.
 */
const BITGET_MONTH = '1M' as ExchangeIntervals

/** Opening of the UTC calendar month containing `t` — what `1Mutc` bars are
 *  stamped with, and the same anchor as Binance's `1M`. */
const utcMonthStart = (t: number): number => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

type SpotOrderInfoV2 = _SpotOrderInfoV2 & {
  basePrice?: string
}

type FuturesOrderDetailV2 = _FuturesOrderDetailV2 & {
  status: 'live' | 'partially_filled' | 'filled' | 'canceled'
}

class BitgetError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

class BitgetExchange extends AbstractExchange implements Exchange {
  /** Bybit client */
  protected client: BitgetClient
  /** Bybit order client */
  private orderClient: BitgetOrderClient
  /** Retry count. Default 10 */
  private retry: number
  /** Array of error codes, after which retry attempt is executed */
  private retryErrors: string[]
  protected futures?: Futures
  private demo = process.env.BITGETENV === 'demo'
  constructor(
    futures: Futures,
    key: string,
    secret: string,
    passphrase: string,
    _environment?: string,
    _keysType?: string,
    _okxSource?: string,
    code?: string,
    _subaccount?: boolean,
  ) {
    super({ key, secret, passphrase })
    const options: RestClientOptions = {
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
      apiPass: this.passphrase ?? '',
      recvWindow: 30000,
    }
    this.client = new BitgetClient(options)
    this.orderClient = new BitgetOrderClient(options, undefined, code)
    this.retry = 10
    this.retryErrors = [
      '10006',
      '12816',
      '12146',
      '12147',
      '5004',
      '10000',
      '10016',
      '502',
      '12149',
      '429',
    ]
    this.futures = futures === Futures.null ? this.futures : futures
  }

  async getRebateOverview(
    _timestamp: number,
  ): Promise<BaseReturn<RebateOverview>> {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  async getRebateRecords(
    _timestamp: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<RebateRecord[]>> {
    return this.returnBad(this.getEmptyTimeProfile())(
      new Error('Method not supported'),
    )
  }

  get usdm() {
    return this.futures === Futures.usdm
  }

  get coinm() {
    return this.futures === Futures.coinm
  }

  private errorFutures(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(new Error('Futures type missed'))
  }

  async classic_getUid(timeProfile = this.getEmptyTimeProfile()) {
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotAccount()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data as SpotAccountType
        return this.returnGood<number | string>(timeProfile)(
          result.code === '00000' ? (data?.userId ?? -1) : -1,
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.classic_getUid,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async classic_getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotAccount()
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data as SpotAccountType
        return this.returnGood<boolean>(timeProfile)(
          `${data?.inviterId}` === `${uid}`,
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.classic_getAffiliate,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Which of Bitget's two private APIs this key's account answers to — see
   * `uta.ts`. Asked once per key per process and cached.
   *
   * A classic account is refused by the v3 settings endpoint with a Bitget
   * business error, which settles it. A transport failure settles nothing, so
   * it is not cached: the classic path runs, and if the account is in fact
   * unified, the classic refusal flips it (`byAccountMode`).
   */
  private async accountMode(
    timeProfile?: TimeProfile,
  ): Promise<BitgetAccountMode> {
    if (!this.key || this.demo) {
      return 'classic'
    }
    const cached = getCachedAccountMode(this.key)
    if (cached) {
      return cached
    }
    try {
      await this.checkLimits('getAccountSettingsV3', 20, timeProfile)
      const res = await this.orderClient.getAccountSettingsV3()
      const mode = accountModeFromSettings(res?.data) ?? 'classic'
      setCachedAccountMode(this.key, mode)
      return mode
    } catch (e) {
      if ((e as { body?: { code?: string } })?.body?.code) {
        setCachedAccountMode(this.key, 'classic')
      }
      return 'classic'
    }
  }

  private async byAccountMode<T>(
    classic: () => Promise<BaseReturn<T>>,
    uta: () => Promise<BaseReturn<T>>,
  ): Promise<BaseReturn<T>> {
    if ((await this.accountMode()) === 'uta') {
      return uta()
    }
    const res = await classic()
    // A classic refusal means nothing was accepted (an order included), so
    // re-sending through v3 cannot act twice.
    if (
      res.status === StatusEnum.notok &&
      isUnifiedModeRefusal(res.reason) &&
      this.key &&
      !this.demo
    ) {
      Logger.log(
        `Bitget key#${keyFingerprint(this.key)} is a Unified Trading Account, switching to v3`,
      )
      setCachedAccountMode(this.key, 'uta')
      return uta()
    }
    return res
  }

  private utaCategory(symbol: string): UtaCategory {
    if (this.coinm) {
      return 'COIN-FUTURES'
    }
    return this.futures ? utaFuturesCategory(symbol) : 'SPOT'
  }

  private get utaCategories(): UtaCategory[] {
    if (this.coinm) {
      return ['COIN-FUTURES']
    }
    return this.futures ? ['USDT-FUTURES', 'USDC-FUTURES'] : ['SPOT']
  }

  /**
   * The venue's name for a pair on the unified line. Only the inverse
   * perpetuals differ from the platform's own name (spec 014 §3.2).
   */
  private utaSymbol(pair: string): string
  private utaSymbol(pair: undefined): undefined
  private utaSymbol(pair?: string): string | undefined
  private utaSymbol(pair?: string): string | undefined {
    if (!pair || !this.coinm) {
      return pair
    }
    return utaCoinmSymbol(pair)
  }

  /**
   * Bitget's quarterly inverse contracts (`BTCUSDU26`) stayed on the classic
   * line when the perpetuals moved; the unified line does not carry them.
   */
  private isCoinmDelivery(pair: string): boolean {
    return this.coinm && /[A-Z]\d{2}$/.test(pair)
  }

  /**
   * The venue's last price for an inverse pair, for sizing a market order
   * whose caller did not carry one (spec 014 §3.4).
   */
  private async utaLastPrice(pair: string): Promise<number> {
    try {
      await this.checkLimits('utaGetTickers', 0)
      const res = await this.orderClient.getTickersV3({
        category: this.utaCategory(pair),
        symbol: this.utaSymbol(pair),
      })
      const row = (Array.isArray(res?.data) ? res.data : [])[0]
      const price = parseFloat(`${row?.lastPrice ?? ''}`)
      return Number.isFinite(price) ? price : 0
    } catch {
      return 0
    }
  }

  /**
   * One v3 request with the adapter's usual limiter, profiler and retry
   * policy. The custom client throws on any code other than `00000`, so `map`
   * only ever sees a successful body.
   */
  private async utaRequest<T>(
    limit: string,
    request: () => Promise<{ data?: any }>,
    map: (data: any) => T | Promise<T>,
    timeProfile: TimeProfile,
  ): Promise<BaseReturn<T>> {
    timeProfile = (await this.checkLimits(limit, 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await request()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      return this.returnGood<T>(timeProfile)(await map(result?.data))
    } catch (e) {
      // A retryable failure repeats this request only, never the steps of
      // the caller that already succeeded.
      return this.handleBitgetErrors<BaseReturn<T>>(
        this.utaRequest,
        limit,
        request,
        map,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(e)
    }
  }

  async uta_getUid(timeProfile = this.getEmptyTimeProfile()) {
    return this.utaRequest<number | string>(
      'getAccountInfoV3',
      () => this.orderClient.getAccountInfoV3(),
      (data) => data?.userId ?? -1,
      timeProfile,
    )
  }

  async uta_getAffiliate(
    uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    return this.utaRequest<boolean>(
      'getAccountInfoV3',
      () => this.orderClient.getAccountInfoV3(),
      (data) => `${data?.inviterId}` === `${uid}`,
      timeProfile,
    )
  }

  async uta_getApiPermission(timeProfile = this.getEmptyTimeProfile()) {
    return this.utaRequest<boolean>(
      'getAccountInfoV3',
      () => this.orderClient.getAccountInfoV3(),
      (data) =>
        Array.isArray(data?.permissions) &&
        data.permissions.includes('uta_trade') &&
        data.permType !== 'read-only',
      timeProfile,
    )
  }

  async uta_getBalance(timeProfile = this.getEmptyTimeProfile()) {
    return this.utaRequest<FreeAsset>(
      'getAccountAssetsV3',
      () => this.orderClient.getAccountAssetsV3(),
      // Futures reports only its margin coins, as the classic product-type
      // accounts did; spot reports every coin held. Inverse contracts are
      // margined in the coin they are written on — a different coin per pair
      // — so that product type reports them all too.
      (data) =>
        convertUtaAssets(
          (data?.assets ?? []) as UtaAsset[],
          this.futures && !this.coinm ? ['USDT', 'USDC'] : undefined,
        ),
      timeProfile,
    )
  }

  /**
   * Pooled collateral on a unified account in `multi_assets` mode (spec 028):
   * every coin in the wallet margins every contract, so an inverse pair can be
   * opened from USDT alone. `null` for classic accounts, spot, and any unified
   * account that is not pooled — callers then keep the per-coin rule.
   *
   * Two reads (settings, then assets). Callers ask only once their own
   * per-coin check has failed, so the common path costs nothing.
   */
  async getMarginAvailableUsd(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number | null>> {
    if (!this.futures || (await this.accountMode(timeProfile)) !== 'uta') {
      return this.returnGood<number | null>(timeProfile)(null)
    }
    const settings = await this.utaRequest<unknown>(
      'getAccountSettingsV3',
      () => this.orderClient.getAccountSettingsV3(),
      (data) => data,
      timeProfile,
    )
    if (settings.status === StatusEnum.notok) {
      return settings
    }
    if (!utaCollateralIsPooled(settings.data)) {
      return this.returnGood<number | null>(settings.timeProfile)(null)
    }
    return this.utaRequest<number | null>(
      'getAccountAssetsV3',
      () => this.orderClient.getAccountAssetsV3(),
      (data) => pooledMarginFromUta(settings.data, data),
      settings.timeProfile,
    )
  }

  async uta_openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: OrderTypeT
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const limit = order.type === 'LIMIT'
    if (this.isCoinmDelivery(order.symbol)) {
      return this.returnBad(timeProfile)(new Error(UTA_COINM_UNSUPPORTED))
    }
    // An inverse order is sized in whole 1-USD contracts (spec 014 §3.4). A
    // limit order carries its own price; a market order is sized from the
    // venue's last price when the caller did not send one.
    let quantity = order.quantity
    if (this.coinm) {
      const price =
        order.price > 0 ? order.price : await this.utaLastPrice(order.symbol)
      if (!(price > 0)) {
        return this.returnBad(timeProfile)(
          new Error(
            `${this.exchangeProblems}no price to size an inverse order for ${order.symbol}`,
          ),
        )
      }
      quantity = coinmContracts(order.quantity, price)
    }
    // Spot market buys are sized in the quote coin, exactly as on classic;
    // main-app already sends them that way.
    const options: Record<string, string> = {
      category: this.utaCategory(order.symbol),
      symbol: this.utaSymbol(order.symbol),
      qty: this.convertNumberToString(quantity),
      side: order.side === 'BUY' ? 'buy' : 'sell',
      orderType: limit ? 'limit' : 'market',
    }
    if (limit) {
      options.price = this.convertNumberToString(order.price)
      options.timeInForce = 'gtc'
    }
    if (order.newClientOrderId) {
      options.clientOid = order.newClientOrderId
    }
    if (this.futures) {
      options.marginMode =
        order.marginType === MarginType.ISOLATED ? 'isolated' : 'crossed'
      // Hedge mode names the position the order acts on; `side` stays the
      // direction of the order itself (close long = sell + long).
      if (
        order.positionSide === PositionSide.LONG ||
        order.positionSide === PositionSide.SHORT
      ) {
        options.posSide =
          order.positionSide === PositionSide.LONG ? 'long' : 'short'
      } else if (order.reduceOnly) {
        options.reduceOnly = 'yes'
      }
    }
    const placed = await this.utaRequest<{ clientOid?: string }>(
      'utaPlaceOrder',
      () => this.orderClient.placeOrderV3(options),
      (data) => data ?? {},
      timeProfile,
    )
    if (placed.status === StatusEnum.notok) {
      return placed
    }
    if (!limit) {
      await sleep(1000)
    }
    return this.uta_getOrder(
      {
        symbol: order.symbol,
        newClientOrderId: placed.data.clientOid || order.newClientOrderId,
      },
      placed.timeProfile,
    )
  }

  async uta_getOrder(
    data: { symbol: string; newClientOrderId?: string; orderId?: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const res = await this.utaRequest<CommonOrder>(
      'utaGetOrder',
      () =>
        this.orderClient.getOrderInfoV3(
          data.orderId
            ? { orderId: data.orderId }
            : { clientOid: data.newClientOrderId },
        ),
      (order) => convertUtaOrder(order as UtaOrder, this.coinm),
      timeProfile,
    )
    // An order just accepted can take a moment to become queryable.
    if (
      res.status === StatusEnum.notok &&
      /not exist|not found|cannot be found/i.test(`${res.reason}`) &&
      res.timeProfile.attempts < 3
    ) {
      await sleep(1000)
      res.timeProfile.attempts++
      return this.uta_getOrder(data, res.timeProfile)
    }
    return res
  }

  async uta_cancelOrder(
    order: { symbol: string; newClientOrderId?: string; orderId?: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    const cancelled = await this.utaRequest<{ orderId?: string }>(
      'utaCancelOrder',
      () =>
        this.orderClient.cancelOrderV3({
          category: this.utaCategory(order.symbol),
          ...(order.orderId
            ? { orderId: order.orderId }
            : { clientOid: order.newClientOrderId }),
        }),
      (data) => data ?? {},
      timeProfile,
    )
    if (cancelled.status === StatusEnum.notok) {
      return cancelled
    }
    return this.uta_getOrder(order, cancelled.timeProfile)
  }

  async uta_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder[]> | BaseReturn<number>> {
    const categories = symbol ? [this.utaCategory(symbol)] : this.utaCategories
    const orders: CommonOrder[] = []
    const pageSize = 100
    for (const category of categories) {
      let cursor: string | undefined
      // 400 open orders per product line is Bitget's own cap.
      for (let page = 0; page < 5; page++) {
        const res = await this.utaRequest<{
          list: UtaOrder[]
          cursor?: string
        }>(
          'utaGetOpenOrders',
          () =>
            this.orderClient.getUnfilledOrdersV3({
              category,
              symbol: this.utaSymbol(symbol),
              limit: `${pageSize}`,
              cursor,
            }),
          (data) => ({
            list: (Array.isArray(data)
              ? data
              : (data?.list ?? [])) as UtaOrder[],
            cursor: data?.cursor,
          }),
          timeProfile,
        )
        if (res.status === StatusEnum.notok) {
          return res
        }
        timeProfile = res.timeProfile
        orders.push(...res.data.list.map((o) => convertUtaOrder(o, this.coinm)))
        if (res.data.list.length < pageSize || !res.data.cursor) {
          break
        }
        cursor = res.data.cursor
      }
    }
    return returnOrders
      ? this.returnGood<CommonOrder[]>(timeProfile)(orders)
      : this.returnGood<number>(timeProfile)(orders.length)
  }

  async uta_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    return this.utaRequest<UserFee>(
      'utaGetFeeRate',
      () =>
        this.orderClient.getFeeRateV3({
          symbol: this.utaSymbol(symbol),
          category: this.utaCategory(symbol),
        }),
      (data) => ({ maker: +data?.makerFeeRate, taker: +data?.takerFeeRate }),
      timeProfile,
    )
  }

  /**
   * One all-symbol fee call per category instead of the classic per-symbol
   * fan-out. Pairs the venue leaves out keep the listed rate, as classic did
   * for a failed lookup.
   */
  async uta_getAllUserFees(): Promise<
    BaseReturn<(UserFee & { pair: string })[]>
  > {
    const info = await this.getAllExchangeInfo()
    if (info.status === StatusEnum.notok) {
      return info
    }
    const rates = new Map<string, UserFee>()
    let timeProfile = info.timeProfile
    for (const category of this.utaCategories) {
      const res = await this.utaRequest<
        { symbol: string; makerFeeRate: string; takerFeeRate: string }[]
      >(
        'utaGetAllFeeRates',
        () => this.orderClient.getAllFeeRatesV3({ category }),
        (data) => (Array.isArray(data) ? data : []),
        timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
      timeProfile = res.timeProfile
      for (const r of res.data) {
        // v3 names the inverse perpetuals `_CM`; the listing they are matched
        // against carries the platform's own names (spec 014 §3.2).
        rates.set(this.coinm ? platformCoinmSymbol(r.symbol) : r.symbol, {
          maker: +r.makerFeeRate,
          taker: +r.takerFeeRate,
        })
      }
    }
    return this.returnGood<(UserFee & { pair: string })[]>(timeProfile)(
      (
        info.data as (ExchangeInfo & {
          pair: string
          makerFee?: number
          takerFee?: number
        })[]
      ).map((p) => ({
        pair: p.pair,
        ...(rates.get(p.pair) ?? { maker: p.makerFee, taker: p.takerFee }),
      })),
    )
  }

  /**
   * Unified leverage is kept per margin mode, and the mode is chosen per order
   * (`uta_openOrder` sends `marginMode`). The caller does not say which mode
   * the bot trades, so cross is the answer and isolated is set alongside it
   * on a best-effort basis; `uta_changeMarginType` is what enforces isolated
   * (spec 027).
   */
  async uta_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    const res = await this.utaRequest<number>(
      'utaSetLeverage',
      () =>
        this.orderClient.setLeverageV3({
          category: this.utaCategory(symbol),
          symbol: this.utaSymbol(symbol),
          leverage: `${leverage}`,
          marginMode: 'crossed',
        }),
      () => leverage,
      timeProfile,
    )
    if (res.status === StatusEnum.notok) {
      return res
    }
    const isolated = await this.uta_setIsolatedLeverage(symbol, leverage)
    if (isolated.status === StatusEnum.notok) {
      Logger.warn(
        `Bitget UTA isolated leverage for ${symbol} not set: ${isolated.reason}`,
      )
    }
    return res
  }

  /**
   * Isolated leverage on the unified line is per position side. In hedge mode
   * the venue wants both sides in one request (`longLeverage` +
   * `shortLeverage`) and refuses a single `posSide` with
   * `DOUBLE_SIDE_HOLD afterShortLeverage and afterLongLeverage none`; one-way
   * mode takes one request per side.
   */
  private async uta_setIsolatedLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    const hedge = await this.uta_getHedge(timeProfile)
    if (hedge.status === StatusEnum.notok) {
      return hedge
    }
    const base = {
      category: this.utaCategory(symbol),
      symbol: this.utaSymbol(symbol),
      marginMode: 'isolated' as const,
    }
    const requests = hedge.data
      ? [{ ...base, longLeverage: `${leverage}`, shortLeverage: `${leverage}` }]
      : (['long', 'short'] as const).map((posSide) => ({
          ...base,
          leverage: `${leverage}`,
          posSide,
        }))
    let res: BaseReturn<number> = this.returnGood<number>(hedge.timeProfile)(
      leverage,
    )
    for (const params of requests) {
      res = await this.utaRequest<number>(
        'utaSetLeverage',
        () => this.orderClient.setLeverageV3(params),
        () => leverage,
        res.timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
    }
    return res
  }

  /**
   * There is no account-level margin mode on UTA to switch; the order carries
   * it. An isolated bot does need its isolated leverage, and a failure to set
   * it is returned so the bot errors instead of opening at the venue's
   * default (spec 027).
   */
  async uta_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (this.isCoinmDelivery(symbol)) {
      return this.returnBad(timeProfile)(new Error(UTA_COINM_UNSUPPORTED))
    }
    if (margin === MarginType.ISOLATED && leverage) {
      const res = await this.uta_setIsolatedLeverage(
        symbol,
        leverage,
        timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
      timeProfile = res.timeProfile
    }
    return this.returnGood<MarginType>(timeProfile)(margin)
  }

  async uta_getHedge(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    return this.utaRequest<boolean>(
      'getAccountSettingsV3',
      () => this.orderClient.getAccountSettingsV3(),
      (data) => data?.holdMode === 'hedge_mode',
      timeProfile,
    )
  }

  async uta_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    return this.utaRequest<boolean>(
      'utaSetHoldMode',
      () =>
        this.orderClient.setHoldModeV3({
          holdMode: value ? 'hedge_mode' : 'one_way_mode',
        }),
      () => value,
      timeProfile,
    )
  }

  async uta_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    const positions: PositionInfo[] = []
    const categories = symbol ? [this.utaCategory(symbol)] : this.utaCategories
    for (const category of categories) {
      const res = await this.utaRequest<PositionInfo[]>(
        'utaGetPositions',
        () =>
          this.orderClient.getCurrentPositionsV3({
            category,
            symbol: this.utaSymbol(symbol),
          }),
        (data) =>
          ((Array.isArray(data) ? data : (data?.list ?? [])) as UtaPosition[])
            .filter((p) => +p.total !== 0)
            .map((pos) => convertUtaPosition(pos, this.coinm)),
        timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
      timeProfile = res.timeProfile
      positions.push(...res.data)
    }
    return this.returnGood<PositionInfo[]>(timeProfile)(positions)
  }

  async getUid() {
    return this.byAccountMode<number | string>(
      () => this.classic_getUid(),
      () => this.uta_getUid(),
    )
  }

  async getAffiliate(uid: string | number) {
    return this.byAccountMode<boolean>(
      () => this.classic_getAffiliate(uid),
      () => this.uta_getAffiliate(uid),
    )
  }

  async getApiPermission(): Promise<BaseReturn<boolean>> {
    return this.byAccountMode<boolean>(
      () => this.classic_getApiPermission(),
      () => this.uta_getApiPermission(),
    )
  }

  async futures_changeLeverage(
    symbol: string,
    leverage: number,
  ): Promise<BaseReturn<number>> {
    return this.byAccountMode<number>(
      () => this.classic_futures_changeLeverage(symbol, leverage),
      () => this.uta_changeLeverage(symbol, leverage),
    )
  }

  async futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
  ): Promise<BaseReturn<MarginType>> {
    return this.byAccountMode<MarginType>(
      () => this.classic_futures_changeMarginType(symbol, margin, leverage),
      () => this.uta_changeMarginType(symbol, margin, leverage),
    )
  }

  async futures_getHedge(symbol?: string): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.byAccountMode<boolean>(
      () => this.classic_futures_getHedge(symbol),
      () => this.uta_getHedge(),
    )
  }

  async futures_setHedge(value: boolean): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.byAccountMode<boolean>(
      () => this.classic_futures_setHedge(value),
      () => this.uta_setHedge(value),
    )
  }

  async futures_getPositions(
    symbol?: string,
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(this.getEmptyTimeProfile())
    }
    return this.byAccountMode<PositionInfo[]>(
      () => this.classic_futures_getPositions(symbol),
      () => this.uta_getPositions(symbol),
    )
  }

  get productTypes() {
    return this.usdm
      ? this.demo
        ? (['SUSDT-FUTURES', 'SUSDC-FUTURES'] as const)
        : (['USDT-FUTURES', 'USDC-FUTURES'] as const)
      : this.demo
        ? (['SCOIN-FUTURES'] as const)
        : (['COIN-FUTURES'] as const)
  }

  private getProductTypeBySymbol(symbol: string) {
    return this.coinm
      ? this.demo
        ? 'SCOIN-FUTURES'
        : 'COIN-FUTURES'
      : symbol.endsWith('USDT')
        ? this.demo
          ? 'SUSDT-FUTURES'
          : 'USDT-FUTURES'
        : this.demo
          ? 'SUSDC-FUTURES'
          : 'USDC-FUTURES'
  }

  private getMarginCoinBySymbolAndProductType(
    symbol: string,
    productType: string,
  ) {
    return productType === 'USDT-FUTURES' || productType === 'SUSDT-FUTURES'
      ? this.demo
        ? 'SUSDT'
        : 'USDT'
      : productType === 'USDC-FUTURES' || productType === 'SUSDC-FUTURES'
        ? this.demo
          ? 'SUSDC'
          : 'USDC'
        : this.demo
          ? 'SBTC'
          : this.demo
            ? symbol.replace(/S?USD?\w+/gm, '')
            : symbol.replace(/USD?\w+/gm, '')
  }

  async classic_futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    try {
      if (!this.futures) {
        return this.errorFutures(timeProfile)
      }
      timeProfile =
        (await this.checkLimits('setFuturesLeverage', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const productType = this.getProductTypeBySymbol(symbol)
      const marginCoin = this.getMarginCoinBySymbolAndProductType(
        symbol,
        productType,
      )
      timeProfile =
        (await this.checkLimits('getFuturesAccountAsset', 0, timeProfile)) ||
        timeProfile
      const account = await this.client
        .getFuturesAccountAsset({
          symbol,
          productType,
          marginCoin,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code === '00000') {
            return this.returnGood<FuturesSingleAccount>(timeProfile)(
              result.data as FuturesSingleAccount,
            )
          }
          throw new BitgetError(result.msg, +result.code)
        })
      const isolatedHedge =
        account?.data?.marginMode === 'isolated' &&
        account?.data?.posMode === 'hedge_mode'
      if (isolatedHedge) {
        for (const holdSide of ['long', 'short'] as const) {
          timeProfile =
            (await this.checkLimits('setFuturesLeverage', 0, timeProfile)) ||
            timeProfile
          this.client
            .setFuturesLeverage({
              symbol,
              productType,
              leverage: `${leverage}`,
              marginCoin,
              holdSide,
            })
            .catch(
              this.handleBitgetErrors(
                this.classic_futures_changeLeverage,
                symbol,
                leverage,
                this.endProfilerTime(timeProfile, 'exchange'),
              ),
            )
        }
        return this.returnGood<number>(timeProfile)(leverage)
      }
      return this.client
        .setFuturesLeverage({
          symbol,
          productType,
          leverage: `${leverage}`,
          marginCoin,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code === '00000') {
            return this.returnGood<number>(timeProfile)(leverage)
          }
          return this.handleBitgetErrors(
            this.classic_futures_changeLeverage,
            symbol,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        })
        .catch(
          this.handleBitgetErrors(
            this.classic_futures_changeLeverage,
            symbol,
            leverage,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    } catch (e) {
      this.handleBitgetErrors(
        this.classic_futures_changeLeverage,
        symbol,
        leverage,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: FreeAsset = []
    for (const productType of this.productTypes) {
      try {
        timeProfile =
          (await this.checkLimits('getFuturesAccountAssets', 0, timeProfile)) ||
          timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')
        const get = await this.client.getFuturesAccountAssets({ productType })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (get.code === '00000') {
          const data = get.data as FuturesAssets[]
          data.map((d) => {
            // `free` and `locked` are a PARTITION of the coin's wallet
            // balance — every consumer renders `free + locked` as the account
            // total — so they have to be derived from that balance, not from
            // `available`. Bitget's `available` is not net of the margin
            // backing a CROSSED position (in cross mode the whole balance
            // backs it, so it keeps counting as available); reading it as
            // `free` and adding the position margin as `locked` counted that
            // margin twice. `accountEquity` is documented as equity
            // *including* unrealized PnL, so equity - unrealizedPL is the
            // wallet balance — the same figure Bybit anchors on.
            //
            // That subtraction is only legal when the margin coin IS the
            // contracts' quote currency, i.e. on the LINEAR product types
            // (USDT-FUTURES / USDC-FUTURES). On COIN-FUTURES the contracts are
            // USD-quoted inverse contracts: every balance field stays in the
            // margin coin but `unrealizedPL` comes back in the contracts'
            // currency, so subtracting it moves the balance by ~1 whole coin
            // per 1 USD of open PnL. Inverse therefore anchors on
            // `accountEquity` alone — the only account-wide figure the venue
            // quotes in the margin coin, and the same account-equity anchor
            // `kucoin` uses. The total is then equity rather than wallet
            // balance, differing by the position's PnL *in coin terms*, and no
            // cross-currency term is read at all.
            const num = (v: unknown) => {
              const n = parseFloat(`${v ?? ''}`)
              return Number.isFinite(n) ? n : 0
            }
            const equityBased = this.coinm
              ? num(d.accountEquity)
              : num(d.accountEquity) - num(d.unrealizedPL)
            // Product types that omit the equity fields fall back to the
            // venue's own two-term split; reporting 0 would read as an
            // emptied account.
            const walletBalance =
              equityBased > 0 ? equityBased : num(d.available) + num(d.locked)
            // Order-frozen funds plus whatever is committed to positions, in
            // either margin mode. Clamped so `free` cannot go negative and
            // the partition stays exact.
            const committed = Math.min(
              Math.max(
                num(d.locked) + num(d.isolatedMargin) + num(d.crossedMargin),
                0,
              ),
              walletBalance,
            )
            res.push({
              asset: d.marginCoin,
              free: walletBalance - committed,
              locked: committed,
            })
          })
        } else {
          return this.handleBitgetErrors(
            this.futures_getBalance,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(get.msg, 0))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  async futures_openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
      marginType?: MarginType
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresSubmitOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    const options = {
      symbol: order.symbol,
      productType,
      marginCoin: this.getMarginCoinBySymbolAndProductType(
        order.symbol,
        productType,
      ),
      marginMode:
        order.marginType === MarginType.ISOLATED ? 'isolated' : 'crossed',
      size: order.quantity,
      price: order.price,
      side:
        order.positionSide === PositionSide.BOTH
          ? order.side === 'BUY'
            ? 'buy'
            : 'sell'
          : order.positionSide === PositionSide.LONG
            ? 'buy'
            : 'sell',
      tradeSide:
        order.positionSide === PositionSide.BOTH
          ? undefined
          : order.positionSide === PositionSide.LONG
            ? order.side === 'BUY'
              ? 'open'
              : 'close'
            : order.side === 'SELL'
              ? 'open'
              : 'close',
      orderType: order.type === 'LIMIT' ? 'limit' : 'market',
      clientOid: order.newClientOrderId,
      reduceOnly:
        order.positionSide === PositionSide.BOTH
          ? undefined
          : order.reduceOnly
            ? 'YES'
            : 'NO',
    }
    if (options.tradeSide === undefined) {
      delete options.tradeSide
    }
    if (options.reduceOnly === undefined) {
      delete options.reduceOnly
    }
    return this.orderClient
      .futuresSubmitOrder(options)
      .catch(async (e) => {
        // The position-mode form of every order is decided by main-app from
        // the `hedge` flag it read when the BOT loaded. A mode change on the
        // account — or a bot that never read the flag at all — leaves every
        // later order in the wrong form, and Bitget rejects all of them with
        // 40774 "the order type for unilateral position must also be the
        // unilateral position type" until the bot happens to reload. Bybit
        // reports the same class of mismatch as "position idx not match
        // position mode" and `bybit/index.ts` openOrder already self-heals by
        // re-sending in the other mode; do the same here. 40774 means the
        // order was never accepted and `clientOid` is unchanged, so the retry
        // cannot double-fill.
        const msg = `${
          (e as { body?: { msg?: string } })?.body?.msg ||
          (e as Error)?.message ||
          ''
        }`.toLowerCase()
        if (msg.indexOf('unilateral position') === -1) {
          throw e
        }
        // Rebuild the payload exactly as the opposite `positionSide` branch
        // above would have: a hedge order carries the position direction in
        // `side` plus `tradeSide` open/close, a one-way order carries the raw
        // order direction in `side` and neither of the hedge fields.
        if (options.tradeSide === undefined) {
          const long =
            order.side === 'BUY' ? !order.reduceOnly : !!order.reduceOnly
          options.side = long ? 'buy' : 'sell'
          options.tradeSide = order.reduceOnly ? 'close' : 'open'
          options.reduceOnly = order.reduceOnly ? 'YES' : 'NO'
        } else {
          options.side = order.side === 'BUY' ? 'buy' : 'sell'
          delete options.tradeSide
          delete options.reduceOnly
        }
        Logger.warn(
          `Bitget position mode mismatch on ${order.newClientOrderId}, retry as ${
            options.tradeSide ? 'hedge' : 'one-way'
          }`,
        )
        timeProfile =
          (await this.checkLimits('futuresSubmitOrder', 0, timeProfile)) ||
          timeProfile
        return await this.orderClient.futuresSubmitOrder(options)
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data as FuturesSubmitOrderResponse
          if (options.orderType === 'market') {
            await sleep(1000)
          }
          return await this.futures_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.futures_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_getOrder(
    data: { symbol: string; newClientOrderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getFuturesOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(data.symbol)
    return this.client
      .getFuturesOrder({
        symbol: data.symbol,
        productType,
        clientOid: data.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<CommonOrder>(timeProfile)(
            this.convertFuturesOrder(data as unknown as FuturesOrderDetailV2),
          )
        }
        if (
          result.msg.indexOf('the data of the order cannot be found') !== -1
        ) {
          Logger.warn(
            `Order not found ${data.newClientOrderId}. Wait 1s and retry`,
          )
          await sleep(1000)
          timeProfile.attempts = timeProfile.attempts + 1
          return this.futures_getOrder(data, timeProfile)
        }
        return this.handleBitgetErrors(
          this.futures_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    return this.client
      .futuresCancelOrder({
        symbol: order.symbol,
        productType,
        clientOid: order.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return await this.futures_getOrder(order, timeProfile)
        }
        return this.handleBitgetErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('futuresCancelOrder', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(order.symbol)
    return this.client
      .futuresCancelOrder({
        symbol: order.symbol,
        productType,
        orderId: order.orderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return await this.futures_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.futures_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async futures_latestPrice(symbol: string) {
    const res = await this.futures_getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const found = res.data.find((p) => p.pair === symbol)
    // A pair Bitget does not carry (never listed, or delisted while bots/positions
    // still reference it) must surface as NOTOK. Defaulting to 0 returned a
    // fabricated price under status OK, which callers treat as a real quote.
    if (!found) {
      return this.returnBad(res.timeProfile)(
        new Error(`Symbol not found on exchange: ${symbol}`),
      )
    }
    return this.returnGood<number>(res.timeProfile)(found.price)
  }

  async futures_getExchangeInfo(symbol: string) {
    const res = await this.futures_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    return this.returnGood<ExchangeInfo>(res.timeProfile)(
      res.data.find((p) => p.pair === symbol),
    )
  }

  async futures_getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async futures_getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async futures_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }

    const productTypes = symbol
      ? ([this.getProductTypeBySymbol(symbol)] as const)
      : this.productTypes
    const res: CommonOrder[] = []
    for (const productType of productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesOpenOrders', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesOpenOrders({
          productType,
          symbol,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          ;(data.entrustedList ?? []).map((o) =>
            res.push(
              this.convertFuturesOrder(o as unknown as FuturesOrderDetailV2),
            ),
          )
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllOpenOrders,
            symbol,
            returnOrders,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return {
      timeProfile,
      usage: limitHelper.getInstance().getLimits(),
      status: StatusEnum.ok as StatusEnum.ok,
      data: returnOrders ? res : res.length,
    }
  }

  async futures_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    try {
      timeProfile =
        (await this.checkLimits('getTradeRate', 0, timeProfile)) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getTradeRate({
        businessType: 'mix',
        symbol,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data as { makerFeeRate: string; takerFeeRate: string }
        return this.returnGood<UserFee>(timeProfile)({
          maker: +data.makerFeeRate,
          taker: +data.takerFeeRate,
        })
      } else {
        return this.handleBitgetErrors(
          this.futures_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.futures_getUserFees,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async futures_getAllUserFees(): Promise<
    BaseReturn<(UserFee & { pair: string })[]>
  > {
    const res = await this.futures_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const fees: (UserFee & { pair: string })[] = []
    const chunks: (typeof res.data)[] = []
    for (let i = 0; i < res.data.length; i += 8) {
      chunks.push(res.data.slice(i, i + 8))
    }
    // A unified account refuses every classic endpoint, and a dead, IP-locked
    // or restricted key refuses every pair. Swallowing that into a per-pair
    // warning spends one refused call on every listed pair and hands back the
    // listed rates instead of the account's own, so the refusal is returned as
    // this call's result — which routes a unified account to v3
    // (`byAccountMode`) and shows the caller one key error instead of one per
    // pair.
    let refusal: string | undefined
    for (const ch of chunks) {
      if (refusal) {
        break
      }
      await Promise.all(
        ch.map(async (p) => {
          const f = await this.futures_getUserFees(p.pair)
          if (f.status === StatusEnum.notok) {
            if (isUnifiedModeRefusal(f.reason) || isKeyRefusal(f.reason)) {
              refusal = refusal ?? `${f.reason}`
              return
            }
            Logger.warn(`Error getting futures fees for ${p.pair} ${f.reason}`)
            fees.push({ pair: p.pair, maker: p.makerFee, taker: p.takerFee })
          } else {
            fees.push({
              pair: p.pair,
              maker: f.data.maker,
              taker: f.data.taker,
            })
          }
        }),
      )
    }

    if (refusal) {
      return this.returnBad(res.timeProfile)(new Error(refusal))
    }
    return this.returnGood<(UserFee & { pair: string })[]>(res.timeProfile)(
      fees,
    )
  }

  async classic_futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const productTypes = symbol
      ? ([this.getProductTypeBySymbol(symbol)] as const)
      : this.productTypes
    const res: PositionInfo[] = []
    for (const productType of productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesPositions', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesPositions({
          productType,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          data.map((o) => res.push(this.convertPosition(o)))
        } else {
          return this.handleBitgetErrors(
            this.classic_futures_getPositions,
            symbol,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.classic_futures_getPositions,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<PositionInfo[]>(timeProfile)(res)
  }

  /**
   * The classic v2 granularity for an interval. Every arm here names a width
   * the venue really serves at that width — a substitution would be returned
   * to the caller unlabelled (bug #913). The two widths the classic line has
   * no granularity for (`8h` on both product lines, `2h` on spot) never reach
   * this function: `bitgetBaseInterval` sends them to a finer interval that
   * `aggregateCandles` merges back up.
   */
  private convertInterval(
    interval: ExchangeIntervals,
  ): FuturesKlineInterval | BitgetSpotGranularity {
    switch (interval) {
      case ExchangeIntervals.oneW:
        return '1Wutc'
      case ExchangeIntervals.oneD:
        return '1Dutc'
      case ExchangeIntervals.fourH:
        return this.futures ? '4H' : '4h'
      case ExchangeIntervals.twoH:
        // Spot has no `2h`; it is aggregated from `1h` before it gets here.
        return '2H'
      case ExchangeIntervals.oneH:
        return this.futures ? '1H' : '1h'
      case ExchangeIntervals.thirtyM:
        return this.futures ? '30m' : '30min'
      case ExchangeIntervals.fifteenM:
        return this.futures ? '15m' : '15min'
      case ExchangeIntervals.fiveM:
        return this.futures ? '5m' : '5min'
      case ExchangeIntervals.threeM:
        return this.futures ? '3m' : '3min'
      case ExchangeIntervals.oneM:
        return this.futures ? '1m' : '1min'
      default:
        return interval as FuturesKlineInterval
    }
  }

  async futures_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    _countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }

    // No Bitget futures line has an `8h` granularity. Read the base interval
    // and merge, rather than substituting a narrower width and returning it as
    // if it were the one asked for (bug #913). Above the inverse delegation so
    // it covers the unified line too, and recursing at the base interval also
    // prices the page budget below at the width the venue is really serving.
    const base = bitgetBaseInterval(interval, true)
    if (base !== interval) {
      const res = await this.futures_getCandles(
        symbol,
        base,
        from,
        to,
        _countData,
        timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
      return this.returnGood<CandleResponse[]>(res.timeProfile)(
        aggregateCandles(res.data, timeIntervalMap[interval]),
      )
    }

    if (interval === BITGET_MONTH) {
      return this.futures_getMonthlyCandles(symbol, from, to, timeProfile)
    }

    if (this.coinm && !this.isCoinmDelivery(symbol)) {
      return this.coinm_getCandles(symbol, interval, from, to, timeProfile)
    }

    const productType = this.getProductTypeBySymbol(symbol)
    // `getFuturesHistoricCandles` maps to `/api/v2/mix/market/history-candles`,
    // which serves the FULL history — there is no date floor to apply (bug
    // #225). But a page is bounded TWICE: by the 200-row limit AND by the
    // window-span cap above, and a page that breaks either one yields nothing.
    // Sizing by rows alone is what emptied `1d` (200 rows = 200 days) and `1w`
    // (1400 days) completely, while everything up to `4h` stayed inside the
    // cap and worked (bug #914). Walking the window to its end is what bounds
    // the loop; `maxPages` is only there so a nonsensical range cannot spin.
    const maxSize = 200
    const maxPages = 400 // 80k candles; callers chunk at 200/request
    const pageSpan = Math.min(
      maxSize * timeIntervalMap[interval],
      BITGET_FUTURES_MAX_SPAN_MS,
    )
    const windowEnd = to
    if (from && to) {
      // An empty or inverted range asked for no candles and still does; the
      // row-count budget it used to be measured against went to zero pages.
      if (+to <= +from) {
        return this.returnGood<CandleResponse[]>(timeProfile)([])
      }
      if (+to - +from > pageSpan) {
        to = +from + pageSpan
      }
    }
    const allCandles: CandleResponse[] = []
    for (let attempt = 1; attempt <= maxPages; attempt++) {
      try {
        timeProfile =
          (await this.checkLimits(
            'getFuturesHistoricCandles',
            20,
            timeProfile,
          )) || timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')
        const result = await this.client.getFuturesHistoricCandles({
          symbol,
          productType,
          startTime: `${from}`,
          endTime: `${to}`,
          limit: `${maxSize}`,
          granularity: this.convertInterval(interval) as FuturesKlineInterval,
        })

        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data as string[][]
          allCandles.push(
            ...data.map((d) => ({
              open: d[1],
              high: d[2],
              low: d[3],
              close: d[4],
              volume: d[6],
              time: +d[0],
            })),
          )
        } else {
          return this.handleBitgetErrors(
            this.futures_getCandles,
            symbol,
            interval,
            from,
            to,
            _countData,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
        if (!from || !to || !windowEnd) {
          break
        }
        // The next page starts exactly where this one ended, NOT one bar past
        // it: the venue's window is `[startTime, endTime)`, so the page just
        // read served opens up to `to - interval` and the bar opening at `to`
        // is the FIRST bar of the next page. Advancing past it meant no page
        // ever asked for it, and one bar was lost at every boundary — silently,
        // and invisibly at the merged widths (bug #918). Half-open is why the
        // CURSOR lays out no overlap; it says nothing about the venue's own
        // end-anchoring, which does overlap the final page and is why the
        // result is deduplicated below (bug #920).
        from = +to
        if (+from >= +windowEnd) {
          break
        }
        // Deliberately NOT clamped to `windowEnd`: a page has always been
        // allowed to run past the requested end, and that overhang is what
        // carries the bar the end falls inside — the venue only serves bars
        // that close within the window. Clamping it would quietly drop the
        // in-progress candle from every multi-page read.
        to = +from + pageSpan
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getCandles,
          symbol,
          interval,
          from,
          to,
          _countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(e)
      }
    }

    // Dedup + sort ascending by time, as `spot_getCandles` already does for
    // its own overlapping chunks. The pages the cursor lays out are disjoint,
    // but the last one deliberately overhangs the requested end (spec 019
    // §1.6) and the venue serves a page anchored on its LAST bar: once
    // `endTime` is in the future it answers with the `limit` bars ending at
    // the latest CLOSED one, reaching back before its own `startTime` and
    // re-serving what the previous page already returned (bug #920). Keeping
    // the first copy is safe — every page but the last reads a window wholly
    // in the past, so both copies are of the same closed bar.
    const seen = new Set<number>()
    const deduped = allCandles
      .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
      .sort((a, b) => a.time - b.time)

    return this.returnGood<CandleResponse[]>(timeProfile)(deduped)
  }

  /**
   * Monthly futures bars, as `1Mutc` (UTC calendar months). Each line serves
   * months differently (measured live, 2026-09-24):
   *
   * - classic `history-candles` is anchored on `endTime`: it returns up to
   *   `limit` CLOSED months at or before it whatever `startTime` says, but
   *   still refuses a window wider than 90 days. The still-forming month
   *   comes only from the recent `candles` endpoint.
   * - the unified v3 endpoint (inverse perpetuals) serves exactly the window
   *   asked for, current month included, under the same 90-day cap.
   *
   * Both are walked BACKWARDS from `to` a window at a time until a page comes
   * back empty or reaches `from`. That is correct whichever way a page is
   * bounded: an anchored page carries the whole history and the next one is
   * empty, a windowed page carries ~3 months and the walk continues. Walking
   * forwards from `from` would instead spend one call per 90 days of
   * pre-listing time a long-range chart asks for.
   */
  private async futures_getMonthlyCandles(
    symbol: string,
    from?: number,
    to?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const end = to ? +to : Date.now()
    const floor = from ? utcMonthStart(+from) : -Infinity
    const maxPages = 400
    const candles: CandleResponse[] = []
    const mapRow = (d: string[]): CandleResponse => ({
      time: +d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: d[6],
    })
    const retry = (
      e: Error & { code: number; response?: string },
      tp: typeof timeProfile,
    ) =>
      this.handleBitgetErrors<BaseReturn<CandleResponse[]>>(
        this.futures_getCandles,
        symbol,
        BITGET_MONTH,
        from,
        to,
        undefined,
        this.endProfilerTime(tp, 'exchange'),
      )(e)

    if (this.coinm && !this.isCoinmDelivery(symbol)) {
      let pageEnd = end
      for (let page = 0; page < maxPages; page++) {
        const pageStart = Math.max(pageEnd - BITGET_FUTURES_MAX_SPAN_MS, floor)
        const res = await this.utaRequest<CandleResponse[]>(
          'utaGetCandles',
          () =>
            this.orderClient.getCandlesV3({
              category: 'COIN-FUTURES',
              symbol: this.utaSymbol(symbol),
              interval: '1Mutc',
              limit: '1000',
              startTime: `${pageStart}`,
              endTime: `${pageEnd}`,
            }),
          (data) =>
            ((Array.isArray(data) ? data : []) as string[][]).map(mapRow),
          timeProfile,
        )
        if (res.status === StatusEnum.notok) {
          return res
        }
        timeProfile = res.timeProfile
        candles.push(...res.data)
        if (!res.data.length || pageStart <= floor) {
          break
        }
        pageEnd = pageStart
      }
    } else {
      const productType = this.getProductTypeBySymbol(symbol)
      let pageEnd = end
      for (let page = 0; page < maxPages; page++) {
        try {
          timeProfile =
            (await this.checkLimits(
              'getFuturesHistoricCandles',
              20,
              timeProfile,
            )) || timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          const result = await this.client.getFuturesHistoricCandles({
            symbol,
            productType,
            startTime: `${Math.max(pageEnd - BITGET_FUTURES_MAX_SPAN_MS, 0)}`,
            endTime: `${pageEnd}`,
            limit: '200',
            granularity: '1Mutc',
          })
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code !== '00000') {
            return retry(new BitgetError(result.msg, +result.code), timeProfile)
          }
          const rows = (result.data as string[][]).map(mapRow)
          candles.push(...rows)
          const oldest = Math.min(...rows.map((c) => c.time))
          if (!rows.length || oldest <= floor || oldest >= pageEnd) {
            break
          }
          pageEnd = oldest
        } catch (e) {
          return retry(e, timeProfile)
        }
      }
      // The still-forming month: `history-candles` serves closed bars only.
      if (end >= utcMonthStart(Date.now())) {
        try {
          timeProfile =
            (await this.checkLimits('getFuturesCandles', 20, timeProfile)) ||
            timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          const result = await this.client.getFuturesCandles({
            symbol,
            productType,
            granularity: '1Mutc',
            limit: '1000',
          })
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code !== '00000') {
            return retry(new BitgetError(result.msg, +result.code), timeProfile)
          }
          candles.push(...(result.data as string[][]).map(mapRow))
        } catch (e) {
          return retry(e, timeProfile)
        }
      }
    }

    const seen = new Set<number>()
    return this.returnGood<CandleResponse[]>(timeProfile)(
      candles
        .filter((c) => c.time >= floor && c.time <= end)
        .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
        .sort((a, b) => a.time - b.time),
    )
  }

  /**
   * Bitget's own granularity for an interval on the unified line. `1D` and
   * `1W` there open at 16:00 UTC (the UTC+8 day), as the Reality tokens do,
   * so the UTC-aligned variants are asked for by name. 8h has no granularity
   * of its own on either line; it never reaches here, because
   * `futures_getCandles` reads it at 4h and merges (bug #913).
   */
  private coinmGranularity(interval: ExchangeIntervals): string {
    switch (interval) {
      case ExchangeIntervals.oneW:
        return '1Wutc'
      case ExchangeIntervals.oneD:
        return '1Dutc'
      case ExchangeIntervals.fourH:
        return '4H'
      case ExchangeIntervals.twoH:
        return '2H'
      case ExchangeIntervals.oneH:
        return '1H'
      default:
        // 30m / 15m / 5m / 3m / 1m are named the same on both lines.
        return interval
    }
  }

  /**
   * Candles for an inverse perpetual. v2 serves nothing for these symbols
   * (spec 014 §2.1), so they come from v3 — 1000 rows a page, ascending,
   * `[ts, open, high, low, close, baseVolume, quoteVolume]`.
   *
   * v3 caps the window span at 90 days just as v2 does (measured on
   * DOGEUSD_CM / BTCUSD_CM, 2026-09-24: 90d accepted, 91d refused with
   * `00001` at 4H, 1Dutc and 1Wutc), so a page is bounded by that as well as
   * by the row limit. Sizing by rows alone refused every page from 4h up —
   * `1w` came back empty and the archive could not backfill `1d`. The loop
   * walks the whole window rather than stopping at the first short page: a
   * span-bounded page is short by design, and so is every page before the
   * listing.
   */
  private async coinm_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const pageSize = 1000
    const pageSpan = Math.min(
      pageSize * timeIntervalMap[interval],
      BITGET_FUTURES_MAX_SPAN_MS,
    )
    const pages =
      from && to ? Math.min(Math.ceil((+to - +from) / pageSpan), 400) : 1
    const candles: CandleResponse[] = []
    let start = from
    for (let page = 0; page < Math.max(pages, 1); page++) {
      const end = start ? Math.min(+start + pageSpan, +(to ?? 0)) : to
      const res = await this.utaRequest<CandleResponse[]>(
        'utaGetCandles',
        () =>
          this.orderClient.getCandlesV3({
            category: 'COIN-FUTURES',
            symbol: this.utaSymbol(symbol),
            interval: this.coinmGranularity(interval),
            limit: `${pageSize}`,
            ...(start ? { startTime: `${start}` } : {}),
            ...(end ? { endTime: `${end}` } : {}),
          }),
        (data) =>
          ((Array.isArray(data) ? data : []) as string[][]).map((d) => ({
            time: +d[0],
            open: d[1],
            high: d[2],
            low: d[3],
            close: d[4],
            // The platform's volume for an inverse pair is the quote one, as
            // the classic reader takes for every futures product type.
            volume: d[6],
          })),
        timeProfile,
      )
      if (res.status === StatusEnum.notok) {
        return res
      }
      timeProfile = res.timeProfile
      candles.push(...res.data)
      if (!start || !to) {
        break
      }
      start = +start + pageSpan
      if (start >= +to) {
        break
      }
    }
    // The venue's bounds at a page edge are not a clean half-open window
    // (a bar can come back on both sides of one), so dedup and sort as
    // `futures_getCandles` does for its own pages.
    const seen = new Set<number>()
    const deduped = candles
      .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
      .sort((a, b) => a.time - b.time)
    return this.returnGood<CandleResponse[]>(timeProfile)(deduped)
  }

  async futures_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const res: AllPricesResponse[] = []
    if (this.coinm) {
      res.push(...(await this.coinmPerpPrices()))
    }
    for (const productType of this.productTypes) {
      timeProfile =
        (await this.checkLimits('getFuturesAllTickers', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getFuturesAllTickers({
          productType,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          data.map((o) =>
            res.push({
              pair: o.symbol,
              price: +o.lastPr,
            }),
          )
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllPrices,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<AllPricesResponse[]>(timeProfile)(res)
  }

  async classic_futures_changeMarginType(
    symbol: string,
    margin: MarginType,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('setFuturesMarginMode', 20, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const productType = this.getProductTypeBySymbol(symbol)
    return this.client
      .setFuturesMarginMode({
        symbol,
        productType,
        marginMode: margin === MarginType.ISOLATED ? 'isolated' : 'crossed',
        marginCoin: this.getMarginCoinBySymbolAndProductType(
          symbol,
          productType,
        ),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return this.returnGood<MarginType>(timeProfile)(margin)
        }
        return this.handleBitgetErrors(
          this.classic_futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.classic_futures_changeMarginType,
          symbol,
          margin,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async classic_futures_getHedge(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    timeProfile =
      (await this.checkLimits('getFuturesAccountAsset', 0, timeProfile)) ||
      timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    if (!symbol) {
      const ex = await this.futures_getAllExchangeInfo()
      if (ex.status === StatusEnum.notok) {
        return ex
      }
      symbol = ex.data[0].pair
    }
    const productType = this.getProductTypeBySymbol(symbol)
    return this.client
      .getFuturesAccountAsset({
        symbol,
        productType,
        marginCoin: this.getMarginCoinBySymbolAndProductType(
          symbol,
          productType,
        ),
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<boolean>(timeProfile)(
            data.posMode === 'hedge_mode',
          )
        }
        return this.handleBitgetErrors(
          this.classic_futures_getHedge,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.classic_futures_getHedge,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async classic_futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    for (const productType of this.productTypes) {
      timeProfile =
        (await this.checkLimits('setFuturesPositionMode', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.setFuturesPositionMode({
          productType,
          posMode: value ? 'hedge_mode' : 'one_way_mode',
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code !== '00000') {
          return this.handleBitgetErrors(
            this.classic_futures_setHedge,
            value,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(result.msg, +result.code))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.classic_futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    return this.returnGood<boolean>(timeProfile)(value)
  }

  async futures_leverageBracket(): Promise<BaseReturn<LeverageBracket[]>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<LeverageBracket[]>(all.timeProfile)(
      all.data.map((a) => ({
        symbol: a.pair,
        leverage: a.maxLeverage ? +a.maxLeverage : 100,
        step: a.stepLeverage ? +a.stepLeverage : 1,
        min: a.minLeverage ? +a.minLeverage : 1,
      })),
    )
  }

  /**
   * GET /api/v2/spot/account/info — the same call getApiPermission() makes,
   * read for `authorities` (permission codes) and `ips` (allowlist, a
   * comma-separated string here rather than an array).
   *
   * Bitget does not publish the authority-code vocabulary, so the parser
   * answers `unknown` rather than `no` when it meets a code it does not
   * recognise. See parseBitgetAccountInfo.
   */
  override async getKeyPermissions(): Promise<KeyPermissions> {
    if ((await this.accountMode()) === 'uta') {
      return this.orderClient
        .getAccountInfoV3()
        .then(
          (result) =>
            parseBitgetUtaAccountInfo(result?.data) ??
            unknownPermissions('Unrecognised Bitget UTA account info response'),
        )
        .catch((e) =>
          unknownPermissions(
            `Bitget UTA account info failed: ${e?.body?.msg ?? e?.message ?? e}`,
          ),
        )
    }
    return this.client
      .getSpotAccount()
      .then(
        (result) =>
          parseBitgetAccountInfo(result?.data) ??
          unknownPermissions('Unrecognised Bitget account info response'),
      )
      .catch((e) =>
        unknownPermissions(`Bitget account info failed: ${e?.message ?? e}`),
      )
  }

  async classic_getApiPermission(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotAccount', 0, timeProfile)) || timeProfile
    return this.client
      .getSpotAccount()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const data = result.data
        return this.returnGood<boolean>(timeProfile)(
          this.futures
            ? data.authorities.includes('coow')
            : data.authorities.includes('stow'),
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.classic_getApiPermission,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  override returnGood<T>(
    timeProfile: TimeProfile,
    usage = limitHelper.getInstance().getLimits(),
  ) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  override returnBad(
    timeProfile: TimeProfile,
    usage = limitHelper.getInstance().getLimits(),
  ) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  async cancelOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId?: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.byAccountMode(
      () =>
        this.futures
          ? this.futures_cancelOrder({ symbol, newClientOrderId })
          : this.spot_cancelOrder({ symbol, newClientOrderId }),
      () => this.uta_cancelOrder({ symbol, newClientOrderId }),
    )
  }

  /** Cancel order
   * @param {object} order Order info
   * @param count
   * @param {string} order.symbol pair
   * @param {string} order.newClientOrderId order id
   * @return {Promise<BaseReturn<CommonOrder>>} Order data
   */
  async spot_cancelOrder(
    order: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('spotCancelOrder', 0, timeProfile)) || timeProfile
    return this.client
      .spotCancelOrder({
        symbol: order.symbol,
        clientOid: order.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return await this.spot_getOrder(order, timeProfile)
        }
        return this.handleBitgetErrors(
          this.spot_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_cancelOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async cancelOrderByOrderIdAndSymbol(order: {
    symbol: string
    orderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.byAccountMode(
      () =>
        this.futures
          ? this.futures_cancelOrderByOrderIdAndSymbol(order)
          : this.spot_cancelOrderByOrderIdAndSymbol(order),
      () => this.uta_cancelOrder(order),
    )
  }

  async spot_cancelOrderByOrderIdAndSymbol(
    order: { symbol: string; orderId: string },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('spotCancelOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .spotCancelOrder({
        symbol: order.symbol,
        orderId: order.orderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return await this.spot_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /** Get exchange info for all pairs
   * @return {Promise<BaseReturn<(ExchangeInfo & {pair: string})[]>>} Exchange info about all pair
   */

  async getAllExchangeInfo(): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
      })[]
    >
  > {
    if (this.futures) {
      return this.futures_getAllExchangeInfo()
    }
    return this.spot_getAllExchangeInfo()
  }

  /**
   * Authoritative per-symbol asset class from Bitget's unified v3 instruments
   * endpoint (`symbolType` = crypto | stock | metal | commodity). This is the
   * ONLY Bitget endpoint that classifies real-world assets — the classic
   * spot/futures `symbolType` is just `perpetual`. Returns a symbol→class map;
   * on any failure returns an empty map (rows fall back to undefined → crypto).
   * `category`: SPOT | USDT-FUTURES | COIN-FUTURES | USDC-FUTURES (demo `S`
   * prefix stripped — v3 only knows the live categories).
   */
  private async bitgetAssetClassMap(
    category: string,
  ): Promise<Map<string, ExchangeInfo['assetClass']>> {
    const map = new Map<string, ExchangeInfo['assetClass']>()
    // Demo futures categories are S-prefixed (SUSDT-FUTURES …); v3 only knows
    // the live names. Strip the leading S ONLY for those — never for SPOT.
    const liveCategory = category.replace(
      /^S(?=(?:USDT|USDC|COIN)-FUTURES$)/,
      '',
    )
    try {
      const res = await this.orderClient.getInstrumentsV3({
        category: liveCategory,
      })
      if (res?.code === '00000' && Array.isArray(res.data)) {
        if (liveCategory === 'SPOT') {
          setRealitySymbols(
            res.data
              .filter((d) => `${d?.isReality}`.toLowerCase() === 'yes')
              .map((d) => d.symbol),
          )
        }
        for (const d of res.data) {
          const st = d?.symbolType
          if (
            st === 'crypto' ||
            st === 'stock' ||
            st === 'metal' ||
            st === 'commodity'
          ) {
            map.set(d.symbol, st)
          }
        }
      }
    } catch (e) {
      if (liveCategory === 'SPOT') {
        setRealitySymbols(null)
      }
      Logger.warn(
        `bitget v3 instruments ${liveCategory} failed: ${(e as Error)?.message}`,
      )
    }
    return map
  }

  private async isRealitySymbol(symbol: string): Promise<boolean> {
    const cached = getRealitySymbols()
    if (cached) {
      return cached.has(symbol)
    }
    await this.bitgetAssetClassMap('SPOT')
    return !!getRealitySymbols()?.has(symbol)
  }

  async futures_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        maxLeverage?: string
        stepLeverage?: string
        minLeverage?: string
        makerFee: number
        takerFee: number
        marginCoins?: string[]
      })[]
    >
  > {
    const res: (ExchangeInfo & {
      pair: string
      maxLeverage?: string
      stepLeverage?: string
      minLeverage?: string
      makerFee: number
      takerFee: number
      marginCoins?: string[]
    })[] = []
    for (const productType of this.productTypes) {
      try {
        timeProfile =
          (await this.checkLimits('getAllExchangeInfo', 20, timeProfile)) ||
          timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')
        const get = await this.client.getFuturesContractConfig({ productType })
        // Authoritative asset class (crypto/stock/metal/commodity) from the v3
        // instruments endpoint — keyed by symbol for this productType.
        const assetClassMap = await this.bitgetAssetClassMap(productType)
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (get.code === '00000') {
          const data = get.data
          data
            .filter((d) => d.symbolStatus === 'normal')
            .map((d) => {
              const r: (typeof res)[0] = {
                pair: d.symbol,
                // Authoritative class from Bitget v3 (undefined => main-app
                // defaults to crypto). No heuristics.
                assetClass: assetClassMap.get(d.symbol),
                baseAsset: {
                  minAmount: +d.minTradeNum,
                  maxAmount: 0,
                  step:
                    +d.volumePlace === 0
                      ? 1
                      : +`0.${'0'.repeat(+d.volumePlace - 1)}1`,
                  name: d.baseCoin,
                  maxMarketAmount: 0,
                  multiplier: +d.sizeMultiplier,
                },
                quoteAsset: {
                  minAmount: +d.minTradeUSDT,
                  name: d.quoteCoin,
                },
                maxOrders: +d.maxSymbolOrderNum,
                priceAssetPrecision: +d.pricePlace,
                minLeverage: d.minLever,
                maxLeverage: d.maxLever,
                makerFee: +d.makerFeeRate,
                takerFee: +d.takerFeeRate,
                priceMultiplier: {
                  up: +d.sellLimitPriceRatio,
                  down: +d.buyLimitPriceRatio,
                  decimals:
                    +d.pricePlace > 0
                      ? +`0.${'0'.repeat(+d.pricePlace - 1)}${+d.priceEndStep}`
                      : +`${+d.priceEndStep}${'0'.repeat(-+d.pricePlace)}`,
                },
              }
              if (this.coinm) {
                r.marginCoins = d.supportMarginCoins
              }
              res.push(r)
            })
        } else {
          return this.handleBitgetErrors(
            this.futures_getAllExchangeInfo,
            this.endProfilerTime(timeProfile, 'exchange'),
          )(new BitgetError(get.msg, 0))
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.futures_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(e?.body?.msg ?? e.message, 0))
      }
    }
    if (this.coinm) {
      // The perpetuals of this product type are only on the unified line
      // (spec 014 §3.1). The listing is public, so every account gets it;
      // what a classic account cannot do is trade them (§3.3).
      res.push(...((await this.coinmPerpExchangeInfo()) as typeof res))
    }
    return this.returnGood<typeof res>(timeProfile)(res)
  }

  /**
   * The v3 `COIN-FUTURES` instruments, as listing rows under their historic
   * names. Their quantity unit is the venue's, not the platform's: an order
   * is a whole number of 1-USD contracts, so the base step cannot be stated
   * as a fixed size — the boundary rounds to the contract (spec 014 §3.4) and
   * the venue's own minimum notional is carried on the quote side.
   */
  private async coinmPerpExchangeInfo(): Promise<
    (ExchangeInfo & {
      pair: string
      maxLeverage?: string
      minLeverage?: string
      makerFee: number
      takerFee: number
      marginCoins?: string[]
    })[]
  > {
    try {
      await this.checkLimits('getAllExchangeInfo', 0)
      const get = await this.orderClient.getInstrumentsV3({
        category: 'COIN-FUTURES',
      })
      if (get?.code !== '00000' || !Array.isArray(get.data)) {
        return []
      }
      return get.data
        .filter(
          (d: Record<string, string>) =>
            d?.status === 'online' && `${d?.type}` === 'perpetual',
        )
        .map((d: Record<string, string>) => ({
          pair: platformCoinmSymbol(d.symbol),
          assetClass:
            d.symbolType === 'crypto' ||
            d.symbolType === 'stock' ||
            d.symbolType === 'metal' ||
            d.symbolType === 'commodity'
              ? (d.symbolType as ExchangeInfo['assetClass'])
              : undefined,
          baseAsset: {
            name: d.baseCoin,
            // The contract, not the coin, is the unit the venue rounds to, so
            // there is no base step to state: consumers derive the base
            // precision from this, and the boundary rounds to the contract.
            minAmount: 0.00000001,
            maxAmount: 0,
            maxMarketAmount: 0,
            step: 0.00000001,
          },
          quoteAsset: {
            name: d.quoteCoin,
            minAmount: +d.minOrderAmount,
          },
          maxOrders: +d.maxSymbolOrderNum || +d.maxProductOrderNum || 200,
          priceAssetPrecision: +d.pricePrecision,
          minLeverage: d.minLeverage,
          maxLeverage: d.maxLeverage,
          makerFee: +d.makerFeeRate,
          takerFee: +d.takerFeeRate,
          priceMultiplier: {
            up: +d.sellLimitPriceRatio,
            down: +d.buyLimitPriceRatio,
            decimals: +d.priceMultiplier,
          },
          // Inverse contracts are margined in the coin they are written on.
          marginCoins: [d.baseCoin],
        }))
    } catch (e) {
      Logger.warn(
        `bitget v3 COIN-FUTURES instruments failed: ${(e as Error)?.message}`,
      )
      return []
    }
  }

  /** Last prices for the inverse perpetuals, which v2 does not quote. */
  private async coinmPerpPrices(): Promise<AllPricesResponse[]> {
    try {
      await this.checkLimits('utaGetTickers', 0)
      const res = await this.orderClient.getTickersV3({
        category: 'COIN-FUTURES',
      })
      if (res?.code !== '00000' || !Array.isArray(res.data)) {
        return []
      }
      return res.data
        .map((t: Record<string, string>) => ({
          pair: platformCoinmSymbol(t.symbol),
          price: +t.lastPrice,
        }))
        .filter((t: AllPricesResponse) => Number.isFinite(t.price))
    } catch (e) {
      Logger.warn(
        `bitget v3 COIN-FUTURES tickers failed: ${(e as Error)?.message}`,
      )
      return []
    }
  }
  async spot_getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<
    BaseReturn<
      (ExchangeInfo & {
        pair: string
        makerFee: number
        takerFee: number
      })[]
    >
  > {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotSymbolInfo', 20, timeProfile)) ||
      timeProfile
    const prices = await this.spot_getAllPrices()
    // Authoritative asset class (crypto/stock/metal/commodity) from Bitget v3.
    const assetClassMap = await this.bitgetAssetClassMap('SPOT')
    return this.client
      .getSpotSymbolInfo()
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return this.returnGood<
            (ExchangeInfo & {
              pair: string
              makerFee: number
              takerFee: number
            })[]
          >(timeProfile)(
            data
              .filter((d) => d.status === 'online')
              // Reality stock tokens (rAAPL/rTSLA/…) are API-tradeable from a
              // Unified Trading Account since 2026-09-03 and are listed. Other
              // spot rows Bitget classes as `stock` (pre-IPO tokens) are still
              // not known to be API-tradeable and stay out. Metals like
              // PAXG/XAUT are ordinary spot tokens and stay.
              .filter(
                (d) =>
                  assetClassMap.get(d.symbol) !== 'stock' ||
                  !!getRealitySymbols()?.has(d.symbol),
              )
              .map((d) => {
                const p = prices?.data?.find(
                  (p) => p.pair === `${d.quoteCoin}USDT`,
                )
                const q =
                  d.quoteCoin === 'USDT' || d.quoteCoin === 'USDC'
                    ? +d.minTradeUSDT
                    : +d.minTradeUSDT / +(p?.price ?? 1)
                // Bitget exposes no underlying-ticker field. Its Reality tokens
                // are named `r` + the stock ticker (`rAAPL`, single-letter `rT`),
                // so the underlying is taken ONLY for rows v3 flags `isReality`;
                // any other base is left alone rather than guessed from shape.
                const underlying =
                  getRealitySymbols()?.has(d.symbol) &&
                  /^r[A-Z]/.test(d.baseCoin)
                    ? d.baseCoin.slice(1)
                    : undefined
                const res = {
                  pair: d.symbol,
                  assetClass: assetClassMap.get(d.symbol),
                  ...(underlying ? { underlying } : {}),
                  baseAsset: {
                    minAmount: +d.minTradeAmount,
                    maxAmount: +d.maxTradeAmount,
                    step:
                      +d.quantityPrecision === 0
                        ? 1
                        : +`0.${'0'.repeat(+d.quantityPrecision - 1)}1`,
                    name: d.baseCoin,
                    maxMarketAmount: 0,
                  },
                  quoteAsset: {
                    minAmount: +q,
                    name: d.quoteCoin,
                    precision: +d.quotePrecision,
                  },
                  maxOrders: +d.orderQuantity,
                  priceAssetPrecision: +d.pricePrecision,
                  makerFee: +d.makerFeeRate,
                  takerFee: +d.takerFeeRate,
                  priceMultiplier: {
                    up: +d.sellLimitPriceRatio,
                    down: +d.buyLimitPriceRatio,
                    decimals: 0,
                  },
                }
                return res
              }),
          )
        }
        return this.handleBitgetErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getAllExchangeInfo,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: false,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: true,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]> | BaseReturn<number>> {
    return this.byAccountMode<CommonOrder[] | number>(
      () =>
        this.futures
          ? this.futures_getAllOpenOrders(symbol, returnOrders)
          : this.spot_getAllOpenOrders(symbol, returnOrders),
      () =>
        this.uta_getAllOpenOrders(symbol, returnOrders) as Promise<
          BaseReturn<CommonOrder[] | number>
        >,
    ) as Promise<BaseReturn<CommonOrder[]> | BaseReturn<number>>
  }

  /** Get all open orders for given pair
   * @param {string} symbol symbol to look for
   * @param {boolean} [returnOrders] return orders or orders count. Default = false
   * @return {Promise<BaseReturn<CommonOrder[]>> | Promise<BaseReturn<number>>} Array of opened orders or orders count if returnOrders set to true
   */
  async spot_getAllOpenOrders(symbol?: string): Promise<BaseReturn<number>>
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders?: boolean,
  ): Promise<BaseReturn<CommonOrder[]>>
  async spot_getAllOpenOrders(
    symbol?: string,
    returnOrders = false,
    timeProfile = this.getEmptyTimeProfile(),
  ) {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    timeProfile =
      (await this.checkLimits('getSpotOpenOrders', 0, timeProfile)) ||
      timeProfile
    return this.client
      .getSpotOpenOrders({ symbol })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          return {
            timeProfile,
            usage: limitHelper.getInstance().getLimits(),
            status: StatusEnum.ok as StatusEnum.ok,
            data: returnOrders
              ? data.map((d) =>
                  this.convertSpotOrder(d as unknown as SpotOrderInfoV2),
                )
              : data.length,
          }
        }
        return this.handleBitgetErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllUserFees(): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    return this.byAccountMode(
      () =>
        this.futures
          ? this.futures_getAllUserFees()
          : this.spot_getAllUserFees(),
      () => this.uta_getAllUserFees(),
    )
  }

  /** Get user fee for all pairs
   * @return {Promise<BaseReturn<(UserFee & {pair: string})[]>>} maker and taker fee all pairs
   */
  async spot_getAllUserFees(): Promise<
    BaseReturn<(UserFee & { pair: string })[]>
  > {
    const res = await this.spot_getAllExchangeInfo()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const fees: (UserFee & { pair: string })[] = []
    const chunks: (typeof res.data)[] = []
    for (let i = 0; i < res.data.length; i += 8) {
      chunks.push(res.data.slice(i, i + 8))
    }
    // A unified account refuses every classic endpoint, and a dead, IP-locked
    // or restricted key refuses every pair. Swallowing that into a per-pair
    // warning spends one refused call on every listed pair and hands back the
    // listed rates instead of the account's own, so the refusal is returned as
    // this call's result — which routes a unified account to v3
    // (`byAccountMode`) and shows the caller one key error instead of one per
    // pair.
    let refusal: string | undefined
    for (const ch of chunks) {
      if (refusal) {
        break
      }
      await Promise.all(
        ch.map(async (p) => {
          const f = await this.spot_getUserFees(p.pair)
          if (f.status === StatusEnum.notok) {
            if (isUnifiedModeRefusal(f.reason) || isKeyRefusal(f.reason)) {
              refusal = refusal ?? `${f.reason}`
              return
            }
            Logger.warn(`Error getting spot fees for ${p.pair} ${f.reason}`)
            fees.push({ pair: p.pair, maker: p.makerFee, taker: p.takerFee })
          } else {
            fees.push({
              pair: p.pair,
              maker: f.data.maker,
              taker: f.data.taker,
            })
          }
        }),
      )
    }
    if (refusal) {
      return this.returnBad(res.timeProfile)(new Error(refusal))
    }
    return this.returnGood<(UserFee & { pair: string })[]>(res.timeProfile)(
      fees,
    )
  }

  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    return this.byAccountMode(
      () => (this.futures ? this.futures_getBalance() : this.spot_getBalance()),
      () => this.uta_getBalance(),
    )
  }

  /** Bybit get balance
   * get user account info from bybit and look for necessary balances
   *
   * @returns {Promise<BaseReturn<FreeAsset>>}
   */
  async spot_getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const res: FreeAsset = []

    try {
      timeProfile =
        (await this.checkLimits('getSpotAccountAssets', 0, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getSpotAccountAssets()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data
        data.map((d) => {
          res.push({
            asset: d.coin,
            free: +d.available,
            locked: +d.locked + +d.frozen,
          })
        })
      } else {
        return this.handleBitgetErrors(
          this.spot_getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getBalance,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<FreeAsset>(timeProfile)(res)
  }

  /** Get exchange info for given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @return {Promise<BaseReturn<ExchangeInfo>>} Exchange info about pair
   */

  async getExchangeInfo(symbol: string): Promise<BaseReturn<ExchangeInfo>> {
    if (this.futures) {
      return await this.futures_getExchangeInfo(symbol)
    }
    return await this.spot_getExchangeInfo(symbol)
  }

  async spot_getExchangeInfo(
    symbol: string,
  ): Promise<BaseReturn<ExchangeInfo>> {
    const all = await this.getAllExchangeInfo()
    if (all.status === StatusEnum.notok) {
      return all
    }
    return this.returnGood<ExchangeInfo>(all.timeProfile)(
      all.data.find((s) => s.pair === symbol),
    )
  }

  async getOrder({
    symbol,
    newClientOrderId,
  }: {
    symbol: string
    newClientOrderId: string
  }): Promise<BaseReturn<CommonOrder>> {
    return this.byAccountMode(
      () =>
        this.futures
          ? this.futures_getOrder({ symbol, newClientOrderId })
          : this.spot_getOrder({ symbol, newClientOrderId }),
      () => this.uta_getOrder({ symbol, newClientOrderId }),
    )
  }

  async spot_getOrder(
    data: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('getSpotOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    return this.client
      .getSpotOrder({
        clientOid: data.newClientOrderId,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          let _data = result.data?.[0]
          if (!_data) {
            timeProfile =
              (await this.checkLimits('getSpotOrder', 0, timeProfile)) ||
              timeProfile
            timeProfile = this.startProfilerTime(timeProfile, 'exchange')
            _data = (
              await this.client.getSpotHistoricOrders({
                symbol: data.symbol,
                orderId: data.newClientOrderId,
              })
            )?.data?.[0]
            timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          }
          if (_data) {
            return this.returnGood<CommonOrder>(timeProfile)(
              this.convertSpotOrder(_data),
            )
          } else {
            return this.returnBad(timeProfile)(
              new BitgetError('Order not found', -1),
            )
          }
        }
        return this.handleBitgetErrors(
          this.spot_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_getOrder,
          data,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }
  async getUserFees(symbol: string): Promise<BaseReturn<UserFee>> {
    return this.byAccountMode(
      () =>
        this.futures
          ? this.futures_getUserFees(symbol)
          : this.spot_getUserFees(symbol),
      () => this.uta_getUserFees(symbol),
    )
  }
  /** Get user fee for given pair
   * @param {string} _symbol symbol to look for
   * @return {Promise<BaseReturn<UserFee>>} maker and taker fee for given symbol
   */
  async spot_getUserFees(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    try {
      timeProfile =
        (await this.checkLimits('getTradeRate', 0, timeProfile)) || timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      const get = await this.client.getTradeRate({
        businessType: 'spot',
        symbol,
      })
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (get.code === '00000') {
        const data = get.data as { makerFeeRate: string; takerFeeRate: string }
        return this.returnGood<UserFee>(timeProfile)({
          maker: +data.makerFeeRate,
          taker: +data.takerFeeRate,
        })
      } else {
        return this.handleBitgetErrors(
          this.spot_getUserFees,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(get.msg, 0))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getUserFees,
        symbol,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }
  }

  async latestPrice(symbol: string): Promise<BaseReturn<number>> {
    if (this.futures) {
      return await this.futures_latestPrice(symbol)
    }
    return await this.spot_latestPrice(symbol)
  }

  /** Get the latest price for a given pair
   * @param {string} symbol symbol to look for
   * @param count
   * @returns {Promise<BaseReturn<number>>} latest price
   */
  async spot_latestPrice(symbol: string): Promise<BaseReturn<number>> {
    const res = await this.spot_getAllPrices()
    if (res.status === StatusEnum.notok) {
      return res
    }
    const found = res.data.find((p) => p.pair === symbol)
    // See futures_latestPrice — an unlisted/delisted pair is an error, not a 0 quote.
    if (!found) {
      return this.returnBad(res.timeProfile)(
        new Error(`Symbol not found on exchange: ${symbol}`),
      )
    }
    return this.returnGood<number>(res.timeProfile)(found.price)
  }

  async openOrder(order: {
    symbol: string
    side: OrderTypes
    quantity: number
    price: number
    newClientOrderId?: string
    type?: OrderTypeT
    reduceOnly?: boolean
    positionSide?: PositionSide
    marginType?: MarginType
  }): Promise<BaseReturn<CommonOrder>> {
    return this.byAccountMode(
      async () => {
        if (this.futures) {
          // An inverse perpetual exists only on the unified line, so a key
          // known to be classic is told that rather than the venue's "symbol
          // does not exist" (spec 014 §3.3).
          if (
            this.coinm &&
            !this.isCoinmDelivery(order.symbol) &&
            getCachedAccountMode(this.key) === 'classic'
          ) {
            return this.returnBad(this.getEmptyTimeProfile())(
              new Error(COINM_PERP_NEEDS_UTA),
            )
          }
          return this.futures_openOrder(order)
        }
        // Only a key known to be classic gets the explanation up front; an
        // undetermined one tries classic, whose refusal routes a unified
        // account to v3.
        if (
          getCachedAccountMode(this.key) === 'classic' &&
          (await this.isRealitySymbol(order.symbol))
        ) {
          return this.returnBad(this.getEmptyTimeProfile())(
            new Error(REALITY_NEEDS_UTA),
          )
        }
        return this.spot_openOrder(order)
      },
      () => this.uta_openOrder(order),
    )
  }

  /** Open order function
   * @param {object} order Order data
   * @param count
   * @param {string} order.symbol pair
   * @param {OrderTypes} order.side BUY or SELL
   * @param {number} order.quantity quantity
   * @param {number} order.price limit price
   * @param {string} order.newClientOrderId order id, optional
   * @param {LIMIT | MARKET} order.type order type
   * @return {Promise<BaseReturn<CommonOrder>>}
   */
  async spot_openOrder(
    order: {
      symbol: string
      side: OrderTypes
      quantity: number
      price: number
      newClientOrderId?: string
      type?: 'LIMIT' | 'MARKET'
      reduceOnly?: boolean
      positionSide?: PositionSide
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    timeProfile =
      (await this.checkLimits('spotSubmitOrder', 0, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    const options = {
      symbol: order.symbol,
      orderType: order.type === 'LIMIT' ? 'limit' : 'market',
      size: order.quantity,
      price: order.price,
      side: order.side === 'BUY' ? 'buy' : 'sell',
      clientOid: order.newClientOrderId,
      force: order.type === 'LIMIT' ? 'gtc' : undefined,
    }
    if (!options.force) {
      delete options.force
    }
    return this.orderClient
      .spotSubmitOrder(options)
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          const data = result.data
          if (options.orderType === 'market') {
            await sleep(1000)
          }
          return await this.spot_getOrder(
            { symbol: order.symbol, newClientOrderId: data.clientOid },
            timeProfile,
          )
        }
        return this.handleBitgetErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      })
      .catch(
        this.handleBitgetErrors(
          this.spot_openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    count?: number,
  ): Promise<BaseReturn<CandleResponse[]>> {
    if (this.futures) {
      return await this.futures_getCandles(symbol, interval, from, to, count)
    }
    return await this.spot_getCandles(symbol, interval, from, to, count)
  }

  /**
   * Bitget spot `getSpotCandles` (recent) supports a limited lookback per
   * granularity. Anything older must be fetched via `getSpotHistoricCandles`
   * which only accepts `endTime` + `limit` and walks backward.
   *
   * These are MEASURED against the live API, not taken from the docs — the
   * documented figures are too optimistic and asking `/spot/market/candles`
   * for a window it cannot reach yields `code 00000` with an empty (or
   * silently truncated) page, i.e. a hole in the series rather than an error
   * (bug #245). Measured 2026-08-01 on BTCUSDT, as the oldest chunk start a
   * recent page still fully covers; each is 1 day inside the real cliff so a
   * boundary chunk cannot land on the wrong side of it:
   *
   *   1min/5min/15min/30min  31.00d  ->  30d
   *   1h                     60.00d  ->  59d
   *   4h                    240.00d  -> 239d
   *   6Hutc                 360.17d  -> 355d   (1Dutc >1200d, 1Wutc 705d)
   *
   * Re-measure with a 200-candle window walked back per granularity. The
   * numbers drift; `spot_getCandles` no longer depends on them being exact.
   */
  private getSpotIntervalLookbackMs(interval: ExchangeIntervals): number {
    const day = 24 * 60 * 60 * 1000
    switch (interval) {
      case ExchangeIntervals.oneM:
      case ExchangeIntervals.threeM:
      case ExchangeIntervals.fiveM:
      case ExchangeIntervals.fifteenM:
      case ExchangeIntervals.thirtyM:
        // Every sub-hour granularity shares one 31-day floor.
        return 30 * day
      // `twoH` is read at granularity `1h` and merged (see bitgetBaseInterval),
      // so it inherits the 1h window rather than a wider one of its own; it
      // reaches here only through that recursion, as `oneH`.
      case ExchangeIntervals.oneH:
      case ExchangeIntervals.twoH:
        return 59 * day
      // `eightH` likewise arrives here as `fourH`.
      case ExchangeIntervals.fourH:
        return 239 * day
      default:
        // 1d / 1w — 1Dutc reaches >1200d and 1Wutc 705d.
        return 355 * day
    }
  }

  async spot_getCandles(
    symbol: string,
    interval: ExchangeIntervals,
    from?: number,
    to?: number,
    countData?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    // `from`/`to` are typed `number` and are NOT numbers at runtime: the
    // controller binds them with `@Query` and no transforming pipe is
    // installed, so every read through `GET /candles` delivers the raw query
    // strings. The pager below is the one place that ADDS to them
    // (`cursor + size * step`), and on a string that concatenates — a 13-digit
    // epoch and a 9-digit page span become a ~22-digit number that is always
    // past `to`, so every chunk clamped to `to`, the first call answered with
    // the most recent page and `advanceCursor` ended the loop. One page for
    // any range, silently (bug #921). `futures_getCandles` coerces with unary
    // `+` at each arithmetic use, which is why futures never had this.
    // Coerced once here rather than per use so the recursion below at the base
    // interval, and anything added later, is right by construction. Left as-is
    // when absent: both are optional and the single-call branches below select
    // on truthiness, which `+undefined` (NaN) would not survive.
    from = from == null ? from : +from
    to = to == null ? to : +to
    // Bitget candle page caps differ by endpoint (verified against the live
    // API docs): recent /spot/market/candles serves up to 1000 per call, but
    // /spot/market/history-candles is hard-capped at 200. Paging recent reads
    // at 1000 cuts request count — and the rate-limit "must sleep" churn it
    // drives — by ~5x.
    const recentMaxSize = 1000
    const historicMaxSize = 200
    const reality = await this.isRealitySymbol(symbol)
    // Monthly: the recent endpoint answers with every month the pair has
    // traded, the forming one included (99 for BTCUSDT, measured 2026-09-24),
    // so one call covers any range and is cut down to it here — the pagers
    // below price their pages by a fixed bar width a month does not have.
    if (interval === BITGET_MONTH && !reality) {
      timeProfile =
        (await this.checkLimits('getSpotCandles', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getSpotCandles({
          symbol,
          granularity: '1Mutc',
          limit: '1000',
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code !== '00000') {
          return this.handleBitgetErrors(
            this.spot_getCandles,
            symbol,
            interval,
            from,
            to,
            countData,
            timeProfile,
          )(new BitgetError(result.msg, +result.code))
        }
        const floor = from ? utcMonthStart(from) : -Infinity
        const end = to ?? Infinity
        return this.returnGood<CandleResponse[]>(timeProfile)(
          (result.data as string[][])
            .map((d) => ({
              open: d[1],
              high: d[2],
              low: d[3],
              close: d[4],
              volume: d[7],
              time: +d[0],
            }))
            .filter((c) => c.time >= floor && c.time <= end)
            .sort((a, b) => a.time - b.time),
        )
      } catch (e) {
        return this.handleBitgetErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(e)
      }
    }
    // Reality tokens are served from the few granularities they have; every
    // other pair from the classic set, which has no `2h` and no `8h` (bug
    // #913). Either way a width the venue cannot serve is read at a finer one
    // and merged, never substituted.
    const baseInterval = reality
      ? realityBaseInterval(interval)
      : bitgetBaseInterval(interval, false)
    if (baseInterval !== interval) {
      const base = await this.spot_getCandles(
        symbol,
        baseInterval,
        from,
        to,
        countData,
        timeProfile,
      )
      if (base.status === StatusEnum.notok) {
        return base
      }
      return this.returnGood<CandleResponse[]>(base.timeProfile)(
        aggregateCandles(
          base.data,
          timeIntervalMap[interval],
          interval === ExchangeIntervals.oneW,
        ),
      )
    }
    const granularity = (
      reality ? realityGranularity(interval) : this.convertInterval(interval)
    ) as SpotKlineInterval
    const step = timeIntervalMap[interval]
    const lookbackMs = this.getSpotIntervalLookbackMs(interval)

    const mapRow = (d: string[]): CandleResponse => ({
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: d[7],
      time: +d[0],
    })

    // Legacy behavior: only `to` provided → single historic call.
    if (to && !from) {
      timeProfile =
        (await this.checkLimits('getSpotHistoricCandles', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      return this.client
        .getSpotHistoricCandles({
          symbol,
          endTime: `${to}`,
          limit: `${historicMaxSize}`,
          granularity,
        })
        .then((result) => {
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          if (result.code === '00000') {
            return this.returnGood<CandleResponse[]>(timeProfile)(
              (result.data as string[][]).map(mapRow),
            )
          }
          return this.handleBitgetErrors(
            this.spot_getCandles,
            symbol,
            interval,
            from,
            to,
            countData,
            timeProfile,
          )(new BitgetError(result.msg, +result.code))
        })
        .catch(
          this.handleBitgetErrors(
            this.spot_getCandles,
            symbol,
            interval,
            from,
            to,
            countData,
            this.endProfilerTime(timeProfile, 'exchange'),
          ),
        )
    }

    // No range at all → most recent page.
    if (!from || !to) {
      timeProfile =
        (await this.checkLimits('getSpotCandles', 20, timeProfile)) ||
        timeProfile
      timeProfile = this.startProfilerTime(timeProfile, 'exchange')
      try {
        const result = await this.client.getSpotCandles({
          symbol,
          //@ts-ignore
          limit: recentMaxSize,
          granularity,
        })
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code === '00000') {
          return this.returnGood<CandleResponse[]>(timeProfile)(
            (result.data as string[][]).map(mapRow),
          )
        }
        return this.handleBitgetErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          timeProfile,
        )(new BitgetError(result.msg, +result.code))
      } catch (e) {
        return this.handleBitgetErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(e)
      }
    }

    // Both `from` and `to` provided → paginate in chunks of `maxSize`,
    // selecting recent vs historic endpoint per chunk based on `lookbackMs`.
    const allCandles: CandleResponse[] = []
    let cursor = from
    // `/spot/market/candles` serves `(startTime, endTime]` — open at the start
    // (spec 025 §2.1) — so a chunk asking `startTime: cursor` gets its first
    // bar at `cursor + step`. `advanceCursor` already pays for that at every
    // LATER boundary (`cursor = pageEnd - step`, bug #918); the FIRST chunk is
    // the one boundary it cannot reach, because there is no preceding page to
    // step back from. So the bar opening exactly at `from` was never inside any
    // requested window and the series silently began one bar late (bug #924).
    //
    // Seeding the cursor is what fixes it, NOT `startTime: cursor - step` at
    // the call site: the venue anchors its `limit` cap on `endTime` and
    // truncates at the START, so widening the window to 1001 bars at
    // `limit: 1000` just has the extra bar capped straight back off (measured
    // live). Moving the seed moves `chunkEnd` with it and the page stays
    // exactly `recentMaxSize` wide.
    //
    // Only when the first chunk will use the recent endpoint. The historic one
    // is `endTime`-anchored and already reaches back to exactly `cursor` (spec
    // 025 §2.2), so back-stepping it would return a bar opening BEFORE `from`
    // and shift every later chunk boundary. The predicate is the loop's own,
    // evaluated on the back-stepped value, so the seed cannot disagree with the
    // branch the loop then takes.
    if (Date.now() - (cursor - step) <= lookbackMs) {
      cursor -= step
    }
    // Size the safety cap off the smaller (historic) page so it never
    // under-counts iterations when a range mixes recent + historic chunks.
    const totalChunks = Math.max(
      1,
      Math.ceil((to - from) / (historicMaxSize * step)),
    )
    // safety cap
    const hardLimit = totalChunks + 5
    /**
     * Move the cursor onto the first bar the page ending at `pageEnd` did not
     * serve, and say whether there is anything left to ask for.
     *
     * The two spot candle endpoints disagree about `endTime`, so there is no
     * single "last bar served" to step past: `/spot/market/candles` serves
     * `(startTime, endTime]` and ends ON `pageEnd`, while
     * `/spot/market/history-candles` serves `[…, endTime)` and ends one bar
     * before it. Stepping BACK one bar is the only rule that leaves no hole
     * whichever pair of endpoints meets at the boundary; it costs at most two
     * bars of overlap, which the dedup at the end of this method absorbs. The
     * cursor used to advance one bar PAST `pageEnd`, which skipped a bar at
     * every boundary and two across the historic -> recent switch (bug #918).
     *
     * `chunkEnd` is clamped to `to`, so a cursor that no longer jumps past the
     * end needs this to stop: a page that reached `to` covered the window, and
     * re-asking it would just spin to `hardLimit`.
     */
    const advanceCursor = (pageEnd: number): boolean => {
      if (pageEnd >= to) {
        return false
      }
      cursor = pageEnd - step
      return true
    }
    for (let attempt = 0; attempt < hardLimit && cursor <= to; attempt++) {
      const useRecent = Date.now() - cursor <= lookbackMs
      // Stride each chunk by the page size of the endpoint it will use: a
      // recent chunk advances 1000 bars, a historic chunk 200. Striding recent
      // at 200 would waste 5x the calls; striding historic at 1000 would skip
      // bars the 200-capped history endpoint can't return.
      const size = useRecent ? recentMaxSize : historicMaxSize
      const chunkEnd = Math.min(cursor + size * step, to)

      try {
        timeProfile =
          (await this.checkLimits(
            useRecent ? 'getSpotCandles' : 'getSpotHistoricCandles',
            20,
            timeProfile,
          )) || timeProfile
        timeProfile = this.startProfilerTime(timeProfile, 'exchange')

        const result = useRecent
          ? await this.client.getSpotCandles({
              symbol,
              //@ts-ignore
              startTime: cursor,
              //@ts-ignore
              endTime: chunkEnd,
              //@ts-ignore
              limit: recentMaxSize,
              granularity,
            })
          : await this.client.getSpotHistoricCandles({
              symbol,
              endTime: `${chunkEnd}`,
              limit: `${historicMaxSize}`,
              granularity,
            })

        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (result.code !== '00000') {
          return this.handleBitgetErrors(
            this.spot_getCandles,
            symbol,
            interval,
            from,
            to,
            countData,
            timeProfile,
          )(new BitgetError(result.msg, +result.code))
        }

        const data = result.data as string[][]

        // A recent chunk can fail to cover the head of its own window without
        // ever saying so: past its (drifting) lookback, `/spot/market/candles`
        // answers `code 00000` with either an empty page or one clamped to the
        // floor, both of which read exactly like "no trades in this window".
        // Skipping it punches a hole mid-series, and a hole ends a backtest —
        // the dashboard loader reads an empty page as the end of history
        // (bug #245). Re-ask the window from the historic endpoint, which has
        // no such floor, before writing it off. It is `endTime`-only and
        // 200-capped, so re-cut the chunk to that size and advance the cursor
        // by what we actually re-read.
        const coversStart = !!data?.length && +data[0][0] <= cursor + step
        if (useRecent && !coversStart) {
          const retryEnd = Math.min(cursor + historicMaxSize * step, chunkEnd)
          timeProfile =
            (await this.checkLimits(
              'getSpotHistoricCandles',
              20,
              timeProfile,
            )) || timeProfile
          timeProfile = this.startProfilerTime(timeProfile, 'exchange')
          const retry = await this.client.getSpotHistoricCandles({
            symbol,
            endTime: `${retryEnd}`,
            limit: `${historicMaxSize}`,
            granularity,
          })
          timeProfile = this.endProfilerTime(timeProfile, 'exchange')
          const retryData = retry.data as string[][]
          if (retry.code === '00000' && retryData?.length) {
            allCandles.push(...retryData.map(mapRow))
            if (!advanceCursor(retryEnd)) {
              break
            }
            continue
          }
          // History has nothing either — genuinely no data here. Fall through
          // and keep whatever the recent page did return.
        }

        if (!data || data.length === 0) {
          // nothing in this window — advance to avoid infinite loop
          if (!advanceCursor(chunkEnd)) {
            break
          }
          continue
        }
        allCandles.push(...data.map(mapRow))
        if (!advanceCursor(chunkEnd)) {
          break
        }
      } catch (e) {
        return this.handleBitgetErrors(
          this.spot_getCandles,
          symbol,
          interval,
          from,
          to,
          countData,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(e)
      }
    }

    // Dedup + sort ascending by time (chunks may overlap on boundaries).
    const seen = new Set<number>()
    const deduped = allCandles
      .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
      .sort((a, b) => a.time - b.time)

    return this.returnGood<CandleResponse[]>(timeProfile)(deduped)
  }

  async getAllPrices(): Promise<BaseReturn<AllPricesResponse[]>> {
    if (this.futures) {
      return await this.futures_getAllPrices()
    }
    return await this.spot_getAllPrices()
  }

  /**
   * Get all prices
   */
  async spot_getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    const res: AllPricesResponse[] = []
    timeProfile =
      (await this.checkLimits('getSpotTicker', 20, timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    try {
      const result = await this.client.getSpotTicker()
      timeProfile = this.endProfilerTime(timeProfile, 'exchange')
      if (result.code === '00000') {
        const data = result.data
        data.map((o) =>
          res.push({
            pair: o.symbol,
            price: +o.lastPr,
          }),
        )
      } else {
        return this.handleBitgetErrors(
          this.spot_getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        )(new BitgetError(result.msg, +result.code))
      }
    } catch (e) {
      return this.handleBitgetErrors(
        this.spot_getAllPrices,
        this.endProfilerTime(timeProfile, 'exchange'),
      )(new BitgetError(e?.body?.msg ?? e.message, 0))
    }

    return this.returnGood<AllPricesResponse[]>(timeProfile)(res)
  }

  /**
   * Convert Bybit order to Common order
   *
   * @param {BybitOrderStatus} order to convert
   * @param {boolean} needFills is needed to query fills
   * @returns {Promise<CommonOrder>} Common order result
   */
  private convertFuturesOrder(order?: FuturesOrderDetailV2): CommonOrder {
    const orderStatus = (): OrderStatusType => {
      const { state, status } = order
      if (['live'].includes(state || status)) {
        return 'NEW'
      }
      if (['partially_filled'].includes(state || status)) {
        return 'PARTIALLY_FILLED'
      }
      if (['filled'].includes(state || status)) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: string): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }

    // Bitget futures state the charged fee on the order record as `fee`, and
    // it is settled in `marginCoin` — the same coin the position is margined
    // in, which the payload names, so no rule has to be inferred from the
    // symbol. Bitget's sign convention is "effect on the balance", i.e. a
    // charge arrives negative; `normalizeOrderFee` takes the magnitude.
    return {
      ...normalizeOrderFee(order.fee, order.marginCoin),
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOid,
      transactTime: +order.uTime,
      updateTime: +order.cTime,
      price:
        order.orderType === 'market'
          ? order.priceAvg
            ? `${+order.priceAvg || +order.price}`
            : order.price
          : order.price,
      origQty: order.size,
      executedQty: order.baseVolume,
      cummulativeQuoteQty: order.quoteVolume,
      status: orderStatus(),
      type: orderType(order.orderType),
      side:
        order.posSide === 'net'
          ? order.side === 'sell'
            ? 'SELL'
            : 'BUY'
          : order.tradeSide === 'open'
            ? order.side === 'sell'
              ? 'SELL'
              : 'BUY'
            : order.side === 'buy'
              ? 'SELL'
              : 'BUY',
      fills: [],
      reduceOnly: order.reduceOnly === 'yes',
      positionSide:
        order.posSide === 'net'
          ? PositionSide.BOTH
          : order.posSide === 'long'
            ? PositionSide.LONG
            : PositionSide.SHORT,
    }
  }

  private convertSpotOrder(order?: SpotOrderInfoV2): CommonOrder {
    const orderStatus = (): OrderStatusType => {
      const { status } = order
      if (['live'].includes(status)) {
        return 'NEW'
      }
      if (['partially_filled'].includes(status)) {
        return 'PARTIALLY_FILLED'
      }
      if (['filled'].includes(status)) {
        return 'FILLED'
      }
      return 'CANCELED'
    }
    const orderType = (type: string): OrderTypeT => {
      if (type === 'limit') {
        return 'LIMIT'
      }
      if (type === 'market') {
        return 'MARKET'
      }
      return 'MARKET'
    }
    return {
      ...bitgetSpotFeeDetail(order.feeDetail),
      symbol: order.symbol,
      orderId: order.orderId,
      clientOrderId: order.clientOid,
      transactTime: +order.uTime,
      updateTime: +order.cTime,
      price:
        order.orderType === 'market'
          ? order.basePrice
            ? `${+order.basePrice || +order.priceAvg}`
            : order.priceAvg
          : order.priceAvg,
      origQty: order.size,
      executedQty: order.baseVolume,
      cummulativeQuoteQty: order.quoteVolume,
      status: orderStatus(),
      type: orderType(order.orderType),
      side: order.side === 'sell' ? 'SELL' : 'BUY',
      fills: [],
    }
  }

  private convertPosition(position: FuturesPosition): PositionInfo {
    return {
      symbol: position.symbol,
      initialMargin: position.marginSize,
      maintMargin: position.marginSize,
      unrealizedProfit: position.unrealizedPL,
      positionInitialMargin: position.marginSize,
      openOrderInitialMargin: position.marginSize,
      leverage: position.leverage,
      isolated: position.marginMode === 'isolated',
      entryPrice: position.openPriceAvg,
      maxNotional: '',
      positionSide:
        position.posMode === 'hedge_mode'
          ? position.holdSide === 'long'
            ? PositionSide.LONG
            : PositionSide.SHORT
          : +position.total > 0
            ? PositionSide.LONG
            : PositionSide.SHORT,
      positionAmt: position.total,
      notional: '',
      isolatedWallet: '',
      updateTime: +position.uTime,
      bidNotional: '',
      askNotional: '',
    }
  }

  /**
   * Handle errors from Bitget API<br/>
   *
   * If error code is in {@link BybitExchange#retryErrors} and attempt is less than {@link BybitExchange#retry} - retry action
   */
  protected handleBitgetErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (
      e: Error & {
        code: number
        response?: string
      },
    ) => {
      const tls =
        'Client network socket disconnected before secure TLS connection was established'.toLowerCase()
      const timeProfile: TimeProfile = args[args.length - 1]
      const restApiNotEnabled = 'Rest API trading is not enabled'.toLowerCase()
      const cannotCancel =
        'Can not cancel order, please try again later'.toLowerCase()
      const unknownError = 'unknown error'.toLowerCase()
      const bad = 'Bad Request'.toLowerCase()
      const msg = `${
        (e as { body?: { msg?: string } })?.body?.msg || e.message
      }`.toLowerCase()
      if (
        this.retryErrors.includes(`${e.code}`) ||
        e.response ||
        msg.indexOf('request timestamp expired') !== -1 ||
        msg.indexOf('Internal System Error'.toLowerCase()) !== -1 ||
        msg.indexOf('Forbidden') !== -1 ||
        msg.indexOf(bad) !== -1 ||
        msg.indexOf('Server Timeout'.toLowerCase()) !== -1 ||
        msg.indexOf('Server error'.toLowerCase()) !== -1 ||
        msg.indexOf('fetch failed'.toLowerCase()) !== -1 ||
        msg.indexOf('getaddrinfo'.toLowerCase()) !== -1 ||
        msg.indexOf('outside of the recvWindow'.toLowerCase()) !== -1 ||
        msg.indexOf('recv_window'.toLowerCase()) !== -1 ||
        msg.indexOf('socket hang up'.toLowerCase()) !== -1 ||
        msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
        msg.indexOf('too many requests'.toLowerCase()) !== -1 ||
        msg.indexOf('possible ip block'.toLowerCase()) !== -1 ||
        msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1 ||
        msg.indexOf('ECONNRESET'.toLowerCase()) !== -1 ||
        msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1 ||
        msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1 ||
        msg.indexOf(tls) !== -1 ||
        msg.indexOf('timeout of 300000ms exceeded'.toLowerCase()) !== -1 ||
        msg.indexOf(restApiNotEnabled) !== -1 ||
        msg.indexOf(cannotCancel) !== -1 ||
        msg.indexOf(unknownError) !== -1
      ) {
        if (timeProfile.attempts < this.retry) {
          if (msg.indexOf(restApiNotEnabled) !== -1) {
            Logger.warn(
              `Bitget Rest API trading is not enabled sleep 10s ${timeProfile.attempts}`,
            )
            await sleep(10 * 1000)
          }
          if (msg.indexOf(unknownError) !== -1) {
            Logger.warn(`Bitget Unknown Error sleep 3s ${timeProfile.attempts}`)
            await sleep(3 * 1000)
          }
          if (msg.indexOf('request timestamp expired') !== -1) {
            Logger.warn(
              `Bitget Request timestamp sleep 5s ${timeProfile.attempts}`,
            )
            await sleep(5 * 1000)
          }
          if (msg.indexOf('recv_window') !== -1) {
            Logger.warn(`Bitget recv_window sleep 5s ${timeProfile.attempts}`)
            await sleep(5 * 1000)
          }
          if (
            msg.indexOf('Too many visits'.toLowerCase()) !== -1 ||
            `${e.code}` === '429'
          ) {
            const time = 1000
            Logger.log(
              `Bitget Too many visits wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } key#${keyFingerprint(this.key)}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('too many requests'.toLowerCase()) !== -1) {
            const time = 1000
            if (timeProfile.attempts > 1) {
              Logger.log(
                `Bitget too many requests wait ${time}ms ${
                  timeProfile.attempts
                } ${cb.name} key#${keyFingerprint(this.key)}`,
              )
            }
            await sleep(time)
          }
          if (`${e.code}` === '403') {
            const time = 60000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Bitget 403 block wait ${time}s ${timeProfile.attempts} ${
                cb.name
              } key#${keyFingerprint(this.key)}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Gateway Time-out'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Gateway Time-out wait 5s ${timeProfile.attempts}`,
            )
            await sleep(5000)
          }
          if (msg.indexOf(bad) !== -1) {
            Logger.log(`Bitget Bad Request wait 0.1s ${timeProfile.attempts}`)
            await sleep(100)
          }
          if (msg.indexOf('socket hang up'.toLowerCase()) !== -1) {
            const time = 2000 + (timeProfile.attempts - 1) * 1000
            Logger.log(
              `Bitget socket hang up wait ${time}s ${timeProfile.attempts}`,
            )
            await sleep(time)
          }
          if (msg.indexOf('Internal System Error'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Internal System Error wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Server Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('Server error'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Server error wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('Server Timeout'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Forbidden wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('possible ip block'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Possible ip block wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('ETIMEDOUT'.toLowerCase()) !== -1) {
            Logger.log(`Bitget Timeout wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('ECONNRESET'.toLowerCase()) !== -1) {
            Logger.log(
              `Bitget Connection reset wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf('EAI_AGAIN'.toLowerCase()) !== -1) {
            Logger.log(`Bitget EAI_AGAIN wait 10s ${timeProfile.attempts}`)
            await sleep(10000)
          }
          if (msg.indexOf('getaddrinfo'.toLowerCase()) !== -1) {
            Logger.log(`Bitget getaddrinfo wait 2s ${timeProfile.attempts}`)
            await sleep(2000)
          }
          if (msg.indexOf(tls) !== -1) {
            Logger.log(
              `Bitget Timeout wait 10s tls error ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          if (msg.indexOf(cannotCancel) !== -1) {
            Logger.log(
              `Bitget Cannot cancel order wait 10s ${timeProfile.attempts}`,
            )
            await sleep(10000)
          }
          timeProfile.attempts++
          args.splice(args.length - 1, 1, timeProfile)
          const newResult = await cb.bind(this)(...args)
          return newResult as T
        } else {
          return this.returnBad(timeProfile)(
            new Error(`${this.exchangeProblems}${msg}`),
          )
        }
      } else {
        // Bitget's own wording for a key that was never given the unified
        // scopes names permissions the user cannot find under that name.
        const message = isUtaPermissionRefusal(msg)
          ? UTA_MISSING_PERMISSIONS
          : isUtaBasicModeRefusal(msg)
            ? UTA_BASIC_MODE_UNSUPPORTED
            : msg
        return this.returnBad(timeProfile)(new Error(message))
      }
    }
  }

  /**
   * Check info from binance provider about limits and set them to {@link BybitExchange#info}
   * If limits exceeded - call {@link BybitExchange} function to wait to reset limits
   */
  protected async checkLimits(
    request: string,
    count?: number,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | void> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }
    const limit = await limitHelper
      .getInstance()
      .addLimit(count ? { name: request, count } : undefined)
    if (limit > 0) {
      Logger.warn(
        `Bitget request must sleep for ${limit / 1000}s. Method: ${request}`,
      )
      await sleep(limit)
      await this.checkLimits(request, count)
    }
    if (timeProfile) {
      timeProfile = this.endProfilerTime(timeProfile, 'queue')
    }
    return timeProfile
  }

  getUsage() {
    return limitHelper.getInstance().getLimits()
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    if (!this.futures) {
      return this.errorFutures(timeProfile)
    }
    const productType = this.getProductTypeBySymbol(symbol)
    timeProfile =
      (await this.checkLimits(
        'getFuturesHistoricFundingRates',
        20,
        timeProfile,
      )) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')
    // This Bitget endpoint paginates by page only (no time filter), so we pull
    // the most recent page and filter to the requested window client-side.
    return this.client
      .getFuturesHistoricFundingRates({
        symbol,
        productType,
        pageSize: `${Math.min(limit ?? 100, 100)}`,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        if (result.code !== '00000') {
          throw new BitgetError(result.msg, +result.code)
        }
        const data =
          (result.data as unknown as {
            symbol: string
            fundingRate: string
            fundingTime: string
          }[]) ?? []
        return this.returnGood<FundingRateResponse[]>(timeProfile)(
          data
            .map((r) => ({
              symbol: r.symbol,
              fundingRate: parseFloat(r.fundingRate),
              fundingTime: +r.fundingTime,
            }))
            .filter(
              (r) =>
                (from ? r.fundingTime >= +from : true) &&
                (to ? r.fundingTime <= +to : true),
            ),
        )
      })
      .catch(
        this.handleBitgetErrors(
          this.getFundingRateHistory,
          symbol,
          from,
          to,
          limit,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getTrades(
    _symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<BaseReturn<TradeResponse[]>> {
    return this.returnGood<TradeResponse[]>(this.getEmptyTimeProfile())([])
  }
}

export default BitgetExchange
