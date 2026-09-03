process.env.NODE_ENV = 'testing'

/**
 * Bug #313 — `clearinghouseState` 422 "Failed to deserialize the JSON body
 * into the target type" on every connector node.
 *
 * That HL error is NOT an API contract change: HL's info endpoint returns it
 * whenever the `user` field is not a well-formed address (see the live probes
 * asserted in `hlAddressLooksValid` below). It is what a *misconfigured
 * account address* looks like from our side — and because the balance /
 * positions loops fan out over HL native + every active builder dex, ONE such
 * account produces a burst of identical 422s per poll, on whichever connector
 * node the balancer routed it to. Fleet-wide log noise, single-account cause.
 *
 * Two defects fall out of that, both asserted here:
 *   1. `hlInfoErrorKind` classified 422/deserialize as `transient`, so every
 *      one of those calls was retried 3x with a 750ms sleep between attempts —
 *      burning ~1.5s and 3 rate-limit slots per dex on an error that can never
 *      succeed on retry.
 *   2. Nothing validated the address before calling HL, and the per-dex catch
 *      swallows the failure (`state: null`), so `futures_getBalance` /
 *      `futures_getPositions` return **status OK with an empty result** — the
 *      bot reads a misconfigured account as "no funds / no positions" instead
 *      of surfacing a configuration error.
 *
 * Run: `npm test` (mocha).
 *
 * Makes real (unauthenticated, read-only) calls to api.hyperliquid.xyz.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'

// A malformed account address: 39 hex digits, not 40. This is the shape of a
// real onboarding typo (one character dropped on paste).
const BAD_ADDRESS = '0x14791697260e4c9a71f18484c9f997b308e5932'
const GOOD_ADDRESS = '0x14791697260e4c9a71f18484c9f997b308e59325'
const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'

/** `getActual` is evaluated lazily, inside the it(), after `before()` has run. */
function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

/**
 * Count real HTTP calls the SDK makes to the HL info endpoint. The SDK passes
 * a `Request` object to `fetch` (not url+init), so read the body off a clone.
 */
function instrumentFetch(): {
  calls: () => number
  restore: () => void
} {
  const orig = globalThis.fetch
  let n = 0
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = args[0]
    if (req instanceof Request && req.url.includes('/info')) {
      const body = await req.clone().text()
      if (body.includes('clearinghouseState')) n++
    }
    return orig(...args)
  }) as typeof fetch
  return { calls: () => n, restore: () => (globalThis.fetch = orig) }
}

const probe = async (user: string) => {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user }),
  })
  return r.status
}

describe('hyperliquid bad-address', () => {
  describe("HL's own acceptance, probed live", () => {
    // Documents exactly which shapes the guard may reject. Note HL accepts a
    // BARE 40-hex address (no 0x) — a stricter /^0x…/ guard would break an
    // account that works today.
    let goodStatus: number
    let bareStatus: number
    let badStatus: number
    let emptyStatus: number

    before(async () => {
      goodStatus = await probe(GOOD_ADDRESS)
      bareStatus = await probe(GOOD_ADDRESS.slice(2))
      badStatus = await probe(BAD_ADDRESS)
      emptyStatus = await probe('')
    })

    expect('HL accepts 0x + 40 hex', () => goodStatus, 200)
    expect('HL accepts bare 40 hex', () => bareStatus, 200)
    expect('HL rejects 39 hex (the typo)', () => badStatus, 422)
    expect('HL rejects empty', () => emptyStatus, 422)
  })

  describe('what the connector does with that address', () => {
    let httpCalls: number
    let bal: any
    let pos: any
    let oo: any

    before(async () => {
      const ex = new HyperliquidExchange(
        Futures.usdm,
        BAD_ADDRESS,
        PRIVATE_KEY,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      )

      const fetchSpy = instrumentFetch()
      bal = await ex.futures_getBalance()
      httpCalls = fetchSpy.calls()
      fetchSpy.restore()

      // Positions and open orders swallow the same per-dex failure, so they
      // must fail loudly too — an empty position list is what a bot acts on.
      pos = await ex.futures_getPositions()
      oo = await ex.getAllOpenOrders()
    })

    // The fix must fail fast and loud, not retry and lie.
    expect('no HTTP call made for a malformed address', () => httpCalls, 0)
    expect('balance does NOT report OK', () => bal.status, 'NOTOK')
    expect(
      'balance reason names the misconfiguration',
      () => /invalid wallet address/i.test(`${bal?.reason ?? ''}`),
      true,
    )
    expect('positions do NOT report OK', () => pos.status, 'NOTOK')
    expect('open orders do NOT report OK', () => oo.status, 'NOTOK')
  })

  describe('a GOOD address must still work unchanged (no false positive)', () => {
    let goodBalStatus: string
    let bareBalStatus: string

    before(async () => {
      const good = new HyperliquidExchange(
        Futures.usdm,
        GOOD_ADDRESS,
        PRIVATE_KEY,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      )
      goodBalStatus = (await good.futures_getBalance()).status

      // HL also accepts a bare 40-hex address — the guard must not reject it.
      const bare = new HyperliquidExchange(
        Futures.usdm,
        GOOD_ADDRESS.slice(2),
        PRIVATE_KEY,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      )
      bareBalStatus = (await bare.futures_getBalance()).status
    })

    expect('valid address still returns OK', () => goodBalStatus, 'OK')
    expect('bare 40-hex address still returns OK', () => bareBalStatus, 'OK')
  })
})
