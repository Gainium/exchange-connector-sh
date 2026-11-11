process.env.NODE_ENV = 'testing'

/**
 * KuCoin Unified Trading Account (UTA) detection. KuCoin answers a UTA's
 * trading requests only on its UTA V2 endpoints, so a UTA key must fail
 * verification with a reason the user can act on, and an unanswered mode probe
 * must never fail a key that is fine. No network. Run: `npm test` from `core/`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KucoinExchange from './index'
import {
  applyKucoinAccountMode,
  KUCOIN_UTA_UNSUPPORTED_REASON,
} from '../../helpers/verify'

const make = (getAccountMode: () => Promise<unknown>) => {
  const ex: any = new KucoinExchange(Futures.null, 'k', 's', 'p')
  ex.checkLimits = async () => undefined
  ex.client.getAccountMode = getAccountMode
  return ex as KucoinExchange
}

const answer = (selfAccountMode: unknown) => async () => ({
  status: StatusEnum.ok,
  data: { selfAccountMode, unifiedSubAccount: [], classicSubAccount: [] },
  reason: null,
})

describe('kucoin — account mode', () => {
  it('reads UNIFIED and CLASSIC', async () => {
    assert.strictEqual(
      await make(answer('UNIFIED')).getAccountMode(),
      'UNIFIED',
    )
    assert.strictEqual(
      await make(answer('CLASSIC')).getAccountMode(),
      'CLASSIC',
    )
  })

  it('is unknown (null) when KuCoin refuses, throws or answers oddly', async () => {
    const refused = async () => ({
      status: StatusEnum.notok,
      data: null,
      reason: 'Access denied',
    })
    const thrown = async () => {
      throw new Error('fetch failed')
    }
    assert.strictEqual(await make(refused).getAccountMode(), null)
    assert.strictEqual(await make(thrown).getAccountMode(), null)
    assert.strictEqual(
      await make(answer('SOMETHING_NEW')).getAccountMode(),
      null,
    )
  })
})

describe('kucoin — verification and account mode', () => {
  const ok = { status: true, reason: '{"status":"OK"}' }
  const bad = { status: false, reason: '{"status":"NOTOK"}' }

  it('a UNIFIED account fails with the UTA reason, even if the balance read worked', () => {
    for (const result of [ok, bad]) {
      const out = applyKucoinAccountMode(result, 'UNIFIED')
      assert.strictEqual(out.status, false)
      assert.strictEqual(out.reason, KUCOIN_UTA_UNSUPPORTED_REASON)
    }
  })

  it('keeps the permissions read alongside', () => {
    const permissions = { known: false, reason: 'x' } as any
    const out = applyKucoinAccountMode({ ...ok, permissions }, 'UNIFIED')
    assert.strictEqual(out.permissions, permissions)
  })

  it('CLASSIC and unknown leave the verdict untouched', () => {
    assert.deepStrictEqual(applyKucoinAccountMode(ok, 'CLASSIC'), ok)
    assert.deepStrictEqual(applyKucoinAccountMode(ok, null), ok)
    assert.deepStrictEqual(applyKucoinAccountMode(bad, null), bad)
  })

  it('the reason is prose, so main-app shows it as written', () => {
    assert.ok(!/[{}]/.test(KUCOIN_UTA_UNSUPPORTED_REASON))
  })
})
