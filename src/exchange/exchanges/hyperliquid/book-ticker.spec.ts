process.env.NODE_ENV = 'testing'

/**
 * Hyperliquid bookTicker: top level of each side of l2Book, asked with the
 * resolved wire coin (perp code / spot `@index`). A missing or zero side is
 * NOTOK, and an unknown pair is rejected without a venue call. No network.
 * Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import HyperliquidExchange from './index'

const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'

const make = (
  futures: Futures,
  coin: string | null,
  levels: unknown,
) => {
  const ex: any = new HyperliquidExchange(
    futures,
    '0x14791697260e4c9a71f18484c9f997b308e59325',
    PRIVATE_KEY,
    '',
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  )
  const asked: unknown[] = []
  ex.checkLimits = async () => undefined
  ex.resolveCoin = async () => coin
  ex.infoClient = {
    l2Book: async (p: unknown) => (
      asked.push(p), { coin, time: 1, levels }
    ),
  }
  return { ex: ex as HyperliquidExchange, asked }
}

const lvl = (px: string) => ({ px, sz: '1', n: 1 })

describe('hyperliquid — bookTicker', () => {
  it('perp: levels[0][0] / levels[1][0]', async () => {
    const { ex, asked } = make(Futures.usdm, 'BTC', [
      [lvl('64000'), lvl('63999')],
      [lvl('64001'), lvl('64002')],
    ])
    const res = await ex.bookTicker('BTC-USDC')
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.deepStrictEqual(res.data, { bid: 64000, ask: 64001 })
    assert.deepStrictEqual(asked, [{ coin: 'BTC' }])
  })

  it('spot: asks the @index coin', async () => {
    const { ex, asked } = make(Futures.null, '@142', [
      [lvl('64000.5')],
      [lvl('64001.5')],
    ])
    const res = await ex.bookTicker('UBTC-USDC')
    assert.deepStrictEqual(res.data, { bid: 64000.5, ask: 64001.5 })
    assert.deepStrictEqual(asked, [{ coin: '@142' }])
  })

  it('an empty side is NOTOK', async () => {
    const { ex } = make(Futures.usdm, 'BTC', [[lvl('64000')], []])
    const res = await ex.bookTicker('BTC-USDC')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(res.reason, 'No book ticker for BTC-USDC')
  })

  it('a zero side is NOTOK', async () => {
    const { ex } = make(Futures.usdm, 'BTC', [[lvl('0')], [lvl('64001')]])
    const res = await ex.bookTicker('BTC-USDC')
    assert.strictEqual(res.status, StatusEnum.notok)
  })

  it('an unknown pair is NOTOK without a venue call', async () => {
    const { ex, asked } = make(Futures.usdm, null, [])
    const res = await ex.bookTicker('BTCUSDC')
    assert.strictEqual(res.status, StatusEnum.notok)
    assert.strictEqual(asked.length, 0)
  })
})
