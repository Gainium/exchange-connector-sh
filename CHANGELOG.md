# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.15.2] - 2026-07-07

### Fixed

- Kraken xStock live prices: `getAllPrices` now also fetches the tokenized Ticker (`asset_class: tokenized_asset`), so deals on Kraken stock pairs get a last/mark price (Kraken serves it even out of hours) instead of "Price unavailable" (which also blocked unrealized P&L / TP-SL).


## [1.15.1] - 2026-07-06

### Fixed

- Kraken xStock fees: `getUserFees`/`getAllUserFees` now fetch the tokenized universe (`aclass: tokenized_asset`), so fees resolve for stock pairs (e.g. PGx-USD) instead of throwing "Pair not found" → "User fee not found".


## [1.15.0] - 2026-07-06

### Added

- Kraken spot now supports tokenized-equity ("xStocks") pairs (e.g. `AAPLx-USD`, `SPYx-USD`). Kraken hides these from the default `AssetPairs` response and rejects every per-pair call that omits the tokenized flag ("Unknown asset pair"), so none surfaced before. `getAllExchangeInfo` (spot) now makes a second `AssetPairs` call with `aclass: 'tokenized_asset'`, merges those pairs, tags each `assetClass: 'etf' | 'stock'` (ETF/index trackers curated in `KRAKEN_XSTOCK_ETFS`, everything else `'stock'`), and registers them via `KrakenSymbolMapper.setTokenized()`. Per-pair spot calls — `latestPrice` (Ticker), `getCandles` (OHLC), `getTrades` (RecentTrades) and `openOrder` (AddOrder) — inject `asset_class: 'tokenized_asset'` for tokenized symbols via `xstockParams()`. Param-name quirk preserved: `AssetPairs` uses `aclass`, all other calls use `asset_class`.
- ADDITIVE + flag-gated: enabled by default, disabled with `KRAKEN_XSTOCKS_ENABLED=false`, and skipped in demo/testnet. Ordinary crypto Kraken spot/futures pairs are unaffected — they carry no `assetClass` and never receive the `asset_class` param.

## [1.14.3] - 2026-07-06

### Fixed

- Kraken spot `getOrder` now resolves a Kraken order txid via QueryOrders (guarded by txid-format detection). main-app already translates our client id to the stored txid before polling Kraken order status (reconcile / checkOrdersAfterReconnect), but the connector could only look up by userref (`parseInt('O…',16)=NaN`), so that path never resolved — resting Kraken spot fills were never reconciled. This repairs the missed-fill reconcile backstop for Kraken (forum #4890); pairs with main-app preserving the local clientOrderId in the merge.

## [1.14.2] - 2026-07-06

### Fixed

- Kraken spot order placement re-fetched the just-placed order by userref, which collides across ALL Gainium client order ids (shared "D-…"/"GRID-…" prefixes all parse to the same int) — with ≥2 such orders on an account, an instantly-filled market order came back as a DIFFERENT resting order (open, 0 filled) and the fill was silently never registered on the deal. Now resolves by the Kraken txid via QueryOrders (exact, state-independent), falling back to the legacy lookup. Also report the average executed price (not descr.price, which is '0' for market orders) in QueryOrders/closed-orders results.

## [1.14.1] - 2026-07-05

### Fixed

- Hyperliquid futures balance under-reported total equity. `futures_getBalance` derived `locked` from `marginSummary.totalMarginUsed` (open-position margin only), so `free + locked = withdrawable + positionMargin` omitted the collateral HL reserves for OPEN ORDERS — a leveraged account with deep resting grid/DCA ladders showed far less than its real `accountValue` (e.g. $13.9k for a $20.8k account). Derive `locked = accountValue - free` (free = `min(withdrawable, accountValue)`) so total equals `accountValue`; still clamps `locked >= 0` and collapses the anomalous non-primary `accountValue=0` dex-state to zero (no phantom balance).

## [1.14.0] - 2026-07-04

### Added

- Hyperliquid spot: emit `isCanonical` per pair (HL-canonical or Unit-bridged = true; permissionless HIP-1 = false) for the dashboard "Canonical only" pair-picker filter.

### Changed

- Hyperliquid spot: stop hiding permissionless TradFi-namesquat tokens; surface every pair and let the dashboard filter/classify them. Equity/RWA spot tokens are still classified via `perpCategories`.

## [1.13.4] - 2026-07-04

### Fixed
- Hyperliquid `spot_getBalance` now clamps a negative spot `hold` to `0`. Hyperliquid can return a negative `hold` on spot-perp / builder-dex wallets (observed live: USDC `total=59953 hold=-85125`, USDT0 `total=0 hold=-89572`); the old `free = total - hold` inflated `free` by the absolute hold (USDC showed `145078` instead of the real `59953`, USDT a phantom `89572`) and `locked = hold` went negative. Now `locked = max(0, hold)` and `free = max(0, total - locked)`, so `free + locked === total` and neither value is phantom. This is the true source of the wrong Hyperliquid free/locked seen in the dashboard; the earlier `futures_getBalance` and main-app `normalizeLocked` fixes addressed the negative-`locked` symptom but not the inflated spot `free`.

## [1.13.3] - 2026-07-04

### Fixed
- Hyperliquid `futures_getBalance` now also bounds `free` by the dex-state's own value — `min(withdrawable, accountValue - locked)` — instead of the raw account-level `withdrawable`. Prevents a phantom balance (e.g. USDT `free=89568` on a state whose `accountValue=0`) from surfacing the account total under a non-primary collateral asset. No change for healthy single-collateral accounts where `withdrawable ≤ accountValue - marginUsed`.

## [1.13.2] - 2026-07-04

### Fixed
- Hyperliquid `futures_getBalance` now derives `locked` from `marginSummary.totalMarginUsed` (per-collateral, always ≥ 0) instead of `accountValue - withdrawable`, which produced a negative `locked` whenever an account-level `withdrawable` exceeded a given dex-state's `accountValue` (e.g. a non-primary collateral reading `accountValue=0`). Fixes negative locked balances propagating to the `balances` collection and wrong "available" display.

## [1.13.1] - 2026-07-04

### Fixed
- Binance.US API-key verification now hits the spot `GET /api/v3/account` (`getAccountInformation`) instead of the Binance.com-only `GET /sapi/v1/account/info` (`getAccountInfo`), which 404s on Binance.US. Every Binance.US key was being rejected as invalid regardless of its actual validity/permissions.

## [1.13.0] - 2026-07-04

### Changed

- Hyperliquid: all Unit-bridged spot bases now normalize to their canonical ticker (`UETH→ETH`, `USOL→SOL`, … — previously only `UBTC→BTC`), derived authoritatively from `spotMeta` `fullName` with a collision guard (`UPUMP`/`UMOG`/`UUUSPX` stay raw). Both the display pair and the wallet balance asset are normalized, and the raw Unit pair is dual-registered so bots created before the change still resolve.

### Fixed

- Hyperliquid: spot balances now reconcile to the pair base (`UBTC` wallet asset → `BTC`), so SELL side and bot funds no longer read 0 for spot holdings (forum #4860), for every Unit token — not just BTC.

### Removed

- Hyperliquid: un-curated HIP-1 permissionless spot tokens that namesquat a TradFi ticker (`AAPL`, `TSLA`, `MSFT`, … — one-genesis-address synthetics with near-zero depth) are now hidden from the spot listing. The real, curated equity exposure is the HIP-3 perp, classified on the perp path.

## [1.12.0] - 2026-07-04

### Added
- OKX Europe (`okxsource=my` → eea.okx.com) authoritative spot instruments. New `GET /exchange/account` endpoint + `OKXExchange.getAccountSpotExchangeInfo()` hit the authenticated, account-scoped `/api/v5/account/instruments` and return the account's real tradeable universe (USDC/EUR spot) — the public feed still advertises the global USDT set EU accounts cannot trade. The instrument→`ExchangeInfo` mapper is now shared between the public and account-scoped paths. Non-OKX exchanges resolve to a "not supported" default.

## [1.11.1] - 2026-07-04

### Fixed
- Binance/Binance.US API-key verification now reports the exchange's real rejection (`code` + message from the client's `.body`/`.response.data`) instead of the useless `Binance us catch [object Object]`. Add-exchange failures for Binance.US were unreadable in the logs, hiding whether the cause was the key, permissions, or IP.

## [1.11.0] - 2026-07-02

### Added
- Authoritative `assetClass` for **Binance** USDⓈ-M TradFi-Perps, read from the exchange's own `underlyingType` in `getAllExchangeInfo`: `EQUITY`/`KR_EQUITY`/`PREMARKET` → `stock` (an `ETF` subtype → `etf`), `COMMODITY` → `commodity`. `COIN` and Binance's crypto composite `INDEX` (BTCDOM/DEFI/ALL) stay crypto, so existing pairs are untouched. Lets stock/commodity symbols surface under their own asset class downstream.

## [1.10.0] - 2026-07-01

### Added
- Authoritative `assetClass` for **Hyperliquid** HIP-3 builder-dex (TradFi) perps from its own `perpCategories` info endpoint: `stocks`/`preipo` → `stock`, `commodities` → `commodity`, `indices` → `index`, `fx` → `forex`. Crypto/native perps stay crypto. (Supersedes the 1.9.0 note that Hyperliquid exposes no signal — the signal lives in the separate `perpCategories` endpoint, keyed by `dex:ASSET`.)

### Changed
- Bitget **SPOT** tokenized stocks (reality tokens `rTSLA`/`rAAPL`/…, v3 `symbolType: stock`) are now **excluded** from spot exchange-info — they are not tradeable through Bitget's API yet, so surfacing them as tradeable pairs was misleading. Re-enable by removing the filter in `spot_getAllExchangeInfo` once Bitget supports API trading for reality stocks. Metals (PAXG/XAUT) are unaffected.

## [1.9.0] - 2026-06-30

### Added
- Authoritative `assetClass` extended to **Bybit** and **Kraken** (same no-heuristics rule as Bitget):
  - Bybit reads its own `symbolType` from v5 instruments-info — spot tokenized equities (`xstocks`) → `stock`; linear perps `stock` → `stock` and `commodity` → `commodity` (Bybit's own label for oil/XAU/XAG, kept verbatim).
  - Kraken Futures reads its own `category` from `/derivatives/api/v3/instruments` — `xStocks`/`Pre-IPO` → `stock`, `Forex` → `forex`, `Commodities` → `commodity`. Kraken's crypto buckets (`Real-world assets`, `DTF`, Layer 1/DeFi/…) stay crypto; Kraken **spot** exposes no class signal (`aclass_base` is uniformly `currency`) so it stays crypto.
- Investigated and left crypto (no authoritative TradFi field exposed): OKX (`instCategory` is a fee tier; `pre_market` is crypto), Binance, KuCoin, Coinbase, Hyperliquid.

## [1.8.0] - 2026-06-30

### Added
- Authoritative asset class per symbol on `ExchangeInfo` (`assetClass`: crypto/stock/etf/commodity/metal/forex/index). Bitget populates it from the unified v3 instruments endpoint (`symbolType`) for both spot and futures — no heuristics. Other exchanges leave it unset (default crypto downstream).

## [1.7.2] - 2026-06-28

### Fixed
- Kraken Futures hedge mode now reports one-way/netting (`getHedge` → false) instead of a hardcoded `true`, which had permanently blocked neutral futures grid bots with "Bot cannot run in hedge mode"
- Kraken spot `submitOrder` re-resolves the just-placed order by its client order id instead of the Kraken txid, so a resting limit order placed below market is no longer wrongly closed with "Order not found in open orders"

## [1.7.1] - 2026-06-25

### Fixed
- Binance spot rebate now queries the apiReferral endpoint (`sapi/v1/apiReferral/rebate/recentRecord`) instead of the sub-account broker endpoint, so records carry orderId/email and can be attributed to users

## [1.7.0] - 2026-06-22

### Added
- Get funding rate hsitory

## [1.6.1] - 2026-06-08

### Fixed
- Bitget futures balance

## [1.6.0] - 2026-06-04

### Added
- Kucoin hedge mode

## [1.5.2] - 2026-06-02

### Added
- Hyperliquid builder fees

## [1.5.1] - 2026-06-01

### Changed
- Hyperliquid balance 422 error retry and log

## [1.5.0] - 2026-05-28

### Added
- Self-hosted admin-config sync (gated by `ADMIN_CONFIG_ENABLED`). Reads
  `gainium:admin:enabled_exchanges` from Redis, subscribes to
  `gainium:admin:config` pubsub for sub-second propagation, and runs a
  10s periodic refresh as a safety net for dropped messages. When the
  flag is off (cloud / unflagged deployments) every code path is a hard
  no-op — no Redis connection opened, no timers, no log lines.

## [1.4.3] - 2026-05-06

### Fixed
- Hyperliquid asset index shift

## [1.4.2] - 2026-05-05

### Fixed
- Hyperliquid handle infinite loop

## [1.4.1] - 2026-05-05

### Fixed
- Hyperliquid not respect limits

## [1.4.0] - 2026-05-04

### Added
- Hyperliquid HIP-3 support

## [1.3.5] - 2026-05-04

### Fixed
- Binance handle HTML 500 error

## [1.3.4] - 2026-04-20

### Changed
- Hyperliquid request fills for limit orders

## [1.3.3] - 2026-04-07

### Changed
- Improve bitget get spot candles request

## [1.3.2] - 2026-03-09

### Changed
- Drop Kraken Coinm support 

## [1.3.1] - 2026-03-06

### Fixed
- Kraken Coinm base asset precision
- Get Coinm candles request

## [1.3.0] - 2026-03-04

### Added
- Kraken

## [1.2.1] - 2026-02-06

### Changed
- Added OKX host app.okx.com

## [1.2.0] - 2026-01-28

### Added
- Support Binance ED25519 keys. 

## [1.1.21] - 2026-01-08

### Changed
- Workaround for Bybit EU pairs. 

## [1.1.20] - 2026-01-08

### Changed
- Handle Binance Request throttled by system-level protection error. 

## [1.1.19] - 2026-01-06

### Changed
- Bybit host. 

## [1.1.18] - 2025-12-12

### Fixed
- Bitget futures candles error. 

## [1.1.17] - 2025-12-08

### Changed
- Hyperliquid retry count. 

## [1.1.16] - 2025-11-11

### Fixed
- Bitget get candles request. 

## [1.1.15] - 2025-11-11

### Fixed
- Hyperliquid sub-account requests without vault address. 

## [1.1.14] - 2025-11-10

### Added
- Hyperliquid sub-account support. 

## [1.1.13] – 2025-11-06

### Fixed
- Hyperliquid queue

## [1.1.12] – 2025-11-03

### Added
- Hyperliquid significant figures check

## [1.1.11] – 2025-10-29

### Changed
- Hyperliquid retry get order amount

## [1.1.10] – 2025-10-27

### Fixed
- Hyperliquid futures balance

## [1.1.9] – 2025-10-22

### Changed
- Bybit coinm quote workaround

## [1.1.8] – 2025-10-20

### Fixed
- Bitget USDC product type

## [1.1.7] – 2025-10-20

### Changed
- Coinbase retry count

## [1.1.6] – 2025-10-13

### Changed
- Bitget limiter logic

## [1.1.5] – 2025-10-07

### Changed
- Hyperliquid price precision logic

## [1.1.4] – 2025-10-01

### Fixed
- Hyperliquid get order retry

## [1.1.3] – 2025-09-29

### Changed
- Updated hyperliquid asset helper logic

### Fixed
- Spot order placement

## [1.1.2] – 2025-09-26

### Fixed
- Hyperliquid all open orders response

## [1.1.1] – 2025-09-26

### Changed
- Hyperliquid market order price deviation
- Hyperliquid spot reduce only flag
- Hyperliquid retry get order

## [1.1.0] – 2025-09-24

### Added
- Hyperliquid integration

## [1.0.13] - 2025-09-01

### Changed
- Bitget futures total balance calculation

## [1.0.12] - 2025-08-29

### Changed
- Bybit do not retry 403 error
  
## [1.0.11] - 2025-08-25

### Changed
- Bybit pre launch pairs

## [1.0.10] - 2025-08-19

### Fixed
- Coinbase limit_limit_gtc undefined

## [1.0.9] - 2025-08-18

### Fixed
- Kucoin handle error in change margin type method

## [1.0.8] - 2025-08-07

### Changed
- Binance logs reduced

## [Unreleased]

## [1.0.7] - 2025-07-24

### Changed
- Binance futures to drop long requests
- Bump dependencies

## [1.0.6] - 2025-07-16

### Added
- Added support for Bybit regional hosts (com, eu, nl, tr, kz, ge)
- New `BybitHost` enum with regional API endpoint mappings
- Enhanced Bybit exchange implementation to support host selection
- Added `bybitHost` parameter to exchange factory and verification helpers

### Changed
- Updated exchange service to accept `bybitHost` parameter
- Modified exchange controller to handle Bybit host configuration
- Enhanced verification helpers to support Bybit host validation
- Updated Bybit exchange constructor to accept optional host parameter

### Fixed
- Coinbase pagination

## [1.0.5] - 2025-07-10

### Added

- Added `futures_changeMarginType` method to KuCoin exchange implementation
- Support for switching between ISOLATED and CROSS margin modes in KuCoin futures
- Enhanced futures trading capabilities with margin mode management

## [1.0.4] - 2025-06-30

### Changed

- Switched to npm package manager
- Removed yarn.lock file (no longer needed with npm)

## [1.0.3] - 2025-06-27

### Security
- Bumped module versions to fix known vulnerability

### Changed
- Bumped binance-api-node from ^0.12.0 to ^0.12.9
- Bumped bitget-api from ^2.0.13 to ^2.3.5
- Bumped bybit-api from ^3.3.3 to ^4.1.13
- Bumped coinbase-advanced-node from ^3.0.1 to ^4.1.0
- Bumped okx-api from ^1.1.3 to ^2.0.5
- Updated exchange connector logic to accommodate new package versions
- Updated Bybit custom REST client implementation
- Updated exchange type definitions and implementations for Bitget, Bybit, and OKX
- Updated Binance exchange connector implementation

## [1.0.2] - 2025-06-26

### Added
- Introduction of custom REST clients for exchange implementations
- Enhanced exchange connector functionality across multiple exchanges

### Changed
- Updated Binance exchange implementation with custom REST client
- Updated Bybit exchange implementation with custom REST client
- Updated Bitget exchange implementation with custom REST client
- Updated Kucoin exchange implementation with custom REST client
- Updated OKX exchange implementation with custom REST client
- Updated Coinbase exchange implementation with custom REST client
- Adjustments made to corresponding test.ts files for all exchange implementations
- Enhanced rate limiting functionality for exchange implementations
- Refined verification helpers
- Updated environment sample configuration
- Updated project documentation (README.md)
- Updated dependency lockfile (yarn.lock)
- @gainium/kucoin-api updated from 1.0.3 to 1.0.4

### Fixed
- Various bug fixes and improvements across exchange implementations
- Enhanced error handling and reliability

### Removed
- Deleted src/utils/crypto.ts file

## [1.0.1] - Previous Release
- Initial stable release
