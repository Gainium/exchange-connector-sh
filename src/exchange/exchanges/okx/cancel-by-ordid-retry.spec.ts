process.env.NODE_ENV = 'testing'

/**
 * A retried cancel-by-ordId must retry the SAME call. It used to retry through
 * the clOrdId cancel with no clOrdId, so OKX answered "Either client order ID
 * or order ID is required" and the order stayed live. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import OKXExchange from './index'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

describe('okx — cancel by ordId', () => {
  it('retries a transient failure with the ordId', async () => {
    const ex: any = new OKXExchange(Futures.null, 'k', 's', 'p')
    ex.checkLimits = async () => undefined
    ex.convertOrder = async (o: any) => ({
      orderId: o.ordId,
      status: 'CANCELED',
    })
    const calls: any[] = []
    ex.client.cancelOrder = async (req: any) => {
      calls.push(req)
      if (calls.length === 1) throw { code: '50013', msg: 'System busy' }
      if (!req.ordId && !req.clOrdId) {
        return [
          {
            sCode: '51000',
            sMsg: 'Either client order ID or order ID is required.',
          },
        ]
      }
      return [{ sCode: '0', ordId: req.ordId, clOrdId: 'X' }]
    }
    ex.client.getOrderDetails = async () => [
      { ordId: '3987477325056806913', state: 'canceled' },
    ]
    const res = await ex.cancelOrderByOrderIdAndSymbol({
      symbol: 'BTC-USDC',
      orderId: '3987477325056806913',
    })
    eq('status', res.status, 'OK')
    eq('calls', calls.length, 2)
    eq('retry ordId', calls[1].ordId, '3987477325056806913')
  })
})
