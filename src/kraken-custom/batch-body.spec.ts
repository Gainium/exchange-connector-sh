process.env.NODE_ENV = 'testing'

/**
 * What a NESTED ARRAY looks like on the wire, and whether the signature covers
 * it, for the two Kraken bulk endpoints.
 *
 * This matters because the connector does not use the SDK's client directly: it
 * uses the wrapper in `./SpotClient.ts`, which overrides `signRequest` and has
 * its own `serializeParams`. That serializer flattens an array into repeated
 * `key=value` pairs (`orderIds=1&orderIds=2`), which is a form-encoding and
 * cannot express `orders: [{…}, {…}]` at all — `encodeURIComponent({})` is the
 * literal text `%5Bobject%20Object%5D`. If a batch request were serialized that
 * way, Kraken would receive a request that describes no orders.
 *
 * It is not serialized that way. On the spot ("main") client a POST is signed
 * over `nonce + JSON.stringify(body)` and SENT as that same JSON object with
 * `Content-Type: application/json`, so `serializeParams` only ever reaches the
 * query string (empty for these calls). These specs pin both halves:
 *
 *  1. the bytes on the wire are JSON with the nested array intact, and
 *  2. Kraken's documented signature — HMAC-SHA512 over
 *     `URI path + SHA256(nonce + POST body)`, keyed with the base64-decoded
 *     secret — recomputed here from the RAW BODY THAT WAS SENT, equals the
 *     `API-Sign` header. That is what makes the signature cover every field of
 *     every order, rather than some other rendering of them.
 *
 * The key/secret are synthetic and the identifiers are made up — this file is
 * public. No network.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { createHash, createHmac } from 'crypto'
import { SpotClient } from './SpotClient'

const SECRET = Buffer.from('s'.repeat(64)).toString('base64')
const API_KEY = 'batch-spec-key'

type Captured = {
  url: string
  contentType: string
  rawBody: string
  sign: string
}

/** A fake Kraken that keeps the exact request bytes and answers blandly. */
function capturing() {
  const seen: Captured[] = []
  const adapter = async (config: any) => {
    const headers = config.headers ?? {}
    const read = (name: string) => headers.get?.(name) ?? headers[name] ?? ''
    seen.push({
      url: String(config.url),
      contentType: String(read('Content-Type')),
      // axios serializes a plain object body with JSON.stringify when the
      // content type is JSON; capturing it as a string is capturing the bytes.
      rawBody:
        typeof config.data === 'string'
          ? config.data
          : JSON.stringify(config.data),
      sign: String(read('API-Sign')),
    })
    return {
      data: { error: [], result: { count: 0, orders: [] } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
    }
  }
  return { adapter, seen }
}

/**
 * Kraken's documented spot signature, recomputed independently of the SDK:
 * `HMAC-SHA512( path || SHA256(nonce || body), base64decode(secret) )`.
 * <https://docs.kraken.com/api/docs/rest-api/add-order-batch>
 */
function krakenSign(path: string, nonce: string, rawBody: string): string {
  const inner = createHash('sha256')
    .update(`${nonce}${rawBody}`, 'utf8')
    .digest()
  return createHmac('sha512', Buffer.from(SECRET, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'latin1'), inner]))
    .digest('base64')
}

const client = (adapter: any) =>
  new SpotClient({ apiKey: API_KEY, apiSecret: SECRET }, {
    adapter,
  } as any) as any

const ORDERS = [
  {
    ordertype: 'limit' as const,
    type: 'buy' as const,
    volume: '0.5',
    price: '101.5',
    cl_ord_id: 'GRID-BO-aa11bb',
  },
  {
    ordertype: 'limit' as const,
    type: 'buy' as const,
    volume: '0.25',
    price: '99.75',
    cl_ord_id: 'GRID-BO-cc22dd',
  },
]

const TXIDS = ['OAAAAA-BBBBB-CCCCCC', 'ODDDDD-EEEEE-FFFFFF']

describe('kraken bulk request bodies', () => {
  describe('AddOrderBatch', () => {
    let sent: Captured
    let body: any

    before(async () => {
      const kraken = capturing()
      await client(kraken.adapter).submitBatchOrders({
        pair: 'SOLUSD',
        orders: ORDERS,
      })
      sent = kraken.seen[0]
      body = JSON.parse(sent.rawBody)
    })

    it('goes out as JSON', () => {
      assert.ok(sent.contentType.includes('application/json'), sent.contentType)
      assert.ok(sent.url.endsWith('/0/private/AddOrderBatch'), sent.url)
    })

    it('carries the orders as a nested array, not flattened key=value pairs', () => {
      assert.ok(Array.isArray(body.orders), sent.rawBody)
      assert.strictEqual(body.orders.length, 2)
      assert.deepStrictEqual(body.orders, ORDERS)
      assert.strictEqual(body.pair, 'SOLUSD')
    })

    it('never renders an order as [object Object]', () => {
      assert.ok(!sent.rawBody.includes('object Object'), sent.rawBody)
    })

    it('puts the nonce first, where Kraken signs it', () => {
      assert.ok(body.nonce, sent.rawBody)
      assert.strictEqual(Object.keys(body)[0], 'nonce')
    })

    it('signs the exact bytes it sends, nested array included', () => {
      assert.strictEqual(
        sent.sign,
        krakenSign(
          '/0/private/AddOrderBatch',
          String(body.nonce),
          sent.rawBody,
        ),
      )
    })

    it('a change inside one order changes the signature', async () => {
      // The point of the previous check, stated as the property that matters:
      // no field of any order can be altered in flight without invalidating it.
      const kraken = capturing()
      const tampered = [{ ...ORDERS[0], price: '101.6' }, ORDERS[1]]
      await client(kraken.adapter).submitBatchOrders({
        pair: 'SOLUSD',
        orders: tampered,
      })
      const other = kraken.seen[0]
      const otherBody = JSON.parse(other.rawBody)
      assert.strictEqual(
        other.sign,
        krakenSign(
          '/0/private/AddOrderBatch',
          String(otherBody.nonce),
          other.rawBody,
        ),
      )
      assert.notStrictEqual(other.sign, sent.sign)
    })
  })

  describe('CancelOrderBatch', () => {
    let sent: Captured
    let body: any

    before(async () => {
      const kraken = capturing()
      await client(kraken.adapter).cancelBatchOrders({ orders: TXIDS })
      sent = kraken.seen[0]
      body = JSON.parse(sent.rawBody)
    })

    it('goes out as JSON', () => {
      assert.ok(sent.contentType.includes('application/json'), sent.contentType)
      assert.ok(sent.url.endsWith('/0/private/CancelOrderBatch'), sent.url)
    })

    it('carries the ids as a JSON array', () => {
      assert.deepStrictEqual(body.orders, TXIDS)
    })

    it('signs the exact bytes it sends', () => {
      assert.strictEqual(
        sent.sign,
        krakenSign(
          '/0/private/CancelOrderBatch',
          String(body.nonce),
          sent.rawBody,
        ),
      )
    })
  })
})
