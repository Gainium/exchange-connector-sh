process.env.NODE_ENV = 'testing'

/**
 * An order OKX has accepted must come back as placed, never as a `51016`
 * ("clOrdId already exists") refusal caused by the connector re-submitting it.
 * See specs/034. No network: drives the real openOrder over a fake OKX that
 * enforces clOrdId uniqueness the way the venue does. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import OKXExchange from './index'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const refusal = (sCode: string, sMsg: string) => ({
  code: '1',
  msg: '',
  data: [{ sCode, sMsg }],
})

type Fake = {
  ex: any
  submits: Record<string, unknown>[]
  lookups: number
  venue: Map<string, { clOrdId: string; state: string }>
}

/**
 * A real spot OKXExchange over a fake OKX. `onSubmit` may throw AFTER the
 * venue recorded the order (response lost) or BEFORE (refused); `onLookup`
 * may throw to simulate a failed read-back.
 */
const make = (opts: {
  onSubmit?: (n: number, accepted: boolean) => void
  acceptOnSubmit?: (n: number) => boolean
  onLookup?: (n: number) => void
}): Fake => {
  const ex: any = new OKXExchange(Futures.null, 'k', 's', 'p')
  const f: Fake = { ex, submits: [], lookups: 0, venue: new Map() }
  ex.checkLimits = async () => undefined
  ex.spotTdMode = async () => 'cash'
  ex.convertOrder = async (o: { clOrdId: string; state: string }) => ({
    clientOrderId: o.clOrdId,
    status: o.state === 'live' ? 'NEW' : o.state,
  })
  ex.orderClient.submitOrder = async (req: { clOrdId: string }) => {
    f.submits.push({ ...req })
    const n = f.submits.length
    if (f.venue.has(req.clOrdId)) {
      throw refusal('51016', 'Client order ID already exists.')
    }
    const accept = opts.acceptOnSubmit ? opts.acceptOnSubmit(n) : true
    if (accept)
      f.venue.set(req.clOrdId, { clOrdId: req.clOrdId, state: 'live' })
    opts.onSubmit?.(n, accept)
    return [{ sCode: '0', clOrdId: req.clOrdId }]
  }
  ex.client.getOrderDetails = async (req: { clOrdId: string }) => {
    f.lookups++
    opts.onLookup?.(f.lookups)
    const o = f.venue.get(req.clOrdId)
    return o ? [o] : []
  }
  return f
}

const order = () => ({
  symbol: 'ETH-USDC',
  side: 'BUY' as const,
  quantity: 0.007109,
  price: 2340,
  newClientOrderId: 'ROiuPKvqcThkSfS',
  type: 'LIMIT' as const,
})

describe('okx — an order OKX accepted is never re-submitted under its clOrdId', () => {
  it('§4.1 a failed read-back after an accepted submit does not re-submit', async () => {
    const f = make({
      onLookup: (n) => {
        if (n === 1) throw { code: '50013', msg: 'System busy' }
      },
    })
    const res = await f.ex.openOrder(order())
    eq('submits', f.submits.length, 1)
    eq('status', res.status, 'OK')
    eq('clientOrderId', res.data?.clientOrderId, 'ROiuPKvqcThkSfS')
  })

  it('§4.2 a lost submit response is resolved by lookup, not a second submit', async () => {
    const f = make({
      onSubmit: (n) => {
        if (n === 1)
          throw { code: '50004', msg: 'API endpoint request timeout' }
      },
    })
    const res = await f.ex.openOrder(order())
    eq('submits', f.submits.length, 1)
    eq('status', res.status, 'OK')
    eq('venue orders', f.venue.size, 1)
  })

  it('§4.2 a submit that really failed is still retried once and placed', async () => {
    const f = make({
      acceptOnSubmit: (n) => n > 1,
      onSubmit: (n) => {
        if (n === 1) throw { code: '50013', msg: 'System busy' }
      },
    })
    const res = await f.ex.openOrder(order())
    eq('submits', f.submits.length, 2)
    eq('status', res.status, 'OK')
  })

  it('§4.3 a 51016 for an order OKX has returns that order as placed', async () => {
    const f = make({})
    f.venue.set('ROiuPKvqcThkSfS', {
      clOrdId: 'ROiuPKvqcThkSfS',
      state: 'live',
    })
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'OK')
    eq('clientOrderId', res.data?.clientOrderId, 'ROiuPKvqcThkSfS')
  })

  it('§4.3 a 51016 OKX cannot back up keeps the original refusal', async () => {
    const f = make({})
    f.ex.orderClient.submitOrder = async (req: Record<string, unknown>) => {
      f.submits.push(req)
      throw refusal('51016', 'Client order ID already exists.')
    }
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'NOTOK')
    eq('reason', res.reason, 'Client order ID already exists.')
    eq('submits', f.submits.length, 1)
  })

  it('§4.4 an ordinary refusal is unchanged and asks nothing', async () => {
    const f = make({})
    f.ex.orderClient.submitOrder = async (req: Record<string, unknown>) => {
      f.submits.push(req)
      throw refusal('51008', 'Order failed. Insufficient USDC balance')
    }
    const res = await f.ex.openOrder(order())
    eq('status', res.status, 'NOTOK')
    eq('reason', res.reason, 'Order failed. Insufficient USDC balance')
    eq('lookups', f.lookups, 0)
  })

  it('§1.3 the request sent to OKX is unchanged', async () => {
    const f = make({})
    await f.ex.openOrder(order())
    eq(
      'body',
      JSON.stringify(f.submits[0]),
      JSON.stringify({
        instId: 'ETH-USDC',
        side: 'buy',
        sz: '0.007109',
        clOrdId: 'ROiuPKvqcThkSfS',
        ordType: 'limit',
        tdMode: 'cash',
        tgtCcy: 'base_ccy',
        tag: f.ex.code,
        px: '2340',
      }),
    )
  })
})
