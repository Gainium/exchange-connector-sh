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
