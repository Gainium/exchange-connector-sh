process.env.NODE_ENV = 'testing'

/**
 * An unfilled classic Bitget spot limit order must be reported at its limit
 * price, not at the venue's `priceAvg: "0"`.
 *
 * Spec: `specs/038.bitget-spot-unfilled-limit-reported-at-price-zero.md`.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the REST clients are stubbed.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'

const expect = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

/** One v2 `/spot/trade/orderInfo` row, all-strings as the venue sends it. */
const spotOrder = (over: Record<string, string>) => ({
  userId: '1',
  symbol: 'QNTUSDT',
  orderId: '1',
  clientOid: 'GRID-1',
  price: '197.54',
  size: '0.5',
  orderType: 'limit',
  side: 'buy',
  status: 'live',
  priceAvg: '0',
  baseVolume: '0',
  quoteVolume: '0',
  enterPointSource: 'API',
  feeDetail: '',
  orderSource: 'normal',
  cTime: '1',
  uTime: '2',
  ...over,
})

/** A classic spot connector whose placement and order read answer `row`. */
function stubSpot(row: Record<string, string>) {
  const ex = new BitgetExchange(Futures.null, 'k', 's', 'p') as any
  ex.checkLimits = async () => undefined
  ex.orderClient = {
    spotSubmitOrder: async () => ({
      code: '00000',
      data: { orderId: row.orderId, clientOid: row.clientOid },
    }),
  }
  ex.client = {
    getSpotOrder: async () => ({ code: '00000', data: [row] }),
  }
  return ex
}

describe('Bitget classic spot order price (spec 038)', () => {
  for (const side of ['buy', 'sell']) {
    it(`§1.1 an unfilled ${side} limit placement reports its limit price`, async () => {
      const ex = stubSpot(spotOrder({ side }))
      const res = await ex.spot_openOrder({
        symbol: 'QNTUSDT',
        side: side === 'buy' ? 'BUY' : 'SELL',
        quantity: 0.5,
        price: 197.54,
        newClientOrderId: 'GRID-1',
        type: 'LIMIT',
      })
      expect('status', res.status, StatusEnum.ok)
      expect('type', res.data.type, 'LIMIT')
      expect('order status', res.data.status, 'NEW')
      expect('price', res.data.price, '197.54')
    })
  }

  it('§1.1 an empty priceAvg on a resting limit also reports the limit price', () => {
    const ex = new BitgetExchange(Futures.null, '', '', 'p') as any
    expect(
      'price',
      ex.convertSpotOrder(spotOrder({ priceAvg: '' })).price,
      '197.54',
    )
  })

  it('§1.3 a filled limit order still reports the average fill price', () => {
    const ex = new BitgetExchange(Futures.null, '', '', 'p') as any
    const o = ex.convertSpotOrder(
      spotOrder({
        status: 'filled',
        priceAvg: '197.5',
        baseVolume: '0.5',
        quoteVolume: '98.75',
      }),
    )
    expect('price', o.price, '197.5')
    expect('status', o.status, 'FILLED')
  })

  it('§1.3 a market order is unchanged', () => {
    const ex = new BitgetExchange(Futures.null, '', '', 'p') as any
    expect(
      'basePrice',
      ex.convertSpotOrder(
        spotOrder({ orderType: 'market', basePrice: '198', priceAvg: '197.9' }),
      ).price,
      '198',
    )
    expect(
      'priceAvg',
      ex.convertSpotOrder(
        spotOrder({ orderType: 'market', priceAvg: '197.9', status: 'filled' }),
      ).price,
      '197.9',
    )
  })
})
