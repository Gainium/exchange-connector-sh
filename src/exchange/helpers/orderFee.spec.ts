process.env.NODE_ENV = 'testing'

/**
 * Checks for the fee-normalisation the venue mappers share.
 *
 * This repo has no test runner (no jest/vitest, no `test` script — the
 * `.spec.ts` files here never run automatically), so this is a standalone
 * script:
 *
 *   npx ts-node --files --project tsconfig.json \
 *     src/exchange/helpers/orderFee.spec.ts
 *
 * The property worth protecting above all the others: **a fee we could not
 * observe is omitted, never reported as 0.** A `0` tells the caller the order
 * was free and replaces a roughly-right estimate with a definitely-wrong
 * observation; an absent field leaves the estimate in force. Every degenerate
 * input below is asserted to produce `{}` for that reason.
 */
import { describe, it } from 'mocha'
import {
  normalizeOrderFee,
  normalizeOrderFees,
  normalizeSidedOrderFee,
} from './orderFee'
import { bitgetSpotFeeDetail } from '../exchanges/bitget/fees'

function expect(label: string, actual: unknown, want: unknown) {
  it(label, () => {
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

describe('orderFee', () => {
  // 1) The happy path: one fee, one currency, ticker passed through upper-cased.
  expect('single fee', normalizeOrderFee('0.42', 'USDT', 'charge-positive'), {
    feePaid: '0.42',
    feeAsset: 'USDT',
  })
  expect(
    'lower-case ticker is normalised',
    normalizeOrderFee('1', 'usdt', 'charge-positive'),
    {
      feePaid: '1',
      feeAsset: 'USDT',
    },
  )

  // 2) Sign. Each venue states its own convention. OKX and Bitget report a
  //    CHARGE as negative (effect on the balance) and a rebate as positive;
  //    Hyperliquid, Binance, Bybit, KuCoin and Coinbase report a charge as
  //    positive and a rebate as negative. `feePaid` is the net cost, so a
  //    rebate lowers it and a net rebate is not a fee at all.
  expect(
    'negative charge becomes the cost',
    normalizeOrderFee(-0.113, 'USDT', 'charge-negative'),
    {
      feePaid: '0.113',
      feeAsset: 'USDT',
    },
  )
  expect(
    'okx positive rebate is not a fee',
    normalizeOrderFee('0.02', 'USDT', 'charge-negative'),
    {},
  )
  // Hyperliquid fills: `fee` positive for a charge, negative for a maker rebate
  // (taker fills always positive, maker fills on a rebate tier negative).
  const hlFills = (fees: string[]) =>
    normalizeOrderFees(
      fees.map((amount) => ({ amount, asset: 'USDC' })),
      'charge-positive',
    )
  expect('hyperliquid fee only', hlFills(['0.1']), {
    feePaid: '0.1',
    feeAsset: 'USDC',
  })
  expect('hyperliquid rebate only is not a fee', hlFills(['-0.017784']), {})
  expect(
    'hyperliquid fee and rebate on one order net off',
    hlFills(['0.1', '-0.04']),
    {
      feePaid: `${0.1 - 0.04}`,
      feeAsset: 'USDC',
    },
  )
  expect(
    'hyperliquid fills netting to a rebate are not a fee',
    hlFills(['0.01', '-0.04']),
    {},
  )
  expect(
    'a currency that nets to a rebate is dropped from a breakdown',
    normalizeOrderFees(
      [
        { amount: '-0.05', asset: 'USDT' },
        { amount: '0.002', asset: 'BNB' },
        { amount: '0.01', asset: 'USDT' },
      ],
      'charge-positive',
    ),
    { feePaid: '0.002', feeAsset: 'BNB' },
  )

  // 3) Nothing observable → nothing emitted. Never `{ feePaid: '0' }`.
  for (const [label, amount] of [
    ['zero', '0'],
    ['zero number', 0],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['NaN', 'not-a-number'],
  ] as [string, any][]) {
    expect(
      `no fee emitted for ${label}`,
      normalizeOrderFee(amount, 'USDT', 'charge-positive'),
      {},
    )
  }
  expect(
    'no fee emitted without a currency',
    normalizeOrderFee('0.5', '', 'charge-positive'),
    {},
  )
  expect(
    'no fee emitted for an all-empty list',
    normalizeOrderFees(
      [
        { amount: '0', asset: 'USDT' },
        { amount: null, asset: null },
      ],
      'charge-positive',
    ),
    {},
  )

  // 4) Multiple lines in the SAME currency are summed — a partially filled order
  //    settles its fee per trade.
  expect(
    'same-currency lines are summed',
    normalizeOrderFees(
      [
        { amount: '0.1', asset: 'USDT' },
        { amount: '0.2', asset: 'USDT' },
      ],
      'charge-positive',
    ),
    { feePaid: '0.30000000000000004', feeAsset: 'USDT' },
  )

  // 5) Lines in DIFFERENT currencies are never added. `feePaid` is deliberately
  //    left unset so a consumer reading only `feePaid` cannot take one leg for
  //    the whole cost.
  const mixed = normalizeOrderFees(
    [
      { amount: '0.1', asset: 'USDT' },
      { amount: '0.002', asset: 'BNB' },
    ],
    'charge-positive',
  )
  expect('mixed currencies produce a breakdown', mixed, {
    feeBreakdown: [
      { asset: 'USDT', amount: '0.1' },
      { asset: 'BNB', amount: '0.002' },
    ],
  })
  expect('mixed currencies leave feePaid unset', mixed.feePaid, undefined)

  // 6) The sided form, for venues that name a side rather than a ticker.
  expect(
    'sided fee',
    normalizeSidedOrderFee('0.01', 'quote', 'charge-positive'),
    {
      feePaid: '0.01',
      feeSide: 'quote',
    },
  )
  expect(
    'sided fee omits a zero',
    normalizeSidedOrderFee('0', 'quote', 'charge-positive'),
    {},
  )
  expect(
    'sided charge-negative fee becomes the cost',
    normalizeSidedOrderFee('-2', 'base', 'charge-negative'),
    {
      feePaid: '2',
      feeSide: 'base',
    },
  )
  expect(
    'sided rebate is not a fee',
    normalizeSidedOrderFee('-2', 'base', 'charge-positive'),
    {},
  )

  // 7) Bitget spot `feeDetail`. Sent as a JSON STRING on the wire; mixes a
  //    currency-less `newFees` summary with the bookable currency-keyed entries.
  expect(
    'bitget feeDetail string, single currency',
    bitgetSpotFeeDetail(
      '{"newFees":{"c":0,"d":0,"deduction":false,"r":-0.113,"t":-0.113,"totalDeductionFee":0},"USDT":{"deduction":false,"feeCoinCode":"USDT","totalDeductionFee":0,"totalFee":-0.113}}',
    ),
    { feePaid: '0.113', feeAsset: 'USDT' },
  )
  expect(
    'bitget feeDetail already parsed',
    bitgetSpotFeeDetail({
      USDT: { deduction: false, feeCoinCode: 'USDT', totalFee: '-0.5' },
    }),
    { feePaid: '0.5', feeAsset: 'USDT' },
  )
  expect(
    'bitget BGB deduction keeps the legs apart',
    bitgetSpotFeeDetail({
      newFees: { t: -0.113 },
      BGB: { deduction: true, feeCoinCode: 'BGB', totalFee: '-0.05' },
      USDT: { deduction: false, feeCoinCode: 'USDT', totalFee: '-0.063' },
    }),
    {
      feeBreakdown: [
        { asset: 'BGB', amount: '0.05' },
        { asset: 'USDT', amount: '0.063' },
      ],
    },
  )
  expect(
    'bitget newFees alone is not bookable',
    bitgetSpotFeeDetail('{"newFees":{"t":-0.113}}'),
    {},
  )
  for (const [label, input] of [
    ['undefined', undefined],
    ['empty string', ''],
    ['malformed json', '{not json'],
    ['empty object', {}],
  ] as [string, any][]) {
    expect(
      `bitget feeDetail ${label} yields nothing`,
      bitgetSpotFeeDetail(input),
      {},
    )
  }
})
