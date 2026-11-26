process.env.NODE_ENV = 'testing'

/**
 * OKX `/fees`: each pair is quoted at the rate of ITS fee group (spec 055).
 * OKX's `trade-fee` answers a `feeGroup` list keyed by `groupId`; instruments
 * name their `groupId`. The deprecated top-level `maker`/`taker` is the USDT
 * spot-pair rate only and is the fallback, never the answer for every pair.
 * No network. Run: `npm test`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, OKXSource, StatusEnum } from '../../types'
import OKXExchange from './index'
import { okxFeeRateFor } from './feeGroup'

const instrument = (instId: string, groupId?: string) => ({
  instId,
  instFamily: '',
  baseCcy: instId.split('-')[0],
  quoteCcy: instId.split('-')[1],
  state: 'live',
  minSz: '0.0001',
  lotSz: '0.00000001',
  tickSz: '0.01',
  maxLmtSz: '100',
  maxMktSz: '100',
  ...(groupId !== undefined ? { groupId } : {}),
})

// Shape of OKX's documented response; the top-level is the USDT group's rate.
const feeRow = (feeGroup?: unknown[]) => ({
  instType: 'SPOT',
  level: 'Lv1',
  maker: '-0.0018',
  taker: '-0.003',
  ...(feeGroup ? { feeGroup } : {}),
})

const make = (instruments: unknown[], fees: unknown[]) => {
  const ex: any = new OKXExchange(
    Futures.null,
    'k',
    's',
    'p',
    undefined,
    undefined,
    OKXSource.com,
  )
  ex.checkLimits = async () => undefined
  ex.client.getInstruments = async () => instruments
  ex.client.getFeeRates = async () => fees
  return ex as OKXExchange
}

const byPair = (rows: { pair: string; maker: number; taker: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.pair, [r.maker, r.taker]]))

describe('okx — fee rate per instrument fee group (spec 055)', () => {
  it("§1.1 a pair is quoted at its own group's rate", async () => {
    const ex = make(
      [instrument('BTC-USDT', '12'), instrument('ETH-EUR', '18')],
      [
        feeRow([
          { groupId: '12', maker: '-0.0018', taker: '-0.003' },
          { groupId: '18', maker: '0', taker: '-0.0003' },
        ]),
      ],
    )
    const res = await ex.getAllUserFees()
    assert.strictEqual(res.status, StatusEnum.ok)
    const fees = byPair(res.data)
    assert.deepStrictEqual(fees['BTC-USDT'], [0.0018, 0.003])
    assert.deepStrictEqual(fees['ETH-EUR'], [0, 0.0003])
    const one = await ex.getUserFees('ETH-EUR')
    assert.strictEqual(one.data.maker, 0)
    assert.strictEqual(one.data.taker, 0.0003)
  })

  it('§1.2 an unknown group keeps the top-level rate', async () => {
    const ex = make(
      [instrument('ETH-EUR', '99'), instrument('SOL-EUR')],
      [feeRow([{ groupId: '18', maker: '0', taker: '-0.0003' }])],
    )
    const fees = byPair((await ex.getAllUserFees()).data)
    assert.deepStrictEqual(fees['ETH-EUR'], [0.0018, 0.003])
    assert.deepStrictEqual(fees['SOL-EUR'], [0.0018, 0.003])
  })

  it('§1.3 no feeGroup: answered as before', async () => {
    const ex = make([instrument('ETH-EUR', '18')], [feeRow()])
    const fees = byPair((await ex.getAllUserFees()).data)
    assert.deepStrictEqual(fees['ETH-EUR'], [0.0018, 0.003])
  })

  it('a blank group rate falls back rather than reading as zero', () => {
    assert.deepStrictEqual(
      okxFeeRateFor(
        feeRow([{ groupId: '18', maker: '', taker: '' }]) as any,
        '18',
      ),
      { maker: 0.0018, taker: 0.003 },
    )
  })
})
