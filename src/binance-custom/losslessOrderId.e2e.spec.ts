process.env.NODE_ENV = 'testing'

/**
 * End-to-end cover for spec `004.binance-order-id-precision-loss.md`.
 *
 * `losslessOrderId.spec.ts` pins the raw-text repair in isolation. This file proves
 * the repair is actually *reached*: it drives the REAL vendor `binance` clients we
 * export from `binance-custom` against a local HTTP server that answers with a real
 * Binance USDM order body, and asserts the 19-digit id survives the whole SDK path
 * (axios -> transformResponse -> beautifier).
 *
 * It also pins the outbound half (§4.7): the id we are asked to cancel is the id
 * that reaches the venue's query string.
 *
 * Run: `npm test` (mocha). Binds 127.0.0.1 on an ephemeral port; no internet, no
 * credentials, no stack.
 */
import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import http from 'http'
import { AddressInfo } from 'net'
import { USDMClient, MainClient } from './index'

/** A real-shaped USDM order id from production: 19 digits, above 2^53. */
const HUGE_ID = '8389766269723522123'
/** What the connector reported before this fix. */
const ROUNDED_ID = '8389766269723522000'

/** A realistic USDM order payload with the id as a bare JSON number, as Binance sends it. */
const orderBody = (id: string) =>
  `{"orderId":${id},"symbol":"RSRUSDT","status":"FILLED","clientOrderId":"D-BO-abc",` +
  `"price":"0.01","avgPrice":"0.011","origQty":"100","executedQty":"100","cumQuote":"1.1",` +
  `"side":"BUY","type":"LIMIT","timeInForce":"GTC","reduceOnly":false,"closePosition":false,` +
  `"positionSide":"BOTH","updateTime":1756900000000}`

describe('binance lossless order id, end to end (spec 004)', () => {
  let server: http.Server
  let baseUrl: string
  /** Every request URL the fake venue received, so we can assert on what we sent. */
  let seen: string[] = []
  /** Body the fake venue replies with; set per test. */
  let reply = orderBody(HUGE_ID)

  before(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          seen.push(req.url ?? '')
          res.setHeader('content-type', 'application/json')
          res.end(reply)
        })
        server.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
          resolve()
        })
      }),
  )

  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const usdm = () =>
    new USDMClient({
      api_key: 'k',
      api_secret: 's',
      baseUrl,
      disableTimeSync: true,
    })

  beforeEach(() => {
    seen = []
    reply = orderBody(HUGE_ID)
  })

  describe('§4.1 inbound: the venue id survives the SDK', () => {
    it('getOrder returns every digit of a 19-digit id', async () => {
      const res: any = await usdm().getOrder({
        symbol: 'RSRUSDT',
        orderId: 1,
      })
      assert.strictEqual(String(res.orderId), HUGE_ID)
      assert.notStrictEqual(String(res.orderId), ROUNDED_ID)
    })

    it("the id is a string, so futures_convertOrder's .toString() is exact", async () => {
      const res: any = await usdm().getOrder({
        symbol: 'RSRUSDT',
        orderId: 1,
      })
      // This is precisely what `futures_convertOrder` does at
      // `src/exchange/exchanges/binance/index.ts` before it fills `CommonOrder.orderId`.
      assert.strictEqual(res.orderId.toString(), HUGE_ID)
    })

    it('the rest of the payload is untouched', async () => {
      const res: any = await usdm().getOrder({
        symbol: 'RSRUSDT',
        orderId: 1,
      })
      assert.strictEqual(res.symbol, 'RSRUSDT')
      assert.strictEqual(res.status, 'FILLED')
      assert.strictEqual(res.clientOrderId, 'D-BO-abc')
      assert.strictEqual(res.updateTime, 1756900000000)
      // Still the venue's own string — `beautifyResponses` is off, so nothing in the
      // SDK re-types numeric-looking fields either way.
      assert.strictEqual(res.executedQty, '100')
    })

    it('§4.2 an ordinary sub-2^53 id still arrives as a number', async () => {
      reply = orderBody('123456789')
      const res: any = await usdm().getOrder({
        symbol: 'RSRUSDT',
        orderId: 1,
      })
      assert.strictEqual(res.orderId, 123456789)
      assert.strictEqual(typeof res.orderId, 'number')
    })

    it('the spot MainClient is covered by the same seam', async () => {
      const res: any = await new MainClient({
        api_key: 'k',
        api_secret: 's',
        baseUrl,
        disableTimeSync: true,
      }).getOrder({ symbol: 'RSRUSDT', orderId: 1 })
      assert.strictEqual(String(res.orderId), HUGE_ID)
    })
  })

  describe('§4.7 outbound: the id we are told to cancel is the id we send', () => {
    it('a 19-digit id reaches the venue query string unrounded', async () => {
      // Mirrors what `futures_cancelOrderByOrderIdAndSymbol` now builds: the caller's
      // string, with no `+` round trip.
      await usdm()
        .cancelOrder({
          symbol: 'RSRUSDT',
          orderId: HUGE_ID as unknown as number,
        })
        .catch(() => undefined)
      const sent = seen.join('\n')
      assert.ok(
        sent.includes(`orderId=${HUGE_ID}`),
        `expected orderId=${HUGE_ID} in ${sent}`,
      )
      assert.ok(!sent.includes(ROUNDED_ID), 'must not send the rounded id')
    })

    it('the old `+orderId` behaviour would have sent a different order id', () => {
      // Pins WHY the `+` had to go: this is not a style change.
      assert.strictEqual(String(+HUGE_ID), ROUNDED_ID)
      assert.notStrictEqual(String(+HUGE_ID), HUGE_ID)
    })

    it('an ordinary id is still sent unchanged', async () => {
      await usdm()
        .cancelOrder({
          symbol: 'RSRUSDT',
          orderId: '123456789' as unknown as number,
        })
        .catch(() => undefined)
      assert.ok(seen.join('\n').includes('orderId=123456789'))
    })
  })
})
