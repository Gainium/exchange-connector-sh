process.env.NODE_ENV = 'testing'

/**
 * Spec 041 — a Hyperliquid cancel whose size shrank without a fill is read
 * back by `getOrder` as partly executed.
 *
 * Hyperliquid can lower `sz` on a resting order without trading (seen on
 * reduce-only orders: `reduceOnlyCanceled`, `sz 0.041` of `origSz 0.044`, no
 * fill for the oid). `getOrder` already reads the order's fills from
 * `userFillsByTime`, but took the executed size from `origSz - sz` regardless,
 * so the cancel came back as 0.003 executed and was booked that way.
 *
 * Asserted here, through the real `getOrder` with a fake info client:
 *   - §4.1 shrunk cancel, fill history read to the end, no fill for the oid →
 *     executedQty 0, quote 0, no fee
 *   - §4.2 shrunk cancel, history holds fewer fills than origSz - sz →
 *     executedQty, quote and fee from those fills
 *   - §4.3 canceled partial whose fills cover origSz - sz → unchanged
 *   - §4.4 history not read to the end (page cap) or the lookup threw →
 *     unchanged origSz - sz (an unread history is not evidence of no fill)
 *   - §4.5 filled order → unchanged
 *
 * Run: `npm test` (mocha). No network: the info client is a fake.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'
import { HL_FILLS_PAGE_LIMIT } from './orderFills'

const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'

// The production frame the +24h check sampled (TAO perp, reduce-only SELL).
const OID = 590804674323
const CLOID = '0xaa5c2d081b93ae696065d4ae584827db'
const PLACED = 1793373386008
const CANCELED_AT = 1793373387547

function order(status: string, sz: string, origSz = '0.044') {
  return {
    status: 'order',
    order: {
      order: {
        coin: 'TAO',
        side: 'A',
        limitPx: '249.59',
        sz,
        oid: OID,
        timestamp: PLACED,
        origSz,
        reduceOnly: true,
        cloid: CLOID,
        orderType: 'Limit',
      },
      status,
      statusTimestamp: CANCELED_AT,
    },
  }
}

function fill(tid: number, sz: string, oid = OID) {
  return {
    oid,
    tid,
    time: PLACED + 100,
    sz,
    px: '249.6',
    fee: '0.002',
    feeToken: 'USDC',
  }
}

async function getOrder(
  orderStatus: unknown,
  fillsByTime: () => Promise<unknown[]>,
) {
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
  const anyEx = ex as any
  anyEx.getPairByCoin = async () => 'TAO-USDC'
  anyEx.checkLimits = async () => undefined
  anyEx.infoClient = {
    orderStatus: async () => orderStatus,
    userFillsByTime: fillsByTime,
  }
  const r = await ex.getOrder({ symbol: 'TAO-USDC', newClientOrderId: CLOID })
  if (r.status !== 'OK') {
    throw new Error(`getOrder failed: ${JSON.stringify(r)}`)
  }
  return r.data
}

function check(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

describe('hyperliquid getOrder shrunk cancel (spec 041)', () => {
  it('§4.1 reduceOnlyCanceled, shrunk, no fill in history → 0 executed', async () => {
    const o = await getOrder(order('reduceOnlyCanceled', '0.041'), async () => [
      fill(1, '1', 7),
    ])
    check('status', o.status, 'CANCELED')
    check('executedQty', +o.executedQty, 0)
    check('quote', +o.cummulativeQuoteQty, 0)
    check('no fee', o.feePaid, undefined)
  })

  it('§4.1 canceled, shrunk, empty history → 0 executed', async () => {
    const o = await getOrder(order('canceled', '0.97', '1.02'), async () => [])
    check('executedQty', +o.executedQty, 0)
    check('quote', +o.cummulativeQuoteQty, 0)
  })

  it('§4.2 history holds fewer fills than origSz - sz → the fills', async () => {
    const o = await getOrder(order('reduceOnlyCanceled', '0.041'), async () => [
      fill(1, '0.001'),
    ])
    check('executedQty', +o.executedQty, 0.001)
    check(
      'quote',
      +(+o.cummulativeQuoteQty).toFixed(6),
      +(0.001 * 249.6).toFixed(6),
    )
    check('fee from the fill', +o.feePaid, 0.002)
  })

  it('§4.3 canceled partial covered by its fills → unchanged', async () => {
    const o = await getOrder(order('canceled', '0.041'), async () => [
      fill(1, '0.001'),
      fill(2, '0.002'),
    ])
    check('executedQty', +(+o.executedQty).toFixed(9), 0.003)
    check('fee', +(+o.feePaid).toFixed(9), 0.004)
  })

  it('§4.4 history not read to the end → origSz - sz kept', async () => {
    const page = Array.from({ length: HL_FILLS_PAGE_LIMIT }, (_, i) => ({
      ...fill(1000 + i, '1', 7),
      time: PLACED + 100,
    }))
    const o = await getOrder(
      order('reduceOnlyCanceled', '0.041'),
      async () => page,
    )
    check('executedQty', +(+o.executedQty).toFixed(9), 0.003)
  })

  it('§4.4 history lookup threw → origSz - sz kept', async () => {
    const o = await getOrder(order('reduceOnlyCanceled', '0.041'), async () => {
      throw new Error('429')
    })
    check('executedQty', +(+o.executedQty).toFixed(9), 0.003)
  })

  it('§4.5 filled → unchanged', async () => {
    const o = await getOrder(order('filled', '0'), async () => [
      fill(1, '0.044'),
    ])
    check('status', o.status, 'FILLED')
    check('executedQty', +o.executedQty, 0.044)
  })
})
