process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/057.binance-futures-account-fills.md`.
 *
 * Binance USDⓈ-M and COIN-M answered the account-fills read with an empty page
 * (the abstract default), so main-app could never price a futures deal closed
 * outside the bot (a hand close in the app, a liquidation) and booked it with
 * no exit price. These pin the per-symbol `userTrades` read, its attribution
 * through each order's client id, and the mapping onto `AccountFill`.
 *
 * Run: `npm test` (mocha). No network — the REST clients are stubbed.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { ExchangeDomain, Futures, StatusEnum } from '../../types'
import BinanceExchange from './index'
import {
  binanceOrderOrigin,
  binanceTradeToAccountFill,
  binanceTradesToAccountFills,
  type BinanceFuturesTrade,
} from './accountFills'

const DAY = 24 * 60 * 60 * 1000

const trade = (over: Partial<BinanceFuturesTrade>): BinanceFuturesTrade => ({
  id: 1,
  orderId: 100,
  symbol: 'IOTXUSDT',
  side: 'SELL',
  price: '0.01520',
  qty: '509496',
  time: 1795709000000,
  commission: '3.87',
  commissionAsset: 'USDT',
  realizedPnl: '-120.5',
  ...over,
})

type Stub = {
  trades?: (ask: Record<string, unknown>) => unknown[]
  orders?: Record<string, string>
  orderError?: (orderId: string) => unknown
}

function stub(futures: Futures | null, s: Stub = {}) {
  const ex = new BinanceExchange(
    ExchangeDomain.com,
    futures as Futures,
    'k',
    's',
  ) as any
  const tradeAsks: Record<string, unknown>[] = []
  const orderAsks: Record<string, unknown>[] = []
  const limits: { request: string; weight: number }[] = []
  ex.checkLimits = async (
    request: string,
    _t: string,
    weight: number,
    tp: unknown,
  ) => {
    limits.push({ request, weight })
    return tp
  }
  const client = {
    getAccountTrades: async (params: Record<string, unknown>) => {
      tradeAsks.push(params)
      return s.trades ? s.trades(params) : []
    },
    getOrder: async (params: Record<string, unknown>) => {
      orderAsks.push(params)
      const id = `${params.orderId}`
      const err = s.orderError?.(id)
      if (err) {
        throw err
      }
      const cid = s.orders?.[id]
      if (cid === undefined) {
        throw Object.assign(new Error('Order does not exist.'), {
          code: -2013,
        })
      }
      return { orderId: +id, clientOrderId: cid }
    },
  }
  ex.usdmClient = client
  ex.coinmClient = client
  ex.client = {
    getAccountTradeList: async () => {
      throw new Error('spot must not be read')
    },
  }
  return { ex, tradeAsks, orderAsks, limits }
}

describe('spec 057 — binance futures account fills', () => {
  it('§1.1 spot answers an empty page and reads nothing', async () => {
    const { ex, tradeAsks, orderAsks } = stub(null)
    const res = await ex.getAccountFills(undefined, 'BTCUSDT')
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(res.data, [])
    assert.equal(tradeAsks.length + orderAsks.length, 0)
  })

  it('§1.1 futures with no symbol answers an empty page and reads nothing', async () => {
    const { ex, tradeAsks } = stub(Futures.usdm)
    const res = await ex.getAccountFills()
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(res.data, [])
    assert.equal(tradeAsks.length, 0)
  })

  it('§1.2 USDⓈ-M reads that symbol’s userTrades, weight 5', async () => {
    const { ex, tradeAsks, limits } = stub(Futures.usdm, {
      trades: () => [trade({})],
      orders: { '100': 'web_abc123' },
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.equal(res.status, StatusEnum.ok)
    assert.equal(res.data.length, 1)
    assert.equal(tradeAsks.length, 1)
    assert.equal(tradeAsks[0].symbol, 'IOTXUSDT')
    assert.equal(tradeAsks[0].limit, 1000)
    assert.equal('endTime' in tradeAsks[0], false)
    assert.equal('startTime' in tradeAsks[0], false)
    assert.deepEqual(
      limits.find((l) => l.request === 'getAccountFills'),
      { request: 'getAccountFills', weight: 5 },
    )
  })

  it('§1.2 COIN-M reads the same feed at weight 20', async () => {
    const { ex, tradeAsks, limits } = stub(Futures.coinm, {
      trades: () => [trade({ symbol: 'BTCUSD_PERP', qty: '12' })],
      orders: { '100': 'ios_x' },
    })
    const res = await ex.getAccountFills(undefined, 'BTCUSD_PERP')
    assert.equal(res.status, StatusEnum.ok)
    assert.equal(tradeAsks[0].symbol, 'BTCUSD_PERP')
    assert.deepEqual(
      limits.find((l) => l.request === 'getAccountFills'),
      { request: 'getAccountFills', weight: 20 },
    )
    assert.equal(res.data[0].quantity, '12')
    assert.equal('fee' in res.data[0], false)
  })

  it('§1.3 `sinceMs` reads the 7 days strictly before it', async () => {
    const { ex, tradeAsks } = stub(Futures.usdm, { trades: () => [] })
    await ex.getAccountFills(1795709000000, 'IOTXUSDT')
    assert.equal(tradeAsks[0].endTime, 1795709000000 - 1)
    assert.equal(tradeAsks[0].startTime, 1795709000000 - 7 * DAY)
  })

  it('§1.4 a full page is followed forward to the newest trades', async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      trade({ id: i + 1, orderId: 100, time: 1795700000000 + i }),
    )
    const { ex, tradeAsks } = stub(Futures.usdm, {
      trades: (ask) =>
        ask.startTime
          ? [trade({ id: 5000, orderId: 200, time: 1795709000000 })]
          : full,
      orders: { '100': 'x-bot-1', '200': 'web_hand' },
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.equal(tradeAsks.length, 2)
    assert.equal(tradeAsks[1].startTime, 1795700000000 + 999 + 1)
    assert.equal(res.data[0].fillId, '5000')
    assert.equal(res.data.length, 1001)
  })

  it('§1.5 attribution: a hand close is not ours, a bot order is', async () => {
    const { ex, orderAsks } = stub(Futures.usdm, {
      trades: () => [
        trade({ id: 1, orderId: 100, time: 10, side: 'BUY' }),
        trade({ id: 2, orderId: 200, time: 20 }),
        trade({ id: 3, orderId: 200, time: 21 }),
      ],
      orders: { '100': 'x-AbCdEf-1795', '200': 'web_q1w2e3' },
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.deepEqual(
      res.data.map((f: any) => [f.fillId, f.clientOrderId, f.source]),
      [
        ['3', '', 'WEB'],
        ['2', '', 'WEB'],
        ['1', 'x-AbCdEf-1795', 'API'],
      ],
    )
    // one order lookup per distinct order, not per trade
    assert.equal(orderAsks.length, 2)
    assert.equal(orderAsks[0].symbol, 'IOTXUSDT')
  })

  it('§1.5 venue-assigned ids are classified', () => {
    assert.deepEqual(binanceOrderOrigin('web_abc'), {
      source: 'WEB',
      venueAssigned: true,
    })
    assert.deepEqual(binanceOrderOrigin('android_abc').source, 'ANDROID')
    assert.deepEqual(binanceOrderOrigin('electron_abc').source, 'ELECTRON')
    assert.deepEqual(binanceOrderOrigin('autoclose-1795709000000'), {
      source: 'SYS',
      fillType: 'liquidation',
      venueAssigned: true,
    })
    assert.equal(
      binanceOrderOrigin('adl_autoclose').fillType,
      'unwindCounterparty',
    )
    assert.equal(
      binanceOrderOrigin('settlement_autoclose-1795').venueAssigned,
      true,
    )
    assert.deepEqual(binanceOrderOrigin('x-AbCd-123'), {
      source: 'API',
      venueAssigned: false,
    })
    assert.deepEqual(binanceOrderOrigin('webhook-tool-1'), {
      source: 'API',
      venueAssigned: false,
    })
  })

  it('§1.6 maps one trade onto AccountFill', () => {
    assert.deepEqual(
      binanceTradeToAccountFill(trade({ symbol: 'iotxusdt' }), 'web_a', true),
      {
        fillId: '1',
        orderId: '100',
        clientOrderId: '',
        symbol: 'IOTXUSDT',
        side: 'SELL',
        price: '0.01520',
        quantity: '509496',
        timestamp: 1795709000000,
        source: 'WEB',
        fee: '3.87',
        realizedPnl: '-120.5',
      },
    )
  })

  it('§1.6 a fee paid in another coin (BNB) is not reported', () => {
    const f = binanceTradeToAccountFill(
      trade({ commissionAsset: 'BNB', commission: '0.001' }),
      'web_a',
      true,
    )
    assert.equal('fee' in f, false)
  })

  it('§1.7 the run stops at the newest trade it cannot attribute', () => {
    const fills = binanceTradesToAccountFills(
      [
        trade({ id: 1, orderId: 100, time: 10 }),
        trade({ id: 2, orderId: 999, time: 20 }),
        trade({ id: 3, orderId: 200, time: 30 }),
      ],
      new Map([
        ['100', 'web_a'],
        ['200', 'web_b'],
      ]),
      true,
    )
    assert.deepEqual(
      fills.map((f) => f.fillId),
      ['3'],
    )
  })

  it('§1.7 an order the venue no longer has ends the run, not the read', async () => {
    const { ex } = stub(Futures.usdm, {
      trades: () => [
        trade({ id: 1, orderId: 100, time: 10 }),
        trade({ id: 2, orderId: 999, time: 20 }),
        trade({ id: 3, orderId: 200, time: 30 }),
      ],
      orders: { '100': 'web_a', '200': 'web_b' },
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(
      res.data.map((f: any) => f.fillId),
      ['3'],
    )
  })

  it('§1.8 a venue error answers NOTOK instead of throwing', async () => {
    const { ex } = stub(Futures.usdm, {
      trades: () => {
        throw Object.assign(new Error('Invalid API-key'), { code: -2015 })
      },
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.equal(res.status, StatusEnum.notok)
  })

  it('§1.8 an order lookup error other than not-found answers NOTOK', async () => {
    const { ex } = stub(Futures.usdm, {
      trades: () => [trade({})],
      orderError: () =>
        Object.assign(new Error('Invalid API-key'), { code: -2015 }),
    })
    const res = await ex.getAccountFills(undefined, 'IOTXUSDT')
    assert.equal(res.status, StatusEnum.notok)
  })
})
