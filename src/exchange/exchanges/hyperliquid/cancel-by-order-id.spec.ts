process.env.NODE_ENV = 'testing'

/**
 * Spec 043 — cancelling a Hyperliquid order by its venue order id fails with
 * "422 Failed to deserialize".
 *
 * `cancelOrderByOrderIdAndSymbol` (DELETE /orders/byid — the terminal's
 * "cancel exchange order" and the import flow) received the venue `oid` this
 * connector reports as `orderId`, and sent it to Hyperliquid as the CLOID of a
 * cancelByCloid. A cloid must be 0x + 32 hex, so the venue rejected the body.
 *
 * Asserted here, through the real class with fake venue clients:
 *   - §4.1 numeric venue oid → `cancel({a, o: <number>})`, never cancelByCloid;
 *     the read-back queries orderStatus with the oid as a NUMBER
 *   - §4.2 cloid-shaped id → cancelByCloid (callers sending the client id keep working)
 *   - §4.3 `cancelOrder` (the bots' path) is unchanged → cancelByCloid
 *   - §4.4 an id that is neither → NOTOK, nothing sent to the venue
 *   - §4.5 getOrder with a cloid → orderStatus receives the cloid unchanged
 *
 * Run: `npm test` (mocha). No network.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'

const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'
const OID = 590895215023
const CLOID = '0xaa5c2d081b93ae696065d4ae584827db'
const ASSET = 5

function make() {
  const ex = new HyperliquidExchange(
    Futures.usdm,
    '0x14791697260e4c9a71f18484c9f997b308e59325',
    PRIVATE_KEY,
    '',
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  )
  const calls = {
    cancel: [] as unknown[],
    cancelByCloid: [] as unknown[],
    orderStatus: [] as unknown[],
  }
  const ok = { response: { data: { statuses: ['success'] } } }
  const anyEx = ex as any
  anyEx.getPairByCoin = async () => 'TAO-USDC'
  anyEx.getCoinByPair = async () => `${ASSET}`
  anyEx.checkLimits = async () => undefined
  anyEx.exchangeClient = {
    cancel: async (p: unknown) => (calls.cancel.push(p), ok),
    cancelByCloid: async (p: unknown) => (calls.cancelByCloid.push(p), ok),
  }
  anyEx.infoClient = {
    orderStatus: async (q: { oid: unknown }) => {
      calls.orderStatus.push(q.oid)
      return {
        status: 'order',
        order: {
          order: {
            coin: 'TAO',
            side: 'A',
            limitPx: '249.59',
            sz: '0.044',
            oid: OID,
            timestamp: 1793373386008,
            origSz: '0.044',
            reduceOnly: false,
            cloid: CLOID,
            orderType: 'Limit',
          },
          status: 'canceled',
          statusTimestamp: 1793373387547,
        },
      }
    },
    userFillsByTime: async () => [],
  }
  return { ex, calls }
}

function check(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

describe('hyperliquid cancel by venue order id (spec 043)', () => {
  it('§4.1 numeric oid → cancel by oid, read back by numeric oid', async () => {
    const { ex, calls } = make()
    const r = await ex.cancelOrderByOrderIdAndSymbol({
      symbol: 'TAO-USDC',
      orderId: `${OID}`,
    })
    check('status', r.status, 'OK')
    check('cancel', calls.cancel, [{ cancels: [{ a: ASSET, o: OID }] }])
    check('no cancelByCloid', calls.cancelByCloid, [])
    check('orderStatus oid', calls.orderStatus, [OID])
    check('order status', r.data?.status, 'CANCELED')
    check('orderId', `${r.data?.orderId}`, `${OID}`)
  })

  it('§4.2 cloid-shaped id → cancelByCloid', async () => {
    const { ex, calls } = make()
    const r = await ex.cancelOrderByOrderIdAndSymbol({
      symbol: 'TAO-USDC',
      orderId: CLOID,
    })
    check('status', r.status, 'OK')
    check('cancelByCloid', calls.cancelByCloid, [
      { cancels: [{ asset: ASSET, cloid: CLOID }] },
    ])
    check('no cancel', calls.cancel, [])
  })

  it('§4.3 cancelOrder (bot path) unchanged → cancelByCloid', async () => {
    const { ex, calls } = make()
    const r = await ex.cancelOrder({
      symbol: 'TAO-USDC',
      newClientOrderId: CLOID,
    })
    check('status', r.status, 'OK')
    check('cancelByCloid', calls.cancelByCloid, [
      { cancels: [{ asset: ASSET, cloid: CLOID }] },
    ])
    check('no cancel', calls.cancel, [])
    check('orderStatus oid', calls.orderStatus, [CLOID])
  })

  it('§4.4 an id that is neither → NOTOK, nothing sent', async () => {
    const { ex, calls } = make()
    const r = await ex.cancelOrderByOrderIdAndSymbol({
      symbol: 'TAO-USDC',
      orderId: 'not-an-id',
    })
    check('status', r.status, 'NOTOK')
    check('no cancel', calls.cancel, [])
    check('no cancelByCloid', calls.cancelByCloid, [])
  })

  it('§4.5 getOrder with a cloid → orderStatus gets the cloid', async () => {
    const { ex, calls } = make()
    await ex.getOrder({ symbol: 'TAO-USDC', newClientOrderId: CLOID })
    check('orderStatus oid', calls.orderStatus, [CLOID])
  })
})
