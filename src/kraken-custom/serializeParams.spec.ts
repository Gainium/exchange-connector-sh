process.env.NODE_ENV = 'testing'

/**
 * Unit-level check for `serializeParams` in `kraken-custom/SpotClient.ts` — the
 * serializer every signed Kraken request goes through.
 *
 * On the derivatives path the serialized string is not just what gets SIGNED,
 * it is the form body that gets SENT (`DerivativesClient.signRequest`:
 * `res.requestData = serialisedBodyParams`). So any key the serializer emits
 * reaches Kraken verbatim.
 *
 * Bug #383: callers build fixed-shape request objects, so an unused option is a
 * present key holding `undefined` — `reduceOnly` on an entry order,
 * `limitPrice` on a MARKET order. Those were encoded as the literal text
 * `reduceOnly=undefined`, which Kraken read as a non-`false` value and honoured,
 * rejecting plain BUY base orders with `wouldNotReducePosition`. The order
 * shapes below are the ones observed being rejected in prod on connector node
 * 62.84.191.112 on 2026-08-11.
 *
 * Run: npx ts-node --files --project tsconfig.json src/kraken-custom/serializeParams.spec.ts
 *
 * No network / auth needed — the function is pure.
 */
import { serializeParams } from './SpotClient'

const S = (params: Record<string, any>, strict?: boolean) =>
  serializeParams(params, strict, true, '', true)

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`,
  )
}

// 1) The regression itself: a DCA base order (`D-BO-…`) never sets reduceOnly,
//    so openOrder() hands the serializer a `reduceOnly: undefined` key. It must
//    not reach Kraken in any form — present-and-undefined has to be
//    indistinguishable from absent.
const baseOrder = S({
  orderType: 'lmt',
  symbol: 'PF_EURUSD',
  side: 'buy',
  size: 6,
  limitPrice: 1.15664,
  cliOrdId: 'D-BO-AmPIXbTWMtGn4Z3EJrdJkGvsUEcLbW',
  reduceOnly: undefined,
})
check(
  'base order: no reduceOnly key at all',
  !baseOrder.includes('reduceOnly'),
  baseOrder,
)
check(
  'base order: never the string "undefined"',
  !baseOrder.includes('undefined'),
  baseOrder,
)
check(
  'base order: real params survive',
  baseOrder ===
    'cliOrdId=D-BO-AmPIXbTWMtGn4Z3EJrdJkGvsUEcLbW&limitPrice=1.15664' +
      '&orderType=lmt&side=buy&size=6&symbol=PF_EURUSD',
  baseOrder,
)

// 2) A MARKET take-profit close: `limitPrice` is undefined by construction
//    (`type === 'LIMIT' ? price : undefined`) but a DELIBERATE reduceOnly:true
//    must still be transmitted — the fix must not over-strip.
const marketTp = S({
  orderType: 'mkt',
  symbol: 'PF_XBTUSD',
  side: 'sell',
  size: 0.0078,
  limitPrice: undefined,
  cliOrdId: 'D-TP-W7TcUq1TsBYWtpdebjZeqMAZo0RzNT',
  reduceOnly: true,
})
check(
  'market TP: no bogus limitPrice',
  !marketTp.includes('limitPrice'),
  marketTp,
)
check(
  'market TP: reduceOnly=true preserved',
  marketTp.includes('reduceOnly=true'),
  marketTp,
)

// 3) Falsy-but-meaningful values are NOT undefined and must survive — dropping
//    these would silently change order semantics.
check(
  'reduceOnly=false transmitted',
  S({ reduceOnly: false }) === 'reduceOnly=false',
)
check('size=0 transmitted', S({ size: 0 }) === 'size=0')
check('empty string transmitted', S({ cliOrdId: '' }) === 'cliOrdId=')
check('null unchanged', S({ x: null }) === 'x=null')

// 4) Shape/ordering guarantees the signature depends on: keys stay sorted, and
//    arrays still repeat as KV pairs. A drift here breaks request signing.
check('sorted key order', S({ z: 1, a: 2 }) === 'a=2&z=1')
check(
  'array repeats as KV pairs',
  S({ orderIds: [1, 2] }) === 'orderIds=1&orderIds=2',
)
check('object of only-undefined serializes empty', S({ b: undefined }) === '')

// 5) Strict signing keeps rejecting undefined loudly rather than quietly
//    dropping it — callers that opt in still want the error.
try {
  S({ a: undefined }, true)
  check('strict_validation still throws', false)
} catch (e: any) {
  check(
    'strict_validation still throws',
    e.message === 'Failed to sign API request due to undefined parameter',
    e.message,
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
