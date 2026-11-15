process.env.NODE_ENV = 'testing'

/**
 * KuCoin bookTicker: spot level-1 `bestBid` / `bestAsk` (all-tickers
 * `buy` / `sell` for a key-less instance, whose client refuses the signed
 * level-1 call), futures ticker `bestBidPrice` / `bestAskPrice`. A missing or
 * zero side is NOTOK. No network. Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KucoinExchange from './index'

const ok = (data: unknown) => ({ status: StatusEnum.ok, data, reason: null })

const make = (futures: Futures, keys = true) => {
  const ex: any = keys
    ? new KucoinExchange(futures, 'k', 's', 'p')
    : new KucoinExchange(futures)
  ex.checkLimits = async () => undefined
  return ex
}

describe('kucoin — bookTicker', () => {
  it('spot: level-1 bestBid / bestAsk', async () => {
    const ex = make(Futures.null)
    const asked: unknown[] = []
    ex.client.getTicker = async (s: string) => (
      asked.push(s),
      ok({ price: '1', bestBid: '64000.1', bestAsk: '64000.2' })
    )
    const res = await ex.bookTicker('BTC-USDT')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
    assert.deepStrictEqual(asked, ['BTC-USDT'])
  })

  it('spot without keys: all-tickers buy / sell', async () => {
    const ex = make(Futures.null, false)
    ex.client.getTicker = async () => {
      throw new Error('must not sign without keys')
    }
    ex.client.getAllTickers = async () =>
      ok({
        ticker: [
          { symbol: 'ETH-USDT', buy: '1', sell: '2' },
          { symbol: 'BTC-USDT', buy: '64000.1', sell: '64000.2' },
        ],
      })
    const res = await ex.bookTicker('BTC-USDT')
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
  })

  it('futures: bestBidPrice / bestAskPrice on the KuCoin symbol', async () => {
    const ex = make(Futures.usdm)
    const asked: unknown[] = []
    ex.client.getFuturesTicker = async (p: unknown) => (
      asked.push(p),
      ok({ price: '1', bestBidPrice: '63999', bestAskPrice: '64001' })
    )
    const res = await ex.bookTicker('BTCUSDT')
    assert.deepStrictEqual(res.data, { bid: 63999, ask: 64001 })
    assert.deepStrictEqual(asked, [{ symbol: 'XBTUSDTM' }])
  })

  it('spot: a zero side is NOTOK', async () => {
    const ex = make(Futures.null)
    ex.client.getTicker = async () => ok({ bestBid: '0', bestAsk: '64000.2' })
    const res = await ex.bookTicker('BTC-USDT')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTC-USDT')
  })

  it('futures: a missing side is NOTOK', async () => {
    const ex = make(Futures.usdm)
    ex.client.getFuturesTicker = async () => ok({ bestBidPrice: '63999' })
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
