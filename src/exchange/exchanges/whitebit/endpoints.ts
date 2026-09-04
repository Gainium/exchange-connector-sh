/**
 * Every WhiteBit path this adapter talks to, in one place — spec 002 §2.2.
 *
 * Collected here rather than inlined so a reviewer can check the whole venue
 * surface against docs.whitebit.com in one pass, and so the `spot` vs
 * `collateral` split (§2.2's central architectural point) is visible as a shape
 * rather than buried in `if (this.usdm)` branches.
 *
 * ## The one thing to understand about WhiteBit's futures
 *
 * WhiteBit has **no separate futures account**. Perpetual futures and
 * leveraged-margin-on-spot-pairs are the same product — a unified "collateral
 * account" — differentiated purely by the market symbol: `BTC_USDT` routes as
 * leveraged margin on a spot pair, `BTC_PERP` routes as a perpetual. Both go
 * through the `collateral` endpoint family below.
 *
 * `whitebitUsdm` in this integration therefore means "collateral-account
 * trading restricted to `_PERP` markets", not a structurally separate futures
 * API the way Binance/Kraken/Bybit have one. The plain leveraged-margin product
 * (non-`_PERP` collateral trading) has no slot in Gainium's spot/usdm/coinm
 * convention and is out of scope: this adapter never sends a non-`_PERP` symbol
 * through a `collateral` endpoint.
 */
export const WHITEBIT_ENDPOINTS = {
  /** Unauthenticated. Rate-limited against the `public` bucket (§2.6). */
  public: {
    /** Market Info — spot AND futures markets in one list (§2.4). */
    markets: '/api/v4/public/markets',
    /** Every market's `last_price` in one call (§2.2). */
    ticker: '/api/v4/public/ticker',
    /** Perp-only market data, including the current funding rate. */
    futures: '/api/v4/public/futures',
    /** Settled funding history for a perp market. */
    fundingHistory: '/api/v4/public/funding-history',
    /** Recent public trades for a market; the market is a path segment. */
    trades: (market: string) => `/api/v4/public/trades/${market}`,
    /**
     * Historical candles. NOTE this is the only `/api/v1/` endpoint the
     * adapter uses — and its row layout is NOT the usual OHLCV order. See
     * `candles.ts` and spec §2.3.
     */
    kline: '/api/v1/public/kline',
  },

  /** Signed. Rate-limited against the `privateTrade` bucket (§2.6). */
  spot: {
    /** Per-asset available/freeze balances. */
    balance: '/api/v4/trade-account/balance',
    /** Executions on the account, for reconciliation (`getAccountFills`). */
    executedHistory: '/api/v4/trade-account/executed-history',
    /** Active orders; also the single-order lookup, via `clientOrderId`. */
    activeOrders: '/api/v4/orders',
    /** Create a LIMIT order. */
    newOrder: '/api/v4/order/new',
    /** Create a MARKET order sized in the BASE asset. */
    marketOrder: '/api/v4/order/stock_market',
    /** Cancel one order by `market` + `orderId`. */
    cancelOrder: '/api/v4/order/cancel',
  },

  /**
   * Signed, collateral-account family — the perp side (§2.2).
   *
   * Order CREATION lives under `/api/v4/order/collateral/*` (the
   * `collateral-limit-order` / `collateral-market-order` doc pages); the
   * account-level operations live under `/api/v4/collateral-account/*`. Both
   * halves are the same product, so they are grouped together here.
   */
  collateral: {
    /** Collateral-account balances. */
    balance: '/api/v4/collateral-account/balance',
    /** Open positions, with an optional `market` filter. */
    openPositions: '/api/v4/collateral-account/positions/open',
    /**
     * Set leverage. The documented body is `{leverage, request, nonce}` — no
     * `market`. See TODO §3.1 in `index.ts`.
     */
    leverage: '/api/v4/collateral-account/leverage',
    /** Read the account-wide hedge-mode flag. */
    hedgeMode: '/api/v4/collateral-account/hedge-mode',
    /** Write the account-wide hedge-mode flag. */
    setHedgeMode: '/api/v4/collateral-account/update-hedge-mode',
    /** Create a LIMIT order on the collateral account. */
    limitOrder: '/api/v4/order/collateral/limit',
    /** Create a MARKET order on the collateral account. */
    marketOrder: '/api/v4/order/collateral/market',
  },

  /** Signed. Rate-limited against the `privateMain` bucket (§2.6). */
  main: {
    /** The account's own maker/taker rates. */
    fee: '/api/v4/main-account/fee',
  },
} as const
