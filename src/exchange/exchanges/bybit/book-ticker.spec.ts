process.env.NODE_ENV = 'testing'

/**
 * Bybit bookTicker: bid1Price / ask1Price from v5 getTickers in the
 * instance's category. A missing or zero side is NOTOK. No network.
 * Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'

const make = (futures: Futures, list: unknown[]) => {
  const ex = new BybitExchange(futures, 'k', 's') as any
  const asked: unknown[] = []
  ex.checkLimits = async () => undefined
  ex.client.getTickers = async (p: unknown) => {
    asked.push(p)
    return { retCode: 0, retMsg: 'OK', result: { list } }
  }
  return { ex: ex as BybitExchange, asked }
}

describe('bybit — bookTicker', () => {
  it('linear: reads bid1Price / ask1Price with the linear category', async () => {
    const { ex, asked } = make(Futures.usdm, [
      { symbol: 'BTCUSDT', bid1Price: '64000.1', ask1Price: '64000.2' },
    ])
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
    assert.deepStrictEqual(asked, [{ category: 'linear', symbol: 'BTCUSDT' }])
  })

  it('spot: uses the spot category', async () => {
    const { ex, asked } = make(Futures.null, [
      { symbol: 'ETHUSDT', bid1Price: '3000', ask1Price: '3000.5' },
    ])
    const res = await ex.bookTicker('ETHUSDT')
    assert.deepStrictEqual(res.data, { bid: 3000, ask: 3000.5 })
    assert.strictEqual((asked[0] as { category: string }).category, 'spot')
  })

  it('an empty side is NOTOK', async () => {
    const { ex } = make(Futures.usdm, [
      { symbol: 'BTCUSDT', bid1Price: '', ask1Price: '64000.2' },
    ])
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTCUSDT')
  })

  it('no row is NOTOK', async () => {
    const { ex } = make(Futures.usdm, [])
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
