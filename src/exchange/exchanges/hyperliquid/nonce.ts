/**
 * Shared, per-signer monotonic nonce source for Hyperliquid signed actions.
 *
 * Hyperliquid validates nonces **per (account, signer)**: a signed action is
 * rejected with `invalid nonce: duplicate nonce <ms>` if the exact nonce has
 * already been seen for that signer. The `@nktkas/hyperliquid` SDK defaults to
 * a **per-ExchangeClient** `NonceManager` seeded from `Date.now()` with a
 * `++lastNonce` collision guard — but that guard only protects requests that
 * share one client instance.
 *
 * The connector builds a fresh `ExchangeClient` per request (see the exchange
 * factory), so two concurrent actions for the same signer each spin up their own
 * NonceManager, both read the same millisecond `Date.now()`, and emit an
 * identical nonce → duplicate. Cancel-heavy flows (DCA/grid rebalances fire many
 * single-order cancels back to back) are where this bites in production.
 *
 * Sharing one counter per signer across every in-process client closes the
 * dominant (same-process) collision window: within a connector process the
 * nonce is now strictly increasing regardless of how many clients exist. The
 * remaining cross-process window (the 6-instance connector fleet can each hold a
 * counter for the same signer) is handled by the retry in
 * `handleHyperliquidErrors`, which re-signs with a fresh, strictly-higher nonce.
 *
 * Keyed by the signer private key (`secret`) since that is what uniquely
 * identifies the Hyperliquid signer; all clients for the same connection share
 * the key and therefore the counter. The map holds one small entry per distinct
 * signer seen by the process (bounded by the number of HL connections) — no
 * eviction needed.
 */
const lastNonceBySigner = new Map<string, number>()

/**
 * Build a nonce function for the given signer, suitable for the SDK's
 * `nonceManager` option. Returns a strictly-increasing integer: the current
 * millisecond time, or `previous + 1` when two calls land in the same
 * millisecond.
 */
export function makeSharedNonce(signer: string | undefined): () => number {
  const key = (signer || '').toLowerCase()
  return () => {
    const now = Date.now()
    const prev = lastNonceBySigner.get(key) ?? 0
    const next = now > prev ? now : prev + 1
    lastNonceBySigner.set(key, next)
    return next
  }
}
