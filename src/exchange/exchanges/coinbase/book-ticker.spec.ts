process.env.NODE_ENV = 'testing'

/**
 * Coinbase bookTicker: top bid / ask of the pricebook from best_bid_ask. A
 * missing or zero side is NOTOK. No network — the REST client is stubbed.
 * Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import CoinbaseExchange from './index'

const make = (pricebooks: unknown[]) => {
  const ex: any = new CoinbaseExchange(Futures.null, 'k', 's')
  const asked: unknown[] = []
  ex.checkLimits = async () => undefined
  ex.client = {
    rest: {
      product: {
        getBestAsksAndBids: async (ids: unknown) => (asked.push(ids), pricebooks),
      },
    },
  }
  return { ex: ex as CoinbaseExchange, asked }
}

describe('coinbase — bookTicker', () => {
  it('reads bids[0] / asks[0] for the asked product', async () => {
    const { ex, asked } = make([
      {
        product_id: 'BTC-USD',
        bids: [{ price: '64000.1', size: '1' }],
        asks: [{ price: '64000.2', size: '1' }],
      },
    ])
    const res = await ex.bookTicker('BTC-USD')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
    assert.deepStrictEqual(asked, [['BTC-USD']])
  })

  it('an empty side is NOTOK', async () => {
    const { ex } = make([
      {
        product_id: 'BTC-USD',
        bids: [],
        asks: [{ price: '64000.2', size: '1' }],
      },
    ])
    const res = await ex.bookTicker('BTC-USD')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTC-USD')
  })

  it('a zero price is NOTOK', async () => {
    const { ex } = make([
      {
        product_id: 'BTC-USD',
        bids: [{ price: '0', size: '1' }],
        asks: [{ price: '64000.2', size: '1' }],
      },
    ])
    const res = await ex.bookTicker('BTC-USD')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
