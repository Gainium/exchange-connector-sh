process.env.NODE_ENV = 'testing'

/**
 * Unit-level guard for "an `EAPI:Invalid nonce` line must name the nonce".
 *
 * Bug #329's +24h verification could not tell a *surviving duplicate nonce*
 * (the counter regressed) from *out-of-order arrival* (two strictly-increasing
 * nonces racing on one key), because the logged line carried neither value:
 *
 *   [Details: {"error":["EAPI:Invalid nonce"],"httpStatus":200},
 *    getBalance called with params: []] [200] Kraken API error: EAPI:Invalid nonce
 *
 * Two of those were logged by ONE pid in the SAME second — which is exactly the
 * shape both mechanisms produce. The verdict had to be inferred from timing.
 * With the nonce in `Details`, `pid + nonce` answers it outright.
 *
 * The nonce lives in the *signed* body, which only exists on the axios options
 * the SDK staples onto the thrown error — the same object that carries the live
 * `API-Key` / `API-Sign` headers. So this spec asserts both halves: the nonce
 * is present, and nothing else from that object came with it.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        core/src/exchange/exchanges/kraken/nonce-logging.spec.ts
 *
 * No network / auth needed — it drives handleKrakenErrors with a stub callback.
 */
import { Logger } from '@nestjs/common'
import { Futures } from '../../types'
import KrakenExchange from './index'
import { krakenNonceFromError, nextKrakenNonce } from '../../../kraken-custom'

const ex: any = new KrakenExchange(Futures.null, '', '')

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = actual === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

const LIVE_KEY = 'LIVEKEY/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const LIVE_SIGN = 'LIVESIGN/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=='

/**
 * The exact object `@siebly/kraken-api`'s `parseException` throws for a Kraken
 * spot rejection (dist/cjs/lib/BaseRestClient.js). Note two things it reproduces
 * faithfully, because both matter here:
 *  - `EAPI:Invalid nonce` comes back on HTTP **200** with the error in the body,
 *    so `code` is 200, not a failure status;
 *  - `requestParams.options.headers` holds the REAL `API-Key`/`API-Sign` while
 *    the sibling `APIKey` field is blanked — the redaction that makes the
 *    object *look* safe is on the field the SDK owns, not the ones that leak.
 */
function krakenNonceError(nonce: string, body: Record<string, any> = {}) {
  return {
    code: 200,
    message: 'OK',
    body: { error: ['EAPI:Invalid nonce'] },
    headers: {},
    requestParams: {
      method: 'POST',
      endpoint: '0/private/Balance',
      path: '/0/private/Balance',
      requestUrl: 'https://api.kraken.com/0/private/Balance',
      params: { body: { ...body } }, // caller's params — no nonce here
      options: {
        headers: {
          'API-Key': LIVE_KEY,
          'API-Sign': LIVE_SIGN,
          APIKey: 'omittedFromError',
        },
        data: { nonce, ...body }, // the signed body — this is where it is
      },
    },
  }
}

/** Capture the two arguments the handler passes to Logger.error. */
async function logLineFor(err: any) {
  let msg = ''
  let details = ''
  const origError = Logger.error
  const origWarn = Logger.warn
  ;(Logger as any).error = (m: any, d: any) => {
    msg = String(m)
    details = String(d)
  }
  ;(Logger as any).warn = () => {}
  const sleepMod = require('../../../utils/sleepUtils')
  const origSleep = sleepMod.sleep
  sleepMod.sleep = async () => {}

  await ex.handleKrakenErrors(async () => ({}), ex.getEmptyTimeProfile())(err)

  sleepMod.sleep = origSleep
  ;(Logger as any).error = origError
  ;(Logger as any).warn = origWarn
  return { msg, details }
}

async function main() {
  // ── 1) The nonce reaches the log line ─────────────────────────────────────
  const { msg, details } = await logLineFor(krakenNonceError('1786100000123'))

  expect(
    'the message line is unchanged',
    msg,
    '[200] Kraken API error: EAPI:Invalid nonce',
  )
  expect(
    'Details names the nonce the rejected request carried',
    details.includes('"nonce":"1786100000123"'),
    true,
  )

  // ── 2) …and nothing else from requestParams came with it ──────────────────
  expect('the live API-Key does not appear', details.includes(LIVE_KEY), false)
  expect(
    'the live API-Sign does not appear',
    details.includes(LIVE_SIGN),
    false,
  )
  expect(
    'no header block leaked in at all',
    /API-Key|API-Sign/.test(details),
    false,
  )

  // ── 3) A duplicate is now visible as a duplicate ──────────────────────────
  // The distinction the +24h check could not make: same value twice = the
  // counter regressed; two different values = concurrency, counter is fine.
  const a = await logLineFor(krakenNonceError('1786100000200'))
  const b = await logLineFor(krakenNonceError('1786100000200'))
  const nonceOf = (d: string) => /"nonce":"(\d+)"/.exec(d)?.[1]
  expect(
    'two rejections carrying one nonce are readable as duplicates',
    nonceOf(a.details) === nonceOf(b.details),
    true,
  )

  // ── 4) Extractor edge cases ───────────────────────────────────────────────
  expect(
    'a pre-serialized urlencoded body still yields the nonce',
    krakenNonceFromError({
      requestParams: { options: { data: 'nonce=1786100000300&pair=XBTUSD' } },
    }),
    '1786100000300',
  )
  expect(
    'a JSON-string body still yields the nonce',
    krakenNonceFromError({
      requestParams: {
        options: { data: '{"nonce":"1786100000400","pair":"XBTUSD"}' },
      },
    }),
    '1786100000400',
  )
  expect(
    'the futures path (signed with an empty nonce) yields nothing',
    krakenNonceFromError({
      requestParams: { options: { data: 'orderType=mkt&symbol=PF_XBTUSD' } },
    }),
    undefined,
  )
  expect(
    'an error this connector raised itself yields nothing',
    krakenNonceFromError(new Error('wouldNotReducePosition')),
    undefined,
  )
  expect(
    'a non-numeric nonce is rejected rather than logged',
    krakenNonceFromError({
      requestParams: { options: { data: { nonce: LIVE_SIGN } } },
    }),
    undefined,
  )
  expect(
    'undefined input is handled',
    krakenNonceFromError(undefined),
    undefined,
  )

  // ── 5) The counter itself is still strictly increasing (regression guard) ──
  // This is what a duplicate in the log would now disprove; keep it honest.
  const key = 'spec-key'
  const seen = new Set<string>()
  let monotonic = true
  let prev = -1
  for (let i = 0; i < 5000; i++) {
    const n = Number(nextKrakenNonce(key))
    if (n <= prev) monotonic = false
    prev = n
    seen.add(String(n))
  }
  expect('5000 nonces on one key are all distinct', seen.size, 5000)
  expect('…and strictly increasing', monotonic, true)

  console.log(
    failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
