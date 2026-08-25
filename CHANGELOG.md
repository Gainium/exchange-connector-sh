# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.20.1] - 2026-08-25

### Fixed

- **Binance's constructor was two slots short of the positional tail the factory passes**, so every argument after `_environment` landed one place too early: `_code` was receiving `keysType` (always undefined) and `_subaccount` was receiving the broker code. Harmless until something actually read `_code` — `getReferralStatus` did, and answered `supported: false` for every account because the agent code was empty. The unused `_keysType` / `_okxSource` parameters are now declared so the slots line up, matching bybit and kraken.

## [1.20.0] - 2026-08-25

### Added

- `getReferralStatus()`, `setReferralCustomerId()` and `getTraderSummary()` on the exchange interface, implemented for Binance and defaulting to "not supported" everywhere else. `getReferralStatus` is signed with the **user's** credentials and answers whether that account earns broker commission: it needs BOTH `isNewUser` (the account registered after we joined the program — fixed at their signup) and `rebateWorking` (not bound to another referral, below VIP 3 — can change over time). `supported: false` means the venue has no such API and must be read as "no opinion", never as "not earning". Note the apiReferral endpoints want the BARE agent code, not the `x-`-prefixed `newClientOrderId` form, which they reject with `-9000 AgentCode is not exist`.
- `setReferralCustomerId()` registers an id for the credentials so the broker-side per-trader report is keyed by something joinable. Without it the venue reports a masked email (`el***87@***.com`), which cannot be matched to a user.

### Fixed

- **Binance futures rebate reads returned a 403 HTML page instead of data.** `getRebateOverview` passed `/fapi/v1/apiReferral/rebateVol` with a leading slash, and the client joins base + endpoint with `/` — producing `https://fapi.binance.com//fapi/v1/...`. The CDN in front of Binance rejects the doubled slash with a 403 HTML error page rather than a Binance error code, so it never looked like an API failure. Verified against the live API: the same request without the leading slash returns data.
- A COIN-M instance had no `usdmClient`, so `getRebateOverview` threw on `undefined.getPrivate`. Every apiReferral read lives on `fapi` and selects the market with `type` (1 = USD-M, 2 = COIN-M) — there is no working `dapi` equivalent — so the USD-M client is now built for COIN-M instances too.

## [1.19.15] - 2026-08-24

### Fixed

- **Funding history for OKX Europe X-Perps asked OKX for an instrument that doesn't exist.** `getFundingRateHistory` called `ensureXperpMap()` without the symbol hint, and that guard bails out unless the instance is EU-perp (`okxSource=my` + futures) *or* the hint says the symbol is an X-Perp. main-app's hourly funding cron builds the exchange with `choose('', '')` — a keyless instance, so `okxSource` is never set and `isEuPerp` is false — so the map stayed empty and `updateSymbol` handed OKX the bare instFamily (`SOL-USD_UM_XPERP`) instead of the live instId (`SOL-USD_UM_XPERP-310404`). OKX answered `51001 Instrument ID … doesn't exist` every hour, and no funding event was published for that symbol at all. Measured on prod: 72 identical hourly failures for `SOL-USD_UM_XPERP` since 2026-08-21, and the same shape on `XRP-USD_UM_XPERP` on 08-08 — it is every X-Perp symbol that holds a position, not one poisoned registry entry. Passing the hint (as `getNewCandles`, `getHistoricCandles` and `futures_changeLeverage` already do) populates the map from the global keyless rail, which does serve these instruments — the same rail `getXperpTickers` relies on for anonymous price lists.

## [1.19.14] - 2026-08-22

### Fixed

- **Kraken Futures positions reported a hardcoded leverage of 1.** Kraken's position payload carries no leverage — it is a per-contract account preference — and `futures_convertPosition` filled in `leverage: '1', isolated: false`. The bot engine's pre-start check compares that with the bot's own leverage, so every Kraken futures bot above 1x refused to start into an existing position with "Leverage in active position is 1, but in settings 2" (119 live bots across 54 users at the time of the fix; users worked around it by dropping their bots to 1x). `futures_getPositions` now reads the account's leverage preferences once (`GET /derivatives/api/v3/leveragepreferences`) and labels each position with its isolated `maxLeverage`; a contract with no preference is cross (`leverage: '0', isolated: false`), and a failed read leaves leverage `'0'` as well — "not an isolated leverage", which consumers must not compare (main-app core 1.52.8 treats 0 as unknown).

## [1.19.13] - 2026-08-21

### Fixed

- OKX Europe X-Perps are now USDC-quoted. OKX reports their settlement currency as the unified-margin label "USD", which no EU account holds, so every X-Perp pair failed the balance check and bots could never open a deal (reported by discord2020 in the Phase-2 beta, forum topic 4925).

## [Unreleased]

### Fixed

- **Users could not connect an OKX account at all: verification turned one click into ~20 identical calls to a per-UserID rate-limited endpoint, then backed off for longer than the caller's whole budget.** An `addExchange` for "OKX SPOT & Futures" issues the spot and futures verify probes concurrently; each goes out `sendtoall`, which the balancer fans over **every** private connector instance concurrently and then awaits with `Promise.all`; and inside each instance `withPermissions` races `getApiPermission()` against `getKeyPermissions()` — which on OKX are **the same** `GET /api/v5/account/config`. Two legs x five instances x two calls is ~20 requests in one second against a limit OKX applies per **UserID**, not per IP, so no amount of egress spreading helps. The local `checkLimits` guard cannot see any of it: it is per-process, and `getKeyPermissions()` bypassed it entirely. OKX answers the excess with `50011`, and the retry ladder was `(attempts + 1) * 10000` — a **20 second** first sleep, against a rate-limit window measured in seconds and inside main-app's 30s `VERIFY_TIMEOUT_MS`. Because the balancer waits for every leg, **one** throttled instance out of five was enough to blow the entire add; the user saw "The exchange did not respond in time" and had no way through. Two changes, either of which would help and which together remove the failure: `account/config` reads now share their **in-flight** promise, so concurrent callers on one client cost one request instead of two (a settled promise is never reused — account config is mutable and long-lived bot clients must keep reading it fresh); and the `50011` backoff is now jittered exponential, 1s -> 2s -> 4s -> 8s capped, randomised over [0.5x, 1.5x]. The jitter is load-bearing rather than cosmetic: the fan-out legs are issued and throttled in the same millisecond, so a deterministic ladder had all five choose an identical 20 000ms, wake together and collide again — the same lockstep pathology as the Kraken nonce collision (bug #329). Measured on prod: 20 failed OKX connection attempts across **five** users between 2026-08-04 and 2026-08-21 (`bernhard@kanduth.at`, `durstloescher2013@gmx.de`, `christian.hornhues@gmail.com`, `freakytrader@protonmail.com`, `discord2020@elvalet.de`), every one of them carrying the same `OKX Too many requests sleep 20s, getApiPermission` fingerprint across multiple connector instances in the same minute, and the 08-21 attempt matching to the second — probes throttled at 09:59:52, escalating to a 30s sleep at 10:00:12, main-app giving up at 10:00:22.738 "30012ms into the mutation". That is **more** timeouts than genuine bad-key rejections among failed OKX adds in the retained logs, and `getApiPermission` accounts for 431 of the 542 OKX rate-limit sleeps in the archive. Self-hosted installs were never affected — a single connector makes two calls and stays under the limit, which is exactly why the reporter's own localhost build worked while the cloud did not. Note `sendtoall` is deliberately left in place on verify: the balancer floats successful legs to the front of its result sort, so verification passes if **any** egress IP is whitelisted, which is what makes partially-whitelisted keys work at all. Verified against the real class with a stubbed transport — concurrent probes drop 2 requests to 1, a sequential follow-up still re-requests, a single `50011` recovers in ~0.6s instead of 20.0s, and five identically-throttled legs pick five distinct backoffs instead of one shared 20 000ms; all five checks fail on the pre-fix code.

- **A Coinbase connection the venue rejects made the whole portfolio refresh take ~19 seconds.** `handleCoinbaseErrors` classified a 401 `Unauthorized` as retryable and ran the full `retry = 10` ladder at a flat 2s sleep, so a revoked / expired / wrong-type key cost ~18 000ms of pure waiting before returning the same `NOTOK / Unauthorized` it could have returned immediately — 10 rejected requests at Coinbase for every one the platform needed to make, and 195k `Coinbase Unauthorized wait 2000s` lines across the log archive. What that costs the user is not on this service: main-app's `updateUserBalance` refreshes EVERY stored connection on a portfolio refresh and its worker pool waits for all of them, so ONE dead Coinbase connection set the wall clock of the entire `updateBalance` GraphQL resolver. Measured on prod 2026-08-11 as `[SlowGraphQL] op=updateBalance ms=19442..19742` sustained over seven distinct minutes for `marioenzler69@gmail.com`, with the identical 19.3–20.8s band on every other affected user — and all of them, and only them, hold a Coinbase connection already flagged `status: false`. Users with the same venue count and far more balances but no Coinbase connection never entered the band, which is what rules out the fan-out itself. A 401 is the venue's verdict on the credentials, not a blip, so it now reports after a SINGLE re-try (the shape `internalTimeout` already uses) — ~2s instead of ~18s. Every other retryable Coinbase signature keeps its existing ladder; a valid key is untouched. Covered by `unauthorized-retry.spec.ts` (run by hand — these specs have no runner in CI).

- **A Kraken Futures order the venue no longer had was reported as resting on the book, so it could never be cleared.** `getOrderStatus` answers about orders that are open, or were filled or cancelled in the last 5 seconds — but for an id outside that window Kraken still returns an *element*, one that carries no usable `status`. `getOrder` passed it through as `orderInfo.status || 'NEW'`, turning "we do not know this order" into the one answer that means the opposite. What that costs is a permanent phantom: main-app cancels the order, Kraken answers `notFound`, the cancel surfaces as `Unknown order`, and `_handleUnknownOrder` re-reads the order here — and is told `NEW`. Because that is a *successful* read, main-app clears its `canceledMap` retry counter every pass, so the 5-attempt force-cancel written for exactly this case is never reached. Observed on a live Kraken Futures grid bot: order `GRID-RO-1w23…` / `a26e32f1-…` sat at `NEW` in Mongo from 2026-08-05, re-attempting the cancel roughly four times a day, holding a dead grid level, with an `Unknown order` error line on the connector each time. A status element is now only trusted when it carries a status Kraken documents for a real order; anything else falls through to the existing `getOrderEvents` lookup, which either resolves the true outcome (a phantom whose cancellation is in history now reconciles straight to CANCELED) or fails and lets main-app reconcile — the path already proven in production on `CMB-GR-…` orders. Nothing here asserts a cancel the venue did not state, so the 1.19.9 fill-race guarantee is untouched. `mapOrderStatus`'s unknown → `NEW` default is deliberately left alone: it is shared with the spot paths and is not in evidence. Covered by `phantom-order-status.spec.ts` (run by hand — these specs have no runner in CI).
- **Kraken Futures orders were recorded at the price we asked for rather than the price the venue charged, and nothing said so.** `futures_getAvgFillPrice` — the only thing standing between a Kraken futures fill and being booked at its limit price — ended in a bare `catch { return null }`. Every failure looked identical to "this order has no fills yet", so a key that is permanently refused the fills endpoint degraded exactly like a one-off rate limit, forever, invisibly. Three things change:
  - **The execution price now comes from the order-placement response**, where Kraken has been stating it all along. A submit answers with `sendStatus.orderEvents` containing `EXECUTION` entries carrying an exact price and amount per fill; the connector discarded them and re-fetched the order instead, and the re-fetch's only price source is `getOrderStatus`, which exposes the **limit** price and nothing else. For a MARKET order that means the recorded price was the price we requested, with all slippage erased — the fill could walk the book arbitrarily far and the record would not move. The events are free, exact, in the same round trip, and need no extra key permission, so they are now the primary source and the fills endpoint is only a fallback. Measured against recorded history this is where essentially all of the mispricing sat: limit orders were already right (a resting limit fills at its limit), market orders were not.
  - **A permanent failure is no longer indistinguishable from a transient one.** Kraken refuses a key that lacks the query-trades permission with `{result:'error', error:'authenticationError'}` at **HTTP 200**, so it cannot be recognised by status code; the history endpoints refuse with a transport 401. Those are now classified as permanent and logged at `error` stating plainly that orders for that key are being recorded at their limit price, while rate limits, timeouts and 5xx stay a quiet `warn`. Both are rate-limited to once an hour per key so a busy account cannot bury the signal — which is what the previous silence amounted to. The API key is never logged, only a short non-reversible fingerprint, and the reason goes through `safeStringify` because Kraken SDK error objects can carry live credentials. A lookup that simply found no matching fill is still not an error and is not logged: `getFills()` returns the most recent page, so an older fill legitimately is not in it.
  - Order recording still never fails over a price refinement — the fallback to the limit price is retained deliberately, it is just no longer silent.
- **Corrects the record set by 1.19.8.** That entry stated Kraken refuses the fills endpoint "for the API keys our users grant" and that `/accountFills` therefore "returns NOTOK for most accounts". That generalised from two accounts and is wrong: `futures_getAvgFillPrice` calls the very same endpoint with the same credentials from inside this connector, and recorded order history from before that measurement carries — on many accounts, over a long window — an average fill price that only that call can produce. The endpoint authenticates routinely for the large majority of accounts. Why those two refused is still unexplained; a granular per-key permission remains the likeliest reason, it is simply not universal. The comment on `getAccountFills` has been rewritten accordingly. The decision to remove the unverified executions-history fallback stands — it never once executed.

### Added

- `futures_readExecutionPrice()` — pure, shared reader turning a batch of Kraken order events into a size-weighted average execution price and total quantity, returning "nothing executed" rather than a price when the batch carries no `EXECUTION` (so a resting limit order can never be overwritten with an invented fill). The cancel path's inline copy of this logic now delegates to it. Covered by `fill-price.spec.ts` alongside the permanent-vs-transient failure classifier; `cancel-verdict.spec.ts` still passes unchanged. Note these specs have **no runner in CI** and must be run by hand.
- `GET /accountFills` documents that Kraken refuses it for the API keys our users grant: `/derivatives/api/v3/fills` answers `authenticationError` and `api/history/v3/executions` answers HTTP 401, on two unrelated accounts, while `/derivatives/api/v3/accounts` authenticates fine on the same keys, egress IP and signing path. Kraken Futures permissions are granular and ours appear not to include reading trade history. The executions-history fallback added in 1.19.7 has been **removed**: the call never got through, so its mapping never once executed — unverified code implying a working path that does not exist, against a payload the SDK types as `any`. The endpoint itself is kept, typed against the SDK's own `FuturesFill`, and starts working the moment a key carries the permission.
- Read-only `GET /accountFills` — executions on the ACCOUNT, newest first, distinct from `/trades` (the public tape for a symbol). Each fill carries the client order id the caller supplied, which is what makes it reconcilable: a fill the venue reports against one of our ids, for an order we recorded as cancelled-and-unfilled, is a fill we lost — provable per fill, with no argument from margin or position size, and a trade the user placed by hand drops out by construction because it carries no id of ours. Implemented for Kraken Futures (`getFills`, paged backwards via `since`); every other venue inherits the abstract default and returns an empty list rather than an error. Booked in the heavy rate-limit bucket alongside `getTradesHistory`, so walking account history competes with other history calls rather than with trading.

### Fixed

- **A Kraken Futures cancel that raced a fill reported the order as cancelled, and the filled position was lost.** `cancelOrderByOrderIdAndSymbol` checked only that the request succeeded and then returned a hand-built order with `status: 'CANCELED'`, `side: 'BUY'` and no executed quantity — none of it read from the response. Kraken answers a cancel with what actually happened to the order (`cancelStatus.status` is `'cancelled' | 'filled' | 'notFound'`), so an order that filled in the moment before the cancel arrived was reported to the caller as dead. The position stayed on the venue while the engine dropped it from the deal: an untracked position carrying no take-profit and no stop-loss, and a deal short by the filled size. The same fabricated fields also overwrote the order's real side and price wherever the caller merges the response, and silently discarded PARTIAL fills on genuine cancels. The verdict is now read: `filled` returns FILLED with the executed quantity and size-weighted execution price taken from the response's `EXECUTION` events (falling back to the account fills), `cancelled` preserves any partial fill, and `notFound` — or a `filled` the response gives no quantities for — is surfaced as an unknown order so the caller re-fetches and reconciles rather than trusting a cancel that was never observed. Side, price, quantity and client order id now come from the order snapshot Kraken returns instead of being assumed. Kraken **spot** is unchanged: its cancel response carries no fill information, so the same class of defect there needs a separate lookup.

## [1.19.1] - 2026-08-07

### Fixed

- Kraken signed REST requests now draw their nonce from a per-API-key counter shared across the whole process, instead of the SDK's per-client-instance one. Kraken requires the nonce for a key to strictly increase, and `@siebly/kraken-api` seeds `apiRequestNonce` as a field initialiser on each client — a guard that only covers requests sharing one instance. The connector builds a fresh exchange, and therefore a fresh `SpotClient`/`DerivativesClient`, for every request, so two concurrent calls on one key each read the same millisecond and emitted an identical nonce: Kraken accepted one and rejected the other with `EAPI:Invalid nonce`. This is the same defect Hyperliquid had (fixed 2026-07-14 with `hyperliquid/nonce.ts`); Kraken was given only the matching `retryErrors` entries at the time, which masked the collisions instead of preventing them, at the cost of a retry ladder on the affected calls. Note this closes the same-process window only — instances are separate processes and do not share the counter.

## [1.19.0] - 2026-08-05

### Added

- `GET /marginAvailableUsd` reports the USD margin available on pooled-collateral futures accounts, implemented for Kraken Futures' flex (`multiCollateralMarginAccount`) and defaulting to `null` — "no opinion" — on every other venue and account type. Kraken pools all collateral currencies into one cross-margin account, so a wallet funded only in EUR can still margin a USD-quoted perpetual; the per-currency balances from `/balance` show no USD at all in that case, which reads as an empty account to anything sizing off the quote asset. This is deliberately a separate endpoint rather than a synthetic entry in `/balance`: that list is also summed to value a user's portfolio, so publishing the pooled USD figure there next to the per-currency holdings would count the same money twice. Callers must treat `null` as "fall back to the quote-asset balance".

## [1.18.4] - 2026-08-04

### Fixed

- A declared IP allowlist can now only ever prove the positive: a populated list answers `yes`, and empty, absent **or an explicit `*` wildcard** all answer `unknown`. 1.18.3 still treated `['*']` as the exchange affirmatively stating "any IP" and returned `no`. That was wrong, and measurably so — Bybit emits `['*']` rather than `[]`, so of 443 credentials re-probed after 1.18.3 shipped, **441 came back `no`**: the change accomplished nothing for the exchange that motivated it. A wildcard is not a claim that the key is unrestricted; it means the key's own allowlist is empty, which is equally true of a key bound through the connect-a-third-party-app flow where the binding lives on the exchange's side. Such keys report `['*']` and still reject calls from unpublished addresses. The cost is deliberate: `ipRestricted` is now effectively binary (`yes`/`unknown`) and no key can be declared unprotected from this field alone — establishing that requires the two-sided capability probe. Binance is unaffected and can still answer `no`, because it declares `ipRestrict` as an explicit boolean rather than an allowlist to be inferred from.

## [1.18.3] - 2026-08-03

### Fixed

- An empty IP allowlist now answers `unknown` on **every** exchange, not just Bybit. 1.18.2 kept `'no'` for a present-but-empty field on OKX and Bitget on the reasoning that an empty field is the exchange affirmatively reporting no allowlist. That reasoning was wrong: OKX ("Linking third-party apps") and Bitget offer the same connect-a-third-party-app flow as Bybit, which provisions the key and configures its IP binding on the exchange's side, where it does not appear in the key's own allowlist. A key created that way is genuinely bound, reports an empty allowlist, and still rejects calls from outside its binding. Gainium's own connection guides steer users into that flow, so these are the common case rather than an edge case. An empty allowlist therefore cannot distinguish "unrestricted" from "restricted somewhere not visible here", and is not evidence either way. A populated list remains a reliable positive and an explicit `['*']` wildcard remains a reliable negative.

## [1.18.2] - 2026-08-03

### Fixed

- An empty IP allowlist is no longer read as "this key is unrestricted". The parsers previously flattened three different situations into `[]` and answered `ipRestricted: 'no'` for all of them: an allowlist the exchange reported as empty, a field the exchange omitted entirely, and — on Bybit — an allowlist that is empty in the API response while the key is in fact bound, because bindings made through Bybit's third-party-app flow are held on Bybit's side rather than in the key's own allowlist. A key in that last state reads empty here and still answers `10010 Unmatched IP` when called from an address outside its binding. The three are now distinguished: a populated list is `'yes'`, an explicit `['*']` wildcard is `'no'`, a present-but-empty field is `'no'`, an absent field is `'unknown'`, and for Bybit an empty list is `'unknown'` as well. Bitget (`ips`) and OKX (`ip`) no longer synthesise `[]` for a missing field. This follows the rule the module is built on — a parser that cannot tell must answer `unknown`, never `no` — and removes a false negative that reported IP-bound keys as unprotected.

## [1.18.1] - 2026-08-01

### Fixed

- Bitget: `wtow` is no longer treated as a withdrawal authority. The code was inferred rather than documented, and the authority sets returned by live keys contradict it — Bitget makes IP-binding mandatory on withdrawal-enabled keys, yet keys carrying `wtow` are markedly *less* likely to be IP-bound than keys without it, the opposite of what a real withdrawal permission would produce. Since main-app refuses a new connection whose key reports `withdraw: 'yes'`, this was wrongly turning away legitimate Bitget connections, citing a permission the key did not have. `chow`, the other plausible candidate, shows the same inverted pattern and is likewise not withdrawal; neither is added to the known-non-withdrawal list, since ruling a code out is not the same as knowing what it grants, so their keys still resolve to `unknown`.

## [1.18.0] - 2026-07-31

### Added

- Withdrawal-permission detection for exchange API keys. `getKeyPermissions()` reports what a key is allowed to do — withdrawal, internal transfer, IP allowlist — per exchange (Binance `apiRestrictions`, Bybit `query-api`, KuCoin `user/api-key`, OKX `account/config`, Bitget `spot/account/info`, Coinbase `key_permissions`, Kraken via a `WithdrawMethods` probe). Gainium only ever needs read + trade, and withdrawal is never required by any feature; until now nothing verified that a stored key was actually limited that way.
- `VerifyResponse.permissions` (optional, additive) and a new `GET /keyPermissions` endpoint for periodic re-auditing without running a full verification.
- Hyperliquid: detect a pasted **master** private key. An API/agent wallet key can only trade, a master key can withdraw; the account address was validated but the secret never was. The signer address is now derived with the SDK's own `getWalletAddress` and compared against the account.

### Notes

- Every state is tri-state; `unknown` never means `no`. The probe runs concurrently with verification, cannot change a verify verdict, and rejects nothing — reject-vs-flag policy lives in main-app, which knows whether a connection is new.

## [1.17.0] - 2026-07-30

### Added

- OKX Europe X-Perp futures (instType=FUTURES, ruleType=xperp) on the okxLinear rail for okxSource=my: instFamily->instId symbol translation with expiry-roll cache, account-scoped `GET /exchange/account/futures` instrument endpoint, `okxsource` on `GET /exchange/all`, X-Perp candles/tickers/funding on keyless clients, and X-Perp tickers merged into the futures price list. Contributed by community member discord2020 (forum topic 4925).

## [1.16.9] - 2026-07-29

### Fixed

- **Kraken: the public (per-IP) rate limit is now retried with backoff instead of failing instantly (bug #181).** Kraken returns its public-endpoint limit as HTTP **200** with `{"error":["EGeneral:Too many requests"]}` in the body, so it matched neither the spot/futures strings in `retryErrors` nor the numeric `httpStatus` entries — `shouldRetry` was always false. Every rejected `/public/OHLC` call returned `NOTOK` immediately and the market-archive backfiller simply re-requested, so the six-node egress fleet hammered Kraken continuously instead of riding the limit out: prod node 40 logged 142 of 145 error lines with this signature and **zero** `Retrying after` lines, leaving candle backfill gapped and burying every other error on those nodes. The code is now in `retryErrors` and gets the same slow rate-limit pacing (3 attempts, 30s apart) as `EAPI:Rate limit exceeded`. It deliberately does **not** trigger `noteRateLimited()`: that downgrades an *account's* private REST tier, and a per-IP public rejection says nothing about any account's private budget. Covered by `src/exchange/exchanges/kraken/rate-limit.spec.ts`.

## [1.16.8] - 2026-07-29

### Added

- **Kraken spot verify now rejects keys missing the "WebSocket interface" permission (issue #167 / ClickUp 86eyep5au).** Such a key passes the REST balance probe, so the connection looked healthy while the user-stream connector's `GetWebSocketsToken` call was rejected with `EGeneral:Permission denied` forever (16 users on 07-28) — the user was never told and their bots silently fell back to delayed reconcile-sweep-only fill delivery. `verifyKraken` now calls the new `Kraken.verifyWebsocketPermission()` (a `GetWebSocketsToken` probe) after the balance check and fails with a user-facing reason naming the exact Kraken setting to enable, following the Hyperliquid agent-address guard precedent. Only a definite `EGeneral:Permission denied` rejects; transient errors (rate limit, 5xx) never block verification. Spot-only — Kraken Futures WS auth signs a challenge with the key itself and has no separate permission.

### Fixed

- **Kraken: retries no longer re-invoke the method with garbled arguments.** `handleKrakenErrors` retries with `cb.call(this, ...args)`, but 19 call sites passed only the timeProfile — so any retryable Kraken error re-called the method with the TimeProfile object in the first parameter slot (`symbol`/`order`), surfacing as unhandled `TypeError: ourSymbol.replace is not a function` 500s (prod: `latestPrice` since June, `getCandles` on 2026-07-28 via WLFI-USD@krakenUsdm). Every call site now forwards the wrapped method's full argument list, matching the already-correct `getFundingRateHistory`/`futures_changeMarginType` sites.

## [1.16.6] - 2026-07-28

### Added

- **`src/exchange/helpers/symbolCodec.ts` — the single home for pair-symbol format knowledge** (Phase 1 of the symbol-format cleanup behind bug #153). Defines the canonical dashed `BASE-QUOTE` form and the adapter contract: resolve wire symbols through the asset map in one place per adapter, never fabricate a wire symbol on a lookup miss (return `null` → one-attempt `NOTOK Unknown pair`), and pass already-wire symbols through unchanged. Fallback-on-miss is only permitted while the asset map itself is unavailable, so a transient refresh outage degrades instead of hard-failing.

### Fixed

- **Hyperliquid: the two remaining fabrication holes now reject unknown symbols in one attempt instead of retrying HL's `500/null` for ~93s.** The 1.16.5 fix covered futures `getCandles` only; spot `getCandles` still passed an unknown pair through unchanged, and `getFundingRateHistory`'s coin lookup fell back to `split('-')[0]` — both forwarded fabricated coins to Hyperliquid. Both now resolve strictly (`resolveSpotCoin` / `resolveFuturesCoin`) and return `NOTOK Unknown Hyperliquid pair <symbol>` immediately. Verified against the live public API: pair, wire-coin and code forms all still return data (candles futures+spot, funding); compact forms reject in ≤1ms.

## [1.16.4] - 2026-07-25

### Fixed

- **`getFundingRateHistory` now accepts our normalized pair on Hyperliquid and Kraken Futures instead of failing on it forever.** The funding registry can hold either the exchange's own symbol or our pair form, but both connectors assumed the exchange form: Hyperliquid passed the symbol straight in as `coin` (every other info call converts via `getCoinNameByPair`), so `BTC-USDC` got an HTTP 500 from the info API and surfaced as `NOTOK`; Kraken Futures passed it straight through as `symbol`, so `BTC-USD` got `[400] Argument invalid: symbol`. Both now normalize first — Hyperliquid via the existing (idempotent) coin lookup, Kraken only for dash-bearing symbols, since futures codes never contain one — so an already-correct symbol is untouched. Verified against the live public endpoints: HL `BTC-USDC` 500 vs `BTC` 267 rows; Kraken `BTC-USD` 400 vs `PF_XBTUSD` success.

## [1.16.3] - 2026-07-18

### Fixed

- **Kraken Futures: a partially- or fully-filled resting order is no longer reported as `NEW`, which was causing the bot to re-buy the same size at the same price (forum #4924).** Kraken Futures reports a resting order with a raw status of `ENTERED_BOOK` / `partiallyFilled` / `untouched` even when `filled > 0`. `getOrderStatus` (primary) and `getAllOpenOrders` passed that raw status straight into `mapOrderStatus`, which lacked the Futures statuses (only spot `"partially filled"` with a space existed) so everything fell through to `NEW`. main-app keys off `PARTIALLY_FILLED`/`FILLED`, so the fill was never recorded and the bot opened the position again. Both futures paths now derive the status from `executedQty` vs `origQty` via a new `futures_deriveOrderStatus` helper (mirroring the `getOrderEvents` fallback: a terminal cancel/reject wins, otherwise fill-derived), and `mapOrderStatus` gained the Futures raw statuses plus an idempotent `PARTIALLY_FILLED` mapping so a derived status survives the re-map in `futures_convertOrder`. Unit repro: `src/exchange/exchanges/kraken/partial-fill.spec.ts` (10 assertions).

## [1.16.1] - 2026-07-16

### Fixed

- **Hyperliquid: a persistent `clearinghouseState` 429 no longer crashes the whole connector process.** When the short-TTL clearinghouseState cache is enabled (`HL_CH_STATE_CACHE_MS>0`, set to `1500` in prod), `HyperliquidChStateCache.track()` registered the in-flight fetch with `void p.finally(cleanup)`. `.finally()` returns a *new* promise that re-raises `p`'s rejection; that derived chain had no `.catch()`, so although the primary consumer (`await run` in `fetchClearinghouseState`, caught by the balance/positions fan-out) handled the error, the floating finally-chain surfaced it as an **unhandled rejection** — which Node ≥15 turns into a process exit. A sustained Hyperliquid rate-limit therefore killed the connector (pm2 auto-restarted it), cascading into main-app `balance … hyperliquidLinear` Internal Server Errors, `[Funding] NOTOK`, and market-archive backfill failures for that venue. The retry/backoff added in 1.15.x did not prevent this: it fires *before* the final rejection, and the crash came from the exhausted-retry rejection escaping via the un-caught finally-chain. `track()` now swallows the finally-chain rejection (`.finally(cleanup).catch(() => {})`); the real error is still handled by the awaiting consumer. Bug only manifests with the cache enabled (prod), which is why it never reproduced in local dev (cache defaults OFF).

## [1.15.11] - 2026-07-15

### Changed

- **Kraken: rate-limit rejections now retry 3x with 30s spacing instead of 10x with <=10s backoff.** `EAPI:Rate limit exceeded` / `apiLimitExceeded` shared the generic retry policy (10 attempts, exponential backoff capped at 10s), so under sustained per-account saturation every throttled call spawned up to 10 more requests while Kraken's counter only decays at ~0.33-0.5/s -- amplifying the storm (2026-07-14: ~2.3k logged rate-limit errors fleet-wide in 4h). Rate-limit-class errors now get at most 3 attempts spaced 30s apart (sized to the counter decay); all other retryable errors keep the existing policy. Retries still re-enter `checkLimits`, preserving local budget accounting.

## [1.15.10] - 2026-07-14

### Fixed

- Kraken `getAllOpenOrders` no longer throws `Cannot read properties of undefined (reading 'replace')` when called without a symbol. Every other connector treats `getAllOpenOrders(symbol?)` as "all open orders for the account" when the symbol is omitted (e.g. the fill-failsafe reconciliation path calls it with no symbol), and the connector's own HTTP layer declares `symbol` optional — but the Kraken implementation required it and unconditionally ran `toKrakenSymbol(symbol)`, so an undefined symbol reached `String.prototype.replace` in the symbol mapper and crashed. The crash was caught by `handleKrakenErrors` and returned as an error result, so Kraken open-order polling **failed silently** for affected accounts (bot could not see its open orders → risk of missed/duplicate order logic) rather than crash-looping. Kraken now honors the connector-family contract: with no symbol it returns all open orders (skips the per-symbol filter), and only maps+filters when a symbol is given. Both spot and futures branches are fixed.

### Changed

- `KrakenSymbolMapper.toKrakenSymbol` / `toOurSymbol` now return `''` for undefined/empty input instead of throwing on `.replace()` — a defensive guard for the mapper's ~30 call sites (widest-blast-radius `core/` code).
- `handleKrakenErrors` now distinguishes connector-side JS faults (`TypeError`/`ReferenceError`/`RangeError`/`SyntaxError` with no error body/response) from genuine Kraken API rejections: they log as `Kraken connector error (<name>)` with a stack instead of masquerading as `Kraken API error`, so log-triage can tell a code bug from an exchange rejection.

## [1.15.9] - 2026-07-14

### Fixed

- Hyperliquid signed actions no longer fail with `invalid nonce: duplicate nonce` under concurrent same-signer requests. The connector builds a fresh `ExchangeClient` per request, so the SDK's per-client nonce counter never spanned concurrent requests — two actions in the same millisecond emitted an identical `Date.now()` nonce (worst in cancel-heavy DCA/grid rebalances, which fire many single-order cancels back to back). A per-signer monotonic nonce is now shared across all in-process clients, and nonce collisions are added to the retry set for both Hyperliquid and Kraken (combo-bot Kraken legs hit the same class via `EAPI:Invalid nonce`). Nonce rejections are pre-execution, so re-signing with a fresh, higher nonce is safe and cannot double-place or double-cancel. This removes the transient, self-recovering `botError` alerts users were getting for it.

### Changed

- Bitget spot candle reads now page the recent `/spot/market/candles` endpoint at its documented max of 1000 candles/call (was 200), while `/spot/market/history-candles` stays correctly capped at 200. Each range read that stays inside the recent-lookback window now issues ~5x fewer upstream requests, which is the dominant driver of the `Bitget request must sleep` rate-limit churn in the connector fleet (getSpotCandles was the single largest source). Chunk striding in the mixed recent/historic path advances by the page size of the endpoint each chunk uses, so no bars are skipped. Futures candles are unchanged (they use the 200-capped history endpoint; raising them requires an endpoint switch, tracked separately).

## [1.15.7] - 2026-07-12

### Fixed

- Kraken spot `submitOrder` no longer reports a just-placed order as "Order not found in open orders". After a successful submit we hold the order's txid, so the post-submit confirmation now retries the exact `getSpotOrderByTxid` (QueryOrders) lookup a few times to ride out Kraken's brief read-after-write lag before ever falling back to the ambiguous userref path — and the final fallback prefers the txid so `getOrder` re-routes through the exact `isKrakenSpotTxid` lookup. Previously a single QueryOrders miss dropped straight to the userref lookup, where every Gainium client id collapses to one shared userref (`parseInt(id.slice(0,8),16)` stops at the first non-hex char, e.g. all `CMB-*` → 12), so a live order could not be matched and combo/grid/dca placement surfaced a false failure.

## [1.15.6] - 2026-07-11

### Fixed

- Hyperliquid connection verification now rejects an **API/agent wallet address** entered in place of the main account address. HL signs orders with the agent key but executes them on the master account, while every info request (balance/positions/orders) targets the address stored on the connection — so an agent address verified "fine" (an empty balance is a valid response) yet left the bot blind to its own positions and fills: `unknownOid` on order read-back, deals frozen with no recorded entry, and (via base-order retries) doubled positions with no take-profit. `verifyHyperliquid` now calls HL `userRole` on the entered address and, when it resolves to `role: "agent"`, fails verification with a clear message naming the correct main account address to use.

### Reverted

- Reverted the 1.15.5 Hyperliquid numeric-`oid` fallback in `getOrder`. It was built on a misdiagnosis — the observed `unknownOid` reports were either transient cloid lag already handled by the existing retry, or (the real case) an agent address being queried, which no order-read fallback can fix. The fallback added latency on the failing path without resolving any real defect. `getOrder`/`openOrder` return to the 1.15.4 behaviour.

## [1.15.5] - 2026-07-11

### Fixed

- Hyperliquid orders no longer surface a spurious `unknownOid` error for orders the exchange actually accepted. After placing an order, `getOrder` re-fetched it **by cloid** (`newClientOrderId`); under load HL's cloid→oid index lags, so `orderStatus` returned `unknownOid`, and once the retry window (~9.5s) was exhausted the error propagated to the bot even though the order had been placed (and often filled). The place response already returns HL's **authoritative numeric `oid`** synchronously — `openOrder` now captures it and `getOrder` falls back to querying by that oid (which resolves immediately) before giving up. Prior fixes only lengthened the cloid retry window; this removes the root cause.

## [1.15.4] - 2026-07-10

### Fixed

- Kraken Futures now records the **actual average fill price** instead of the limit price. `getOrderStatus`/`getOrderEvents` only expose an order's `limitPrice`, so a limit order that filled better than its limit (common for marketable base orders) was reported at the worse limit price — understating deal P/L (e.g. entry booked at 63528 when Kraken filled at 63264, showing +$1.52 net where the real result was ~+$2.79). `getOrder` now fetches `getFills` for filled orders, computes the size-weighted average execution price, and passes it through as `avgPrice` + `price` + `cummulativeQuoteQty` so main-app's fill logic resolves the true entry on both the placement and poll/reconcile paths. Falls back to the limit price when no fills match (or on a transient `getFills` error), so order recording never breaks.

## [1.15.3] - 2026-07-10

### Fixed

- Kraken Futures rate-limit (`{error:"apiLimitExceeded", httpStatus:429}`) is now retried with backoff. The retry list only had spot's `EAPI:Rate limit exceeded`, so futures 429s were thrown straight through and surfaced to users as an uncategorized `apiLimitExceeded`.

### Changed

- `futures_changeLeverage` / `futures_changeMarginType` now dedupe redundant `setLeverageSettings` calls via a process-level cache of the last confirmed leverage-preference per (account, symbol). Multi-pair futures bots re-set leverage/margin on every deal open, spraying the `leveragepreferences` endpoint across pairs and self-inflicting the 429s above. Cache writes only on confirmed success; 30-min TTL self-heals external changes.

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
