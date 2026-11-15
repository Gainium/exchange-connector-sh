process.env.NODE_ENV = 'testing'

/**
 * OKX bookTicker: bidPx / askPx from the single-instrument ticker, asked with
 * the same instId mapping as every other call (`-SWAP` for perps, the live
 * `<family>-<expiry>` for an X-Perp). A missing or zero side is NOTOK. No
 * network. Run: `npm test`.
 */
import assert from 'assert'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Futures, OKXSource, StatusEnum } from '../../types'
import OKXExchange from './index'

const resetCache = () => {
  const s = OKXExchange as any
  s.xperpMap = new Map()
  s.xperpMapLoaded = 0
  s.xperpMapMissLoaded = new Map()
  s.xperpMapLoading = undefined
}

const make = (futures: Futures, bidPx: string, askPx: string) => {
  const ex: any = new OKXExchange(
    futures,
    'k',
    's',
    'p',
    undefined,
    undefined,
    OKXSource.com,
  )
  const asked: string[] = []
  ex.checkLimits = async () => undefined
  ex.client.getInstruments = async () => [
    {
      instFamily: 'HYPE-USD_UM_XPERP',
      instId: 'HYPE-USD_UM_XPERP-310523',
      ruleType: 'xperp',
      state: 'live',
    },
  ]
  ex.client.getTicker = async (p: { instId: string }) => {
    asked.push(p.instId)
    return [{ instId: p.instId, last: '1', bidPx, askPx }]
  }
  return { ex: ex as OKXExchange, asked }
}

describe('okx — bookTicker', () => {
  beforeEach(resetCache)
  afterEach(resetCache)

  it('spot: reads bidPx / askPx', async () => {
    const { ex, asked } = make(Futures.null, '64000.1', '64000.3')
    const res = await ex.bookTicker('BTC-USDT')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000.1, ask: 64000.3 })
    assert.deepStrictEqual(asked, ['BTC-USDT'])
  })

  it('swap: asks the -SWAP instId', async () => {
    const { ex, asked } = make(Futures.usdm, '10', '10.1')
    const res = await ex.bookTicker('BTC-USDT')
    assert.deepStrictEqual(res.data, { bid: 10, ask: 10.1 })
    assert.deepStrictEqual(asked, ['BTC-USDT-SWAP'])
  })

  it('X-Perp: asks the live instId, not the bare family', async () => {
    const { ex, asked } = make(Futures.usdm, '40', '40.02')
    const res = await ex.bookTicker('HYPE-USD_UM_XPERP')
    assert.deepStrictEqual(res.data, { bid: 40, ask: 40.02 })
    assert.deepStrictEqual(asked, ['HYPE-USD_UM_XPERP-310523'])
  })

  it('a zero side is NOTOK', async () => {
    const { ex } = make(Futures.null, '0', '64000.3')
    const res = await ex.bookTicker('BTC-USDT')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTC-USDT')
  })

  it('a crossed book is NOTOK', async () => {
    const { ex } = make(Futures.null, '10', '9')
    const res = await ex.bookTicker('BTC-USDT')
    assert.strictEqual(res.status, StatusEnum.notok)
  })
})
