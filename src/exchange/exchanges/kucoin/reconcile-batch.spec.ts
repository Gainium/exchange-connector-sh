process.env.NODE_ENV = 'testing'

/**
 * KuCoin reconcile lookups are answered from the active-orders list (KuCoin
 * has no multi-id order lookup). No network. Run: `npm test` from `core/`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KucoinExchange from './index'

type Row = {
  id: string
  clientOid: string
  dealSize: string
  size: string
  isActive: boolean
}

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    clientOid: `c${i}`,
    dealSize: '0',
    size: '1',
    isActive: true,
  }))

const make = (
  futures: Futures,
  open: Row[],
  opts: { failPage?: number; pageSize?: number } = {},
) => {
  const ex: any = new KucoinExchange(futures, 'k', 's', 'p')
  const calls: Record<string, unknown>[] = []
  const fillsFor: boolean[] = []
  ex.checkLimits = async () => undefined
  ex.convertSymbolToKucoin = (s: string) => `${s}M`
  ex.convertOrder = async (o: Row, needFills?: boolean) => {
    fillsFor.push(!!needFills)
    return { clientOrderId: o.clientOid, orderId: o.id }
  }
  const list = async (req: { currentPage: number; pageSize: number }) => {
    calls.push({ ...req })
    if (opts.failPage === req.currentPage) {
      throw new Error('fetch failed')
    }
    const size = opts.pageSize ?? req.pageSize
    const start = (req.currentPage - 1) * size
    return {
      status: StatusEnum.ok,
      data: {
        currentPage: req.currentPage,
        pageSize: size,
        totalNum: open.length,
        totalPage: Math.ceil(open.length / size),
        items: open.slice(start, start + size),
      },
    }
  }
  ex.client.getOrders = list
  ex.client.getFuturesOrders = list
  return { ex, calls, fillsFor }
}

describe('kucoin — reconcile batch from the active-orders list', () => {
  it('spot: matches client ids, one call, leaves the rest out', async () => {
    const { ex, calls } = make(Futures.null, rows(20))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c2', 'c7', 'gone'],
    })
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.strictEqual(calls.length, 1)
    assert.deepStrictEqual(
      res.data.map((o: any) => o.clientOrderId),
      ['c2', 'c7'],
    )
    assert.strictEqual(calls[0].status, 'active')
    assert.strictEqual(calls[0].tradeType, 'TRADE')
  })

  it('futures: matches KuCoin order ids, on the futures symbol', async () => {
    const { ex, calls } = make(Futures.usdm, rows(5))
    const res = await ex.getOrdersBatch({
      symbol: 'XBTUSDT',
      newClientOrderIds: ['o1', 'o3'],
    })
    assert.deepStrictEqual(
      res.data.map((o: any) => o.orderId),
      ['o1', 'o3'],
    )
    assert.strictEqual(calls[0].symbol, 'XBTUSDTM')
  })

  it('is a good answer when none of the orders are active', async () => {
    const { ex } = make(Futures.null, rows(3))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['x', 'y'],
    })
    assert.strictEqual(res.status, StatusEnum.ok)
    assert.strictEqual(res.data.length, 0)
  })

  it('pages until all are found or the last page', async () => {
    const { ex, calls } = make(Futures.null, rows(120))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c1', 'c60'],
    })
    assert.strictEqual(res.data.length, 2)
    assert.strictEqual(calls.length, 2)
    const all = make(Futures.null, rows(120))
    await all.ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c1', 'missing'],
    })
    assert.strictEqual(all.calls.length, 3)
  })

  it('follows the page size KuCoin actually returns', async () => {
    const { ex, calls } = make(Futures.null, rows(45), { pageSize: 20 })
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c44', 'missing'],
    })
    assert.strictEqual(res.data.length, 1)
    assert.strictEqual(calls.length, 3)
  })

  it('spot: a partly filled order is converted with its fills, as getOrder does', async () => {
    const open = rows(2)
    open[1].dealSize = '0.5'
    const { ex, fillsFor } = make(Futures.null, open)
    await ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c0', 'c1'],
    })
    assert.deepStrictEqual(fillsFor, [false, true])
    const fut = make(Futures.usdm, open)
    await fut.ex.getOrdersBatch({
      symbol: 'XBTUSDT',
      newClientOrderIds: ['o0', 'o1'],
    })
    assert.deepStrictEqual(fut.fillsFor, [false, false])
  })

  it('declines when the first page cannot be read; keeps found rows after', async () => {
    const first = make(Futures.null, rows(3), { failPage: 1 })
    const r1 = await first.ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c1', 'c2'],
    })
    assert.strictEqual(r1.status, StatusEnum.notok)
    const later = make(Futures.null, rows(120), { failPage: 2 })
    const r2 = await later.ex.getOrdersBatch({
      symbol: 'BTC-USDT',
      newClientOrderIds: ['c1', 'c60'],
    })
    assert.strictEqual(r2.status, StatusEnum.ok)
    assert.deepStrictEqual(
      r2.data.map((o: any) => o.clientOrderId),
      ['c1'],
    )
  })
})
