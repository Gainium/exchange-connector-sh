process.env.NODE_ENV = 'testing'

/**
 * Spec 042 — a Hyperliquid MARKET order that does not fill at once is read
 * back as a LIMIT order at the un-padded request price.
 *
 * Hyperliquid has no market order type: `openOrder` sends a MARKET as a GTC
 * limit padded 10% through the book. When the place response is `resting`
 * instead of `filled`, the read-back reported the order as `type: 'LIMIT'`
 * (HL `orderType: 'Limit'`) at the price we were ASKED for, not the padded one
 * resting on the venue. main-app sees a LIMIT reply at exactly the requested
 * price, nothing executed, and books the market entry as a limit one.
 *
 * Asserted here, through the real `openOrder` with fake venue clients:
 *   - §4.1 requested MARKET, place response `resting`, still open on read-back
 *     → type MARKET, price = the padded price resting on the venue
 *   - §4.2 requested MARKET, place response `filled` → type MARKET, price =
 *     the fill price (unchanged)
 *   - §4.3 requested LIMIT, `resting` → type LIMIT at the requested price
 *     (unchanged, and the price sent is unpadded)
 *   - §4.4 the price SENT is unchanged: MARKET SELL padded to price * 0.9,
 *     MARKET BUY to price * 1.1
 *
 * Run: `npm test` (mocha). No network: exchange + info clients are fakes.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'

const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'
const CLOID = '0x7c3c97193a93dfe041643191f9b9e6a5'

async function place(
  req: { side: 'BUY' | 'SELL'; type: 'LIMIT' | 'MARKET'; price: number },
  placeStatus: 'resting' | 'filled',
) {
  const ex = new HyperliquidExchange(
    Futures.null,
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
  const sent: { p?: string } = {}
  anyEx.getCoinByPair = async () => '10123'
  anyEx.getPairByCoin = async () => 'UANSEM-USDC'
  anyEx.checkLimits = async () => undefined
  anyEx.updateMaxFiguresInPrice = (p: string) => p
  anyEx.exchangeClient = {
    order: async (input: any) => {
      sent.p = input.orders[0].p
      return {
        response: {
          data: {
            statuses: [
              placeStatus === 'resting'
                ? { resting: { oid: 1, cloid: CLOID } }
                : {
                    filled: {
                      oid: 1,
                      cloid: CLOID,
                      totalSz: '1000',
                      avgPx: '0.05061',
                    },
                  },
            ],
          },
        },
      }
    },
  }
  anyEx.infoClient = {
    orderStatus: async () => ({
      status: 'order',
      order: {
        order: {
          coin: '@123',
          side: req.side === 'SELL' ? 'A' : 'B',
          // HL holds whatever we sent, as a Limit.
          limitPx: sent.p,
          sz: placeStatus === 'resting' ? '1000' : '0',
          oid: 1,
          timestamp: 1793000000000,
          origSz: '1000',
          cloid: CLOID,
          orderType: 'Limit',
        },
        status: placeStatus === 'resting' ? 'open' : 'filled',
        statusTimestamp: 1793000000100,
      },
    }),
    userFillsByTime: async () => [
      {
        oid: 1,
        tid: 1,
        time: 1793000000050,
        sz: '1000',
        px: '0.05061',
        fee: '0.01',
        feeToken: 'USDC',
      },
    ],
  }
  const r = await ex.openOrder({
    symbol: 'UANSEM-USDC',
    side: req.side,
    quantity: 1000,
    price: req.price,
    newClientOrderId: undefined,
    type: req.type,
  })
  if (r.status !== 'OK') {
    throw new Error(`openOrder failed: ${JSON.stringify(r)}`)
  }
  // newClientOrderId is unset above only to skip the pre-flight duplicate
  // lookup; the read-back is keyed on it, so the fake ignores the key.
  return { order: r.data, sent: sent.p }
}

function check(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

describe('hyperliquid openOrder MARKET that rests (spec 042)', () => {
  it('§4.1 MARKET SELL resting → MARKET at the padded price HL holds', async () => {
    const { order, sent } = await place(
      { side: 'SELL', type: 'MARKET', price: 0.050678 },
      'resting',
    )
    check('sent padded', sent, '0.045610')
    check('type', order.type, 'MARKET')
    check('price', +order.price, 0.04561)
    check('status', order.status, 'NEW')
    check('executedQty', +order.executedQty, 0)
  })

  it('§4.1 MARKET BUY resting → MARKET at the padded price HL holds', async () => {
    const { order, sent } = await place(
      { side: 'BUY', type: 'MARKET', price: 0.050678 },
      'resting',
    )
    check('sent padded', sent, '0.055746')
    check('type', order.type, 'MARKET')
    check('price', +order.price, 0.055746)
  })

  it('§4.2 MARKET filled at once → MARKET at the fill price', async () => {
    const { order } = await place(
      { side: 'SELL', type: 'MARKET', price: 0.050678 },
      'filled',
    )
    check('type', order.type, 'MARKET')
    check('price', +order.price, 0.05061)
    check('status', order.status, 'FILLED')
  })

  it('§4.3 LIMIT resting → LIMIT at the requested price, sent unpadded', async () => {
    const { order, sent } = await place(
      { side: 'SELL', type: 'LIMIT', price: 0.050678 },
      'resting',
    )
    check('sent unpadded', sent, '0.050678')
    check('type', order.type, 'LIMIT')
    check('price', +order.price, 0.050678)
  })
})
