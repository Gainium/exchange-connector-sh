/**
 * Shared, per-API-key monotonic nonce source for WhiteBit signed REST requests.
 *
 * WhiteBit validates the nonce **per API key**: a signed request is rejected
 * when its nonce is not strictly greater than the last one the key has seen
 * (unless `nonceWindow` is enabled on the key, which widens the accepted range
 * but does not remove the ordering requirement). The connector builds a fresh
 * exchange instance — and therefore a fresh {@link WhitebitClient} — for every
 * request, so an instance-local counter would never survive between calls: two
 * concurrent calls on one key would both read the same millisecond and emit an
 * identical nonce, and one of them would be rejected.
 *
 * This is byte-for-byte the same defect, and the same fix, as
 * `kraken-custom/nonce.ts` — see that file for the full write-up. Keyed by the
 * API key, which is what WhiteBit scopes the nonce to; one small entry per
 * distinct key seen by the process, bounded by the number of connected
 * accounts, so no eviction is needed.
 *
 * **What this does NOT close:** the connector fleet runs several processes, so
 * two processes serving the same key in the same millisecond can still collide.
 * That is the same residual window Kraken has, and is handled the same way —
 * at the balancer, and by the adapter's retry ladder.
 */
const lastNonceByApiKey = new Map<string, number>()

/**
 * Next nonce for `apiKey`: the current millisecond, or `previous + 1` when two
 * calls land in the same millisecond. Returned as a string because that is the
 * form WhiteBit's request body and the signed payload expect.
 */
export function nextWhitebitNonce(apiKey: string | undefined): string {
  const key = apiKey ?? ''
  const now = Date.now()
  const prev = lastNonceByApiKey.get(key) ?? 0
  const next = now > prev ? now : prev + 1
  lastNonceByApiKey.set(key, next)
  return String(next)
}
