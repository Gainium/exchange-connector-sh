/**
 * Shared, per-API-key monotonic nonce source for Kraken signed REST requests.
 *
 * Kraken validates nonces **per API key**: a signed request is rejected with
 * `EAPI:Invalid nonce` when its nonce is not strictly greater than the last one
 * the key has seen. `@siebly/kraken-api`'s `BaseRestClient` keeps that counter
 * as a **per-client-instance** field seeded from `Date.now()`:
 *
 *     apiRequestNonce = Date.now()          // field initialiser, per instance
 *     getNextRequestNonce() {
 *       const newNonce = Date.now()
 *       if (newNonce <= this.apiRequestNonce) this.apiRequestNonce++
 *       else this.apiRequestNonce = newNonce
 *     }
 *
 * That guard only protects requests sharing one client instance — and the
 * connector builds a fresh exchange (hence a fresh `SpotClient` /
 * `DerivativesClient`) for **every** request, via `getExchange()` →
 * `createExchangeFactory` → `new KrakenExchange(...)`. So two concurrent calls
 * on one key each construct their own client, both read the same millisecond,
 * and emit an identical nonce → one succeeds, the other is rejected.
 *
 * This is the same defect Hyperliquid had (see
 * `exchange/exchanges/hyperliquid/nonce.ts`, 2026-07-14); Kraken was given only
 * the retry entries at the time, which masked the collisions rather than
 * preventing them. Observed in production as duplicate nonces inside a single
 * connector process — e.g. `1785848609663` emitted twice by the same instance,
 * and `…898` followed by the lower `…897` within one second.
 *
 * Sharing one counter per API key across every client in the process closes the
 * same-process window: the nonce is now strictly increasing regardless of how
 * many client instances exist.
 *
 * **What this does NOT close:** the connector fleet runs several processes on
 * one host, so two processes serving the same key in the same millisecond still
 * collide. That window is not a race but a certainty on the `sendtoall` path
 * (`/verify`, `/accountType` fan out to every instance at once) and is handled
 * where it is created — the balancer serialises those legs for Kraken. The
 * retry ladder in `kraken/index.ts` remains the backstop for whatever is left.
 *
 * Keyed by the API key, which is what Kraken scopes the nonce to. The map holds
 * one small entry per distinct key seen by the process (bounded by the number
 * of connected Kraken accounts) — no eviction needed.
 */
const lastNonceByApiKey = new Map<string, number>()

/**
 * Next nonce for `apiKey`: the current millisecond, or `previous + 1` when two
 * calls land in the same millisecond. Returned as a string because that is what
 * Kraken's request body and the sign input expect.
 */
export function nextKrakenNonce(apiKey: string | undefined): string {
  const key = apiKey ?? ''
  const now = Date.now()
  const prev = lastNonceByApiKey.get(key) ?? 0
  const next = now > prev ? now : prev + 1
  lastNonceByApiKey.set(key, next)
  return String(next)
}

/**
 * The nonce the *rejected* request actually carried, for the error log.
 *
 * Without it an `EAPI:Invalid nonce` line is undiagnosable: the two mechanisms
 * that produce one — a duplicate nonce, and a strictly-increasing nonce that
 * simply reaches Kraken out of order — are indistinguishable from the outside,
 * so you cannot tell a regression of the counter from ordinary concurrency.
 * With it, `pid + nonce` across the fleet's logs answers both directly.
 *
 * Read from the *signed* request, not from the caller's params: the nonce is
 * injected inside `signRequest` (`res.requestData = { nonce, ...body }` — a NEW
 * object), so `requestParams.params.body` never sees it. `buildRequest` puts
 * that signed body on the axios options as `data`, and `parseException` staples
 * the whole options object onto the thrown error.
 *
 * ⚠️ That same `requestParams.options` is where the live `API-Key` / `API-Sign`
 * headers ride (see `utils/redact.ts`). This function must only ever return the
 * nonce itself — never the object it came from, and never a widened slice of
 * it. The `\d+` guard is part of that: whatever it returns is digits or nothing.
 *
 * Returns undefined for requests that carry no nonce — the futures/derivatives
 * path signs with `nonce = ''`, and errors this connector raises itself (e.g.
 * `new Error('wouldNotReducePosition')`) have no `requestParams` at all.
 */
export function krakenNonceFromError(error: unknown): string | undefined {
  const data = (error as any)?.requestParams?.options?.data

  const raw =
    typeof data === 'string'
      ? // urlencoded or pre-serialized body
        /(?:^|[&{,"\s])"?nonce"?\s*[:=]\s*"?(\d+)/.exec(data)?.[1]
      : data?.nonce

  return typeof raw === 'string' || typeof raw === 'number'
    ? /^\d+$/.test(String(raw))
      ? String(raw)
      : undefined
    : undefined
}
