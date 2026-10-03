process.env.NODE_ENV = 'testing'

/**
 * OKX X-Perp order paths must send the live instId (`<family>-<expiry>`), never
 * the bare instFamily, which OKX rejects with 51001 ("Instrument ID ... doesn't
 * exist"). No network: drives the real openOrder / cancelOrder / getOrder with
 * stubbed REST clients. Run: `npm test`.
 */
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Futures, OKXSource } from '../../types'
import OKXExchange from './index'

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

const FAMILY = 'HYPE-USD_UM_XPERP'
const INST_ID = 'HYPE-USD_UM_XPERP-310523'
const xperpRow = (instFamily: string, instId: string) => ({
  instFamily,
  instId,
  ruleType: 'xperp',
  state: 'live',
})

type Stub = {
  ex: any
  sent: string[]
  instrumentCalls: () => number
}

/**
 * A real OKXExchange with its REST clients stubbed. `instruments` is called per
 * `getInstruments` request; the order client records the instId it was handed
 * and fails like OKX does when that instId is the bare family.
 */
const make = (
  okxSource: OKXSource | undefined,
  instruments: () => Promise<unknown[]>,
): Stub => {
  const ex: any = new OKXExchange(
    Futures.usdm,
    'k',
    's',
    'p',
    undefined,
    undefined,
    okxSource,
  )
  const sent: string[] = []
  let calls = 0
  ex.checkLimits = async () => undefined
  ex.client.getInstruments = async () => {
    calls++
    return instruments()
  }
  const answer = async (req: { instId: string }) => {
    sent.push(req.instId)
    if (!/-\d{6,}$/.test(req.instId) && /_UM_XPERP/.test(req.instId)) {
      throw {
        code: '1',
        msg: '',
        data: [
          {
            sCode: '51001',
            sMsg: "Instrument ID, Instrument ID code, or Spread ID doesn't exist.",
          },
        ],
      }
    }
    return [{ sCode: '0', clOrdId: 'c1' }]
  }
  ex.orderClient.submitOrder = answer
  ex.client.cancelOrder = answer
  ex.client.getOrderDetails = async (req: { instId: string }) => {
    sent.push(req.instId)
    return [{ clOrdId: 'c1' }]
  }
  ex.convertOrder = async () => ({})
  return { ex, sent, instrumentCalls: () => calls }
}

const order = (symbol: string) => ({
  symbol,
  side: 'BUY' as const,
  quantity: 1,
  price: 40,
  newClientOrderId: 'c1',
  type: 'LIMIT' as const,
})

const resetCache = () => {
  const s = OKXExchange as any
  s.xperpMap = new Map()
  s.xperpMapLoaded = 0
  s.xperpMapMissLoaded = new Map()
  s.xperpMapLoading = undefined
}

describe('okx — X-Perp orders resolve the live instId', () => {
  beforeEach(resetCache)
  afterEach(resetCache)

  it('a rate-limited instruments call does not strip the expiry tag when the map was already loaded', async () => {
    // First request in the process loads the map.
    const a = make(OKXSource.my, async () => [xperpRow(FAMILY, INST_ID)])
    await a.ex.openOrder(order(FAMILY))
    eq('first order instId', a.sent[0], INST_ID)
    // The next request is a NEW instance (the service builds one per request)
    // and OKX now throttles the public instruments call.
    const b = make(OKXSource.my, async () => {
      throw { code: '50011', msg: 'Too Many Requests' }
    })
    const res = await b.ex.openOrder(order(FAMILY))
    eq('second order instId', b.sent[0], INST_ID)
    eq('second order status', res.status, 'OK')
    eq('no refetch while fresh', b.instrumentCalls(), 0)
  })

  it('a burst of orders on a cold process fetches the instrument list once', async () => {
    const stubs = Array.from({ length: 8 }, () =>
      make(OKXSource.my, async () => [xperpRow(FAMILY, INST_ID)]),
    )
    let calls = 0
    for (const s of stubs) {
      const inner = s.ex.client.getInstruments
      s.ex.client.getInstruments = async (...a: unknown[]) => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return inner(...a)
      }
    }
    await Promise.all(stubs.map((s) => s.ex.openOrder(order(FAMILY))))
    eq('instruments calls', calls, 1)
    for (const s of stubs) eq('instId', s.sent[0], INST_ID)
  })

  it('a fresh cached map that lacks the pair is refreshed before the order', async () => {
    const a = make(OKXSource.my, async () => [
      xperpRow('BTC-USD_UM_XPERP', 'BTC-USD_UM_XPERP-310404'),
    ])
    await a.ex.openOrder(order('BTC-USD_UM_XPERP'))
    // HYPE is listed after the map was cached.
    const b = make(OKXSource.my, async () => [
      xperpRow('BTC-USD_UM_XPERP', 'BTC-USD_UM_XPERP-310404'),
      xperpRow(FAMILY, INST_ID),
    ])
    await b.ex.openOrder(order(FAMILY))
    eq('instId', b.sent[0], INST_ID)
  })

  it('a miss on a pair OKX does not serve does not hold back another pair', async () => {
    const rows = [xperpRow('BTC-USD_UM_XPERP', 'BTC-USD_UM_XPERP-310404')]
    await make(OKXSource.my, async () => rows).ex.openOrder(
      order('BTC-USD_UM_XPERP'),
    )
    // NOPE is not served: its miss refresh is spent.
    await make(OKXSource.my, async () => rows).ex.openOrder(
      order('NOPE-USD_UM_XPERP'),
    )
    // HYPE lists right after; its own miss still refreshes.
    rows.push(xperpRow(FAMILY, INST_ID))
    const c = make(OKXSource.my, async () => rows)
    await c.ex.openOrder(order(FAMILY))
    eq('instId', c.sent[0], INST_ID)
  })

  it('a non-EU instance with an X-Perp pair resolves the live instId', async () => {
    const a = make(undefined, async () => [xperpRow(FAMILY, INST_ID)])
    const res = await a.ex.openOrder(order(FAMILY))
    eq('openOrder instId', a.sent[0], INST_ID)
    eq('openOrder status', res.status, 'OK')
  })

  it('cancel and order lookup resolve the live instId on a fresh instance', async () => {
    const a = make(OKXSource.my, async () => [xperpRow(FAMILY, INST_ID)])
    await a.ex.cancelOrder({ symbol: FAMILY, newClientOrderId: 'c1' })
    eq('cancelOrder instId', a.sent[0], INST_ID)
    const b = make(undefined, async () => [xperpRow(FAMILY, INST_ID)])
    await b.ex.getOrder({ symbol: FAMILY, newClientOrderId: 'c1' })
    eq('getOrder instId', b.sent[0], INST_ID)
  })

  it('a 51001 on an X-Perp pair drops the cached map so the next call refetches', async () => {
    const a = make(OKXSource.my, async () => [xperpRow(FAMILY, INST_ID)])
    a.ex.orderClient.submitOrder = async () => {
      throw {
        code: '1',
        data: [{ sCode: '51001', sMsg: "Instrument ID ... doesn't exist." }],
      }
    }
    ;(OKXExchange as any).xperpMapLoaded = Date.now()
    const res = await a.ex.openOrder(order(FAMILY))
    eq('status', res.status, 'NOTOK')
    eq('cache invalidated', (OKXExchange as any).xperpMapLoaded, 0)
  })

  it('global SWAP pairs are untouched and never fetch X-Perp instruments', async () => {
    const a = make(undefined, async () => [xperpRow(FAMILY, INST_ID)])
    await a.ex.openOrder(order('BTC-USDT'))
    eq('instId', a.sent[0], 'BTC-USDT-SWAP')
    eq('instruments calls', a.instrumentCalls(), 0)
  })
})
