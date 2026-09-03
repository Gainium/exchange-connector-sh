process.env.NODE_ENV = 'testing'

/**
 * 2026-08-26 — a canceled, partially-filled TP booked a live DCA deal at a
 * phantom ~18x price and +$684 profit on a $40 position.
 *
 * Hyperliquid's resting-order struct reports `sz` as the REMAINING size, not
 * the executed size. `convertOrder` computed
 * `cummulativeQuoteQty = limitPx * sz` — the remaining notional. main-app
 * derives the booked price as `cummulativeQuoteQty / executedQty`, so a TP of
 * 0.472 with 0.025 filled and 0.447 remaining came back as
 * quote 38.478654 / executed 0.025 = price 1539.15 instead of 86.082, and the
 * deal was closed at that price.
 *
 * Asserted here, per order state:
 *   - canceled partial: quote = executed * limitPx (fills-price when given)
 *   - untouched open order: quote = 0 (was: full notional)
 *   - fully filled limit: quote = origSz * price (was: 0)
 *   - filled MARKET without a fills price: quote = 0 — limitPx is the
 *     slippage-padded IOC request price, nothing traded there (bug #426
 *     shape); with a fills price, that price is used.
 *
 * Run: `npm test` (mocha).
 *
 * No network: getPairByCoin is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'

const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'

/** `getActual` is evaluated lazily, inside the it(), after `before()` has run. */
function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

function makeOrder(overrides: Record<string, unknown>) {
  return {
    coin: 'xyz:CL',
    oid: 525194289095,
    cloid: '0x0c02558653676adb90c97665d1a8b7fa',
    timestamp: 1787581575100,
    orderType: 'Limit',
    limitPx: '86.082',
    origSz: '0.472',
    sz: '0.447',
    side: 'A',
    ...overrides,
  }
}

describe('hyperliquid convert-order-executed-quote', () => {
  let canceled: any
  let canceledWithFillPx: any
  let open: any
  let filled: any
  let market: any
  let marketWithPx: any

  before(async () => {
    const ex = new HyperliquidExchange(
      Futures.usdm,
      '0x14791697260e4c9a71f18484c9f997b308e59325',
      PRIVATE_KEY,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )
    const anyEx = ex as any
    anyEx.getPairByCoin = async () => 'xyz:CL-USDC'

    // The incident order: TP 0.472, filled 0.025, canceled with 0.447 remaining.
    canceled = await anyEx.convertOrder(makeOrder({}), 'canceled', 1)

    // Same order with a fills-derived price supplied by getOrder.
    canceledWithFillPx = await anyEx.convertOrder(
      makeOrder({}),
      'canceled',
      1,
      '86.100',
    )

    // Untouched open order: nothing executed, nothing to report.
    open = await anyEx.convertOrder(makeOrder({ sz: '0.472' }), 'open', 1)

    // Fully filled limit order.
    filled = await anyEx.convertOrder(makeOrder({ sz: '0' }), 'filled', 1)

    // Filled MARKET without a fills price: limitPx is the padded IOC request
    // price — report 0 so the consumer falls back to the price it knows.
    market = await anyEx.convertOrder(
      makeOrder({ orderType: 'Market', sz: '0' }),
      'filled',
      1,
    )
    marketWithPx = await anyEx.convertOrder(
      makeOrder({ orderType: 'Market', sz: '0' }),
      'filled',
      1,
      '85.9',
    )
  })

  // Float subtraction — this exact string is what prod stored for the
  // incident order.
  expect(
    'canceled partial executedQty',
    () => canceled.executedQty,
    '0.024999999999999967',
  )
  expect(
    'canceled partial quote = executed * limitPx',
    () => +(+canceled.cummulativeQuoteQty).toFixed(6),
    +(0.025 * 86.082).toFixed(6),
  )
  expect(
    'canceled partial derived price sane',
    () => +(+canceled.cummulativeQuoteQty / +canceled.executedQty).toFixed(3),
    86.082,
  )

  expect(
    'canceled partial quote uses fills price when given',
    () => +(+canceledWithFillPx.cummulativeQuoteQty).toFixed(6),
    +(0.025 * 86.1).toFixed(6),
  )

  expect('open order executedQty', () => open.executedQty, '0')
  expect('open order quote', () => +open.cummulativeQuoteQty, 0)

  expect('filled limit executedQty', () => filled.executedQty, '0.472')
  expect(
    'filled limit quote = origSz * limitPx',
    () => +(+filled.cummulativeQuoteQty).toFixed(6),
    +(0.472 * 86.082).toFixed(6),
  )

  expect(
    'filled market quote without fills price',
    () => +market.cummulativeQuoteQty,
    0,
  )
  expect(
    'filled market quote with fills price',
    () => +(+marketWithPx.cummulativeQuoteQty).toFixed(6),
    +(0.472 * 85.9).toFixed(6),
  )
})
