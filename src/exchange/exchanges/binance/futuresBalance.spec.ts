process.env.NODE_ENV = 'testing'

/**
 * Spec 035: a Binance USDⓈ-M Multi-Assets account's negative BNFCR wallet
 * balance survives the futures balance read instead of becoming 0.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import { ExchangeDomain, Futures, StatusEnum } from '../../types'
import BinanceExchange from './index'
import { futuresAssetBalance } from './futuresBalance'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const assets = [
  { asset: 'USDC', walletBalance: '22624.97', maxWithdrawAmount: '7397.06' },
  { asset: 'BNB', walletBalance: '0.69164081', maxWithdrawAmount: '0.5' },
  { asset: 'BNFCR', walletBalance: '-4250.82', maxWithdrawAmount: '0' },
  { asset: 'USDT', walletBalance: '0', maxWithdrawAmount: '0' },
]

describe('spec 035 — Binance futures balance keeps a negative BNFCR', () => {
  it('§1.1 a negative BNFCR is reported as free, locked 0', () => {
    const r = futuresAssetBalance(assets[2])
    eq('free', r.free, -4250.82)
    eq('locked', r.locked, 0)
  })

  it('§1.3 every other row maps as before', () => {
    const usdc = futuresAssetBalance(assets[0])
    eq('usdc free', usdc.free, 7397.06)
    eq('usdc locked', usdc.locked, 22624.97 - 7397.06)
    const bnb = futuresAssetBalance(assets[1])
    eq('bnb free', bnb.free, 0.5)
    eq('bnb locked', bnb.locked, 0.69164081 - 0.5)
    const usdt = futuresAssetBalance(assets[3])
    eq('usdt free', usdt.free, 0)
    eq('usdt locked', usdt.locked, 0)
    const zero = futuresAssetBalance({
      asset: 'BNFCR',
      walletBalance: '0',
      maxWithdrawAmount: '0',
    })
    eq('bnfcr 0 free', zero.free, 0)
    eq('bnfcr 0 locked', zero.locked, 0)
    const pos = futuresAssetBalance({
      asset: 'BNFCR',
      walletBalance: '120.5',
      maxWithdrawAmount: '100',
    })
    eq('bnfcr + free', pos.free, 100)
    eq('bnfcr + locked', pos.locked, 20.5)
  })

  it('§1.3 a negative wallet balance on another asset is unchanged', () => {
    const r = futuresAssetBalance({
      asset: 'USDT',
      walletBalance: '-10',
      maxWithdrawAmount: '0',
    })
    eq('free', r.free, 0)
    eq('locked', r.locked, 0)
  })

  it('§1.1 futures_getBalance returns the BNFCR debt', async () => {
    const ex = new BinanceExchange(
      ExchangeDomain.com,
      Futures.usdm,
      'key',
      's',
    ) as any
    ex.checkLimits = async () => undefined
    ex.usdmClient = {
      getAccountInformation: async () => ({ multiAssetsMargin: true, assets }),
    }
    const res = await ex.futures_getBalance()
    eq('status', res.status, StatusEnum.ok)
    const rows = res.data as { asset: string; free: number; locked: number }[]
    const bnfcr = rows.find((r) => r.asset === 'BNFCR')
    eq('bnfcr free', bnfcr?.free, -4250.82)
    eq('bnfcr locked', bnfcr?.locked, 0)
    const usdc = rows.find((r) => r.asset === 'USDC')
    eq('usdc free', usdc?.free, 7397.06)
  })
})
