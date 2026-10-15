process.env.NODE_ENV = 'testing'

import { strict as assert } from 'assert'
import { describe, it } from 'mocha'
import { binanceDeliveryTime, datedDeliveryTime } from './deliveryTime'

describe('datedDeliveryTime', () => {
  it('passes a positive millisecond epoch through, from a number or a string', () => {
    assert.equal(datedDeliveryTime(1792137600000), 1792137600000)
    assert.equal(datedDeliveryTime('1792137600000'), 1792137600000)
  })

  it("reports perpetual markers as undated (Bybit '0', KuCoin null)", () => {
    assert.equal(datedDeliveryTime('0'), undefined)
    assert.equal(datedDeliveryTime(0), undefined)
    assert.equal(datedDeliveryTime(null), undefined)
    assert.equal(datedDeliveryTime(undefined), undefined)
    assert.equal(datedDeliveryTime(''), undefined)
  })

  it('rejects anything that is not a finite positive number', () => {
    assert.equal(datedDeliveryTime('abc'), undefined)
    assert.equal(datedDeliveryTime(-5), undefined)
    assert.equal(datedDeliveryTime(Number.POSITIVE_INFINITY), undefined)
  })
})

describe('binanceDeliveryTime', () => {
  // Binance perpetuals carry a placeholder delivery date in 2100.
  const placeholder = 4133404800000

  it('ignores the placeholder date on perpetuals', () => {
    assert.equal(binanceDeliveryTime('PERPETUAL', placeholder), undefined)
    assert.equal(
      binanceDeliveryTime('TRADIFI_PERPETUAL', placeholder),
      undefined,
    )
  })

  it('reports the delivery date of quarterly and monthly contracts', () => {
    assert.equal(
      binanceDeliveryTime('CURRENT_QUARTER', 1797926400000),
      1797926400000,
    )
    assert.equal(
      binanceDeliveryTime('NEXT_QUARTER', 1805788800000),
      1805788800000,
    )
    assert.equal(
      binanceDeliveryTime('CURRENT_MONTH', 1792137600000),
      1792137600000,
    )
  })

  it('reports nothing without a contract type (spot, unknown shapes)', () => {
    assert.equal(binanceDeliveryTime(undefined, 1797926400000), undefined)
    assert.equal(binanceDeliveryTime('', 1797926400000), undefined)
  })
})
