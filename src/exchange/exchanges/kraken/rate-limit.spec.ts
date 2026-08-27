process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #181 — "Kraken EGeneral:Too many requests on
 * getCandles saturating all six nodes".
 *
 * Kraken's *public* (per-IP) rate limit is returned as HTTP **200** with the
 * code in the body:
 *   {"error":["EGeneral:Too many requests"],"httpStatus":200}
 * getCandles turns that into `throw new Error('EGeneral:Too many requests')`.
 *
 * Pre-fix that string was in neither `retryErrors` nor the `isRateLimit` set, so
 * `shouldRetry` was false: the call failed instantly with no backoff and the
 * archive backfiller immediately re-requested. On an affected egress node
 * nearly every error line carried this signature, with **zero** "Retrying
 * after" lines.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/kraken/rate-limit.spec.ts
 *
 * No network / auth needed — it drives handleKrakenErrors with a stub callback.
 */
import { Futures } from '../../types'
import KrakenExchange from './index'
import limitHelper from './limit'

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
 * Drive the real handleKrakenErrors with a callback that throws `error` the
 * first `throwTimes` times, then succeeds. Returns how many times the callback
 * ran (1 = no retry) and how long the handler slept.
 */
async function drive(error: string, throwTimes: number) {
  let calls = 0
  const timeProfile = ex.getEmptyTimeProfile()

  // Stub sleep so the 30s backoff doesn't make the spec take minutes; record it.
  const waits: number[] = []
  const sleepMod = require('../../../utils/sleepUtils')
  const origSleep = sleepMod.sleep
  sleepMod.sleep = async (ms: number) => {
    waits.push(ms)
  }

  const cb: any = async function attempt(this: any, tp = timeProfile) {
    calls++
    if (calls <= throwTimes) {
      const e: any = new Error(error)
      e.body = { error: [error], httpStatus: 200 }
      return ex.handleKrakenErrors(cb, tp)(e)
    }
    return { status: 'OK', data: [] }
  }

  const res = await cb(timeProfile)
  sleepMod.sleep = origSleep
  return { calls, waits, res }
}

async function main() {
  // ── 1) The classification predicates, straight off the instance ────────────
  const retryable = (msg: string) =>
    ex.retryErrors.some((code: string) => msg.includes(code))

  expect(
    'retryErrors matches "EGeneral:Too many requests"',
    retryable('EGeneral:Too many requests'),
    true,
  )
  // Regression guards: the pre-existing classes must keep matching.
  expect(
    'retryErrors still matches "EAPI:Rate limit exceeded"',
    retryable('EAPI:Rate limit exceeded'),
    true,
  )
  expect(
    'retryErrors still matches "apiLimitExceeded"',
    retryable('apiLimitExceeded'),
    true,
  )
  expect(
    'retryErrors still matches "EGeneral:Temporary lockout"',
    retryable('EGeneral:Temporary lockout'),
    true,
  )
  // A genuine rejection must NOT become retryable.
  expect(
    'retryErrors does NOT match "EOrder:Insufficient funds"',
    retryable('EOrder:Insufficient funds'),
    false,
  )

  // ── 2) The public IP limit must NOT drop an account's private tier ─────────
  // noteRateLimited is the per-account adaptive downgrade; an IP-level public
  // rejection says nothing about any account's private budget.
  let noted: string[] = []
  const origNote = limitHelper.noteRateLimited
  ;(limitHelper as any).noteRateLimited = (k?: string) => {
    noted.push(String(k))
  }

  noted = []
  await drive('EGeneral:Too many requests', 1)
  expect(
    'public "Too many requests" does NOT call noteRateLimited',
    noted.length,
    0,
  )

  noted = []
  await drive('EAPI:Rate limit exceeded', 1)
  expect(
    'account "Rate limit exceeded" still calls noteRateLimited',
    noted.length,
    1,
  )

  ;(limitHelper as any).noteRateLimited = origNote

  // ── 3) End-to-end: the handler now retries with rate-limit pacing ──────────
  const once = await drive('EGeneral:Too many requests', 1)
  expect('transient public 429 is retried (callback runs twice)', once.calls, 2)
  expect('backoff used the rate-limit wait (30s)', once.waits[0], 30000)
  expect('and the retry succeeds', (once.res as any)?.status, 'OK')

  // Sustained saturation: capped at 3 attempts, not this.retry (10).
  const sustained = await drive('EGeneral:Too many requests', 99)
  expect('sustained saturation caps at 3 attempts', sustained.calls, 3)
  expect(
    'every wait is the 30s rate-limit pacing (never the 1-10s ramp)',
    sustained.waits.every((w) => w === 30000),
    true,
  )
  expect(
    'gives up as NOTOK rather than looping',
    (sustained.res as any)?.status,
    'NOTOK',
  )

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main()
