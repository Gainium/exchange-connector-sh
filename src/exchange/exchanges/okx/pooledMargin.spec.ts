process.env.NODE_ENV = 'testing'

/**
 * OKX pooled collateral: a Multi-currency / Portfolio margin account backs
 * every cross position with every coin, so an EUR-only OKX Europe account can
 * trade USDC-quoted X-Perps. The connector reports that pool in USD so
 * main-app's balance check stops reading "0 USDC".
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import { Futures, OKXSource, StatusEnum } from '../../types'
import OKXExchange from './index'
import { okxCollateralIsPooled, pooledMarginFromOkx } from './pooledMargin'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const balance = { adjEq: '1150.5', imr: '150.5', details: [] }

function stub(
  futures: Futures,
  acctLv: string | undefined,
  getBalance: () => Promise<unknown>,
) {
  const ex = new OKXExchange(
    futures,
    'key',
    's',
    'p',
    undefined,
    undefined,
    OKXSource.my,
  ) as any
  ex.checkLimits = async () => undefined
  ex.getAcctLv = async () => acctLv
  ex.client = { getBalance }
  return ex
}

describe('okx — pooled collateral', () => {
  it('multi-currency (3) and portfolio (4) margin are pooled', () => {
    eq('3', okxCollateralIsPooled('3'), true)
    eq('4', okxCollateralIsPooled('4'), true)
    eq('1', okxCollateralIsPooled('1'), false)
    eq('2', okxCollateralIsPooled('2'), false)
    eq('unknown', okxCollateralIsPooled(undefined), false)
  })

  it('the pool is adjEq minus initial margin in use', () => {
    eq('pool', pooledMarginFromOkx('3', balance), 1000)
  })

  it('never reports a negative pool', () => {
    eq('floor', pooledMarginFromOkx('3', { adjEq: '10', imr: '25' }), 0)
  })

  it('a missing imr counts as nothing held', () => {
    eq('no imr', pooledMarginFromOkx('4', { adjEq: '42' }), 42)
  })

  it('an answer without adjEq is no answer', () => {
    eq('empty adjEq', pooledMarginFromOkx('3', { adjEq: '', imr: '0' }), null)
    eq('no balance', pooledMarginFromOkx('3', undefined), null)
  })

  it('a non-pooled mode answers null', () => {
    eq('single-currency', pooledMarginFromOkx('2', balance), null)
  })

  it('a pooled futures connection reports the pool', async () => {
    const ex = stub(Futures.usdm, '3', async () => [balance])
    const res = await ex.getMarginAvailableUsd()
    eq('status', res.status, StatusEnum.ok)
    eq('data', res.data, 1000)
  })

  it('a single-currency account never reads its balance', async () => {
    let reads = 0
    const ex = stub(Futures.usdm, '2', async () => {
      reads++
      return [balance]
    })
    const res = await ex.getMarginAvailableUsd()
    eq('data', res.data, null)
    eq('reads', reads, 0)
  })

  it('a spot connection answers null without asking the venue', async () => {
    let reads = 0
    const ex = stub(Futures.null, '3', async () => {
      reads++
      return [balance]
    })
    const res = await ex.getMarginAvailableUsd()
    eq('data', res.data, null)
    eq('reads', reads, 0)
  })

  it('an unreadable account mode answers null', async () => {
    const ex = stub(Futures.usdm, undefined, async () => [balance])
    const res = await ex.getMarginAvailableUsd()
    eq('data', res.data, null)
  })
})
