process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #385 — the Coinbase Unauthorized retry ladder.
 *
 * `handleCoinbaseErrors` treated a 401 `Unauthorized` as a retryable condition
 * and ran the full `this.retry = 10` attempts at a flat 2s sleep each. A
 * revoked / expired / wrong-type key cannot become valid by asking again, so
 * every one of those attempts was pure waiting: ~18s per call, then the same
 * `NOTOK / Unauthorized` it could have returned at once.
 *
 * Production consequence: main-app's `updateUserBalance` refreshes EVERY stored
 * connection on a portfolio refresh, and its worker pool waits for all of them,
 * so ONE dead Coinbase connection set the wall clock of the whole
 * `updateBalance` GraphQL resolver. On 2026-08-11 that was
 * `[SlowGraphQL] op=updateBalance ms=19442..19742` for marioenzler69@gmail.com,
 * sustained over seven distinct minutes — and the same 19.3-20.8s band for
 * every other affected user, all three of whom hold a Coinbase connection
 * already flagged `status: false`. The connector logged the ladder verbatim:
 * `Coinbase Unauthorized wait 2000s 1` … `9`, 195k lines across the archive.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/coinbase/unauthorized-retry.spec.ts
 *
 * No network / auth needed — the Coinbase REST client is stubbed.
 */
import { Futures } from '../../types'
import CoinbaseExchange from './index'

let failures = 0
function check(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

/** A connector whose `listAccounts` behaves however the test wants. */
function connector(listAccounts: () => Promise<unknown>) {
  const ex = new CoinbaseExchange(
    Futures.null,
    'dead-key',
    'dead-secret',
  ) as unknown as {
    client: unknown
    getBalance: () => Promise<{ status: string; reason: string; data: unknown }>
  }
  let calls = 0
  ex.client = {
    rest: {
      account: {
        listAccounts: () => {
          calls++
          return listAccounts()
        },
      },
    },
  }
  return { ex, calls: () => calls }
}

const main = async () => {
  // 1) A 401 is a verdict, not a blip: one re-try, then report. Before the fix
  //    this was 10 venue calls and ~18 000ms of sleep.
  {
    const { ex, calls } = connector(() =>
      Promise.reject(new Error('Unauthorized')),
    )
    const started = Date.now()
    const res = await ex.getBalance()
    const ms = Date.now() - started
    check('unauthorized | venue calls', calls(), 2)
    check('unauthorized | status', res.status, 'NOTOK')
    check('unauthorized | reason', res.reason, 'Unauthorized')
    check('unauthorized | under 5s', ms < 5000, true)
    console.log(`      (took ${ms}ms; the ladder used to take ~18000ms)`)
  }

  // 2) Valid credentials are untouched — one call, no retry, real balances.
  {
    const { ex, calls } = connector(() =>
      Promise.resolve({
        data: [
          {
            currency: 'USDT',
            available_balance: { value: '12.5' },
            hold: { value: '0.5' },
          },
        ],
        pagination: { has_next: false },
      }),
    )
    const res = await ex.getBalance()
    check('happy path | venue calls', calls(), 1)
    check('happy path | status', res.status, 'OK')
    check('happy path | data', res.data, [
      { asset: 'USDT', free: 12.5, locked: 0.5 },
    ])
  }

  // 3) Every OTHER retryable Coinbase error keeps its ladder — this fix is
  //    scoped to the one signature that can never succeed on a retry.
  {
    const { ex, calls } = connector(() =>
      Promise.reject(new Error('Something went wrong')),
    )
    const settled = await Promise.race([
      ex.getBalance().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still-retrying'), 9000)),
    ])
    check('other errors | still retrying after 9s', settled, 'still-retrying')
    check('other errors | more than one attempt', calls() > 1, true)
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
