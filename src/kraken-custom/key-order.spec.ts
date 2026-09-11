process.env.NODE_ENV = 'testing'

/**
 * Concurrent signed calls on one Kraken API key must reach Kraken in nonce
 * order.
 *
 * Kraken accepts a signed spot request only if its nonce is strictly greater
 * than the last nonce that key had accepted — judged when the request ARRIVES.
 * The shared per-key counter (`nextKrakenNonce`) makes nonces unique and
 * increasing at signing time, but two requests signed a millisecond apart and
 * sent at once can still land in the opposite order: the later nonce is
 * accepted first and the earlier one is rejected with `EAPI:Invalid nonce`.
 * Enough of those and Kraken locks the key (`EGeneral:Temporary lockout`), which
 * stops every bot on the account.
 *
 * The fake Kraken below enforces that rule behind an axios adapter, with uneven
 * per-request latency so arrival order differs from send order. No network.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { SpotClient } from './SpotClient'
import { inKrakenKeyOrder } from './nonce'

const SECRET = Buffer.from('k'.repeat(64)).toString('base64')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function check(label: string, ok: () => boolean, detail: () => unknown) {
  it(label, () => {
    if (!ok()) {
      throw new Error(`${label}: ${JSON.stringify(detail())}`)
    }
  })
}

/** Uneven, deterministic latencies: request i spends latency(i) ms on the wire. */
const UNEVEN = [12, 0, 7, 3, 10, 1, 5, 9, 2, 8]

function fakeKraken(latency: (i: number) => number) {
  const lastAccepted = new Map<string, number>()
  const rejected: string[] = []
  let sent = 0
  let inFlight = 0
  let maxInFlight = 0

  const adapter = async (config: any) => {
    const i = sent++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await wait(latency(i))

    const headers = config.headers ?? {}
    const key = headers.get?.('API-Key') ?? headers['API-Key'] ?? 'public'
    const body =
      typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    const nonce = Number(body?.nonce ?? 0)

    let data: any = { error: [], result: {} }
    if (body?.nonce !== undefined) {
      if (nonce > (lastAccepted.get(key) ?? 0)) {
        lastAccepted.set(key, nonce)
      } else {
        rejected.push(String(nonce))
        data = { error: ['EAPI:Invalid nonce'] }
      }
    }
    inFlight--
    return {
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
    }
  }

  return { adapter, stats: () => ({ rejected, maxInFlight, sent }) }
}

const client = (apiKey: string, adapter: any) =>
  new SpotClient({ apiKey, apiSecret: SECRET }, { adapter } as any)

/** Fire `n` private calls at once; resolve once all settle. */
const burst = (c: SpotClient, n: number) =>
  Promise.allSettled(
    Array.from({ length: n }, () => (c as any).getAccountBalance()),
  )

describe('kraken key order', () => {
  describe('ten simultaneous private calls on one key', () => {
    let stats: ReturnType<ReturnType<typeof fakeKraken>['stats']>

    before(async () => {
      const kraken = fakeKraken((i) => UNEVEN[i % UNEVEN.length])
      await burst(client('key-a', kraken.adapter), 10)
      stats = kraken.stats()
    })

    check(
      'all ten reached Kraken',
      () => stats.sent === 10,
      () => stats,
    )
    check(
      'none was rejected for an out-of-order nonce',
      () => stats.rejected.length === 0,
      () => stats,
    )
    check(
      'they were on the wire one at a time',
      () => stats.maxInFlight === 1,
      () => stats,
    )
  })

  describe('different keys are not queued behind each other', () => {
    let stats: ReturnType<ReturnType<typeof fakeKraken>['stats']>

    before(async () => {
      const kraken = fakeKraken(() => 20)
      await Promise.all([
        burst(client('key-b', kraken.adapter), 3),
        burst(client('key-c', kraken.adapter), 3),
      ])
      stats = kraken.stats()
    })

    check(
      'one request per key in flight at once',
      () => stats.maxInFlight === 2,
      () => stats,
    )
    check(
      'and still no nonce rejection',
      () => stats.rejected.length === 0,
      () => stats,
    )
  })

  describe('public calls are not queued', () => {
    let stats: ReturnType<ReturnType<typeof fakeKraken>['stats']>

    before(async () => {
      const kraken = fakeKraken(() => 20)
      const c = client('key-d', kraken.adapter) as any
      await Promise.all(
        Array.from({ length: 3 }, () =>
          c._call('GET', '0/public/Time', {}, true),
        ),
      )
      stats = kraken.stats()
    })

    check(
      'all three public calls ran concurrently',
      () => stats.maxInFlight === 3,
      () => stats,
    )
  })

  describe('the queue never wedges a key', () => {
    let secondStartedAfter = -1
    let afterFailure = ''

    before(async () => {
      // A stalled request holds the key only up to the bound, then the next
      // call proceeds even though the first has not answered.
      const t0 = Date.now()
      const stalled = inKrakenKeyOrder('key-e', () => wait(300), 30)
      await inKrakenKeyOrder('key-e', async () => {
        secondStartedAfter = Date.now() - t0
      })
      await stalled

      // A failed request releases the key.
      await inKrakenKeyOrder('key-f', async () => {
        throw new Error('boom')
      }).catch(() => undefined)
      afterFailure = await inKrakenKeyOrder('key-f', async () => 'ran')
    })

    check(
      'a stalled request releases the key after the hold bound',
      () => secondStartedAfter >= 25 && secondStartedAfter < 250,
      () => ({ secondStartedAfter }),
    )
    check(
      'a failed request releases the key',
      () => afterFailure === 'ran',
      () => ({ afterFailure }),
    )
  })
})
