---
name: new-exchange-integration-exchange-connector-sh
description: This repo's slice of adding a brand-new exchange to Gainium — the adapter (implements the Exchange interface, symbol mapping, rate limits, verify/factory registration). Use when scoping or implementing a new-exchange PR in exchange-connector-sh, or figuring out what else across the platform depends on this adapter.
---

# New exchange integration — exchange-connector-sh's part

Canonical source: `new-exchange-integration` in Gainium's internal `skills`
repo (private — this file is a scoped copy synced from there; edit the
source, not this copy, if it needs updating).

## Global objective

Gainium supports trading on multiple exchanges through a common internal
`Exchange` interface — one adapter per exchange, so the rest of the platform
(bot engine, dashboards, backtester, paper trading) never has to know which
exchange it's talking to. Adding a new exchange means implementing that
interface once here, then wiring the resulting enum id through every
service that has its own copy of the exchange list.

## This repo's part

This is the bulk of the real work — the adapter.

Implement `<Name>Exchange extends AbstractExchange implements Exchange`
(`src/exchange/exchanges/<name>/index.ts`). Check the current `Exchange`
interface (`src/exchange/types.ts`) for the exact method list — it typically
includes balance/order/position lookups, order placement/cancellation,
price/candle/trade history, and (for futures exchanges) leverage/margin/
hedge methods. **Every method must return `BaseReturn<T>`**
(`{status, data, reason, usage, timeProfile}`) — this shape is load-bearing
across the whole platform; don't invent your own.

Supporting pieces, same PR:

1. **Symbol mapping** — exchanges name pairs differently from Gainium's
   normalized form. Build the map (often a cached singleton) and expose
   `toOurSymbol` / `to<Exchange>Symbol`. This is the #1 source of
   post-launch bugs (precision, asset-index mismatches) — get it right.
2. **Custom SDK client**, if no good npm client exists for this exchange.
   Bump `package.json`/`package-lock.json` for any new dependency.
3. **Rate limits** (`src/exchange/exchanges/<name>/limit.ts`) — per-endpoint
   weight/limit declarations the limiter enforces. Skipping this risks an
   IP ban.
4. **`.env.sample`** — any new API host / key env the adapter reads.
5. **Broker/affiliate code on order placement** — the platform hands the
   adapter a broker code as `authHeaders.code`; put it wherever this
   exchange's broker/affiliate program expects it (header, order param,
   builder address for a DEX). This is how Gainium earns trade rebates —
   don't skip it even though nothing errors if you do.

Register the adapter (4 small, easy-to-forget files — verify these still
exist at these paths before assuming the pattern hasn't shifted):

- `src/exchange/types.ts` — add the `ExchangeEnum` members (this repo is one
  of several places the enum is independently declared — see the "enum
  convention" idea: `<name>`, `<name>Usdm`, `<name>Coinm` per variant this
  exchange supports). If the exchange's WS symbol differs from its REST
  symbol, add an optional `wsCode?` field on `ExchangeInfo` here.
- `src/exchange/helpers/exchangeChooser.ts` — register the factory branch.
- `src/exchange/helpers/verify.ts` — add `verify<Name>()`, wire it into the
  verifier map (validates a user's API keys on account-add).
- `src/exchange/helpers/additionalApis.ts` — add cases to `getPrices()` and
  `getCandles()`.

## Sister repos

All public, same repo family as this one:

- **websocket-connector-sh** — the streams: public price/candle WS + private
  user (order/balance) WS, over the same enum ids this repo defines.
- **app-sh** — the bot engine, GraphQL schema, and cron wiring that let a
  running bot actually use this adapter.
- **paper-trading-sh** — the paper-trading mirror (enum + paper-specific
  utils, on top of what this repo defines).
- **main-dash-sh** — the dashboard's exchange config/entitlements/forms —
  what a user sees when adding this exchange.
- **backtester** — the shared backtest engine's own `ExchangeEnum`; needs
  price-helper work too if this exchange has USD-quoted perps.
- **content** — the "connect via API keys" guide the dashboard links to.
- **docker-sh** — the self-hosted release bundle that ships all of the
  above together.

Gainium's cloud SaaS wires a few more pieces on top of this stack
(paid-plan gating, an internal monitoring/admin layer, marketing pages) —
not part of the self-hosted deployment, not this repo's concern.
