process.env.NODE_ENV = 'testing'

/**
 * OKX reconcile lookups: a batch is answered from the open-orders list, and
 * private calls are rate-limited per account, not in one bucket per connector
 * shared by every account. No network. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import OKXExchange from './index'
import limitHelper from './limit'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

type Row = { clOrdId: string; ordId: string; state: string }

const make = (open: Row[], opts: { failPage?: number } = {}) => {
  const ex: any = new OKXExchange(Futures.usdm, 'k', 's', 'p')
  const calls: Record<string, unknown>[] = []
  ex.checkLimits = async () => undefined
  ex.ensureXperpMap = async () => undefined
  ex.convertOrder = async (o: Row) => ({
    clientOrderId: o.clOrdId,
    status: o.state === 'live' ? 'NEW' : o.state,
  })
  ex.client.getOrderList = async (req: { after?: string; limit: string }) => {
    calls.push({ ...req })
    if (opts.failPage === calls.length - 1) {
      throw new Error('fetch failed')
    }
    // Newest first, `after` = rows older than that ordId.
    const start = req.after
      ? open.findIndex((r) => r.ordId === req.after) + 1
      : 0
    return open.slice(start, start + +req.limit)
  }
  return { ex, calls }
}

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    clOrdId: `c${i}`,
    ordId: `${1000 - i}`,
    state: 'live',
  }))

describe('okx — reconcile batch from the open-orders list', () => {
  it('answers every open order in one call and leaves the rest out', async () => {
    const { ex, calls } = make(rows(30))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT-SWAP',
      newClientOrderIds: ['c1', 'c5', 'gone'],
    })
    eq('status', res.status, StatusEnum.ok)
    eq('calls', calls.length, 1)
    eq('found', res.data.map((o: any) => o.clientOrderId).join(), 'c1,c5')
  })

  it('is a good answer when none of the orders are open', async () => {
    const { ex } = make(rows(3))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT-SWAP',
      newClientOrderIds: ['x', 'y'],
    })
    eq('status', res.status, StatusEnum.ok)
    eq('found', res.data.length, 0)
  })

  it('pages past 100 open orders, and stops once all are found', async () => {
    const { ex, calls } = make(rows(250))
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT-SWAP',
      newClientOrderIds: ['c3', 'c150'],
    })
    eq('found', res.data.length, 2)
    eq('calls', calls.length, 2)
    eq('cursor', calls[1].after, '901')
  })

  it('declines when the first page cannot be read', async () => {
    const { ex } = make(rows(3), { failPage: 0 })
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT-SWAP',
      newClientOrderIds: ['c1', 'c2'],
    })
    eq('status', res.status, StatusEnum.notok)
  })

  it('keeps what earlier pages found when a later page fails', async () => {
    const { ex } = make(rows(250), { failPage: 1 })
    const res = await ex.getOrdersBatch({
      symbol: 'BTC-USDT-SWAP',
      newClientOrderIds: ['c3', 'c150'],
    })
    eq('status', res.status, StatusEnum.ok)
    eq('found', res.data.map((o: any) => o.clientOrderId).join(), 'c3')
  })
})

describe('okx — private calls are limited per account', () => {
  const fill = async (bucket: string, n: number, perAccount = true) => {
    const l = new limitHelper.Limit()
    const waits: number[] = []
    for (let i = 0; i < n; i++) {
      waits.push(await l.addMethod(bucket, 2000, 12, perAccount))
    }
    return waits
  }

  it("one account's burst does not park another account", async () => {
    const a = await fill('acctA|getOrderDetails', 40)
    const b = await fill('acctB|getOrderDetails', 1)
    eq('A parked', a.filter((w) => w > 0).length, 28)
    eq('B waits', b[0], 0)
  })

  it('a parked call waits for the window to reset, not a whole new frame', async () => {
    const w = await fill('acctC|openOrder', 13)
    const wait = w[12]
    if (!(wait > 0 && wait <= 2001)) {
      throw new Error(`wait ${wait} not within the current window`)
    }
  })

  it('uses OKX documented budgets, split over the connector instances', () => {
    eq('order', limitHelper.okxPrivateLimit('openOrder').frameCount, 12)
    eq('balance', limitHelper.okxPrivateLimit('getBalance').frameCount, 2)
    eq(
      'config',
      limitHelper.okxPrivateLimit('getAccountConfiguration').frameCount,
      1,
    )
    eq('frame', limitHelper.okxPrivateLimit('openOrder').frame, 2000)
    eq('public', limitHelper.okxPrivateLimit('getCandles'), null)
  })

  it('reports the busiest account to the balancer, not the sum of all', async () => {
    await fill('usage0|getBalance', 6)
    const one = limitHelper.getUsage()[0].value
    for (let i = 1; i < 20; i++) {
      await fill(`usage${i}|getBalance`, 6)
    }
    eq('usage', limitHelper.getUsage()[0].value, one)
  })
})
