process.env.NODE_ENV = 'testing'

/**
 * Unit-level check for `signWhitebitRequest` — spec 002 §2.5, the whole of
 * WhiteBit's auth layer.
 *
 * Every private WhiteBit call this connector makes is authenticated by this one
 * function, and a signing regression is invisible until it reaches the venue:
 * WhiteBit answers a bad signature with a generic 401, so a drift here would
 * look like "the user's API key is wrong" rather than like our bug. Pinning the
 * exact bytes is the only way to catch that before it ships.
 *
 * The scheme (docs.whitebit.com, "Private endpoints" authentication):
 *   body      = { request: '<path>', nonce: '<ms epoch>', [nonceWindow], ...params }
 *   payload   = base64(JSON.stringify(body))
 *   signature = hex(HMAC_SHA512(payload, secret))
 *
 * Fixtures use a fixed key/secret/nonce, so the expected payload and signature
 * are constants. They were produced by the reference scheme above, not by
 * copying this module's own output — a test that only asserts "whatever the
 * implementation does" would pass through any regression.
 *
 * Run: `npm test` (mocha).
 *
 * No network / no live credentials — the function is pure.
 */
import { describe, it } from 'mocha'
import { signWhitebitRequest } from './signRequest'
import { nextWhitebitNonce } from './nonce'

const KEY = 'gainium-whitebit-test-key'
const SECRET = 'gainium-whitebit-test-secret'
const NONCE = 1735689600000

function check(label: string, ok: boolean, detail = '') {
  it(label, () => {
    if (!ok) throw new Error(detail ? `${label} :: ${detail}` : label)
  })
}

function expect(label: string, actual: unknown, want: unknown) {
  it(label, () => {
    if (actual !== want) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

describe('signWhitebitRequest (spec 002 §2.5)', () => {
  // 1) The no-params case — a balance read. This is the request `verifyWhitebit`
  //    makes, so it is the first thing a user's credentials ever hit.
  describe('a private request with no extra params', () => {
    const signed = signWhitebitRequest({
      path: '/api/v4/trade-account/balance',
      key: KEY,
      secret: SECRET,
      nonce: NONCE,
    })

    expect(
      'body carries request + nonce, in that order',
      signed.body,
      '{"request":"/api/v4/trade-account/balance","nonce":"1735689600000"}',
    )
    expect(
      'payload is base64 of exactly that body',
      signed.payload,
      'eyJyZXF1ZXN0IjoiL2FwaS92NC90cmFkZS1hY2NvdW50L2JhbGFuY2UiLCJub25jZSI6IjE3MzU2ODk2MDAwMDAifQ==',
    )
    expect(
      'signature is hex HMAC_SHA512(payload, secret)',
      signed.signature,
      'f3395579fc616ec91ee39490782003f5a5f09098e7cd5214fbd8651ee5f9d0a7d' +
        '21d52b1bcd410d4e722c0d57949ea0bfd1335c8207196f210335b1521dd5657',
    )

    // The headers are the contract with the venue; a renamed or missing one is
    // a 401 that looks like a credential problem.
    expect(
      'Content-Type header',
      signed.headers['Content-Type'],
      'application/json',
    )
    expect(
      'X-TXC-APIKEY header carries the key',
      signed.headers['X-TXC-APIKEY'],
      KEY,
    )
    expect(
      'X-TXC-PAYLOAD header matches the payload',
      signed.headers['X-TXC-PAYLOAD'],
      signed.payload,
    )
    expect(
      'X-TXC-SIGNATURE header matches the signature',
      signed.headers['X-TXC-SIGNATURE'],
      signed.signature,
    )
    check(
      'the secret never appears in the headers',
      !JSON.stringify(signed.headers).includes(SECRET),
    )
  })

  // 2) A real order placement. Params are appended after request/nonce, and the
  //    body string that gets signed is the body string that gets sent — this is
  //    the property that would break silently if the client re-serialized.
  describe('a private request with params (order placement)', () => {
    const signed = signWhitebitRequest({
      path: '/api/v4/order/new',
      key: KEY,
      secret: SECRET,
      nonce: 1735689600001,
      params: {
        market: 'BTC_USDT',
        side: 'buy',
        amount: '0.001',
        price: '40000',
        clientOrderId: 'D-BO-test',
      },
    })

    expect(
      'body: request + nonce first, then params in insertion order',
      signed.body,
      '{"request":"/api/v4/order/new","nonce":"1735689600001",' +
        '"market":"BTC_USDT","side":"buy","amount":"0.001","price":"40000",' +
        '"clientOrderId":"D-BO-test"}',
    )
    expect(
      'signature over the param-carrying payload',
      signed.signature,
      '7db39419d042b7fa439edf5b4a5c3b0e86a23e4bdc176dc76320d00eaad2d015' +
        '91970a13b992624cb6ae7ed13047edc4f6ca515d2638e8c959c0bd19b51744c9',
    )
    check(
      'the signed body round-trips to the same object that was sent',
      JSON.parse(signed.body).market === 'BTC_USDT',
      signed.body,
    )
    check(
      'payload decodes back to the signed body byte-for-byte',
      Buffer.from(signed.payload, 'base64').toString() === signed.body,
    )
  })

  // 3) `nonceWindow` changes the body, therefore the signature. Only an explicit
  //    `true` may emit the key: absent and `false` must be the same request, or
  //    every caller that passes a fixed-shape options object silently changes
  //    what it signs.
  describe('nonceWindow', () => {
    const withWindow = signWhitebitRequest({
      path: '/api/v4/trade-account/balance',
      key: KEY,
      secret: SECRET,
      nonce: NONCE,
      nonceWindow: true,
    })
    const withoutWindow = signWhitebitRequest({
      path: '/api/v4/trade-account/balance',
      key: KEY,
      secret: SECRET,
      nonce: NONCE,
      nonceWindow: false,
    })

    expect(
      'nonceWindow: true is emitted and signed',
      withWindow.body,
      '{"request":"/api/v4/trade-account/balance","nonce":"1735689600000",' +
        '"nonceWindow":true}',
    )
    expect(
      'nonceWindow: true signature',
      withWindow.signature,
      '63f306cb6ec3d603d98f3dbb4bee2c6836b234177f83605d784fb595bcdc6daf' +
        '12e8924bc05b52d676bc87cc94888a54af839cffd413721fa9dfe6dd9866dd67',
    )
    expect(
      'nonceWindow: false is NOT emitted (same body as omitting it)',
      withoutWindow.body,
      '{"request":"/api/v4/trade-account/balance","nonce":"1735689600000"}',
    )
  })

  // 4) Present-and-undefined must be indistinguishable from absent. Callers
  //    build fixed-shape param objects (`clientOrderId` on an order that has
  //    none, `market` on an account-wide read), and the Kraken serializer
  //    shipped exactly this bug (#383) by encoding `reduceOnly=undefined`.
  describe('undefined params never reach the venue', () => {
    const signed = signWhitebitRequest({
      path: '/api/v4/orders',
      key: KEY,
      secret: SECRET,
      nonce: NONCE,
      params: {
        market: 'BTC_USDT',
        clientOrderId: undefined,
        limit: undefined,
      },
    })
    check(
      'no clientOrderId key at all',
      !signed.body.includes('clientOrderId'),
      signed.body,
    )
    check(
      'never the literal string "undefined"',
      !signed.body.includes('undefined'),
      signed.body,
    )
    check(
      'falsy-but-meaningful values survive',
      signWhitebitRequest({
        path: '/api/v4/orders',
        key: KEY,
        secret: SECRET,
        nonce: NONCE,
        params: { offset: 0, postOnly: false },
      }).body.includes('"offset":0,"postOnly":false'),
    )
  })

  // 5) The nonce source itself: strictly increasing per key, independent across
  //    keys. WhiteBit rejects a nonce that is not greater than the last one it
  //    saw for that key, and the connector builds a fresh client per request —
  //    so this counter has to live above the client instance to work at all.
  describe('nextWhitebitNonce', () => {
    const a1 = +nextWhitebitNonce('key-a')
    const a2 = +nextWhitebitNonce('key-a')
    const a3 = +nextWhitebitNonce('key-a')
    check(
      'strictly increasing within one key',
      a2 > a1 && a3 > a2,
      `${a1},${a2},${a3}`,
    )
    check(
      'looks like a ms epoch',
      a1 > 1_600_000_000_000 && a1 < 4_000_000_000_000,
      String(a1),
    )
    check(
      'a second key is tracked independently',
      +nextWhitebitNonce('key-b') > 1_600_000_000_000,
    )
    check(
      'undefined key does not throw',
      typeof nextWhitebitNonce(undefined) === 'string',
    )
  })
})
