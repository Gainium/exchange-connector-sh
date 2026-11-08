process.env.NODE_ENV = 'testing'

/**
 * A Kraken spot key that can place orders but cannot read or cancel them must
 * be caught at verify time.
 *
 * Such a key passed every verify probe (Balance, WebSocket token). A grid bot
 * on it then could not read its own orders, and when the user closed it every
 * cancel was refused with `EGeneral:Permission denied`: the orders kept
 * resting on the exchange, holding the account's funds.
 *
 * Drives the real `verifyOrderPermissions` over a fake spot client. No network.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { strict as assert } from 'assert'
import { Futures } from '../../types'
import KrakenExchange from './index'

const DENIED = 'EGeneral:Permission denied'

/** A spot client whose two probes answer as given; records what was asked. */
const build = (open: () => Promise<unknown>, cancel: () => Promise<unknown>) => {
  const asked: any[] = []
  const ex: any = new KrakenExchange(Futures.null, 'k', 's')
  ex.spotClient = {
    getOpenOrders: async (p?: unknown) => {
      asked.push(['getOpenOrders', p])
      return open()
    },
    cancelOrder: async (p: unknown) => {
      asked.push(['cancelOrder', p])
      return cancel()
    },
  }
  return { ex, asked }
}

const ok = async () => ({ error: [], result: { open: {} } })
const rejects = (msg: string) => async () => {
  const e: any = new Error(msg)
  e.body = { error: [msg] }
  throw e
}
const answers = (msg: string) => async () => ({ error: [msg] })

describe('kraken verifyOrderPermissions', () => {
  it('a key with both permissions passes; the cancel probe aims at an id no order can carry', async () => {
    const { ex, asked } = build(ok, answers('EOrder:Unknown order'))
    const r = await ex.verifyOrderPermissions()
    assert.equal(r.ok, true)
    const cancel = asked.find((a) => a[0] === 'cancelOrder')[1]
    assert.equal(cancel.txid, undefined, 'never addresses a txid or userref')
    assert.match(
      cancel.cl_ord_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('a key that cannot query orders is refused (thrown error shape)', async () => {
    const { ex, asked } = build(rejects(DENIED), ok)
    const r = await ex.verifyOrderPermissions()
    assert.equal(r.ok, false)
    assert.equal(r.missing, 'query')
    assert.equal(asked.length, 1, 'no cancel probe once the read is refused')
  })

  it('a key that cannot cancel is refused (error array shape)', async () => {
    const { ex } = build(ok, answers(DENIED))
    const r = await ex.verifyOrderPermissions()
    assert.equal(r.ok, false)
    assert.equal(r.missing, 'cancel')
  })

  it('transient or unexpected answers never block verification', async () => {
    for (const msg of [
      'EAPI:Rate limit exceeded',
      'EService:Unavailable',
      'EGeneral:Invalid arguments',
    ]) {
      const { ex } = build(rejects(msg), rejects(msg))
      assert.equal((await ex.verifyOrderPermissions()).ok, true, msg)
    }
  })

  it('a futures key is not probed', async () => {
    const ex: any = new KrakenExchange(Futures.usdm, 'k', 's')
    assert.equal(ex.spotClient, undefined)
    assert.equal((await ex.verifyOrderPermissions()).ok, true)
  })
})
