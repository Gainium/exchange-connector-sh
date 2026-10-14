process.env.NODE_ENV = 'testing'

/**
 * Spec 036 — Bybit linear contracts must report the venue's minimum order
 * value (`lotSizeFilter.minNotionalValue`) as `quoteAsset.minAmount`; inverse
 * contracts keep the contract size (1) there.
 *
 * Drives the real `BybitExchange.getAllExchangeInfo` — only the venue REST
 * call and the rate limiter are stubbed. No network, no keys.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it, before } from 'mocha'
import { RestClientV5 } from 'bybit-api'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'

/** One instrument row as Bybit v5 `instruments-info` returns it. */
const instrument = (
  symbol: string,
  lot: Record<string, string>,
  extra: Record<string, string> = {},
) => ({
  symbol,
  contractType: 'LinearPerpetual',
  status: 'Trading',
  baseCoin: symbol.replace(/USDT$|USD$/, ''),
  quoteCoin: symbol.endsWith('USDT') ? 'USDT' : 'USD',
  priceFilter: { tickSize: '0.0001' },
  leverageFilter: { minLeverage: '1', maxLeverage: '50', leverageStep: '0.01' },
  lotSizeFilter: {
    minOrderQty: '1',
    maxOrderQty: '1000000',
    qtyStep: '1',
    ...lot,
  },
  ...extra,
})

async function read(futures: Futures, list: unknown[]) {
  const proto = RestClientV5.prototype as any
  const original = proto.getInstrumentsInfo
  proto.getInstrumentsInfo = async (params: {
    category: string
    status: string
  }) => ({
    retCode: 0,
    retMsg: 'OK',
    result: {
      category: params.category,
      // only the Trading page carries rows; PreLaunch is empty
      list: params.status === 'Trading' ? list : [],
      nextPageCursor: '',
    },
  })
  try {
    const ex = new BybitExchange(futures, 'k', 's') as any
    ex.checkLimits = async () => undefined
    return await ex.getAllExchangeInfo()
  } finally {
    proto.getInstrumentsInfo = original
  }
}

function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

describe('bybit exchange info — minimum order value (spec 036)', () => {
  describe('linear contracts', () => {
    let res: any
    const pair = (p: string) => res?.data?.find((d: any) => d.pair === p)

    before(async () => {
      res = await read(Futures.usdm, [
        instrument('XRPUSDT', { minNotionalValue: '5', minOrderQty: '0.1' }),
        instrument('BTCUSDT', {
          minNotionalValue: '100',
          minOrderQty: '0.001',
        }),
        instrument('OLDUSDT', {}),
        instrument('BADUSDT', { minNotionalValue: 'n/a' }),
      ])
    })

    expect('status', () => res.status, StatusEnum.ok)
    // §1.1 — the venue minimum, per instrument
    expect(
      'XRPUSDT quote minimum',
      () => pair('XRPUSDT')?.quoteAsset.minAmount,
      5,
    )
    expect(
      'BTCUSDT quote minimum',
      () => pair('BTCUSDT')?.quoteAsset.minAmount,
      100,
    )
    // §1.3 — absent or unparsable: 0, never NaN or an invented default
    expect(
      'missing field reads 0',
      () => pair('OLDUSDT')?.quoteAsset.minAmount,
      0,
    )
    expect(
      'unparsable field reads 0',
      () => pair('BADUSDT')?.quoteAsset.minAmount,
      0,
    )
    // §1.3 — base side unchanged
    expect('base minimum', () => pair('XRPUSDT')?.baseAsset.minAmount, 0.1)
  })

  describe('inverse contracts', () => {
    let res: any

    before(async () => {
      res = await read(Futures.coinm, [
        instrument(
          'BTCUSD',
          { minNotionalValue: '100' },
          { contractType: 'InversePerpetual' },
        ),
      ])
    })

    // §1.3 — the field is the 1-USD contract size for coin-margined consumers
    expect('contract size kept', () => res.data?.[0]?.quoteAsset.minAmount, 1)
  })
})
