process.env.NODE_ENV = 'testing'

/**
 * Bitget bookTicker: bidPr / askPr from the v2 single-symbol ticker (spot,
 * USDⓈ-M, inverse delivery), bid1Price / ask1Price from v3 for inverse
 * perpetuals — the same rails the last-price reads use. A missing or zero
 * side is NOTOK. No network. Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'

const ok = (data: unknown) => ({ code: '00000', msg: 'success', data })

const make = (futures: Futures) => {
  const ex = new BitgetExchange(futures, 'k', 's', 'p') as any
  const asked: { fn: string; p: unknown }[] = []
  ex.checkLimits = async () => undefined
  return { ex, asked }
}

describe('bitget — bookTicker', () => {
  it('spot: getSpotTicker bidPr / askPr', async () => {
    const { ex, asked } = make(Futures.null)
    ex.client.getSpotTicker = async (p: unknown) => (
      asked.push({ fn: 'spot', p }),
      ok([{ symbol: 'BTCUSDT', bidPr: '64000.1', askPr: '64000.2' }])
    )
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
    assert.deepStrictEqual(asked, [{ fn: 'spot', p: { symbol: 'BTCUSDT' } }])
  })

  it('usdm: getFuturesTicker with the symbol product type', async () => {
    const { ex, asked } = make(Futures.usdm)
    ex.client.getFuturesTicker = async (p: unknown) => (
      asked.push({ fn: 'futures', p }),
      ok([{ symbol: 'BTCUSDC', bidPr: '10', askPr: '10.5' }])
    )
    const res = await ex.bookTicker('BTCUSDC')
    assert.deepStrictEqual(res.data, { bid: 10, ask: 10.5 })
    assert.deepStrictEqual(asked, [
      {
        fn: 'futures',
        p: { symbol: 'BTCUSDC', productType: 'USDC-FUTURES' },
      },
    ])
  })

  it('coinm perpetual: v3 tickers on the _CM symbol', async () => {
    const { ex, asked } = make(Futures.coinm)
    ex.orderClient.getTickersV3 = async (p: unknown) => (
      asked.push({ fn: 'v3', p }),
      ok([{ symbol: 'BTCUSD_CM', bid1Price: '60000', ask1Price: '60000.5' }])
    )
    const res = await ex.bookTicker('BTCUSD')
    assert.deepStrictEqual(res.data, { bid: 60000, ask: 60000.5 })
    assert.deepStrictEqual(asked, [
      { fn: 'v3', p: { category: 'COIN-FUTURES', symbol: 'BTCUSD_CM' } },
    ])
  })

  it('coinm delivery: stays on v2', async () => {
    const { ex, asked } = make(Futures.coinm)
    ex.client.getFuturesTicker = async (p: unknown) => (
      asked.push({ fn: 'futures', p }),
      ok([{ symbol: 'BTCUSDU26', bidPr: '61000', askPr: '61001' }])
    )
    const res = await ex.bookTicker('BTCUSDU26')
    assert.deepStrictEqual(res.data, { bid: 61000, ask: 61001 })
    assert.strictEqual(asked[0].fn, 'futures')
  })

  it('a zero side is NOTOK', async () => {
    const { ex } = make(Futures.null)
    ex.client.getSpotTicker = async () =>
      ok([{ symbol: 'BTCUSDT', bidPr: '64000.1', askPr: '0' }])
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTCUSDT')
  })

  it('an empty answer is NOTOK', async () => {
    const { ex } = make(Futures.coinm)
    ex.orderClient.getTickersV3 = async () => ok([])
    const res = await ex.bookTicker('BTCUSD')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
