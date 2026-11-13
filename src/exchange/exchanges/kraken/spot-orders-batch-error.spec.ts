process.env.NODE_ENV = 'testing'

/**
 * Kraken spot `getOrdersBatch` when the QueryOrders call THROWS.
 *
 * `@siebly/kraken-api` throws on any venue error array, even on an HTTP 200 —
 * a key without "Query Open/Closed Orders" permission answers
 * `EGeneral:Permission denied` that way. The batch path awaited the SDK with no
 * catch, so the throw escaped the controller and became a bare 500 from Nest's
 * exception handler, with the venue's reason lost from the answer. The batch is
 * best-effort: the answer it owes is a NOTOK that names what the venue said,
 * logged as the message only, never the thrown object (which carries the signed
 * request).
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 */
import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { Logger } from '@nestjs/common'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const TXIDS = ['OQ7Y2M-Q7E4Y-3XPZ3I', 'O65DRT-ANH2I-6R2S2E']
const SECRET = 'S3CR3T-api-secret-value-must-not-be-logged'
const KEY = 'K3Y-api-key-value-must-not-be-logged'

function sdkError() {
  return {
    code: 200,
    message: 'OK',
    body: { error: ['EGeneral:Permission denied'] },
    headers: { 'API-Key': KEY, 'API-Sign': 'sig' },
    requestOptions: { apiKey: KEY, apiSecret: SECRET },
    requestParams: { txid: TXIDS.join(',') },
  }
}

function makeExchange(getOrders: () => Promise<unknown>) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.retry = 0
  ex.spotClient = { getOrders }
  return ex
}

describe('kraken spot getOrdersBatch when the venue call throws (§spot batch read)', () => {
  const logged: string[] = []
  const originals: Record<string, any> = {}
  before(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      originals[level] = (Logger as any)[level]
      ;(Logger as any)[level] = (...args: unknown[]) => {
        logged.push(
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        )
      }
    }
  })
  after(() => {
    for (const level of Object.keys(originals)) {
      ;(Logger as any)[level] = originals[level]
    }
  })

  describe('a key without order-query permission', () => {
    let res: any
    let thrown: unknown
    before(async () => {
      const ex = makeExchange(async () => {
        throw sdkError()
      })
      try {
        res = await ex.getOrdersBatch({
          symbol: 'BTC-USD',
          newClientOrderIds: TXIDS,
        })
      } catch (e) {
        thrown = e
      }
    })
    it('does not throw (no bare 500 from the exception handler)', () => {
      assert.strictEqual(thrown, undefined)
    })
    it('answers NOTOK', () => {
      assert.strictEqual(res?.status, StatusEnum.notok)
    })
    it("carries the venue's reason", () => {
      assert.ok(
        `${res?.reason}`.includes('EGeneral:Permission denied'),
        `reason was ${res?.reason}`,
      )
    })
    it('is not worded as "not supported" (main-app would latch batching off)', () => {
      assert.ok(!/not supported|unsupported/i.test(`${res?.reason}`))
    })
    it('logs the venue message, and no credential', () => {
      const all = logged.join('\n')
      assert.ok(all.includes('EGeneral:Permission denied'), all)
      assert.ok(!all.includes(SECRET), 'secret reached the logger')
      assert.ok(!all.includes(KEY), 'api key reached the logger')
    })
  })

  describe('a later chunk throwing after an earlier one answered', () => {
    let res: any
    before(async () => {
      let call = 0
      const ids = Array.from(
        { length: 51 },
        (_, i) => `O${String(i).padStart(5, '0')}-AAAAA-BBBBBB`,
      )
      const ex = makeExchange(async () => {
        call++
        if (call === 1) {
          return {
            error: [],
            result: {
              [ids[0]]: {
                status: 'open',
                userref: 0,
                vol: '1',
                vol_exec: '0',
                price: '0',
                fee: '0',
                descr: {
                  pair: 'XBTUSD',
                  price: '60000',
                  ordertype: 'limit',
                  type: 'buy',
                },
              },
            },
          }
        }
        throw sdkError()
      })
      res = await ex.getOrdersBatch({
        symbol: 'BTC-USD',
        newClientOrderIds: ids,
      })
    })
    it('still returns the rows already resolved', () => {
      assert.strictEqual(res?.status, StatusEnum.ok)
      assert.strictEqual(res?.data?.length, 1)
    })
  })
})
