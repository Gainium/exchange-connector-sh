process.env.NODE_ENV = 'testing'

/**
 * Binance spot fills carry the venue's own trade id.
 *
 * A FULL `POST /api/v3/order` response states `tradeId` on every fill — the
 * same id the public trade tape and `myTrades` carry — although the vendor
 * SDK's `OrderFill` type omits it. `convertOrder` must report that id, and
 * fall back to a synthetic `${orderId}-${index}` only when the venue sent
 * none (or sent the `-1` it uses for SOR allocations, which are not trades).
 *
 * The fixture is the FULL response example from Binance's spot REST docs
 * ("New order (TRADE)", binance-spot-api-docs `rest-api.md`), unchanged.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import assert from 'assert'
import { ExchangeDomain, StatusEnum } from '../../types'
import BinanceExchange from './index'

const fullResponse = () => ({
  symbol: 'BTCUSDT',
  orderId: 28,
  orderListId: -1,
  clientOrderId: '6gCrw2kRUAF9CvJDGP16IP',
  transactTime: 1507725176595,
  price: '1.00000000',
  origQty: '10.00000000',
  executedQty: '10.00000000',
  origQuoteOrderQty: '0.000000',
  cummulativeQuoteQty: '10.00000000',
  status: 'FILLED',
  timeInForce: 'GTC',
  type: 'MARKET',
  side: 'SELL',
  workingTime: 1507725176595,
  selfTradePreventionMode: 'NONE',
  fills: [
    {
      price: '4000.00000000',
      qty: '1.00000000',
      commission: '4.00000000',
      commissionAsset: 'USDT',
      tradeId: 56,
    },
    {
      price: '3999.00000000',
      qty: '5.00000000',
      commission: '19.99500000',
      commissionAsset: 'USDT',
      tradeId: 57,
    },
    {
      price: '3998.00000000',
      qty: '2.00000000',
      commission: '7.99600000',
      commissionAsset: 'USDT',
      tradeId: 58,
    },
    {
      price: '3997.00000000',
      qty: '1.00000000',
      commission: '3.99700000',
      commissionAsset: 'USDT',
      tradeId: 59,
    },
    {
      price: '3995.00000000',
      qty: '1.00000000',
      commission: '3.99500000',
      commissionAsset: 'USDT',
      tradeId: 60,
    },
  ],
})

const spot = (): any =>
  new BinanceExchange(ExchangeDomain.com, undefined as any, 'key', 's')

const ids = (o: any) => (o.fills ?? []).map((f: any) => f.tradeId)

describe('binance spot — fills carry the venue trade id', () => {
  it('uses the real tradeId of every fill, as a string', () => {
    const out = spot().convertOrder(fullResponse())
    assert.deepStrictEqual(ids(out), ['56', '57', '58', '59', '60'])
  })

  it('keeps every other fill field as before', () => {
    const out = spot().convertOrder(fullResponse())
    assert.deepStrictEqual(out.fills[1], {
      price: '3999.00000000',
      qty: '5.00000000',
      commission: '19.99500000',
      commissionAsset: 'USDT',
      tradeId: '57',
    })
    assert.strictEqual(out.fills.length, 5)
  })

  it('falls back to orderId-index when the fill has no tradeId', () => {
    const res = fullResponse()
    res.fills = res.fills.map(({ tradeId: _t, ...f }) => f) as any
    const out = spot().convertOrder(res)
    assert.deepStrictEqual(ids(out), ['28-0', '28-1', '28-2', '28-3', '28-4'])
  })

  it('falls back per fill, keeping real ids where they exist', () => {
    const res: any = fullResponse()
    delete res.fills[1].tradeId
    res.fills[3].tradeId = null
    const out = spot().convertOrder(res)
    assert.deepStrictEqual(ids(out), ['56', '28-1', '58', '28-3', '60'])
  })

  it('never reports the SOR -1 allocation id, or a non-integer, as a trade', () => {
    const res: any = fullResponse()
    res.fills[0].tradeId = -1
    res.fills[1].tradeId = 0
    res.fills[2].tradeId = 1.5
    res.fills[3].tradeId = 'abc'
    res.fills[4].tradeId = '61'
    const out = spot().convertOrder(res)
    assert.deepStrictEqual(ids(out), ['28-0', '28-1', '28-2', '28-3', '61'])
  })

  it('an order lookup with no fills still reports none', () => {
    const { fills: _f, ...noFills } = fullResponse()
    assert.deepStrictEqual(spot().convertOrder(noFills).fills, [])
  })

  it('a spot placement asks for FULL and returns the real ids', async () => {
    const ex = spot()
    ex.checkLimits = async () => undefined
    let sent: any
    ex.client = {
      submitNewOrder: async (params: unknown) => {
        sent = params
        return fullResponse()
      },
    }
    const res = await ex.openOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      quantity: 10,
      price: 0,
      type: 'MARKET',
    })
    assert.strictEqual(sent.newOrderRespType, 'FULL')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(ids(res.data), ['56', '57', '58', '59', '60'])
  })
})
