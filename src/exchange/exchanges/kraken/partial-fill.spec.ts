process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for forum #4924 — "Kraken - Bug with partially filled orders
 * with futures". A Kraken Futures limit order that fills in pieces is reported
 * by getOrderStatus / getOpenOrders with a raw status of ENTERED_BOOK /
 * partiallyFilled / untouched. The pre-fix code passed that raw status straight
 * through, so mapOrderStatus() fell through to NEW and main-app never recorded
 * the fill → duplicate buys.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/kraken/partial-fill.spec.ts
 *
 * No network / auth needed — it exercises the pure status-mapping helpers.
 */
import { Futures } from '../../types'
import KrakenExchange from './index'

const ex: any = new KrakenExchange(Futures.usdm, '', '')

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = actual === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`)
}

// 1) Raw Kraken Futures statuses must map, not fall through to NEW.
expect('mapOrderStatus(partiallyFilled)', ex.mapOrderStatus('partiallyFilled'), 'PARTIALLY_FILLED')
expect('mapOrderStatus(untouched)', ex.mapOrderStatus('untouched'), 'NEW')
expect('mapOrderStatus(ENTERED_BOOK)', ex.mapOrderStatus('ENTERED_BOOK'), 'NEW')
expect('mapOrderStatus(FULLY_EXECUTED)', ex.mapOrderStatus('FULLY_EXECUTED'), 'FILLED')
// Idempotent on our canonical value so a pre-derived status survives re-mapping
// inside futures_convertOrder (this also repairs the getOrderEvents fallback).
expect('mapOrderStatus(PARTIALLY_FILLED)', ex.mapOrderStatus('PARTIALLY_FILLED'), 'PARTIALLY_FILLED')

// 2) getOrderStatus primary path: a partially-filled order is reported by Kraken
//    as ENTERED_BOOK with filled>0 → must derive PARTIALLY_FILLED from fills.
const primaryPartial = ex.futures_convertOrder({
  orderId: 'o1',
  symbol: 'BTC-USD',
  clientOrderId: 'c1',
  price: 100,
  origQty: 1,
  executedQty: 0.4,
  status: ex.futures_deriveOrderStatus('ENTERED_BOOK', 0.4, 1),
  type: 'lmt',
  side: 'buy',
})
expect('primary ENTERED_BOOK + partial fill', primaryPartial.status, 'PARTIALLY_FILLED')

// 3) getAllOpenOrders path: raw status partiallyFilled with filledSize>0.
const openPartial = ex.futures_convertOrder({
  orderId: 'o2',
  symbol: 'BTC-USD',
  clientOrderId: 'c2',
  price: 100,
  origQty: 1,
  executedQty: 0.6,
  status: ex.futures_deriveOrderStatus('partiallyFilled', 0.6, 1),
  type: 'lmt',
  side: 'buy',
})
expect('open partiallyFilled', openPartial.status, 'PARTIALLY_FILLED')

// 4) Fully filled derives FILLED; untouched/no fill stays NEW; cancel wins over fills.
expect('derive fully filled', ex.futures_deriveOrderStatus('ENTERED_BOOK', 1, 1), 'FILLED')
expect('derive untouched no fill', ex.futures_deriveOrderStatus('untouched', 0, 1), 'NEW')
expect('derive cancelled beats fill', ex.futures_deriveOrderStatus('CANCELLED', 0.4, 1), 'CANCELED')

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log('\nAll assertions passed')
