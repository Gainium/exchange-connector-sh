process.env.NODE_ENV = 'testing'

/**
 * Binance bookTicker: best bid / best ask from the symbol order-book ticker,
 * spot and both futures rails. A missing or zero side is NOTOK, never a 0
 * price. No network — the REST clients are stubbed. Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { ExchangeDomain, Futures, StatusEnum } from '../../types'
import BinanceExchange from './index'

const make = (futures: Futures, client: Record<string, unknown>) => {
  const ex = new BinanceExchange(ExchangeDomain.com, futures, 'k', 's') as any
  ex.checkLimits = async () => undefined
  if (futures === Futures.usdm) ex.usdmClient = client
  else if (futures === Futures.coinm) ex.coinmClient = client
  else ex.client = client
  return ex as BinanceExchange
}

const row = (bidPrice: string, askPrice: string, symbol = 'BTCUSDT') => ({
  symbol,
  bidPrice,
  bidQty: '1',
  askPrice,
  askQty: '1',
})

describe('binance — bookTicker', () => {
  it('spot: reads bidPrice / askPrice for the asked symbol', async () => {
    const asked: unknown[] = []
    const ex = make(Futures.null, {
      getSymbolOrderBookTicker: async (p: unknown) => (
        asked.push(p), row('100.1', '100.2')
      ),
    })
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 100.1, ask: 100.2 })
    assert.deepStrictEqual(asked, [{ symbol: 'BTCUSDT' }])
  })

  it('usdm: single object answer', async () => {
    const ex = make(Futures.usdm, {
      getSymbolOrderBookTicker: async () => row('50', '50.5'),
    })
    const res = await ex.bookTicker('BTCUSDT')
    assert.deepStrictEqual(res.data, { bid: 50, ask: 50.5 })
  })

  it('coinm: array answer, picks the asked symbol', async () => {
    const ex = make(Futures.coinm, {
      getSymbolOrderBookTicker: async () => [
        row('1', '2', 'ETHUSD_PERP'),
        row('60000', '60001', 'BTCUSD_PERP'),
      ],
    })
    const res = await ex.bookTicker('BTCUSD_PERP')
    assert.deepStrictEqual(res.data, { bid: 60000, ask: 60001 })
  })

  it('a zero side is NOTOK', async () => {
    const ex = make(Futures.null, {
      getSymbolOrderBookTicker: async () => row('0', '100.2'),
    })
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTCUSDT')
    assert.strictEqual(res.data, null)
  })

  it('a missing row is NOTOK', async () => {
    const ex = make(Futures.usdm, {
      getSymbolOrderBookTicker: async () => row('1', '2', 'ETHUSDT'),
    })
    const res = await ex.bookTicker('BTCUSDT')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
