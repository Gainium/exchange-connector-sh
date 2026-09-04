# exchange-connector-sh — new exchange runbook

Canonical source: `new-exchange-integration` (private `skills` repo). This
is a scoped excerpt — see [SKILL.md](SKILL.md) for the narrative version.

## Where this sits

This is repo **1 of the public pipeline** (exchange-connector-sh →
websocket-connector-sh → app-sh → paper-trading-sh → backtester →
main-dash-sh → content → docker-sh). Nothing needs to land before this one
— it's the foundation everything else bumps toward. `app-sh`'s bot-engine
work and any dashboard/backtester work should treat this adapter as done
(merged, commit noted) before starting, since they test against its real
shape.

Before writing code: confirm the feasibility check has been done — the
exchange's docs actually support the methods below, its family (spot only /
+usdm / +usdm+coinm) is decided, and its auth model is known (standard
key/secret vs. something non-standard).

## Checklist

```
[ ] exchanges/<name>/index.ts   (adapter, implements Exchange, returns BaseReturn<T>)
[ ]   └ send authHeaders.code (broker code / builder fee) on order placement
[ ] exchanges/<name>/limit.ts   (rate limits)
[ ] <name>-custom/*             (if custom SDK needed)
[ ] symbol mapping + converters (toOurSymbol / to<Exchange>Symbol)
[ ] types.ts                    (ExchangeEnum members, + wsCode? if WS symbol != REST symbol)
[ ] helpers/exchangeChooser.ts  (factory registration)
[ ] helpers/verify.ts           (verify<Name> + verifiers map)
[ ] helpers/additionalApis.ts   (getPrices + getCandles cases)
[ ] .env.sample, package.json (+ package-lock.json if new dep)
[ ] CHANGELOG + version bump
```

## Verify before calling it done

- Every implemented method actually returns `BaseReturn<T>` — no raw
  exceptions, no ad-hoc shapes.
- `verify<Name>()` correctly fails on bad credentials and succeeds on good
  ones (this gates account-add for every user).
- Rate-limit file matches the exchange's documented limits per endpoint —
  don't ship without it.
- If you introduced `wsCode`, note it clearly in the PR description —
  `websocket-connector-sh` and `app-sh` both need to know to thread it
  through.
