process.env.NODE_ENV = 'testing'

/**
 * Kraken API Partner attribution: every order placement (spot `AddOrder`,
 * spot `AddOrderBatch`, futures `sendorder`) carries `broker` = the partner
 * IIBAN passed in as the connector `code`, exactly as Kraken wants it
 * (four groups of four, spaces included). A missing or malformed code sends
 * no `broker` at all, so attribution can never be the reason an order fails.
 *
 * Run: `npm test` (mocha). No network — the SDK clients are stubbed.
 */
import { describe, it } from 'mocha'
import { strict as assert } from 'assert'
import { Futures } from '../../types'
import KrakenExchange from './index'

const IIBAN = 'AA00 B11C DDD2 E3FF'

const make = (futures: Futures, code?: string): any =>
  new (KrakenExchange as any)(
    futures,
    'key',
    'secret',
    undefined,
    undefined,
    undefined,
    undefined,
    code,
  )

describe('Kraken broker (API Partner ID)', () => {
  it('normalises a valid IIBAN', () => {
    assert.equal(make(Futures.null, IIBAN).broker, IIBAN)
    assert.equal(make(Futures.null, ' aa00  b11c ddd2 e3ff ').broker, IIBAN)
  })

  it('drops a missing or malformed code', () => {
    assert.equal(make(Futures.null).broker, undefined)
    assert.equal(make(Futures.null, '').broker, undefined)
    assert.equal(make(Futures.null, 'AA00B11CDDD2E3FF').broker, undefined)
    assert.equal(make(Futures.null, 'x-BKSVA3NT').broker, undefined)
  })

  it('tags spot AddOrder', async () => {
    const ex = make(Futures.null, IIBAN)
    let sent: any
    ex.checkLimits = async () => undefined
    ex.toKrakenSymbol = async () => 'XBTUSD'
    ex.spotClient.submitOrder = async (params: any) => {
      sent = params
      throw new Error('stop')
    }
    ex.handleKrakenErrors = () => async () => ({ status: 'NOTOK' })
    await ex.openOrder({
      symbol: 'BTCUSD',
      side: 'BUY',
      quantity: 1,
      price: 1,
      newClientOrderId: 'abc',
    })
    assert.equal(sent.broker, IIBAN)
  })

  it('omits broker on spot AddOrder without a code', async () => {
    const ex = make(Futures.null)
    let sent: any
    ex.checkLimits = async () => undefined
    ex.toKrakenSymbol = async () => 'XBTUSD'
    ex.spotClient.submitOrder = async (params: any) => {
      sent = params
      throw new Error('stop')
    }
    ex.handleKrakenErrors = () => async () => ({ status: 'NOTOK' })
    await ex.openOrder({ symbol: 'BTCUSD', side: 'BUY', quantity: 1, price: 1 })
    assert.equal('broker' in sent, false)
  })

  it('tags futures sendorder', async () => {
    const ex = make(Futures.usdm, IIBAN)
    let sent: any
    ex.checkLimits = async () => undefined
    ex.toKrakenSymbol = async () => 'PF_XBTUSD'
    ex.derivativesClient.submitOrder = async (params: any) => {
      sent = params
      throw new Error('stop')
    }
    ex.handleKrakenErrors = () => async () => ({ status: 'NOTOK' })
    await ex.openOrder({
      symbol: 'BTCUSD',
      side: 'SELL',
      quantity: 1,
      price: 1,
      type: 'MARKET',
    })
    assert.equal(sent.broker, IIBAN)
  })
})
