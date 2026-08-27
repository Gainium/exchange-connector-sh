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
import {
  normalizeOrderFee,
  normalizeOrderFees,
  normalizeSidedOrderFee,
} from './orderFee'
import { bitgetSpotFeeDetail } from '../exchanges/bitget/fees'

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(
      actual,
    )} want ${JSON.stringify(want)}`,
  )
}

// 1) The happy path: one fee, one currency, ticker passed through upper-cased.
expect('single fee', normalizeOrderFee('0.42', 'USDT'), {
  feePaid: '0.42',
  feeAsset: 'USDT',
})
expect('lower-case ticker is normalised', normalizeOrderFee('1', 'usdt'), {
  feePaid: '1',
  feeAsset: 'USDT',
})

// 2) Sign. OKX, Bitget and Hyperliquid report a CHARGE as negative (effect on
//    the balance). `feePaid` is the cost, so it is always the magnitude.
expect('negative charge becomes magnitude', normalizeOrderFee(-0.113, 'USDT'), {
  feePaid: '0.113',
  feeAsset: 'USDT',
})

// 3) Nothing observable → nothing emitted. Never `{ feePaid: '0' }`.
for (const [label, amount] of [
  ['zero', '0'],
  ['zero number', 0],
  ['empty string', ''],
  ['undefined', undefined],
  ['null', null],
  ['NaN', 'not-a-number'],
] as [string, any][]) {
  expect(`no fee emitted for ${label}`, normalizeOrderFee(amount, 'USDT'), {})
}
expect('no fee emitted without a currency', normalizeOrderFee('0.5', ''), {})
expect(
  'no fee emitted for an all-empty list',
  normalizeOrderFees([
    { amount: '0', asset: 'USDT' },
    { amount: null, asset: null },
  ]),
  {},
)

// 4) Multiple lines in the SAME currency are summed — a partially filled order
//    settles its fee per trade.
expect(
  'same-currency lines are summed',
  normalizeOrderFees([
    { amount: '0.1', asset: 'USDT' },
    { amount: '0.2', asset: 'USDT' },
  ]),
  { feePaid: '0.30000000000000004', feeAsset: 'USDT' },
)

// 5) Lines in DIFFERENT currencies are never added. `feePaid` is deliberately
//    left unset so a consumer reading only `feePaid` cannot take one leg for
//    the whole cost.
const mixed = normalizeOrderFees([
  { amount: '0.1', asset: 'USDT' },
  { amount: '0.002', asset: 'BNB' },
])
expect('mixed currencies produce a breakdown', mixed, {
  feeBreakdown: [
    { asset: 'USDT', amount: '0.1' },
    { asset: 'BNB', amount: '0.002' },
  ],
})
expect('mixed currencies leave feePaid unset', mixed.feePaid, undefined)

// 6) The sided form, for venues that name a side rather than a ticker.
expect('sided fee', normalizeSidedOrderFee('0.01', 'quote'), {
  feePaid: '0.01',
  feeSide: 'quote',
})
expect('sided fee omits a zero', normalizeSidedOrderFee('0', 'quote'), {})
expect('sided fee takes the magnitude', normalizeSidedOrderFee('-2', 'base'), {
  feePaid: '2',
  feeSide: 'base',
})

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
