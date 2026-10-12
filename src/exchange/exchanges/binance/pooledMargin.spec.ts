process.env.NODE_ENV = 'testing'

/**
 * Binance pooled collateral: a USDⓈ-M account in Multi-Assets mode backs every
 * contract with every collateral coin, so an EEA Credits-mode account holding
 * only USDC trades USDT-quoted perpetuals. The connector reports that pool in
 * USD so main-app's balance check stops reading the BNFCR row (its settled
 * PnL) as the account's funds.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import { ExchangeDomain, Futures, StatusEnum } from '../../types'
import BinanceExchange from './index'
import { pooledMarginFromBinance } from './pooledMargin'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const multiAssets = {
  multiAssetsMargin: true,
  availableBalance: '7397.06741724',
  assets: [
    { asset: 'USDC', walletBalance: '22624.97', maxWithdrawAmount: '7397.06' },
    { asset: 'BNFCR', walletBalance: '-3715.49', maxWithdrawAmount: '0' },
  ],
}

function stub(futures: Futures, getAccountInformation: () => Promise<unknown>) {
  const ex = new BinanceExchange(ExchangeDomain.com, futures, 'key', 's') as any
  ex.checkLimits = async () => undefined
  ex.usdmClient = { getAccountInformation }
  return ex
}

describe('binance — pooled collateral', () => {
  it('multi-assets mode reports the account-level availableBalance', () => {
    eq('pool', pooledMarginFromBinance(multiAssets), 7397.06741724)
  })

  it('single-asset mode answers null', () => {
    eq(
      'single',
      pooledMarginFromBinance({ ...multiAssets, multiAssetsMargin: false }),
      null,
    )
  })

  it('never reports a negative pool', () => {
    eq(
      'floor',
      pooledMarginFromBinance({
        multiAssetsMargin: true,
        availableBalance: '-5',
      }),
      0,
    )
  })

  it('an answer without availableBalance is no answer', () => {
    eq('empty', pooledMarginFromBinance({ multiAssetsMargin: true }), null)
    eq('none', pooledMarginFromBinance(undefined), null)
  })

  it('a multi-assets USDⓈ-M connection reports the pool', async () => {
    const ex = stub(Futures.usdm, async () => multiAssets)
    const res = await ex.getMarginAvailableUsd()
    eq('status', res.status, StatusEnum.ok)
    eq('data', res.data, 7397.06741724)
  })

  it('COIN-M and spot answer null without asking the venue', async () => {
    for (const futures of [Futures.coinm, Futures.null]) {
      let reads = 0
      const ex = stub(futures, async () => {
        reads++
        return multiAssets
      })
      const res = await ex.getMarginAvailableUsd()
      eq(`${futures} data`, res.data, null)
      eq(`${futures} reads`, reads, 0)
    }
  })
})
