process.env.NODE_ENV = 'testing'

/**
 * Unit cover for spec `004.binance-order-id-precision-loss.md`.
 *
 * Binance USDM order ids are now 19-digit integers, above 2^53. axios's default
 * `transformResponse` is a bare `JSON.parse`, so the connector received them already
 * rounded to the nearest double -- distinct venue orders collapsing onto one id
 * (spec §2.1: 60 groups / 63 filled rows / 5 users on production).
 *
 * These tests pin the raw-text repair that has to happen before `JSON.parse` runs.
 * The end-to-end proof, driving the real vendor `USDMClient` against a local HTTP
 * server, is `binanceLosslessOrderId.e2e.spec.ts`.
 *
 * Run: `npm test` (mocha). Pure -- no network, no auth, no stack.
 */
import { describe, it } from 'mocha'
import assert from 'assert'
import { parseBinanceResponse, quoteUnsafeIntegerIds } from './losslessOrderId'

/** A real-shaped USDM order id from production, 19 digits, above 2^53. */
const HUGE_ID = '8389766269723522123'
/** What `JSON.parse` turns HUGE_ID into today -- note the trailing zeros. */
const ROUNDED_ID = '8389766269723522000'

describe('binance lossless order id (spec 004)', () => {
  describe('§1.2 the defect this exists to prevent', () => {
    it('plain JSON.parse rounds a 19-digit order id away', () => {
      const parsed = JSON.parse(`{"orderId":${HUGE_ID}}`)
      assert.strictEqual(String(parsed.orderId), ROUNDED_ID)
      assert.notStrictEqual(String(parsed.orderId), HUGE_ID)
    })

    it('two distinct venue ids collapse onto one value', () => {
      const a = JSON.parse(`{"orderId":8389766269723522123}`).orderId
      const b = JSON.parse(`{"orderId":8389766269723522089}`).orderId
      assert.strictEqual(a, b, 'precondition: these round together')
    })
  })

  describe('§4.1 an id above 2^53 survives exactly', () => {
    it('is returned as a string with every digit intact', () => {
      const out = parseBinanceResponse(
        `{"symbol":"RSRUSDT","orderId":${HUGE_ID},"status":"FILLED"}`,
      ) as { orderId: unknown; symbol: string; status: string }
      assert.strictEqual(out.orderId, HUGE_ID)
      assert.strictEqual(typeof out.orderId, 'string')
      assert.strictEqual(out.symbol, 'RSRUSDT')
      assert.strictEqual(out.status, 'FILLED')
    })

    it('keeps the two colliding ids distinct', () => {
      const a = (parseBinanceResponse(`{"orderId":8389766269723522123}`) as any)
        .orderId
      const b = (parseBinanceResponse(`{"orderId":8389766269723522089}`) as any)
        .orderId
      assert.notStrictEqual(a, b)
      assert.strictEqual(a, '8389766269723522123')
      assert.strictEqual(b, '8389766269723522089')
    })

    it('works inside an array of orders and at any nesting depth', () => {
      const out = parseBinanceResponse(
        `[{"orderId":${HUGE_ID}},{"orderId":12345},{"o":{"orderId":8389766269723522089}}]`,
      ) as any[]
      assert.strictEqual(out[0].orderId, HUGE_ID)
      assert.strictEqual(out[1].orderId, 12345)
      assert.strictEqual(out[2].o.orderId, '8389766269723522089')
    })

    it('tolerates whitespace around the key and the value', () => {
      const out = parseBinanceResponse(
        `{\n  "orderId" :   ${HUGE_ID}\n}`,
      ) as any
      assert.strictEqual(out.orderId, HUGE_ID)
    })
  })

  describe('§4.2 ids at or below 2^53 are untouched', () => {
    it('leaves an ordinary id as a JSON number', () => {
      const out = parseBinanceResponse(`{"orderId":123456789}`) as any
      assert.strictEqual(out.orderId, 123456789)
      assert.strictEqual(typeof out.orderId, 'number')
    })

    it('leaves MAX_SAFE_INTEGER itself as a number', () => {
      const out = parseBinanceResponse(
        `{"orderId":${Number.MAX_SAFE_INTEGER}}`,
      ) as any
      assert.strictEqual(out.orderId, Number.MAX_SAFE_INTEGER)
      assert.strictEqual(typeof out.orderId, 'number')
    })

    it('rewrites nothing at all when no id is unsafe', () => {
      const raw = `{"orderId":123,"updateTime":1756900000000,"price":"0.01"}`
      assert.strictEqual(quoteUnsafeIntegerIds(raw), raw)
    })

    it('leaves the -1 placeholder alone', () => {
      const out = parseBinanceResponse(`{"orderId":-1}`) as any
      assert.strictEqual(out.orderId, -1)
    })

    it('leaves an already-quoted id alone', () => {
      const out = parseBinanceResponse(`{"orderId":"${HUGE_ID}"}`) as any
      assert.strictEqual(out.orderId, HUGE_ID)
    })
  })

  describe('§4.3 no other field is retyped', () => {
    it('a large non-id integer keeps its number type', () => {
      const out = parseBinanceResponse(
        `{"tradeId":8389766269723522123,"updateTime":1756900000000,"time":1756900000000}`,
      ) as any
      assert.strictEqual(typeof out.tradeId, 'number')
      assert.strictEqual(out.updateTime, 1756900000000)
      assert.strictEqual(out.time, 1756900000000)
    })

    it('prices and quantities are unaffected', () => {
      const out = parseBinanceResponse(
        `{"orderId":${HUGE_ID},"price":"0.0123","executedQty":"100","avgPrice":"0.011"}`,
      ) as any
      assert.strictEqual(out.price, '0.0123')
      assert.strictEqual(out.executedQty, '100')
      assert.strictEqual(out.avgPrice, '0.011')
    })
  })

  describe('§4.4 digits inside a string value are never rewritten', () => {
    it('does not touch a clientOrderId that embeds the key text', () => {
      const raw = `{"clientOrderId":"D-BO-\\"orderId\\":8389766269723522123","orderId":${HUGE_ID}}`
      const out = parseBinanceResponse(raw) as any
      assert.strictEqual(
        out.clientOrderId,
        'D-BO-"orderId":8389766269723522123',
      )
      assert.strictEqual(out.orderId, HUGE_ID)
    })

    it('does not touch an error msg that embeds the key text', () => {
      const out = parseBinanceResponse(
        `{"code":-2011,"msg":"Unknown order sent. \\"orderId\\": 8389766269723522123"}`,
      ) as any
      assert.strictEqual(
        out.msg,
        'Unknown order sent. "orderId": 8389766269723522123',
      )
    })

    it('handles a trailing backslash-escape run without mis-syncing', () => {
      const out = parseBinanceResponse(
        `{"clientOrderId":"back\\\\slash","orderId":${HUGE_ID}}`,
      ) as any
      assert.strictEqual(out.clientOrderId, 'back\\slash')
      assert.strictEqual(out.orderId, HUGE_ID)
    })

    it('is not fooled by the key appearing as a string VALUE', () => {
      const out = parseBinanceResponse(
        `{"field":"orderId","orderId":${HUGE_ID}}`,
      ) as any
      assert.strictEqual(out.field, 'orderId')
      assert.strictEqual(out.orderId, HUGE_ID)
    })
  })

  describe('§4.5 / §4.6 non-JSON and error bodies behave like axios', () => {
    it('returns a non-JSON body unchanged instead of throwing', () => {
      const html = '<html><body>502 Bad Gateway</body></html>'
      assert.strictEqual(parseBinanceResponse(html), html)
    })

    it('returns an empty body unchanged', () => {
      assert.strictEqual(parseBinanceResponse(''), '')
    })

    it('passes a non-string payload straight through', () => {
      const buf = Buffer.from('x')
      assert.strictEqual(parseBinanceResponse(buf), buf)
    })

    it('still parses a Binance error body into code/msg', () => {
      const out = parseBinanceResponse(
        `{"code":-2011,"msg":"Unknown order sent."}`,
      ) as any
      assert.strictEqual(out.code, -2011)
      assert.strictEqual(out.msg, 'Unknown order sent.')
    })

    it('does not hang on an unterminated string literal', () => {
      const raw = `{"clientOrderId":"unterminated`
      assert.strictEqual(parseBinanceResponse(raw), raw)
    })
  })
})
