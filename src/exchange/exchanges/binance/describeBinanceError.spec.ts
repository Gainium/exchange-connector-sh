process.env.NODE_ENV = 'testing'

/**
 * Unit-level cover for the Binance thrown-error renderer.
 *
 * The SDK's `parseException` does not throw an Error. On any non-2xx it throws
 * a plain object `{ code, message, body, headers, requestUrl, requestBody,
 * requestOptions }` in which `message` is `response.data?.msg` -- undefined
 * whenever the venue's error body is not Binance's own `{code,msg}` JSON.
 * `body` is then the parsed payload, and for a JSON error page that is an
 * object.
 *
 * The old ladder interpolated it directly, so those failures collapsed to the
 * literal string "[object Object]" and were carried unchanged through the
 * connector's `reason` into the user-visible error, destroying the only
 * diagnostic the response carried. The US domain is worst affected: it routes
 * through the raw `getPrivate()` call, whose upstream failures are exactly the
 * ones with no `msg`.
 *
 * Run: `npm test` (mocha). No network / auth needed -- the unit is pure.
 */
import { describe, it } from 'mocha'
import assert from 'assert'
import { describeBinanceError } from './index'

/** The exact shape `BaseRestClient.parseException` throws. */
const thrown = (body: unknown, message?: string) => ({
  code: undefined,
  message,
  body,
  headers: { 'content-type': 'application/json' },
  requestUrl: 'https://api.binance.us/api/v3/openOrders',
  requestBody: undefined,
  requestOptions: { api_key: undefined, api_secret: undefined },
})

describe('describeBinanceError', () => {
  it('returns the venue message unchanged when the body carries {code,msg}', () => {
    const msg = 'Invalid API-key, IP, or permissions for action.'
    assert.strictEqual(
      describeBinanceError(thrown({ code: -2015, msg }, msg)),
      msg,
    )
  })

  it('renders an object body instead of "[object Object]" (the regression)', () => {
    const out = describeBinanceError(
      thrown({ error: 'blocked', detail: 'region' }),
    )
    assert.ok(!out.includes('[object Object]'), `still stringified: ${out}`)
    assert.ok(out.includes('blocked'), `lost the diagnostic: ${out}`)
    assert.ok(out.includes('region'), `lost the detail: ${out}`)
  })

  it('passes an HTML error page through as-is', () => {
    const html = '<html><body><h2>404 Not found</h2></body></html>'
    assert.strictEqual(describeBinanceError(thrown(html)), html)
  })

  it('uses the message of a real Error', () => {
    const e = new Error('getaddrinfo ENOTFOUND api.binance.us')
    assert.strictEqual(
      describeBinanceError(e),
      'getaddrinfo ENOTFOUND api.binance.us',
    )
  })

  it('passes a bare string throw through', () => {
    assert.strictEqual(
      describeBinanceError('Request Timeout'),
      'Request Timeout',
    )
  })

  it('redacts credential-shaped keys rather than emitting them', () => {
    const out = describeBinanceError(
      thrown({
        'X-MBX-APIKEY': 'REALKEY123',
        apiSecret: 'REALSECRET456',
        note: 'diagnostic kept',
      }),
    )
    assert.ok(!out.includes('REALKEY123'), `leaked api key: ${out}`)
    assert.ok(!out.includes('REALSECRET456'), `leaked secret: ${out}`)
    assert.ok(out.includes('diagnostic kept'), `over-redacted: ${out}`)
  })

  it('never throws on null or undefined', () => {
    assert.strictEqual(typeof describeBinanceError(null), 'string')
    assert.strictEqual(typeof describeBinanceError(undefined), 'string')
  })

  it('degrades gracefully when serialization itself throws', () => {
    const nasty: Record<string, unknown> = {}
    Object.defineProperty(nasty, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope')
      },
    })
    assert.strictEqual(typeof describeBinanceError(thrown(nasty)), 'string')
  })
})
