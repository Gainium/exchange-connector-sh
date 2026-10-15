process.env.NODE_ENV = 'testing'

/**
 * KuCoin futures exchange info carries the contract's max leverage (KuCoin
 * publishes `maxLeverage` on every contract; there is no min, so none is
 * reported). No network. Run: `npm test` from `core/`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KucoinExchange from './index'

const contract = {
  symbol: 'XBTUSDTM',
  baseCurrency: 'XBT',
  quoteCurrency: 'USDT',
  multiplier: 0.001,
  maxOrderQty: 1000000,
  lotSize: 1,
  tickSize: 0.1,
  supportCross: true,
  isInverse: false,
  maxLeverage: 125,
}

describe('KuCoin futures exchange info: leverage', () => {
  it('reports the contract max leverage and no min', async () => {
    const ex: any = new KucoinExchange(Futures.usdm, 'k', 's', 'p')
    ex.checkLimits = async () => undefined
    ex.client = {
      getFuturesSymbols: async () => ({
        status: StatusEnum.ok,
        data: [contract],
      }),
    }
    const res = await ex.futures_getAllExchangeInfo()
    assert.equal(res.status, StatusEnum.ok)
    assert.equal(res.data.length, 1)
    assert.equal(res.data[0].maxLeverage, 125)
    assert.equal(res.data[0].minLeverage, undefined)
  })
})
