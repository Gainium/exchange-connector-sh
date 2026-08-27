process.env.NODE_ENV = 'testing'

/**
 * Wiring check: each venue's order mapper must surface the fee the venue
 * actually reported, from that venue's real field, on a payload shaped the way
 * the venue sends it.
 *
 * This is the half the pure helper checks cannot cover. `orderFee.spec.ts`
 * proves the normalisation is right; this proves each mapper is reading the
 * field that exists rather than one that sounds plausible — and, just as
 * importantly, that a payload with no fee produces NO fee fields, so the
 * caller's `commission` estimate stays in force instead of a missing fee
 * booking as zero cost.
 *
 * This repo has no test runner. Run it directly:
 *
 *   npx ts-node --files --project tsconfig.json \
 *     src/exchange/exchanges/venue-fee-capture.spec.ts
 *
 * No network or credentials: every mapper below is a pure transform, reached
 * through `any` because they are private.
 */
import { ExchangeDomain, Futures } from '../types'
import BybitExchange from './bybit'
import OkxExchange from './okx'
import KucoinExchange from './kucoin'
import BitgetExchange from './bitget'
import CoinbaseExchange from './coinbase'
import BinanceExchange from './binance'

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

/** Only the fee-bearing fields — the rest of CommonOrder is not under test. */
function fee(o: any) {
  const out: Record<string, unknown> = {}
  for (const k of ['feePaid', 'feeSide', 'feeAsset', 'feeBreakdown']) {
    if (o?.[k] !== undefined) out[k] = o[k]
  }
  return out
}

async function run() {
  // ── Bybit ────────────────────────────────────────────────────────────────
  // `cumExecFee` is the observation; the currency follows the product, and
  // `cumFeeDetail` overrides it whenever Bybit sends the map.
  const bybitSpot: any = new BybitExchange(undefined as any, '', '')
  const bybitLinear: any = new BybitExchange(Futures.usdm, '', '')
  const bybitInverse: any = new BybitExchange(Futures.coinm, '', '')
  const bybitOrder = (over: Record<string, unknown>) => ({
    symbol: 'BTCUSDT',
    orderId: '1',
    orderLinkId: 'D-1',
    orderStatus: 'Filled',
    orderType: 'Limit',
    side: 'Buy',
    price: '100',
    qty: '1',
    avgPrice: '100',
    cumExecQty: '1',
    cumExecFee: '0.1',
    createdTime: '1',
    updatedTime: '2',
    ...over,
  })
  expect(
    'bybit spot BUY takes the fee in base (asset received)',
    fee(await bybitSpot.convertOrder(bybitOrder({}))),
    { feePaid: '0.1', feeSide: 'base' },
  )
  expect(
    'bybit spot SELL takes the fee in quote',
    fee(await bybitSpot.convertOrder(bybitOrder({ side: 'Sell' }))),
    { feePaid: '0.1', feeSide: 'quote' },
  )
  expect(
    'bybit linear settles in quote',
    fee(await bybitLinear.convertOrder(bybitOrder({}))),
    { feePaid: '0.1', feeSide: 'quote' },
  )
  expect(
    'bybit inverse settles in base',
    fee(await bybitInverse.convertOrder(bybitOrder({}))),
    { feePaid: '0.1', feeSide: 'base' },
  )
  expect(
    'bybit cumFeeDetail wins over the product rule',
    fee(
      await bybitSpot.convertOrder(
        bybitOrder({ cumFeeDetail: { USDT: '0.07', BNB: '0.001' } }),
      ),
    ),
    {
      feeBreakdown: [
        { asset: 'USDT', amount: '0.07' },
        { asset: 'BNB', amount: '0.001' },
      ],
    },
  )
  expect(
    'bybit reports nothing when the fee is 0',
    fee(await bybitSpot.convertOrder(bybitOrder({ cumExecFee: '0' }))),
    {},
  )

  // ── OKX ──────────────────────────────────────────────────────────────────
  // `fee` + `feeCcy`, negative for a charge.
  const okx: any = new OkxExchange(undefined as any, '', '', 'pass')
  const okxOrder = (over: Record<string, unknown>) => ({
    instId: 'BTC-USDT',
    ordId: '1',
    clOrdId: 'D-1',
    state: 'filled',
    ordType: 'limit',
    side: 'buy',
    px: '100',
    sz: '1',
    accFillSz: '1',
    avgPx: '100',
    cTime: '1',
    uTime: '2',
    fee: '-0.08',
    feeCcy: 'USDT',
    ...over,
  })
  expect('okx fee + feeCcy', fee(await okx.convertOrder(okxOrder({}))), {
    feePaid: '0.08',
    feeAsset: 'USDT',
  })
  expect(
    'okx reports nothing when the fee is 0',
    fee(await okx.convertOrder(okxOrder({ fee: '0' }))),
    {},
  )

  // ── KuCoin ───────────────────────────────────────────────────────────────
  // `fee` + `feeCurrency`; the KCS discount charges a third asset entirely.
  const kucoin: any = new KucoinExchange(undefined as any, '', '', 'pass')
  const kucoinOrder = (over: Record<string, unknown>) => ({
    id: '1',
    symbol: 'BTC-USDT',
    clientOid: 'D-1',
    type: 'limit',
    side: 'buy',
    price: '100',
    size: '1',
    funds: '100',
    dealFunds: '100',
    dealSize: '1',
    fee: '0.09',
    feeCurrency: 'USDT',
    isActive: false,
    cancelExist: false,
    createdAt: 1,
    ...over,
  })
  expect(
    'kucoin fee + feeCurrency',
    fee(await kucoin.convertOrder(kucoinOrder({}))),
    { feePaid: '0.09', feeAsset: 'USDT' },
  )
  expect(
    'kucoin KCS discount is reported as KCS, not as a side of the pair',
    fee(
      await kucoin.convertOrder(
        kucoinOrder({ fee: '0.004', feeCurrency: 'KCS' }),
      ),
    ),
    { feePaid: '0.004', feeAsset: 'KCS' },
  )
  expect(
    'kucoin reports nothing when the fee is 0',
    fee(await kucoin.convertOrder(kucoinOrder({ fee: '0' }))),
    {},
  )

  // ── Bitget ───────────────────────────────────────────────────────────────
  // Futures: `fee` settled in `marginCoin`. Spot: the `feeDetail` blob.
  const bitget: any = new BitgetExchange(Futures.usdm, '', '', 'pass')
  expect(
    'bitget futures fee settles in marginCoin',
    fee(
      bitget.convertFuturesOrder({
        symbol: 'BTCUSDT',
        orderId: '1',
        clientOid: 'D-1',
        state: 'filled',
        orderType: 'limit',
        side: 'buy',
        posSide: 'net',
        price: '100',
        priceAvg: '100',
        size: '1',
        baseVolume: '1',
        quoteVolume: '100',
        marginCoin: 'USDT',
        fee: '-0.06',
        cTime: '1',
        uTime: '2',
      }),
    ),
    { feePaid: '0.06', feeAsset: 'USDT' },
  )
  expect(
    'bitget spot reads feeDetail',
    fee(
      bitget.convertSpotOrder({
        symbol: 'BTCUSDT',
        orderId: '1',
        clientOid: 'D-1',
        status: 'filled',
        orderType: 'limit',
        side: 'buy',
        price: '100',
        priceAvg: '100',
        size: '1',
        baseVolume: '1',
        quoteVolume: '100',
        cTime: '1',
        uTime: '2',
        feeDetail:
          '{"newFees":{"t":-0.113},"USDT":{"feeCoinCode":"USDT","totalFee":-0.113}}',
      }),
    ),
    { feePaid: '0.113', feeAsset: 'USDT' },
  )

  // ── Coinbase ─────────────────────────────────────────────────────────────
  // `total_fees`, always in the product's quote currency.
  const coinbase: any = new CoinbaseExchange(undefined as any, '', '')
  const cbOrder = (over: Record<string, unknown>) => ({
    product_id: 'BTC-USD',
    order_id: '1',
    client_order_id: 'D-1',
    status: 'FILLED',
    order_type: 'LIMIT',
    side: 'BUY',
    completion_percentage: '100',
    created_time: '2026-08-27T00:00:00Z',
    filled_size: '1',
    filled_value: '100',
    average_filled_price: '100',
    total_fees: '0.6',
    order_configuration: { limit_limit_gtc: { limit_price: '100' } },
    ...over,
  })
  expect(
    'coinbase total_fees is a quote-side fee',
    fee(await coinbase.convertOrder(cbOrder({}))),
    { feePaid: '0.6', feeSide: 'quote' },
  )
  expect(
    'coinbase reports nothing when total_fees is 0',
    fee(await coinbase.convertOrder(cbOrder({ total_fees: '0' }))),
    {},
  )

  // ── Binance ──────────────────────────────────────────────────────────────
  // The fee lives on the FILLS of a FULL placement response, never on the
  // order. `commissionAsset` matters: a "pay fees in BNB" account is charged
  // in an asset that is neither side of the pair.
  const binance: any = new BinanceExchange(
    ExchangeDomain.com,
    undefined as any,
    '',
    '',
  )
  const binanceOrder = (fills: unknown[]) => ({
    symbol: 'BTCUSDT',
    orderId: 1,
    clientOrderId: 'D-1',
    transactTime: 1,
    price: '100',
    origQty: '1',
    executedQty: '1',
    cummulativeQuoteQty: '100',
    status: 'FILLED',
    type: 'LIMIT',
    side: 'BUY',
    fills,
  })
  expect(
    'binance sums the fills commission',
    fee(
      binance.convertOrder(
        binanceOrder([
          {
            price: '100',
            qty: '0.5',
            commission: '0.05',
            commissionAsset: 'USDT',
          },
          {
            price: '100',
            qty: '0.5',
            commission: '0.05',
            commissionAsset: 'USDT',
          },
        ]),
      ),
    ),
    { feePaid: '0.1', feeAsset: 'USDT' },
  )
  expect(
    'binance BNB discount is reported as BNB',
    fee(
      binance.convertOrder(
        binanceOrder([
          {
            price: '100',
            qty: '1',
            commission: '0.0007',
            commissionAsset: 'BNB',
          },
        ]),
      ),
    ),
    { feePaid: '0.0007', feeAsset: 'BNB' },
  )
  expect(
    'binance straddling two fee assets keeps them apart',
    fee(
      binance.convertOrder(
        binanceOrder([
          {
            price: '100',
            qty: '0.5',
            commission: '0.0003',
            commissionAsset: 'BNB',
          },
          {
            price: '100',
            qty: '0.5',
            commission: '0.05',
            commissionAsset: 'USDT',
          },
        ]),
      ),
    ),
    {
      feeBreakdown: [
        { asset: 'BNB', amount: '0.0003' },
        { asset: 'USDT', amount: '0.05' },
      ],
    },
  )
  // The GET-order path has no fills at all: Binance's order endpoint carries no
  // commission field. It must stay silent so the estimate survives.
  expect(
    'binance getOrder payload reports no fee rather than a zero one',
    fee(binance.convertOrder(binanceOrder([]))),
    {},
  )

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
