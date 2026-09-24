process.env.NODE_ENV = 'testing'

/**
 * OKX asset classes from OKX's own `instCategory` (1 crypto, 3 equities incl.
 * equity ETFs, 4 commodities) — present on SPOT, SWAP and the OKX Europe
 * X-Perps. Before this the connector emitted no `assetClass`, so every OKX row
 * defaulted to crypto and the pair picker had no class filters on OKX.
 *
 * Contributed by a community member as patch 06 of the X-Perp work; ported to
 * mocha. Run: `npm test`. No network — drives the real mapper with synthetic
 * rows.
 */
import { describe, it } from 'mocha'
import { Futures, OKXSource } from '../../types'
import OKXExchange, { okxAssetClass } from './index'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

/** Minimal X-Perp instrument row: only the fields the mapper reads. */
const row = (over: Record<string, unknown>) => ({
  state: 'live',
  ctType: 'linear',
  ruleType: 'xperp',
  instId: 'X-USD_UM_XPERP-310613',
  instFamily: 'X-USD_UM_XPERP',
  baseCcy: 'X',
  quoteCcy: '',
  settleCcy: 'USD',
  ctValCcy: 'X',
  ctVal: '1',
  minSz: '0.01',
  lotSz: '0.01',
  maxLmtSz: '100000000',
  maxMktSz: '500',
  tickSz: '0.01',
  lever: '20',
  ...over,
})

const mapped = (futures: Futures, rows: Record<string, unknown>[]) => {
  const ex: any = new OKXExchange(
    futures,
    '',
    '',
    '',
    undefined,
    undefined,
    OKXSource.my,
  )
  return ex.mapInstrumentsToInfo(
    rows,
    futures === Futures.null ? null : 'linear',
  )
}

describe('okx — asset class from instCategory', () => {
  it('maps the values OKX emits and guesses nothing else', () => {
    eq('1', okxAssetClass('1'), undefined)
    eq('3', okxAssetClass('3'), 'stock')
    eq('4', okxAssetClass('4'), 'commodity')
    eq('unknown', okxAssetClass('7'), undefined)
    eq('absent', okxAssetClass(undefined), undefined)
  })

  it('X-Perp rows carry the class', () => {
    const [crypto, equity, commodity, absent] = mapped(Futures.usdm, [
      row({ instCategory: '1', ctValCcy: 'BTC' }),
      row({ instCategory: '3', ctValCcy: 'AAPL' }),
      row({ instCategory: '4', ctValCcy: 'XAU' }),
      row({ ctValCcy: 'ETH' }),
    ]).map((i: { assetClass?: string }) => i.assetClass)
    eq('crypto', crypto, undefined)
    eq('equity', equity, 'stock')
    eq('commodity', commodity, 'commodity')
    eq('absent', absent, undefined)
  })

  it('spot rows carry the class', () => {
    const [spot] = mapped(Futures.null, [
      row({
        instCategory: '3',
        instId: 'AAPL-USDC',
        baseCcy: 'AAPL',
        quoteCcy: 'USDC',
      }),
    ])
    eq('spot equity', spot.assetClass, 'stock')
  })

  it('leaves pair, base and quote mapping untouched', () => {
    const [info] = mapped(Futures.usdm, [
      row({
        instCategory: '3',
        ctValCcy: 'AAPL',
        instFamily: 'AAPL-USD_UM_XPERP',
      }),
    ])
    eq('pair', info.pair, 'AAPL-USD_UM_XPERP')
    eq('base', info.baseAsset.name, 'AAPL')
    eq('quote', info.quoteAsset.name, 'USDC')
  })
})
