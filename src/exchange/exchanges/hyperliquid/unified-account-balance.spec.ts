process.env.NODE_ENV = 'testing'

/**
 * Hyperliquid unified-account / portfolio-margin wallets keep all collateral
 * in the SPOT clearinghouse; their per-dex perps `clearinghouseState` reads
 * accountValue=0 / withdrawable=0. The perps balance was built only from the
 * latter, so a unified wallet with funds showed an empty futures account and
 * bots could not start. Unified wallets now take the perps balance from the
 * spot state, restricted to perps collateral assets.
 */
import { describe, it } from 'mocha'
import { strict as assert } from 'assert'
import { hlUnifiedPerpBalance, HL_SPOT_COLLATERAL_MODES } from './index'

const alias = (c: string) => (c === 'USDT0' ? 'USDT' : c === 'UBTC' ? 'BTC' : c)

describe('Hyperliquid unified account perps balance', () => {
  it('maps collateral spot balances to free/locked, skips non-collateral', () => {
    const res = hlUnifiedPerpBalance(
      [
        { coin: 'USDC', total: '10163.29634', hold: '10.032' },
        { coin: 'USDT0', total: '5', hold: '0' },
        { coin: 'UBTC', total: '0.5', hold: '0' },
      ],
      new Set(['USDC', 'USDT']),
      alias,
    )
    assert.deepEqual(res, [
      { asset: 'USDC', free: 10163.29634 - 10.032, locked: 10.032 },
      { asset: 'USDT', free: 5, locked: 0 },
    ])
  })

  it('clamps a negative hold and never reports negative free', () => {
    const res = hlUnifiedPerpBalance(
      [
        { coin: 'USDC', total: '100', hold: '-50' },
        { coin: 'USDE', total: '1', hold: '3' },
      ],
      new Set(['USDC', 'USDE']),
      alias,
    )
    assert.deepEqual(res, [
      { asset: 'USDC', free: 100, locked: 0 },
      { asset: 'USDE', free: 0, locked: 3 },
    ])
  })

  it('treats only unified and portfolio margin as spot-collateral modes', () => {
    assert.ok(HL_SPOT_COLLATERAL_MODES.has('unifiedAccount'))
    assert.ok(HL_SPOT_COLLATERAL_MODES.has('portfolioMargin'))
    assert.ok(!HL_SPOT_COLLATERAL_MODES.has('default'))
    assert.ok(!HL_SPOT_COLLATERAL_MODES.has('dexAbstraction'))
  })
})
