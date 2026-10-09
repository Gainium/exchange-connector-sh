process.env.NODE_ENV = 'testing'

/**
 * An order OKX acknowledged must not come back as "Order does not exist" just
 * because OKX has not indexed it yet. No network: drives the real openOrder
 * over a fake OKX whose order-details endpoint lags the submit.
 * Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import OKXExchange from './index'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const notExist = {
  code: '1',
  msg: '',
  data: [{ sCode: '51603', sMsg: 'Order does not exist' }],
}

/** `visibleAfter` = number of lookups that miss before OKX serves the order. */
const make = (visibleAfter: number, missShape: 'throw' | 'empty' = 'throw') => {
  const ex: any = new OKXExchange(Futures.null, 'k', 's', 'p')
  const f = { ex, submits: 0, lookups: 0, converted: [] as any[] }
  ex.checkLimits = async () => undefined
  ex.spotTdMode = async () => 'cash'
  ex.convertOrder = async (o: any) => {
    f.converted.push(o)
    return {
      clientOrderId: o.clOrdId,
      orderId: o.ordId,
      price: o.px,
      origQty: o.sz,
      status: o.state === 'live' ? 'NEW' : o.state,
    }
  }
  ex.orderClient.submitOrder = async (req: { clOrdId: string }) => {
    f.submits++
    return [
      {
        sCode: '0',
        clOrdId: req.clOrdId,
        ordId: '3992015668520128513',
        ts: '1791473737929',
      },
    ]
  }
  ex.client.getOrderDetails = async (req: { clOrdId: string }) => {
    f.lookups++
    if (f.lookups <= visibleAfter) {
      if (missShape === 'throw') throw notExist
      return []
    }
    return [
      { clOrdId: req.clOrdId, ordId: '3992015668520128513', state: 'live' },
    ]
  }
  return f
}

const order = (type: 'LIMIT' | 'MARKET' = 'LIMIT') => ({
  symbol: 'ETH-USDC',
  side: 'SELL' as const,
  quantity: 0.02667,
  price: 2572.8,
  newClientOrderId: 'DTPG7MKwdHhysHHF',
  type,
})

describe('okx — an acknowledged order is never reported as not existing', () => {
  it('keeps reading back through 51603 until OKX serves the order', async () => {
    const f = make(2)
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'OK')
    eq('order status', res.data?.status, 'NEW')
    eq('submits', f.submits, 1)
    eq('lookups', f.lookups, 3)
  })

  it('treats an empty read-back the same way', async () => {
    const f = make(1, 'empty')
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'OK')
    eq('submits', f.submits, 1)
  })

  it('returns a never-readable LIMIT order as NEW from the submit ack', async () => {
    const f = make(99)
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'OK')
    eq('order status', res.data?.status, 'NEW')
    eq('orderId', res.data?.orderId, '3992015668520128513')
    eq('clientOrderId', res.data?.clientOrderId, 'DTPG7MKwdHhysHHF')
    eq('qty', res.data?.origQty, '0.02667')
    eq('submits', f.submits, 1)
    eq('lookups', f.lookups, 5)
  })

  it('returns a never-readable MARKET order as an ambiguous timeout, not a refusal', async () => {
    const f = make(99)
    const res = await f.ex.openOrder(order('MARKET'))
    eq('status', res.status, 'NOTOK')
    eq('timeout in reason', /timeout/i.test(res.reason), true)
    eq('no "does not exist"', /does not exist/i.test(res.reason), false)
    eq('submits', f.submits, 1)
  })
})
