import AbstractExchange, { Exchange } from '../../abstractExchange'
import {
  AccountFill,
  AllPricesResponse,
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  ExchangeIntervals,
  FreeAsset,
  FundingRateResponse,
  Futures,
  LeverageBracket,
  MarginType,
  OrderStatusType,
  OrderSideType,
  OrderTypes,
  OrderTypeT,
  PositionInfo,
  PositionSide,
  RebateOverview,
  RebateRecord,
  ReferralStatus,
  StatusEnum,
  TimeProfile,
  TradeResponse,
  TraderSummary,
  UserFee,
} from '../../types'
import { WhitebitClient } from '../../../whitebit-custom'
import limitHelper from './limit'
import { WHITEBIT_ENDPOINTS } from './endpoints'
import { parseWhitebitCandles, WHITEBIT_INTERVALS } from './candles'
import {
  splitWhitebitMarkets,
  whitebitMarketToPair,
  WhitebitSymbolMapper,
} from './symbolMapper'
import { Logger } from '@nestjs/common'
import { sleep } from '../../../utils/sleepUtils'
import { safeStringify } from '../../../utils/redact'

/**
 * WhiteBit adapter — spot (`whitebit`) and USDⓈ-M linear perps
 * (`whitebitUsdm`). Spec 002, plan 002.
 *
 * Two things about this venue drive almost every design choice in this file,
 * and both are easy to get wrong by pattern-matching off another adapter:
 *
 * 1. **There is no separate futures account.** Perps and leveraged margin are
 *    one "collateral account", distinguished only by the market's `_PERP`
 *    suffix — so `this.usdm` selects a different *endpoint family* on the same
 *    credentials, not a different client against a different host. See
 *    `endpoints.ts`.
 * 2. **Candle rows are `[time, open, close, high, low, …]`** — open/close
 *    BEFORE high/low, unlike every other adapter here. See `candles.ts`.
 *
 * Broker/affiliate code (`authHeaders.code`, the `_code` constructor argument)
 * is accepted and deliberately **never attached to any outgoing request** —
 * spec §2.8. That is an explicit product decision for this PR, not an
 * oversight: WhiteBit's Broker ID needs account-manager onboarding that has not
 * happened. Do not wire it up without updating the spec.
 */

/** WhiteBit reports no per-market open-order cap; use the same default Kraken does. */
const WHITEBIT_DEFAULT_MAX_ORDERS = 200

/** Fallback when a perp market's payload carries no max-leverage field. */
const WHITEBIT_DEFAULT_MAX_LEVERAGE = 20

/**
 * Attempts `checkLimits` will wait and re-ask before letting a call through.
 * Same bounded-wait reasoning as Kraken's `KRAKEN_LIMIT_WAIT_ATTEMPTS`: a
 * parked request must not hold a connector slot open indefinitely.
 */
const WHITEBIT_LIMIT_WAIT_ATTEMPTS = 3

/**
 * Per-market maximum leverage, keyed by our normalized pair, harvested from the
 * Market Info response. WhiteBit publishes no Binance-style notional-tiered
 * bracket table, so this is the only input `futures_leverageBracket` has (§2.2).
 * Module-scoped because exchange instances are built fresh per request.
 */
const whitebitMaxLeverage = new Map<string, number>()

/** Which rate-limit bucket an endpoint is charged against (§2.6). */
type WhitebitLimitBucket = 'public' | 'privateTrade' | 'privateMain'

class WhitebitExchange extends AbstractExchange implements Exchange {
  private client: WhitebitClient
  protected futures?: Futures
  private symbolMapper: WhitebitSymbolMapper
  /** Retry count for transient venue failures. */
  private retry: number
  /** Error fragments after which a retry is attempted. */
  private retryErrors: string[]

  constructor(
    futures: Futures,
    key: string,
    secret: string,
    _passphrase?: string,
    _environment?: string,
    _keysType?: unknown,
    _okxSource?: string,
    /**
     * Broker code. Accepted so this adapter matches every other one's factory
     * signature, and then intentionally dropped — spec §2.8. It is never read
     * below, and no request in this file carries it.
     */
    _code?: string,
    _bybitHost?: unknown,
    _subaccount?: boolean,
  ) {
    super({ key, secret })

    this.futures = futures === Futures.null ? this.futures : futures

    this.client = new WhitebitClient({
      apiKey: this.key ?? '',
      apiSecret: this.secret ?? '',
    })

    this.symbolMapper = this.usdm
      ? WhitebitSymbolMapper.getUsdmInstance()
      : WhitebitSymbolMapper.getSpotInstance()

    this.retry = 5
    this.retryErrors = [
      // WhiteBit's own throttling. Per-IP, so a retry after a wait is the only
      // thing that can clear it.
      'Too many requests',
      'too many requests',
      'Rate limit',
      '429',
      // A nonce rejection is a PRE-execution refusal — the order never reached
      // the matching engine — so re-signing with a fresh, higher nonce is safe.
      // Same reasoning as Kraken's `EAPI:Invalid nonce` entry.
      'nonce',
      'Nonce',
      '500',
      '502',
      '503',
      '504',
      '520',
      '521',
      '522',
    ]

    // Populate the symbol maps in the background, exactly as Kraken does — the
    // first symbol conversion otherwise falls back to derivation. The
    // derivation is exact for every market WhiteBit lists (see symbolMapper.ts),
    // so a failure here degrades nothing; it just costs a lookup.
    this.initializeSymbolMaps()
  }

  private async initializeSymbolMaps() {
    if (!this.symbolMapper.getIsInitialized()) {
      try {
        await this.getAllExchangeInfo()
      } catch (error) {
        Logger.warn(
          `Failed to initialize WhiteBit symbol maps: ${error?.message}. ` +
            `Maps will be populated on the first getAllExchangeInfo call.`,
        )
      }
    }
  }

  /** True for `whitebitUsdm` — the collateral-account / `_PERP` variant. */
  get usdm() {
    return this.futures === Futures.usdm
  }

  getUsage() {
    return limitHelper.getUsage()
  }

  override returnGood<T>(
    timeProfile: TimeProfile,
    usage = limitHelper.getUsage(),
  ) {
    return (r: T) => ({
      status: StatusEnum.ok as StatusEnum.ok,
      data: r,
      reason: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  override returnBad(timeProfile: TimeProfile, usage = limitHelper.getUsage()) {
    return (e: Error) => ({
      status: StatusEnum.notok as StatusEnum.notok,
      reason: e.message,
      data: null,
      usage,
      timeProfile: { ...timeProfile, outcomingTime: +new Date() },
    })
  }

  // ===========================
  // Plumbing
  // ===========================

  /**
   * Charge the call against its rate-limit bucket, waiting and re-asking until
   * the budget admits it (bounded).
   *
   * The limiter does NOT charge a refused call, so a single sleep-then-send
   * would take no token at all under load — the failure mode Kraken's
   * `checkLimits` documents at length. Re-ask instead.
   */
  private async checkLimits(
    bucket: WhitebitLimitBucket,
    timeProfile?: TimeProfile,
  ): Promise<TimeProfile | undefined> {
    if (timeProfile) {
      timeProfile = this.startProfilerTime(timeProfile, 'queue')
    }

    const charge = async () => {
      if (bucket === 'public') return limitHelper.addPublicCall()
      if (bucket === 'privateMain') return limitHelper.addPrivateMainCall()
      return limitHelper.addPrivateTradeCall()
    }

    let waitTime = await charge()
    for (
      let attempt = 0;
      waitTime > 0 && attempt < WHITEBIT_LIMIT_WAIT_ATTEMPTS;
      attempt++
    ) {
      await sleep(waitTime)
      waitTime = await charge()
    }

    if (timeProfile) {
      return this.endProfilerTime(timeProfile, 'queue')
    }
    return undefined
  }

  /**
   * Error handler for the `.catch(...)` tail of every venue call.
   *
   * Call sites MUST pass the wrapped method's full argument list ending with
   * the timeProfile — the retry re-invokes `cb.call(this, ...args)` verbatim.
   * (Kraken shipped a bug where only the timeProfile was passed and the retry
   * called the method with a TimeProfile in the `symbol` slot; same trap here.)
   */
  private handleWhitebitErrors<T>(
    cb: (...args: any[]) => Promise<T>,
    ...args: any[]
  ) {
    return async (e: Error): Promise<any> => {
      const timeProfile: TimeProfile =
        args[args.length - 1] ?? this.getEmptyTimeProfile()
      const message = e?.message ?? `${e}`

      const shouldRetry =
        this.retryErrors.some((code) => message.includes(code)) &&
        timeProfile.attempts < this.retry

      if (shouldRetry) {
        // Rate limiting is per-IP and the window is 10s, so pace a throttled
        // retry against the window rather than against a generic ramp.
        const isRateLimited = /too many requests|rate limit|429/i.test(message)
        const wait = isRateLimited
          ? 10_000
          : Math.min(1000 * Math.pow(2, timeProfile.attempts), 8000)

        Logger.warn(
          `WhiteBit ${cb.name || 'request'} failed (attempt ` +
            `${timeProfile.attempts}/${this.retry}), retrying after ${wait}ms: ` +
            `${safeStringify(message).slice(0, 300)}`,
        )

        await sleep(wait)
        const retryArgs = [...args]
        retryArgs[retryArgs.length - 1] = {
          ...timeProfile,
          attempts: timeProfile.attempts + 1,
        }
        return cb.call(this, ...retryArgs)
      }

      // `safeStringify` because a thrown axios error can carry the signed
      // request — including the live `X-TXC-APIKEY` / `X-TXC-SIGNATURE`
      // headers. A log line must never be the thing that leaks a credential.
      Logger.error(
        `WhiteBit API error in ${cb.name || 'request'}: ` +
          `${safeStringify(message).slice(0, 500)}`,
      )
      return this.returnBad(timeProfile)(new Error(message))
    }
  }

  private noCredentials(timeProfile: TimeProfile) {
    return this.returnBad(timeProfile)(
      new Error('WhiteBit API credentials are not configured'),
    )
  }

  private spotOnly(timeProfile: TimeProfile, what: string) {
    return this.returnBad(timeProfile)(
      new Error(`${what} is only supported for WhiteBit futures (whitebitUsdm)`),
    )
  }

  /** `BTC-USDT` -> `BTC_USDT` (spot) / `BTC_PERP` (usdm). */
  private toWhitebitSymbol(symbol: string): string {
    return this.symbolMapper.toWhitebitSymbol(symbol)
  }

  /** `BTC_USDT` / `BTC_PERP` -> `BTC-USDT`. */
  private normalizeSymbol(whitebitSymbol: string): string {
    return this.symbolMapper.toOurSymbol(whitebitSymbol)
  }

  // ===========================
  // Order shaping
  // ===========================

  private mapOrderType(type: string | undefined): OrderTypeT {
    return `${type ?? ''}`.toLowerCase().includes('market') ? 'MARKET' : 'LIMIT'
  }

  /**
   * Canonical status for a WhiteBit order.
   *
   * WhiteBit's active-orders payload carries no `status` field at all — an
   * order's state is implied by `left` (unfilled remainder) against `amount`.
   * Deriving it from the quantities is therefore the only correct reading, and
   * it is also what makes a partially-filled resting order visible: reporting
   * such an order as NEW is the class of bug that makes the bot engine re-buy
   * size it already holds (see Kraken's `futures_deriveOrderStatus`).
   */
  private deriveOrderStatus(raw: {
    amount?: string | number
    left?: string | number
    dealStock?: string | number
    status?: string
  }): OrderStatusType {
    const status = `${raw.status ?? ''}`.toLowerCase()
    if (status.includes('cancel') || status.includes('expired')) {
      return 'CANCELED'
    }

    const amount = Number(raw.amount ?? 0)
    const executed = Number(raw.dealStock ?? 0)
    const left = raw.left === undefined ? undefined : Number(raw.left)

    if (left !== undefined && left <= 0 && amount > 0) {
      return 'FILLED'
    }
    if (amount > 0 && executed >= amount) {
      return 'FILLED'
    }
    if (executed > 0) {
      return 'PARTIALLY_FILLED'
    }
    return 'NEW'
  }

  /**
   * WhiteBit order payload -> `CommonOrder`.
   *
   * ⚠️ Fees are deliberately NOT populated. WhiteBit reports `dealFee` on the
   * order payload, but the documentation read for this spec does not state
   * which currency it is charged in, and `CommonOrder.feePaid` without a
   * `feeSide`/`feeAsset` is worse than absent: the consumer would book a real
   * amount against a guessed asset. A missing fee falls back to main-app's own
   * estimate, which is the documented, safe behaviour. TODO §3.8 — confirm the
   * fee currency and then set `feePaid` + `feeAsset` together.
   */
  private convertOrder(
    raw: any,
    fallbackSymbol?: string,
    override?: Partial<CommonOrder>,
  ): CommonOrder {
    const timestampMs = raw?.timestamp
      ? Math.round(Number(raw.timestamp) * 1000)
      : Date.now()

    const order: CommonOrder = {
      symbol: raw?.market
        ? this.normalizeSymbol(raw.market)
        : (fallbackSymbol ?? ''),
      orderId: `${raw?.orderId ?? raw?.id ?? ''}`,
      clientOrderId: raw?.clientOrderId || '',
      transactTime: timestampMs,
      updateTime: timestampMs,
      price: `${raw?.price ?? '0'}`,
      origQty: `${raw?.amount ?? '0'}`,
      executedQty: `${raw?.dealStock ?? '0'}`,
      cummulativeQuoteQty: `${raw?.dealMoney ?? '0'}`,
      status: this.deriveOrderStatus(raw ?? {}),
      type: this.mapOrderType(raw?.type),
      side: `${raw?.side ?? 'buy'}`.toUpperCase() as OrderSideType,
    }

    return { ...order, ...override }
  }

  // ===========================
  // Account
  // ===========================

  async getBalance(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FreeAsset>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    // The collateral account is the perp/leveraged wallet; the trade account is
    // spot. Same credentials, different endpoint — §2.2.
    // TODO §3.8 — the collateral-balance response was confirmed to exist but
    // not read in full; the parser below accepts both shapes WhiteBit uses
    // elsewhere (a flat asset->amount map, and an available/freeze object).
    const path = this.usdm
      ? WHITEBIT_ENDPOINTS.collateral.balance
      : WHITEBIT_ENDPOINTS.spot.balance

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<Record<string, any>>(path, {})
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result || typeof result !== 'object') {
          throw new Error('Failed to get balance: unexpected response shape')
        }

        const balances: FreeAsset = []
        for (const [asset, value] of Object.entries(result)) {
          if (value && typeof value === 'object') {
            balances.push({
              asset,
              free: parseFloat((value as any).available ?? '0') || 0,
              locked: parseFloat((value as any).freeze ?? '0') || 0,
            })
          } else {
            balances.push({
              asset,
              free: parseFloat(`${value ?? '0'}`) || 0,
              locked: 0,
            })
          }
        }

        return this.returnGood<FreeAsset>(timeProfile)(balances)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getBalance,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Executions on the account, for reconciliation.
   *
   * TODO §3.8 — `executed-history` was confirmed to exist via the docs index
   * but its exact field names were not read in full; the mapping below is
   * defensive about the two spellings WhiteBit uses elsewhere. Verify against a
   * live response before relying on it for fill recovery.
   */
  async getAccountFills(
    sinceMs?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AccountFill[]>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<Record<string, any[]>>(
        WHITEBIT_ENDPOINTS.spot.executedHistory,
        { limit: 100, offset: 0 },
      )
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const fills: AccountFill[] = []
        // The response is keyed by market, each holding that market's deals.
        for (const [market, deals] of Object.entries(result ?? {})) {
          if (!Array.isArray(deals)) continue
          for (const deal of deals) {
            const timestamp = deal?.time
              ? Math.round(Number(deal.time) * 1000)
              : 0
            if (sinceMs && timestamp && timestamp < sinceMs) {
              continue
            }
            fills.push({
              fillId: `${deal?.id ?? ''}`,
              orderId: `${deal?.dealOrderId ?? deal?.orderId ?? ''}`,
              clientOrderId: deal?.clientOrderId || '',
              symbol: this.normalizeSymbol(market),
              // WhiteBit encodes side numerically on deals: 1 = sell, 2 = buy.
              side:
                `${deal?.side}` === '1' ||
                `${deal?.side}`.toLowerCase() === 'sell'
                  ? 'SELL'
                  : 'BUY',
              price: `${deal?.price ?? '0'}`,
              quantity: `${deal?.amount ?? '0'}`,
              timestamp,
              // 1 = maker, 2 = taker; passed through unmapped for diagnostics.
              fillType: deal?.role !== undefined ? `${deal.role}` : undefined,
            })
          }
        }

        fills.sort((a, b) => b.timestamp - a.timestamp)
        return this.returnGood<AccountFill[]>(timeProfile)(fills)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getAccountFills,
          sinceMs,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Orders
  // ===========================

  async openOrder(
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
      leverage?: number
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    const { symbol, side, quantity, price, newClientOrderId, type = 'LIMIT' } =
      order

    const market = this.toWhitebitSymbol(symbol)

    // §2.2: the perp side does NOT reuse the spot create-order endpoints with a
    // different symbol — it has its own `collateral` order family. This branch
    // is the whole difference between placing a perp order and placing a
    // leveraged spot order by accident.
    const path = this.usdm
      ? type === 'MARKET'
        ? WHITEBIT_ENDPOINTS.collateral.marketOrder
        : WHITEBIT_ENDPOINTS.collateral.limitOrder
      : type === 'MARKET'
        ? WHITEBIT_ENDPOINTS.spot.marketOrder
        : WHITEBIT_ENDPOINTS.spot.newOrder

    const params: Record<string, unknown> = {
      market,
      side: side.toLowerCase(),
      amount: this.convertNumberToString(quantity),
      // A MARKET order carries no price; the signer drops undefined keys so an
      // absent price never reaches the venue as the string "undefined".
      price: type === 'LIMIT' ? this.convertNumberToString(price) : undefined,
      clientOrderId: newClientOrderId,
    }

    // `reduceOnly`, `positionSide`, `marginType` and `leverage` are accepted on
    // the interface but not forwarded: WhiteBit's collateral order endpoints
    // were not confirmed to take them (leverage is set separately — see
    // futures_changeLeverage), and sending an unrecognised parameter to a
    // trading endpoint is exactly how Kraken's bug #383 turned a plain BUY into
    // a rejected reduce-only order. Left out on purpose, not forgotten.

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any>(path, params)
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!result || (!result.orderId && !result.id)) {
          throw new Error(
            `Failed to create order: ${safeStringify(result).slice(0, 300)}`,
          )
        }

        return this.returnGood<CommonOrder>(timeProfile)(
          this.convertOrder(result, symbol, {
            clientOrderId: result.clientOrderId || newClientOrderId || '',
          }),
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.openOrder,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * One order by our client order id.
   *
   * `POST /api/v4/orders` answers about ACTIVE orders only (§2.2), so a filled
   * or cancelled order is absent from it — which for a bot is the single most
   * important case, not an edge case. On a miss we fall back to the account's
   * executed history and rebuild the order from its deals.
   */
  async getOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }
    if (!newClientOrderId) {
      return this.returnBad(timeProfile)(new Error('Client order ID required'))
    }

    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any[]>(WHITEBIT_ENDPOINTS.spot.activeOrders, {
        market,
        clientOrderId: newClientOrderId,
        limit: 100,
        offset: 0,
      })
      .then(async (result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const active = Array.isArray(result) ? result : []
        const match =
          active.find((o) => o?.clientOrderId === newClientOrderId) ?? active[0]

        if (match) {
          return this.returnGood<CommonOrder>(timeProfile)(
            this.convertOrder(match, symbol),
          )
        }

        const historical = await this.findOrderInHistory(
          market,
          symbol,
          newClientOrderId,
          timeProfile,
        )
        if (historical) {
          return this.returnGood<CommonOrder>(timeProfile)(historical)
        }

        throw new Error(`Order ${newClientOrderId} not found`)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getOrder,
          { symbol, newClientOrderId },
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Rebuild an order that is no longer active from its executed deals.
   *
   * Returns `null` (never throws) when nothing matches — "not in the active
   * list and not in recent history" is a legitimate answer that the caller
   * turns into its own not-found error, and swallowing a history failure must
   * not turn a resting order into a phantom.
   *
   * TODO §3.8 — deal field names not yet verified against a live response.
   */
  private async findOrderInHistory(
    market: string,
    ourSymbol: string,
    clientOrderId: string,
    timeProfile: TimeProfile,
  ): Promise<CommonOrder | null> {
    try {
      await this.checkLimits('privateTrade')
      const history = await this.client.privatePost<Record<string, any[]>>(
        WHITEBIT_ENDPOINTS.spot.executedHistory,
        { market, clientOrderId, limit: 100, offset: 0 },
      )

      const deals: any[] = []
      for (const value of Object.values(history ?? {})) {
        if (Array.isArray(value)) deals.push(...value)
      }
      const matching = deals.filter(
        (d) => !d?.clientOrderId || d.clientOrderId === clientOrderId,
      )
      if (!matching.length) {
        return null
      }

      let filledQty = 0
      let notional = 0
      let latest = 0
      for (const deal of matching) {
        const qty = Number(deal?.amount ?? 0)
        const price = Number(deal?.price ?? 0)
        filledQty += qty
        notional += qty * price
        latest = Math.max(latest, Math.round(Number(deal?.time ?? 0) * 1000))
      }
      const avgPrice = filledQty > 0 ? notional / filledQty : 0
      const first = matching[0]

      return {
        symbol: ourSymbol,
        orderId: `${first?.dealOrderId ?? first?.orderId ?? ''}`,
        clientOrderId,
        transactTime: latest || Date.now(),
        updateTime: latest || Date.now(),
        price: `${avgPrice}`,
        avgPrice: `${avgPrice}`,
        origQty: `${filledQty}`,
        executedQty: `${filledQty}`,
        cummulativeQuoteQty: `${notional}`,
        status: 'FILLED',
        type: this.mapOrderType(first?.type),
        side:
          `${first?.side}` === '1' ||
          `${first?.side}`.toLowerCase() === 'sell'
            ? 'SELL'
            : 'BUY',
      }
    } catch (e) {
      Logger.warn(
        `WhiteBit order-history lookup failed for ${clientOrderId}: ` +
          `${safeStringify(e?.message ?? e).slice(0, 200)}`,
      )
      return null
    }
  }

  async cancelOrder(
    {
      symbol,
      newClientOrderId,
    }: {
      symbol: string
      newClientOrderId?: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!newClientOrderId) {
      return this.returnBad(timeProfile)(new Error('Client order ID required'))
    }

    // WhiteBit cancels by its own `orderId`, so resolve the client id first —
    // the same two-step Kraken uses.
    const found = await this.getOrder({ symbol, newClientOrderId }, timeProfile)
    if (found.status !== StatusEnum.ok) {
      return found as BaseReturn<CommonOrder>
    }

    return this.cancelOrderByOrderIdAndSymbol(
      { symbol, orderId: `${found.data.orderId}` },
      timeProfile,
    )
  }

  async cancelOrderByOrderIdAndSymbol(
    order: {
      symbol: string
      orderId: string
    },
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CommonOrder>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    const { symbol, orderId } = order
    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any>(WHITEBIT_ENDPOINTS.spot.cancelOrder, {
        market,
        orderId: Number(orderId),
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        // WhiteBit answers a successful cancel with the cancelled order. Its
        // payload carries no status field, so state it explicitly rather than
        // letting the quantity-based derivation call a cancelled order NEW.
        return this.returnGood<CommonOrder>(timeProfile)(
          this.convertOrder(result ?? { orderId }, symbol, {
            orderId,
            status: 'CANCELED',
          }),
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.cancelOrderByOrderIdAndSymbol,
          order,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllOpenOrders(
    symbol: string,
    returnOrders?: false,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<number>>
  async getAllOpenOrders(
    symbol: string,
    returnOrders: true,
    timeProfile?: TimeProfile,
  ): Promise<BaseReturn<CommonOrder[]>>
  async getAllOpenOrders(
    symbol: string,
    returnOrders: boolean = false,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number> | BaseReturn<CommonOrder[]>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }
    if (!symbol) {
      // `POST /api/v4/orders` requires a market; there is no account-wide
      // active-order read. Say so, rather than returning a wrong zero.
      return this.returnBad(timeProfile)(
        new Error('WhiteBit open-order lookup requires a market'),
      )
    }

    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any[]>(WHITEBIT_ENDPOINTS.spot.activeOrders, {
        market,
        limit: 100,
        offset: 0,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const orders = Array.isArray(result) ? result : []

        if (returnOrders) {
          return this.returnGood<CommonOrder[]>(timeProfile)(
            orders.map((o) => this.convertOrder(o, symbol)),
          )
        }
        return this.returnGood<number>(timeProfile)(orders.length)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getAllOpenOrders,
          symbol,
          returnOrders,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Market data
  // ===========================

  async latestPrice(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<Record<string, any>>(WHITEBIT_ENDPOINTS.public.ticker)
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const ticker = result?.[market]
        if (!ticker) {
          throw new Error(`Market ${market} not found in ticker response`)
        }
        return this.returnGood<number>(timeProfile)(
          parseFloat(ticker.last_price ?? ticker.last ?? '0') || 0,
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.latestPrice,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllPrices(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<AllPricesResponse[]>> {
    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<Record<string, any>>(WHITEBIT_ENDPOINTS.public.ticker)
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        // One response holds spot AND perp markets; the `_PERP` suffix is the
        // only discriminator (§2.4), so each variant filters it down to its own.
        const names = Object.keys(result ?? {}).map((name) => ({ name }))
        const { spot, usdm } = splitWhitebitMarkets(names)
        const wanted = this.usdm ? usdm : spot

        const prices: AllPricesResponse[] = []
        for (const { name } of wanted) {
          const price = parseFloat(
            result[name]?.last_price ?? result[name]?.last ?? '0',
          )
          if (!isFinite(price)) continue
          prices.push({ pair: this.normalizeSymbol(name), price })
        }

        return this.returnGood<AllPricesResponse[]>(timeProfile)(prices)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getAllPrices,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getExchangeInfo(
    symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<ExchangeInfo>> {
    const full = await this.getAllExchangeInfo(timeProfile)
    if (full.status !== StatusEnum.ok) {
      return full
    }
    const info = full.data.find((e) => e.pair === symbol)
    if (!info) {
      return this.returnBad(timeProfile)(new Error('Symbol not found'))
    }
    return this.returnGood<ExchangeInfo>(timeProfile)(info)
  }

  async getAllExchangeInfo(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(ExchangeInfo & { pair: string })[]>> {
    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<any[]>(WHITEBIT_ENDPOINTS.public.markets)
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        if (!Array.isArray(result)) {
          throw new Error('Failed to get markets: unexpected response shape')
        }

        // Spot and perps arrive in ONE list; split on `_PERP` (§2.4).
        const { spot, usdm } = splitWhitebitMarkets(result)
        const markets = (this.usdm ? usdm : spot).filter(
          (m: any) => m?.tradesEnabled !== false,
        )

        const infos: (ExchangeInfo & { pair: string })[] = markets.map(
          (market: any) => {
            const pair = whitebitMarketToPair(market)
            const basePrecision = Number(market.stockPrec ?? 8)
            const quotePrecision = Number(market.moneyPrec ?? 8)
            const step = Math.pow(10, -basePrecision)

            // WhiteBit publishes the perp's ceiling on the market itself; it is
            // the ONLY leverage input this integration has (§2.2 — there is no
            // tiered bracket table). Both spellings are accepted because the
            // field was inferred from the leverage endpoint's error text rather
            // than read off a live Market Info response.
            const maxLeverage = Number(
              market.maxLeverage ?? market.max_leverage ?? 0,
            )
            if (this.usdm) {
              whitebitMaxLeverage.set(
                pair,
                maxLeverage > 0 ? maxLeverage : WHITEBIT_DEFAULT_MAX_LEVERAGE,
              )
            }

            return {
              code: market.name,
              pair,
              baseAsset: {
                name: market.stock ?? pair.split('-')[0],
                minAmount: parseFloat(market.minAmount ?? '0') || step,
                maxAmount: parseFloat(market.maxTotal ?? '0') || 999999999,
                step,
                maxMarketAmount:
                  parseFloat(market.maxTotal ?? '0') || 999999999,
              },
              quoteAsset: {
                name: market.money ?? pair.split('-')[1],
                minAmount: parseFloat(market.minTotal ?? '0') || 0,
                precision: quotePrecision,
              },
              maxOrders: WHITEBIT_DEFAULT_MAX_ORDERS,
              priceAssetPrecision: quotePrecision,
              type: market.type,
            }
          },
        )

        const unique = [...new Map(infos.map((i) => [i.pair, i])).values()]

        this.symbolMapper.updateMaps(
          unique.map((i) => ({ pair: i.pair, code: `${i.code}` })),
        )

        return this.returnGood<(ExchangeInfo & { pair: string })[]>(timeProfile)(
          unique,
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.getAllExchangeInfo,
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
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<CandleResponse[]>> {
    const market = this.toWhitebitSymbol(symbol)
    const whitebitInterval = WHITEBIT_INTERVALS[interval]
    if (!whitebitInterval) {
      return this.returnBad(timeProfile)(
        new Error(`Interval ${interval} is not supported by WhiteBit`),
      )
    }

    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<any>(WHITEBIT_ENDPOINTS.public.kline, {
        market,
        interval: whitebitInterval,
        // WhiteBit's v1 endpoints take seconds, not milliseconds.
        start: from ? Math.floor(from / 1000) : undefined,
        end: to ? Math.floor(to / 1000) : undefined,
        limit: count,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        // v1 responses wrap the payload: `{ success, message, result }`.
        if (result?.success === false) {
          throw new Error(result?.message || 'Failed to get candles')
        }

        // The column order here is NOT the usual OHLCV — see candles.ts / §2.3.
        let candles = parseWhitebitCandles(result?.result ?? result)

        if (from) candles = candles.filter((c) => c.time >= from)
        if (to) candles = candles.filter((c) => c.time <= to)
        if (count && candles.length > count) candles = candles.slice(0, count)

        return this.returnGood<CandleResponse[]>(timeProfile)(candles)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getCandles,
          symbol,
          interval,
          from,
          to,
          count,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getTrades(
    symbol: string,
    _fromId?: number,
    _startTime?: number,
    _endTime?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<TradeResponse[]>> {
    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<any[]>(WHITEBIT_ENDPOINTS.public.trades(market))
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const raw = Array.isArray(result) ? result : (result as any)?.result
        if (!Array.isArray(raw)) {
          throw new Error('Failed to get trades: unexpected response shape')
        }

        const trades: TradeResponse[] = raw.map((trade: any, index: number) => {
          const seconds = Number(
            trade?.trade_timestamp ?? trade?.timestamp ?? trade?.time ?? 0,
          )
          return {
            aggId: `${trade?.tradeID ?? trade?.tradeId ?? trade?.id ?? index}`,
            symbol,
            price: `${trade?.price ?? '0'}`,
            quantity: `${trade?.base_volume ?? trade?.amount ?? '0'}`,
            firstId: index,
            lastId: index,
            // WhiteBit publishes trade times in seconds; anything already in
            // milliseconds (13 digits) is passed through untouched.
            timestamp: seconds > 1e11 ? seconds : Math.round(seconds * 1000),
          }
        })

        return this.returnGood<TradeResponse[]>(timeProfile)(trades)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getTrades,
          symbol,
          _fromId,
          _startTime,
          _endTime,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getFundingRateHistory(
    symbol: string,
    from?: number,
    to?: number,
    limit?: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<FundingRateResponse[]>> {
    if (!this.usdm) {
      // Funding exists only on the perp side; an empty answer, not an error —
      // same contract as Kraken's spot branch.
      return this.returnGood<FundingRateResponse[]>(timeProfile)([])
    }

    const market = this.toWhitebitSymbol(symbol)

    timeProfile = (await this.checkLimits('public', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .publicGet<any>(WHITEBIT_ENDPOINTS.public.fundingHistory, {
        market,
        startDate: from ? Math.floor(from / 1000) : undefined,
        endDate: to ? Math.floor(to / 1000) : undefined,
        limit,
      })
      .then((response) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const rows = Array.isArray(response)
          ? response
          : (response?.result ?? [])
        if (!Array.isArray(rows)) {
          throw new Error(
            'Failed to get funding history: unexpected response shape',
          )
        }

        const rates: FundingRateResponse[] = rows
          .map((row: any) => {
            const seconds = Number(
              row?.funding_time ?? row?.fundingTime ?? row?.time ?? 0,
            )
            return {
              symbol,
              fundingRate: Number(
                row?.funding_rate ?? row?.fundingRate ?? row?.rate ?? 0,
              ),
              fundingTime: seconds > 1e11 ? seconds : Math.round(seconds * 1000),
            }
          })
          .filter(
            (r) =>
              (from ? r.fundingTime >= +from : true) &&
              (to ? r.fundingTime <= +to : true),
          )
          .slice(-(limit ?? Infinity))

        return this.returnGood<FundingRateResponse[]>(timeProfile)(rates)
      })
      .catch(
        this.handleWhitebitErrors(
          this.getFundingRateHistory,
          symbol,
          from,
          to,
          limit,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Fees
  // ===========================

  /**
   * The account's own maker/taker rates.
   *
   * WhiteBit publishes them as PERCENTAGES (`"0.1"` = 0.1%), while `UserFee` is
   * a fraction — the same units `orderFee`/main-app's gross-up arithmetic
   * assumes. Getting this wrong by a factor of 100 silently mis-sizes every
   * order, so the conversion is explicit and commented rather than inferred.
   *
   * `source: 'venue'` because this IS what the account pays, not a public
   * ladder entry.
   */
  private async fetchAccountFee(
    timeProfile: TimeProfile,
  ): Promise<{ fee: UserFee; timeProfile: TimeProfile }> {
    timeProfile = (await this.checkLimits('privateMain', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    const result = await this.client.privatePost<any>(
      WHITEBIT_ENDPOINTS.main.fee,
      {},
    )
    timeProfile = this.endProfilerTime(timeProfile, 'exchange')

    const maker = parseFloat(result?.makerFee ?? result?.maker ?? '0')
    const taker = parseFloat(result?.takerFee ?? result?.taker ?? '0')

    return {
      fee: {
        maker: (isFinite(maker) ? maker : 0) / 100,
        taker: (isFinite(taker) ? taker : 0) / 100,
        source: 'venue',
      },
      timeProfile,
    }
  }

  async getUserFees(
    _symbol: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<UserFee>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    // Per-market fee overrides exist on WhiteBit (§2.2) but are not modelled in
    // v1: the account-wide rate is returned for every market. That is the
    // venue's answer for the overwhelming majority of accounts, and it is
    // marked `source: 'venue'` because it genuinely is the account's rate —
    // just not per-market-refined.
    return this.fetchAccountFee(timeProfile)
      .then(({ fee, timeProfile: tp }) => this.returnGood<UserFee>(tp)(fee))
      .catch(
        this.handleWhitebitErrors(
          this.getUserFees,
          _symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  async getAllUserFees(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<(UserFee & { pair: string })[]>> {
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    return this.fetchAccountFee(timeProfile)
      .then(async ({ fee, timeProfile: tp }) => {
        let pairs = this.symbolMapper.knownPairs()
        if (!pairs.length) {
          const info = await this.getAllExchangeInfo(tp)
          if (info.status === StatusEnum.ok) {
            pairs = info.data.map((i) => i.pair)
          }
        }
        return this.returnGood<(UserFee & { pair: string })[]>(tp)(
          pairs.map((pair) => ({ ...fee, pair })),
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.getAllUserFees,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Futures (collateral account)
  // ===========================

  /**
   * Set leverage.
   *
   * ⚠️ TODO §3.1 — `POST /api/v4/collateral-account/leverage`'s documented body
   * is `{leverage, request, nonce}`: there is **no `market` parameter** in the
   * example that was read, which says WhiteBit's leverage is an ACCOUNT-WIDE
   * setting rather than the per-symbol setting Binance/Kraken/Bybit have. This
   * is implemented account-wide accordingly, which means `symbol` below is
   * accepted for interface-shape compatibility and deliberately not sent —
   * NOT silently dropped by accident.
   *
   * The consequence if that reading is right: a multi-pair futures bot changing
   * leverage for one pair changes it for every open position on the account.
   * The consequence if it is wrong (the docs excerpt merely omitted an optional
   * `market`): every leverage change lands account-wide instead of on one
   * market. Both are material, which is why this must be confirmed manually
   * against the live endpoint before this leaves draft.
   */
  async futures_changeLeverage(
    symbol: string,
    leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<number>> {
    if (!this.usdm) {
      return this.spotOnly(timeProfile, 'Leverage change')
    }
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any>(WHITEBIT_ENDPOINTS.collateral.leverage, {
        leverage,
        // TODO §3.1 — no `market` param: see the doc comment above.
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        const applied = Number(result?.leverage ?? leverage)
        return this.returnGood<number>(timeProfile)(
          isFinite(applied) && applied > 0 ? applied : leverage,
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.futures_changeLeverage,
          symbol,
          leverage,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Set cross vs. isolated margin.
   *
   * ⚠️ TODO §3.2 — **not implemented, on purpose.** WhiteBit's futures overview
   * documents that both Cross and Isolated margin modes exist, but no dedicated
   * "set margin mode" endpoint was found alongside the leverage and hedge-mode
   * endpoints. It may be a parameter on the `collateral` order endpoints
   * (i.e. set per order, at placement time) rather than an account-level
   * toggle; that needs its own documentation pass.
   *
   * Deliberately NOT guessed at an endpoint path. An invented path fails at the
   * venue with a 404 that reads like an outage, and — worse — a stubbed
   * `returnGood` would tell the bot engine the account is in a margin mode
   * nobody ever set. Refusing is the honest answer: it surfaces the gap at the
   * call site instead of hiding it behind a lie about account state.
   */
  async futures_changeMarginType(
    _symbol: string,
    _margin: MarginType,
    _leverage: number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<MarginType>> {
    return this.returnBad(timeProfile)(
      new Error(
        'WhiteBit margin-type switching is not implemented yet ' +
          '(spec 002 §3.2 — no confirmed endpoint)',
      ),
    )
  }

  async futures_getHedge(
    _symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.usdm) {
      // Spot has no position model at all, so one-way is the only truthful
      // answer. Reporting `true` here is what permanently blocked neutral grid
      // bots on Kraken; do not repeat it.
      return this.returnGood<boolean>(timeProfile)(false)
    }
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any>(WHITEBIT_ENDPOINTS.collateral.hedgeMode, {})
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        // Account-wide, not per market — hence the ignored `_symbol`.
        return this.returnGood<boolean>(timeProfile)(!!result?.hedgeMode)
      })
      .catch(
        this.handleWhitebitErrors(
          this.futures_getHedge,
          _symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Set the account-wide hedge-mode flag.
   *
   * TODO §3.8 — the paired update endpoint was confirmed to exist from the docs
   * index (`update-collateral-account-hedge-mode`) but was not read in full;
   * its exact path and body shape need a final check against the live docs.
   */
  async futures_setHedge(
    value: boolean,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    if (!this.usdm) {
      return this.returnGood<boolean>(timeProfile)(false)
    }
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any>(WHITEBIT_ENDPOINTS.collateral.setHedgeMode, {
        hedgeMode: value,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')
        return this.returnGood<boolean>(timeProfile)(
          result?.hedgeMode === undefined ? value : !!result.hedgeMode,
        )
      })
      .catch(
        this.handleWhitebitErrors(
          this.futures_setHedge,
          value,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  /**
   * Leverage brackets, derived — not fetched.
   *
   * WhiteBit publishes no Binance-style notional-tiered bracket table (§2.2).
   * What it does publish is a per-market ceiling on the Market Info response,
   * so each market gets a SINGLE tier spanning all notionals: `min: 0` with
   * that market's max leverage. Presenting one honest tier is better than
   * inventing tier boundaries the venue never stated.
   */
  async futures_leverageBracket(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<LeverageBracket[]>> {
    if (!this.usdm) {
      return this.spotOnly(timeProfile, 'Leverage brackets')
    }

    if (!whitebitMaxLeverage.size) {
      const info = await this.getAllExchangeInfo(timeProfile)
      if (info.status !== StatusEnum.ok) {
        return info as BaseReturn<LeverageBracket[]>
      }
    }

    const brackets: LeverageBracket[] = [...whitebitMaxLeverage.entries()].map(
      ([symbol, leverage]) => ({
        symbol,
        leverage,
        step: 1,
        min: 0,
      }),
    )

    return this.returnGood<LeverageBracket[]>(timeProfile)(brackets)
  }

  async futures_getPositions(
    symbol?: string,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<PositionInfo[]>> {
    if (!this.usdm) {
      return this.spotOnly(timeProfile, 'Positions')
    }
    if (!this.client.hasCredentials()) {
      return this.noCredentials(timeProfile)
    }

    timeProfile = (await this.checkLimits('privateTrade', timeProfile)) || timeProfile
    timeProfile = this.startProfilerTime(timeProfile, 'exchange')

    return this.client
      .privatePost<any[]>(WHITEBIT_ENDPOINTS.collateral.openPositions, {
        market: symbol ? this.toWhitebitSymbol(symbol) : undefined,
      })
      .then((result) => {
        timeProfile = this.endProfilerTime(timeProfile, 'exchange')

        const raw = Array.isArray(result) ? result : []
        const positions: PositionInfo[] = raw.map((pos: any) => {
          const amount = Number(pos?.amount ?? 0)
          // `positionSide` is LONG/SHORT/BOTH on a hedge-mode account. On a
          // one-way account WhiteBit reports BOTH and encodes direction in the
          // sign of `amount`, so derive rather than trust the label blindly.
          const declared = `${pos?.positionSide ?? ''}`.toUpperCase()
          const positionSide =
            declared === 'LONG' || declared === 'SHORT'
              ? (declared as 'LONG' | 'SHORT')
              : amount < 0
                ? 'SHORT'
                : 'LONG'
          const leverage = `${pos?.leverage ?? ''}`

          return {
            symbol: this.normalizeSymbol(pos?.market ?? ''),
            initialMargin: `${pos?.margin ?? '0'}`,
            maintMargin: '0',
            unrealizedProfit: `${pos?.pnl ?? '0'}`,
            positionInitialMargin: `${pos?.margin ?? '0'}`,
            openOrderInitialMargin: '0',
            // '0' means "not an isolated leverage" and must not be compared by
            // the consumer — same contract as Kraken's positions.
            leverage: leverage && leverage !== 'undefined' ? leverage : '0',
            isolated: false,
            entryPrice: `${pos?.basePrice ?? pos?.entryPrice ?? '0'}`,
            maxNotional: '0',
            positionSide,
            positionAmt: `${amount}`,
            notional: '0',
            isolatedWallet: '0',
            updateTime: pos?.modifyTime
              ? Math.round(Number(pos.modifyTime) * 1000)
              : Date.now(),
            bidNotional: '0',
            askNotional: '0',
            positionId:
              pos?.positionId !== undefined ? `${pos.positionId}` : undefined,
          }
        })

        return this.returnGood<PositionInfo[]>(timeProfile)(positions)
      })
      .catch(
        this.handleWhitebitErrors(
          this.futures_getPositions,
          symbol,
          this.endProfilerTime(timeProfile, 'exchange'),
        ),
      )
  }

  // ===========================
  // Broker / affiliate — all stubs (spec §2.8)
  // ===========================
  //
  // WhiteBit's Broker ID requires account-manager onboarding that has not
  // happened, so there is no program to query and no code to attach. These are
  // stubbed exactly the way Kraken stubs its own: a well-formed `BaseReturn`
  // saying "nothing here", never a thrown error — a caller sweeping every
  // connected exchange for rebates must not have its sweep fail because one
  // venue has no rebate program.

  async getUid(
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<string | number>> {
    return this.returnGood<number>(timeProfile)(-1)
  }

  async getAffiliate(
    _uid: string | number,
    timeProfile = this.getEmptyTimeProfile(),
  ): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>(timeProfile)(false)
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

  /**
   * `supported: false` = "no opinion", never "not earning" — stated explicitly
   * here (rather than inherited) so the §2.8 scope cut is visible in this file.
   */
  override async getReferralStatus(): Promise<BaseReturn<ReferralStatus>> {
    return this.returnGood<ReferralStatus>(this.getEmptyTimeProfile())({
      code: '',
      isNewUser: false,
      rebateWorking: false,
      earning: false,
      supported: false,
    })
  }

  override async setReferralCustomerId(
    _customerId: string,
  ): Promise<BaseReturn<boolean>> {
    return this.returnGood<boolean>(this.getEmptyTimeProfile())(false)
  }

  override async getTraderSummary(
    _startTime?: number,
    _endTime?: number,
    _customerId?: string,
  ): Promise<BaseReturn<TraderSummary[]>> {
    return this.returnGood<TraderSummary[]>(this.getEmptyTimeProfile())([])
  }
}

export default WhitebitExchange
