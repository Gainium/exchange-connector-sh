process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #321 — "15-min Kraken outage produced ~2,850
 * Service Unavailable lines at up to 141/min per node".
 *
 * Kraken was down 07:01:45Z→07:16:38Z on 2026-08-06 (its own
 * `{"event":"alert","message":"Trading engine unavailable"}` frame is in the
 * log). The spot client's `parseException` turns an HTTP 503 into a PLAIN
 * OBJECT — not an Error:
 *   { code: 503, message: 'Service Unavailable', body, headers, requestParams }
 * so `actualError` falls through to `e.message` and the handler logs
 *   [503] Kraken API error: Service Unavailable
 * which is verbatim the line the log-triage monitor counted.
 *
 * That string matches NONE of the outage codes by name — `'EService:Unavailable'`
 * does not contain `'Service Unavailable'` — it is retryable only via the
 * numeric `'503'` entry in `retryErrors`, and it is NOT in the `isRateLimit`
 * set. So pre-fix it drew `maxAttempts = this.retry` (10) and the generic
 * `min(1000 * 2^n, 10000)` ramp: 1+2+4+8+10+10+10+10+10 = 65s of retrying and
 * TEN logged error lines per failing call. Six egress nodes × a price poll that
 * keeps starting fresh ladders = the ~2,850 lines.
 *
 * The ramp is per-request state (`timeProfile.attempts`) so it resets to zero on
 * every new call: the backoff paces retries WITHIN one call and has no memory
 * across calls. Triage filed this as "retry loop has no backoff" — there is
 * backoff; what there is not is a cap sized to a provider-wide outage.
 *
 * Precedent: bug #181 fixed the same fleet-saturation shape for the rate-limit
 * class in this exact handler by classifying it and capping/pacing its retries
 * (see rate-limit.spec.ts). This applies that pattern to the outage class.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        core/src/exchange/exchanges/kraken/outage-backoff.spec.ts
 *
 * No network / auth needed — it drives handleKrakenErrors with a stub callback.
 */
import { Logger } from '@nestjs/common'
import { Futures } from '../../types'
import KrakenExchange from './index'

const ex: any = new KrakenExchange(Futures.null, '', '')

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = actual === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

/**
 * The exact object @siebly/kraken-api's `parseException` throws for an HTTP 5xx
 * (dist/cjs/lib/BaseRestClient.js): a plain object carrying the numeric status
 * in `code` and the HTTP reason phrase in `message`.
 */
function krakenHttpError(status: number, reason: string) {
  return {
    code: status,
    message: reason,
    body: '<html><head><title>503 Service Unavailable</title></head></html>',
    headers: {},
    requestParams: { method: 'GET', endpoint: '/0/public/Ticker' },
  }
}

/**
 * Drive the real handleKrakenErrors with a callback that throws `err` the first
 * `throwTimes` times, then succeeds. Returns how many times the callback ran
 * (1 = no retry), how long the handler slept, and how many ERROR lines it
 * logged — log volume is the symptom this bug is about.
 */
async function drive(err: any, throwTimes: number) {
  let calls = 0
  const timeProfile = ex.getEmptyTimeProfile()

  // Stub sleep so the spec doesn't actually take minutes; record the waits.
  const waits: number[] = []
  const sleepMod = require('../../../utils/sleepUtils')
  const origSleep = sleepMod.sleep
  sleepMod.sleep = async (ms: number) => {
    waits.push(ms)
  }

  // Count (and silence) the error lines the handler emits.
  let errorLines = 0
  const origError = Logger.error
  ;(Logger as any).error = () => {
    errorLines++
  }
  const origWarn = Logger.warn
  ;(Logger as any).warn = () => {}

  const cb: any = async function attempt(this: any, tp = timeProfile) {
    calls++
    if (calls <= throwTimes) {
      return ex.handleKrakenErrors(cb, tp)(err)
    }
    return { status: 'OK', data: [] }
  }

  const res = await cb(timeProfile)

  sleepMod.sleep = origSleep
  ;(Logger as any).error = origError
  ;(Logger as any).warn = origWarn
  const totalWaitS = waits.reduce((a, b) => a + b, 0) / 1000
  return { calls, waits, res, errorLines, totalWaitS }
}

async function main() {
  // ── 1) The prod error really does render as the line the monitor counted ───
  const err503 = krakenHttpError(503, 'Service Unavailable')
  let logged = ''
  const origError = Logger.error
  ;(Logger as any).error = (msg: any) => {
    logged = String(msg)
  }
  await ex.handleKrakenErrors(async () => ({}), ex.getEmptyTimeProfile())(
    err503,
  )
  ;(Logger as any).error = origError
  expect(
    'a Kraken 503 logs the exact prod line "[503] Kraken API error: Service Unavailable"',
    logged,
    '[503] Kraken API error: Service Unavailable',
  )

  // The name-based codes do NOT catch it — retryability comes from '503' only.
  expect(
    '"EService:Unavailable" does NOT substring-match "Service Unavailable"',
    'EService:Unavailable'.includes('Service Unavailable'),
    false,
  )
  expect(
    'the numeric 503 entry is what makes it retryable',
    ex.retryErrors.some((c: string) => String(503).includes(c)),
    true,
  )

  // ── 2) A brief blip must still self-heal (regression guard) ────────────────
  const blip = await drive(err503, 1)
  expect('a one-off 503 is still retried', blip.calls, 2)
  expect('and the retry succeeds', (blip.res as any)?.status, 'OK')

  // ── 3) A SUSTAINED outage — this is the bug ───────────────────────────────
  const outage = await drive(err503, 99)
  console.log(
    `\n  sustained 503: attempts=${outage.calls} errorLines=${outage.errorLines} ` +
      `waits=[${outage.waits.join(',')}] totalWait=${outage.totalWaitS}s\n`,
  )
  expect('sustained outage caps attempts at 3', outage.calls, 3)
  expect('…so it logs 3 error lines per call, not 10', outage.errorLines, 3)
  expect(
    'and gives up in well under the old 65s ladder',
    outage.totalWaitS <= 30,
    true,
  )
  expect(
    'gives up as NOTOK rather than looping',
    (outage.res as any)?.status,
    'NOTOK',
  )

  // Same treatment for the other provider-outage spellings/statuses.
  for (const [status, reason] of [
    [502, 'Bad Gateway'],
    [504, 'Gateway Timeout'],
    [520, 'Web Server Returned an Unknown Error'],
  ] as [number, string][]) {
    const r = await drive(krakenHttpError(status, reason), 99)
    expect(`HTTP ${status} is capped the same way`, r.calls, 3)
  }
  const named = await drive(
    Object.assign(new Error('EService:Unavailable'), {
      body: { error: ['EService:Unavailable'] },
    }),
    99,
  )
  expect('the spot code "EService:Unavailable" is capped too', named.calls, 3)
  const busy = await drive(
    Object.assign(new Error('EService:Busy'), {
      body: { error: ['EService:Busy'] },
    }),
    99,
  )
  expect('"EService:Busy" is capped too', busy.calls, 3)

  // ── 4) Regression guards: the OTHER classes keep their own pacing ──────────
  const rl = await drive(
    Object.assign(new Error('EGeneral:Too many requests'), {
      body: { error: ['EGeneral:Too many requests'] },
    }),
    99,
  )
  expect('rate-limit class still caps at 3 attempts (bug #181)', rl.calls, 3)
  expect(
    'rate-limit class still waits 30s, not the outage pacing',
    rl.waits.every((w) => w === 30000),
    true,
  )

  const nonce = await drive(
    Object.assign(new Error('EAPI:Invalid nonce'), {
      body: { error: ['EAPI:Invalid nonce'] },
    }),
    99,
  )
  expect(
    'ordinary transients keep the full 10-attempt ladder',
    nonce.calls,
    10,
  )
  // `attempts` starts at 1 (getEmptyTimeProfile), so the ramp opens at 2s.
  expect(
    'ordinary transients keep the 2s→10s exponential ramp',
    nonce.waits.join(','),
    '2000,4000,8000,10000,10000,10000,10000,10000,10000',
  )

  const rejected = await drive(
    Object.assign(new Error('EOrder:Insufficient funds'), {
      body: { error: ['EOrder:Insufficient funds'] },
    }),
    99,
  )
  expect('a genuine rejection is still never retried', rejected.calls, 1)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main()
