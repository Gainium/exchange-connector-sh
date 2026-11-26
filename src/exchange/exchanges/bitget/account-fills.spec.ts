process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/054.bitget-futures-account-fills.md`.
 *
 * Bitget USDT-M answered the account-fills read with an empty page (the
 * abstract default), so main-app could never price a futures deal the venue
 * closed outside the bot (a liquidation, a hand close) and booked it at no
 * exit price. These pin the mapping of `/api/v2/mix/order/fills` rows.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'
import {
  bitgetFillDirection,
  bitgetFuturesFillToAccountFill,
  type BitgetFuturesFill,
} from './accountFills'

const fill = (over: Partial<BitgetFuturesFill>): BitgetFuturesFill => ({
  tradeId: '1',
  symbol: 'ETHUSDT',
  orderId: '9',
  price: '0.0295',
  baseVolume: '1083',
  side: 'sell',
  cTime: '1795100000000',
  ...over,
})

describe('spec 054 — bitget futures account fills', () => {
  it('§1.2 reads the direction off tradeSide when it names the position', () => {
    // Hedge mode: `side` is the position's side, so a long's close says buy.
    const cases: [Partial<BitgetFuturesFill>, 'BUY' | 'SELL'][] = [
      [{ side: 'buy', tradeSide: 'burst_close_long', posMode: 'hedge_mode' }, 'SELL'],
      [{ side: 'buy', tradeSide: 'close', posMode: 'hedge_mode' }, 'SELL'],
      [{ side: 'sell', tradeSide: 'close', posMode: 'hedge_mode' }, 'BUY'],
      [{ side: 'sell', tradeSide: 'close_short' }, 'BUY'],
      [{ side: 'sell', tradeSide: 'burst_sell_single', posMode: 'one_way_mode' }, 'SELL'],
      [{ side: 'buy', tradeSide: 'buy_single' }, 'BUY'],
      [{ side: 'buy', tradeSide: 'open', posMode: 'hedge_mode' }, 'BUY'],
    ]
    for (const [f, want] of cases) {
      assert.equal(bitgetFillDirection(fill(f)), want, JSON.stringify(f))
    }
  })

  it('§1.1 maps a liquidation fill with its source, raw tradeSide and quote fee', () => {
    const f = bitgetFuturesFillToAccountFill(
      fill({
        symbol: 'ethusdt',
        side: 'buy',
        tradeSide: 'burst_close_long',
        posMode: 'hedge_mode',
        enterPointSource: 'SYS',
        feeDetail: [{ feeCoin: 'USDT', totalFee: '-0.0191' }],
      }),
    )
    assert.deepEqual(f, {
      fillId: '1',
      orderId: '9',
      clientOrderId: '',
      symbol: 'ETHUSDT',
      side: 'SELL',
      price: '0.0295',
      quantity: '1083',
      timestamp: 1795100000000,
      fillType: 'burst_close_long',
      source: 'SYS',
      fee: '0.0191',
    })
  })

  it('§1.1 leaves the fee out when it was charged in another coin', () => {
    const f = bitgetFuturesFillToAccountFill(
      fill({ feeDetail: [{ feeCoin: 'BGB', totalFee: '-0.01' }] }),
    )
    assert.equal(f.fee, undefined)
    assert.equal(f.source, undefined)
  })

  it('§1.3 reads every USDT-M product line, newest first, paging by endTime', async () => {
    const ex = new BitgetExchange(Futures.usdm, 'k', 's', 'p') as any
    ex.checkLimits = async () => undefined
    ex.accountMode = async () => 'classic'
    const calls: Record<string, string>[] = []
    ex.client = {
      getFuturesFills: async (p: Record<string, string>) => {
        calls.push(p)
        return {
          code: '00000',
          msg: 'success',
          data: {
            endId: '',
            fillList:
              p.productType === 'USDT-FUTURES'
                ? [fill({ tradeId: 'a', cTime: '100' })]
                : [fill({ tradeId: 'b', symbol: 'BTCUSDC', cTime: '200' })],
          },
        }
      },
    }
    const res = await ex.getAccountFills(5000)
    assert.equal(res.status, StatusEnum.ok)
    assert.deepEqual(
      res.data.map((f: { fillId: string }) => f.fillId),
      ['b', 'a'],
    )
    assert.deepEqual(
      calls.map((c) => [c.productType, c.endTime, c.limit]),
      [
        ['USDT-FUTURES', '4999', '100'],
        ['USDC-FUTURES', '4999', '100'],
      ],
    )
  })

  it('§1.4 a Unified Trading Account and spot answer an empty page', async () => {
    const uta = new BitgetExchange(Futures.usdm, 'k', 's', 'p') as any
    uta.accountMode = async () => 'uta'
    uta.client = {
      getFuturesFills: async () => {
        throw new Error('must not be called')
      },
    }
    const r1 = await uta.getAccountFills()
    assert.equal(r1.status, StatusEnum.ok)
    assert.deepEqual(r1.data, [])
    const spot = new BitgetExchange(Futures.null, 'k', 's', 'p') as any
    spot.client = uta.client
    const r2 = await spot.getAccountFills()
    assert.deepEqual(r2.data, [])
  })
})
