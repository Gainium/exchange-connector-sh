process.env.NODE_ENV = 'testing'

/**
 * Bybit `getOrder` when the client order id is in neither active orders nor
 * order history.
 *
 * Both calls answer retCode 0 with an empty list, and the lookup used to fail
 * with Bybit's own `retMsg`, which is literally `OK`. main-app only writes off
 * an order the venue definitively says does not exist, so an order that never
 * reached Bybit was asked about on every reconcile, forever.
 *
 * Bybit's history defaults to the last 7 days, so "empty" is only an answer
 * when history was searched back to the order's placement (`since`).
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'
import {
  bybitHistoryRetentionMs,
  bybitHistorySkewMs,
  bybitHistoryWindowMs,
  bybitHistoryWindows,
  bybitOrderNotFoundReason,
} from './historyWindows'

const day = 24 * 60 * 60 * 1000
const ok = (list: unknown[]) => ({
  retCode: 0,
  retMsg: 'OK',
  result: { list, nextPageCursor: '', category: 'linear' },
})

const filled = {
  orderId: 'ex-1',
  orderLinkId: 'CMB-RO-x',
  symbol: 'BTCUSDT',
  side: 'Buy',
  orderType: 'Limit',
  price: '100',
  qty: '1',
  cumExecQty: '1',
  cumExecValue: '100',
  orderStatus: 'Filled',
  createdTime: '1',
  updatedTime: '1',
  avgPrice: '100',
  timeInForce: 'GTC',
}

function stub(history: (ask: Record<string, unknown>) => unknown) {
  const ex = new BybitExchange(Futures.usdm, 'k', 's') as any
  const asks: Record<string, unknown>[] = []
  ex.checkLimits = async (_r: string, _t: string, tp: unknown) => tp
  ex.convertOrder = async (o: { orderId: string }) => ({ orderId: o.orderId })
  ex.client = {
    getActiveOrders: async () => ok([]),
    getHistoricOrders: async (params: Record<string, unknown>) => {
      asks.push(params)
      return history(params)
    },
  }
  return { ex, asks }
}

describe('bybit getOrder — order in neither active orders nor history', function () {
  this.timeout(60_000)

  it('without a placement time it stays an error, never "not found"', async () => {
    const { ex, asks } = stub(() => ok([]))
    // handleBybitErrors would replay the call; pin the single answer.
    ex.handleBybitErrors = () => async (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    })
    const res = await ex.getOrder({ symbol: 'BTCUSDT', newClientOrderId: 'a' })
    assert.equal(res.status, StatusEnum.notok)
    assert.equal(res.reason, 'OK')
    assert.equal(asks.length, 2)
  })

  it('placed inside the default window: "Order not found", no extra calls', async () => {
    const { ex, asks } = stub(() => ok([]))
    const res = await ex.getOrder({
      symbol: 'BTCUSDT',
      newClientOrderId: 'a',
      since: Date.now() - 2 * day,
    })
    assert.equal(res.status, StatusEnum.notok)
    assert.equal(res.reason, bybitOrderNotFoundReason)
    assert.match(res.reason.toLowerCase(), /\border not found\b/)
    assert.doesNotMatch(
      res.reason.toLowerCase(),
      /\border not found in open orders\b/,
    )
    assert.equal(asks.length, 2)
  })

  it('placed 54 days ago: searches every 7-day window back to placement', async () => {
    const since = Date.now() - 54 * day
    const { ex, asks } = stub(() => ok([]))
    const res = await ex.getOrder({
      symbol: 'BTCUSDT',
      newClientOrderId: 'a',
      since,
    })
    assert.equal(res.status, StatusEnum.notok)
    assert.equal(res.reason, bybitOrderNotFoundReason)
    const ranged = asks.filter((a) => 'startTime' in a)
    assert.equal(ranged.length, 7)
    for (const a of ranged) {
      assert.equal(a.orderLinkId, 'a')
      assert.ok(
        (a.endTime as number) - (a.startTime as number) <= bybitHistoryWindowMs,
      )
    }
    assert.equal(
      Math.min(...ranged.map((a) => a.startTime as number)),
      since - bybitHistorySkewMs,
    )
  })

  it('an old order that FILLED is found in its window, not written off', async () => {
    const since = Date.now() - 30 * day
    const { ex } = stub((a) =>
      a.startTime !== undefined && (a.startTime as number) <= since
        ? ok([filled])
        : ok([]),
    )
    const res = await ex.getOrder({
      symbol: 'BTCUSDT',
      newClientOrderId: 'a',
      since,
    })
    assert.equal(res.status, StatusEnum.ok)
    assert.equal(res.data.orderId, 'ex-1')
  })

  it('a window that fails is the venue error, not "not found"', async () => {
    const since = Date.now() - 30 * day
    const { ex } = stub((a) =>
      a.startTime !== undefined
        ? { retCode: 10006, retMsg: 'Too many visits!', result: {} }
        : ok([]),
    )
    ex.handleBybitErrors = () => async (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    })
    const res = await ex.getOrder({
      symbol: 'BTCUSDT',
      newClientOrderId: 'a',
      since,
    })
    assert.equal(res.status, StatusEnum.notok)
    assert.equal(res.reason, 'Too many visits!')
  })
})

describe('bybitHistoryWindows', () => {
  const now = 1_800_000_000_000
  it('no or bad placement time: cannot answer', () => {
    assert.equal(bybitHistoryWindows(undefined, now), null)
    assert.equal(bybitHistoryWindows(0, now), null)
    assert.equal(bybitHistoryWindows(NaN, now), null)
  })
  it('older than Bybit keeps history: cannot answer', () => {
    assert.equal(
      bybitHistoryWindows(now - bybitHistoryRetentionMs - day, now),
      null,
    )
  })
  it('inside the default window: nothing extra', () => {
    assert.deepEqual(bybitHistoryWindows(now - day, now), [])
  })
  it('windows are contiguous, <= 7 days, and reach since - skew', () => {
    const since = now - 20 * day
    const w = bybitHistoryWindows(since, now)!
    assert.ok(w.length >= 2)
    assert.ok(w[0].endTime > now - bybitHistoryWindowMs)
    for (let i = 0; i < w.length; i++) {
      assert.ok(w[i].endTime - w[i].startTime <= bybitHistoryWindowMs)
      assert.ok(w[i].endTime > w[i].startTime)
      if (i) assert.equal(w[i].endTime, w[i - 1].startTime)
    }
    assert.equal(w[w.length - 1].startTime, since - bybitHistorySkewMs)
  })
})
