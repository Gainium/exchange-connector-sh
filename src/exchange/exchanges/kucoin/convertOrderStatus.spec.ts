process.env.NODE_ENV = 'testing'

/**
 * Spec 037 — the status `convertOrder` gives a KuCoin order record. No
 * network; fixture ids are synthetic. Run: `npm test` from `core/`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import KucoinExchange from './index'

const record = (o: Record<string, unknown>) => ({
  id: 'o1',
  clientOid: 'c1',
  symbol: 'AAA-USDT',
  side: 'buy',
  type: 'market',
  price: '0',
  size: '100',
  dealSize: '0',
  dealFunds: '0',
  fee: '0',
  feeCurrency: 'USDT',
  createdAt: 1,
  isActive: false,
  cancelExist: false,
  ...o,
})

const convert = async (o: Record<string, unknown>, futures = Futures.null) => {
  const ex: any = new KucoinExchange(futures, 'k', 's', 'p')
  return ex.convertOrder(record(o))
}

describe('spec 037 KuCoin convertOrder status', () => {
  it('§1.1 an inactive order with nothing executed is CANCELED, not FILLED', async () => {
    const o = await convert({ cancelExist: false, dealSize: '0' })
    assert.strictEqual(o.status, 'CANCELED')
    assert.strictEqual(o.executedQty, '0')
  })

  it('§1.1 the same on futures, where dealSize is a number', async () => {
    const o = await convert({ cancelExist: false, dealSize: 0 }, Futures.usdm)
    assert.strictEqual(o.status, 'CANCELED')
  })

  it('§1.3 an inactive order that executed is FILLED', async () => {
    const o = await convert({ dealSize: '100', dealFunds: '5' })
    assert.strictEqual(o.status, 'FILLED')
    assert.strictEqual(o.executedQty, '100')
    const part = await convert({ dealSize: '40', dealFunds: '2' })
    assert.strictEqual(part.status, 'FILLED')
    assert.strictEqual(part.executedQty, '40')
  })

  it('§1.3 a cancelled part-fill is CANCELED and keeps what executed', async () => {
    const o = await convert({ cancelExist: true, dealSize: '40' })
    assert.strictEqual(o.status, 'CANCELED')
    assert.strictEqual(o.executedQty, '40')
  })

  it('§1.3 active orders are NEW / PARTIALLY_FILLED', async () => {
    assert.strictEqual((await convert({ isActive: true })).status, 'NEW')
    assert.strictEqual(
      (await convert({ isActive: true, dealSize: '40' })).status,
      'PARTIALLY_FILLED',
    )
  })
})
