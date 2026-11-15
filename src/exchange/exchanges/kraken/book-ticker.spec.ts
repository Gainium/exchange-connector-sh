process.env.NODE_ENV = 'testing'

/**
 * Kraken bookTicker: spot ticker `b[0]` / `a[0]`, futures ticker `bid` /
 * `ask`. A missing or zero side is NOTOK. No network. Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const make = (futures: Futures) => {
  const ex: any = new KrakenExchange(futures, '', '')
  ex.checkLimits = async () => undefined
  ex.toKrakenSymbol = async (s: string) => `K:${s}`
  return ex
}

describe('kraken — bookTicker', () => {
  it('spot: reads b[0] / a[0]', async () => {
    const ex = make(Futures.null)
    const asked: unknown[] = []
    ex.spotClient = {
      getTicker: async (p: unknown) => (
        asked.push(p),
        {
          error: [],
          result: {
            XXBTZUSD: {
              a: ['64000.2', '1', '1.000'],
              b: ['64000.1', '2', '2.000'],
              c: ['64000.15', '0.1'],
            },
          },
        }
      ),
    }
    const res = await ex.bookTicker('BTC/USD')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.2 })
    assert.strictEqual((asked[0] as { pair: string }).pair, 'K:BTC/USD')
  })

  it('futures: reads bid / ask', async () => {
    const ex = make(Futures.usdm)
    ex.derivativesClient = {
      getTicker: async () => ({
        result: 'success',
        ticker: { symbol: 'PF_XBTUSD', last: 64000, bid: 63999.5, ask: 64000.5 },
      }),
    }
    const res = await ex.bookTicker('BTCUSD')
    assert.deepStrictEqual(res.data, { bid: 63999.5, ask: 64000.5 })
  })

  it('spot: a missing side is NOTOK', async () => {
    const ex = make(Futures.null)
    ex.spotClient = {
      getTicker: async () => ({
        error: [],
        result: { XXBTZUSD: { a: ['64000.2'], b: [], c: ['1'] } },
      }),
    }
    const res = await ex.bookTicker('BTC/USD')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTC/USD')
  })

  it('futures: a zero side is NOTOK', async () => {
    const ex = make(Futures.usdm)
    ex.derivativesClient = {
      getTicker: async () => ({
        result: 'success',
        ticker: { symbol: 'PF_XBTUSD', last: 64000, bid: 0, ask: 64000.5 },
      }),
    }
    const res = await ex.bookTicker('BTCUSD')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
