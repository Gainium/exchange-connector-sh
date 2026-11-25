process.env.NODE_ENV = 'testing'

/**
 * Spec `053.futures-order-aged-out-of-history-reads-account-fills`.
 *
 * Kraken Futures `getOrder` for an order the live status view no longer
 * holds falls back to the order-events page. That page is only Kraken's most
 * recent slice, so a sell that filled while the user stream was down aged out
 * of it and the lookup answered "Order not found in history" — which main-app
 * reads as definitive and writes the order off as CANCELED with 0 executed.
 * 2026-10-30, Kraken Futures combo grid: resting sells that filled
 * on the venue, each stored CANCELED/0.
 *
 * Run: `npm test` (mocha). No network: the Kraken client is stubbed.
 */
import { describe, it } from 'mocha'
import assert from 'assert'
import { Futures } from '../../types'
import KrakenExchange from './index'

const CLI = 'CMB-GR-Jhep2E1vPStRJ1nRu6gY6XNlNSH5'
const UID = 'a319db7a-0000-4000-8000-000000000001'

const fill = (over: Record<string, unknown> = {}) => ({
  fill_id: `f-${Math.random()}`,
  symbol: 'PF_ONDOUSD',
  side: 'sell',
  order_id: UID,
  cliOrdId: CLI,
  size: 13,
  price: 0.6871,
  fillTime: '2026-10-30T04:47:12.000Z',
  fillType: 'maker',
  ...over,
})

function makeExchange(opts: {
  fills?: unknown[]
  fillsResult?: 'success' | 'error'
  statusResult?: 'success' | 'error'
  events?: unknown[]
}) {
  const ex: any = new KrakenExchange(Futures.usdm, '', '')
  const calls = { getFills: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) =>
    s === 'PF_ONDOUSD' ? 'ONDO-USD' : s
  ex.toKrakenSymbol = async () => 'PF_ONDOUSD'
  ex.derivativesClient = {
    getOrderStatus: async () => ({
      result: opts.statusResult ?? 'success',
      orders: [],
    }),
    getOrderEvents: async () => ({ elements: opts.events ?? [] }),
    getFills: async () => {
      calls.getFills++
      return {
        result: opts.fillsResult ?? 'success',
        fills: opts.fills ?? [],
      }
    },
  }
  return { ex, calls }
}

const ask = (ex: any) =>
  ex.getOrder({ symbol: 'ONDO-USD', newClientOrderId: CLI })

/** A cancel Kraken still holds in the events page: the ordinary path. */
const CANCEL_EVENT = {
  timestamp: Date.now() - 60_000,
  event: {
    OrderCancelled: {
      order: {
        uid: UID,
        clientId: CLI,
        tradeable: 'PF_ONDOUSD',
        direction: 'Sell',
        quantity: '13',
        filled: '0',
        limitPrice: '0.6871',
        orderType: 'Limit',
        timestamp: Date.now() - 3_600_000,
      },
      reason: 'CANCELLED_BY_USER',
    },
  },
}

describe('kraken futures: an order aged out of the events page is settled by its fills (spec 053)', () => {
  it('§1/§3.1 filled on the venue, event aged out -> FILLED with the executed size and fill price', async () => {
    const { ex, calls } = makeExchange({
      fills: [fill(), fill({ cliOrdId: 'someone-else', size: 99 })],
    })
    const res = await ask(ex)
    assert.strictEqual(calls.getFills, 1)
    assert.strictEqual(res.status, 'OK')
    assert.strictEqual(res.data.status, 'FILLED')
    assert.strictEqual(res.data.executedQty, '13')
    assert.strictEqual(res.data.side, 'SELL')
    assert.strictEqual(res.data.orderId, UID)
    assert.strictEqual(res.data.clientOrderId, CLI)
    assert.ok(Math.abs(+res.data.avgPrice - 0.6871) < 1e-12)
    assert.ok(Math.abs(+res.data.cummulativeQuoteQty - 13 * 0.6871) < 1e-9)
    assert.strictEqual(res.data.updateTime, +new Date('2026-10-30T04:47:12Z'))
  })

  it('§3.1 part fills sum, price is size-weighted', async () => {
    const { ex } = makeExchange({
      fills: [fill({ size: 5, price: 1 }), fill({ size: 8, price: 2 })],
    })
    const res = await ask(ex)
    assert.strictEqual(res.data.status, 'FILLED')
    assert.strictEqual(res.data.executedQty, '13')
    assert.ok(Math.abs(+res.data.avgPrice - 21 / 13) < 1e-12)
  })

  it('§3.2 no fills for the id (a cancel or reject with nothing executed) -> still the definitive not-found', async () => {
    const { ex } = makeExchange({ fills: [fill({ cliOrdId: 'other' })] })
    const res = await ask(ex)
    assert.strictEqual(res.status, 'NOTOK')
    assert.match(`${res.reason}`, /Order not found/)
  })

  it('§3.2 the fills read refused -> still not-found (no fill invented)', async () => {
    const { ex } = makeExchange({ fills: [fill()], fillsResult: 'error' })
    const res = await ask(ex)
    assert.strictEqual(res.status, 'NOTOK')
    assert.match(`${res.reason}`, /Order not found/)
  })

  it('§3.3 the live status view did not answer -> fills are not consulted (the order may still rest)', async () => {
    const { ex, calls } = makeExchange({
      fills: [fill()],
      statusResult: 'error',
    })
    const res = await ask(ex)
    assert.strictEqual(calls.getFills, 0)
    assert.strictEqual(res.status, 'NOTOK')
  })

  it('§3.2 control: a cancel still in the events page stays CANCELED', async () => {
    const { ex } = makeExchange({ fills: [], events: [CANCEL_EVENT] })
    const res = await ask(ex)
    assert.strictEqual(res.status, 'OK')
    assert.strictEqual(res.data.status, 'CANCELED')
    assert.strictEqual(res.data.executedQty, '0')
  })
})
