process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/056.bybit-futures-account-fills.md`.
 *
 * Bybit linear/inverse answered the account-fills read with an empty page
 * (the abstract default), so main-app could never price a futures deal the
 * venue closed outside the bot (a liquidation, a hand close) and booked it
 * with no exit price. These pin the `/v5/execution/list` read and mapping.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'
import {
  bybitExecutionToAccountFill,
  type BybitExecution,
} from './accountFills'

const exec = (over: Partial<BybitExecution>): BybitExecution => ({
  execId: 'e1',
  orderId: 'o1',
  orderLinkId: '',
  symbol: 'TRXUSDT',
  side: 'Sell',
  execPrice: '0.3040',
  execQty: '6371',
  execTime: '1795500000000',
  execType: 'Trade',
  execFee: '1.16',
  ...over,
})

const ok = (list: unknown[], nextPageCursor = '') => ({
  retCode: 0,
  retMsg: 'OK',
  result: { list, nextPageCursor, category: 'linear' },
})

function stub(
  futures: Futures | null,
  pages: (ask: Record<string, unknown>) => unknown,
) {
  const ex = new BybitExchange(futures as Futures, 'k', 's') as any
  const asks: Record<string, unknown>[] = []
  ex.checkLimits = async (_r: string, _t: string, tp: unknown) => tp
  ex.client = {
    getExecutionList: async (params: Record<string, unknown>) => {
      asks.push(params)
      return pages(params)
    },
  }
  return { ex, asks }
}

describe('spec 056 — bybit futures account fills', () => {
  it('§1.1 a linear account answers its executions, not an empty page', async () => {
    const { ex, asks } = stub(Futures.usdm, () => ok([exec({})]))
    const res = await ex.getAccountFills()
    assert.equal(res.status, StatusEnum.ok)
    assert.equal(res.data.length, 1)
    assert.equal(asks.length, 1)
    assert.equal(asks[0].category, 'linear')
    assert.equal(asks[0].limit, 100)
    assert.equal('endTime' in asks[0], false)
  })

  it('§1.2 maps one execution onto AccountFill', () => {
    assert.deepEqual(
      bybitExecutionToAccountFill(
        exec({ orderLinkId: 'gainium-1', side: 'Buy', symbol: 'trxusdt' }),
        true,
      ),
      {
        fillId: 'e1',
        orderId: 'o1',
        clientOrderId: 'gainium-1',
        symbol: 'TRXUSDT',
        side: 'BUY',
        price: '0.3040',
        quantity: '6371',
        timestamp: 1795500000000,
        fillType: 'Trade',
        fee: '1.16',
      },
    )
  })

  it('§1.3 types a forced close in the shared forced-close vocabulary', () => {
    const bust = bybitExecutionToAccountFill(
      exec({ execType: 'BustTrade' }),
      true,
    )
    const adl = bybitExecutionToAccountFill(
      exec({ execType: 'AdlTrade' }),
      true,
    )
    assert.equal(bust.fillType, 'liquidation')
    assert.equal(adl.fillType, 'unwindCounterparty')
    // Neither carries a client order id of ours.
    assert.equal(bust.clientOrderId, '')
  })

  it('§1.4 keeps only position-moving executions (no Funding, no Settle)', async () => {
    const { ex } = stub(Futures.usdm, () =>
      ok([
        exec({ execId: 'f', execType: 'Funding', execTime: '1795500000300' }),
        exec({ execId: 's', execType: 'Settle', execTime: '1795500000200' }),
        exec({ execId: 'b', execType: 'BustTrade', execTime: '1795500000100' }),
        exec({ execId: 't', execType: 'Trade', execTime: '1795500000000' }),
        exec({ execId: 'a', execType: 'AdlTrade', execTime: '1795500000050' }),
      ]),
    )
    const res = await ex.getAccountFills()
    assert.deepEqual(
      res.data.map((f: { fillId: string }) => f.fillId),
      ['b', 'a', 't'],
    )
  })

  it('§1.5 fee only in the quote coin and only as a cost', () => {
    assert.equal(bybitExecutionToAccountFill(exec({}), true).fee, '1.16')
    // Maker rebate: not a cost, so not reported as one.
    assert.equal(
      'fee' in bybitExecutionToAccountFill(exec({ execFee: '-0.2' }), true),
      false,
    )
    assert.equal(
      'fee' in bybitExecutionToAccountFill(exec({ execFee: '' }), true),
      false,
    )
    // Inverse charges the base coin.
    assert.equal('fee' in bybitExecutionToAccountFill(exec({}), false), false)
  })

  it('§1.6 pages backwards: endTime is strictly before sinceMs', async () => {
    const { ex, asks } = stub(Futures.coinm, () => ok([]))
    const res = await ex.getAccountFills(1795500000000)
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(res.data, [])
    assert.equal(asks[0].category, 'inverse')
    assert.equal(asks[0].endTime, 1795499999999)
  })

  it('§1.7 a run of funding rows does not end the history early', async () => {
    const funding = Array.from({ length: 100 }, (_, i) =>
      exec({ execId: `f${i}`, execType: 'Funding' }),
    )
    const { ex, asks } = stub(Futures.usdm, (ask) =>
      !ask.cursor
        ? ok(funding, 'p2')
        : ask.cursor === 'p2'
          ? ok([exec({ execId: 'close', execType: 'BustTrade' })], 'p3')
          : ok([]),
    )
    const res = await ex.getAccountFills()
    assert.equal(asks[1].cursor, 'p2')
    assert.deepEqual(
      res.data.map((f: { fillId: string }) => f.fillId),
      ['close'],
    )
  })

  it('§1.8 stops after 5 venue pages and on a repeated cursor', async () => {
    const a = stub(Futures.usdm, () =>
      ok([exec({ execType: 'Funding' })], 'again'),
    )
    await a.ex.getAccountFills()
    assert.equal(a.asks.length, 2)
    let n = 0
    const b = stub(Futures.usdm, () =>
      ok([exec({ execType: 'Funding' })], `c${n++}`),
    )
    await b.ex.getAccountFills()
    assert.equal(b.asks.length, 5)
  })

  it('§1.9 a venue error fails the read instead of answering an empty page', async () => {
    const { ex } = stub(Futures.usdm, () => ({
      retCode: 10001,
      retMsg: 'params error',
      result: {},
    }))
    const res = await ex.getAccountFills()
    assert.equal(res.status, StatusEnum.notok)
  })

  it('§1.10 spot has no futures fills and makes no request', async () => {
    const { ex, asks } = stub(null, () => ok([exec({})]))
    const res = await ex.getAccountFills()
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(res.data, [])
    assert.equal(asks.length, 0)
  })
})
