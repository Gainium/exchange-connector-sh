process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for spec `015` — Kraken spot reported funds held by open
 * orders as free.
 *
 * Driven over the REAL `getBalance` with the Kraken client stubbed. The stub
 * answers BOTH balance endpoints, so the test fails on a connector that still
 * reads the basic one (which has no hold figure to report).
 *
 * Quantities are synthetic because this file is public.
 *
 * Run: `npm test` (mocha). No network / auth needed.
 */
import { describe, it } from 'mocha'
import assert from 'assert'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'
import { krakenSpotFreeLocked } from './balance'

function makeExchange(rows: Record<string, Record<string, string>>) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  ex.checkLimits = async () => undefined
  ex.retry = 0
  ex.symbolMapper = { getActualAssetName: (a: string) => a }
  ex.spotClient = {
    getAccountBalance: async () => ({
      error: [],
      result: Object.fromEntries(
        Object.entries(rows).map(([a, r]) => [a, r.balance]),
      ),
    }),
    getExtendedBalance: async () => ({ error: [], result: rows }),
  }
  return ex
}

describe('Kraken spot balance — funds held by open orders (spec 015)', () => {
  it('§4.1 reports the hold as locked and only the rest as free', async () => {
    const ex = makeExchange({
      USD: {
        balance: '15000.0000',
        credit: '0.0000',
        credit_used: '0.0000',
        hold_trade: '10372.0000',
      },
      KSM: {
        balance: '260.83008372',
        credit: '0',
        credit_used: '0',
        hold_trade: '260.83008372',
      },
      BTC: { balance: '0.5', credit: '0', credit_used: '0', hold_trade: '0' },
    })
    const res = await ex.getBalance()
    assert.strictEqual(res.status, StatusEnum.ok)
    const by = Object.fromEntries(res.data.map((b: any) => [b.asset, b]))
    assert.deepStrictEqual(by.USD, { asset: 'USD', free: 4628, locked: 10372 })
    assert.deepStrictEqual(by.KSM, {
      asset: 'KSM',
      free: 0,
      locked: 260.83008372,
    })
    assert.deepStrictEqual(by.BTC, { asset: 'BTC', free: 0.5, locked: 0 })
  })

  it('§4.2 free follows Kraken’s formula, credit line included', () => {
    assert.deepStrictEqual(
      krakenSpotFreeLocked({
        balance: '100',
        credit: '50',
        credit_used: '20',
        hold_trade: '30',
      }),
      { free: 100, locked: 30 },
    )
  })

  it('§4.3 never surfaces a negative or NaN figure', () => {
    assert.deepStrictEqual(
      krakenSpotFreeLocked({ balance: '1', hold_trade: '2' }),
      { free: 0, locked: 2 },
    )
    assert.deepStrictEqual(krakenSpotFreeLocked({ balance: '0.3' }), {
      free: 0.3,
      locked: 0,
    })
    assert.deepStrictEqual(krakenSpotFreeLocked({}), { free: 0, locked: 0 })
  })

  it('§4.3 leaves no binary subtraction residue in free', () => {
    const { free } = krakenSpotFreeLocked({ balance: '0.3', hold_trade: '0.1' })
    assert.strictEqual(free, 0.2)
  })
})
