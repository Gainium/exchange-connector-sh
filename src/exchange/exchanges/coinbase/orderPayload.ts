import { Order } from 'coinbase-advanced-node'

/**
 * Spec `008` §4.1 — what a Coinbase payload must STATE before
 * {@link CoinbaseExchange#convertOrder} has an order to convert.
 *
 * These are identity facts: which order, on which pair, which way round, of
 * which kind, opened when. A Coinbase order object carries all five from the
 * moment it is accepted. Deliberately NOT here are `filled_size`,
 * `average_filled_price`, `filled_value` and `total_fees` (§4.2) — those are
 * fill facts, and a resting order legitimately states none of them.
 *
 * "States" is the whole test (§4.3): a value we do not recognise is still a
 * statement, and how `convertOrder` maps it is that mapping's business. What
 * this refuses is silence — because the converter answers silence with
 * `MARKET`, `BUY` and `new Date(undefined)`, and those reach the database
 * looking exactly like facts.
 *
 * Pure: no client, no network, no `this`.
 */
export function unstatedOrderFields(order?: Partial<Order>): string[] {
  if (!order || typeof order !== 'object') {
    return ['order_id', 'product_id', 'side', 'order_type', 'created_time']
  }
  const stated = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  const missing: string[] = []
  if (!stated(order.order_id)) missing.push('order_id')
  if (!stated(order.product_id)) missing.push('product_id')
  if (!stated(order.side)) missing.push('side')
  if (!stated(order.order_type)) missing.push('order_type')
  // The `NaN` source. `+new Date(undefined)` is `NaN`, which becomes `null`
  // the moment the answer is JSON-encoded for transport to main-app.
  if (!Number.isFinite(+new Date(order.created_time as unknown as string))) {
    missing.push('created_time')
  }
  return missing
}

/**
 * The reason string the refusal carries. Names the order the venue was asked
 * about — without it the operator has an error with no subject — and the
 * fields it declined to describe.
 *
 * Worded to match no entry in `handleCoinbaseErrors`' retryable `reasons`
 * list, so the refusal is reported once rather than slept over (§4.4).
 */
export function unreadableOrderPayload(
  askedFor: string,
  unstated: string[],
): string {
  return (
    `Coinbase described no order for ${askedFor}: the payload states no ` +
    `${unstated.join(', ')}. Refusing to convert it.`
  )
}
