process.env.NODE_ENV = 'testing'

/**
 * Spec 012 — "A Kraken order call that is deferred still spends a token in the
 * bucket that admitted it."
 *
 * Kraken gates a private order call on TWO independent budgets: the per-key
 * private-REST counter and the per-pair matching-engine counter. `addOrderCall`
 * consults both and returns `Math.max()` of their waits — but each bucket
 * charges itself the moment *it* admits, regardless of whether the other one
 * refused. `checkLimits` then re-asks after sleeping, so the bucket that
 * admitted on the previous attempt is charged AGAIN for a request that was
 * never sent.
 *
 * These specs drive the real `limit.ts` through a faithful copy of
 * `checkLimits`' charge loop (index.ts:879-915) under a virtual clock, and
 * count how many times each bucket is actually charged per SENT call. Both
 * must be exactly 1.
 *
 * Run: `npm test` (mocha). No network, no auth, no wall-clock sleeping.
 */
import { describe, it, before, after } from 'mocha'

// The limiter reads `process.env` at call time, so the mode is set in the
// top-level `before()` below rather than here — setting it at module load
// would hand it to every other spec file too, for the same reason the clock
// must not be installed here (spec 018 §1.2). The numbers below are identical
// in either mode (spec §2.2), and both are exercised at the bottom of this
// file.

// ── virtual clock ───────────────────────────────────────────────────────────
// `limit.ts` reads Date.now() directly for decay; "sleeping" is advancing VNOW.
//
// It is installed in the top-level `before()` below and handed back in the
// matching `after()` — NOT at module load. Mocha loads every spec file before
// it runs any test, so a clock patched here would be the clock every file
// sorting ahead of this one runs on, and their subjects read `Date.now()` too
// (spec 018 §1.2).
//
// The anchor is relative, never an absolute instant: `limit.ts` is a
// process-wide singleton and its decay only runs forward, so a clock that
// starts BEHIND the timestamps an earlier spec left on it would find buckets
// that never refill (spec 018 §4.3). `batch-limit.spec.ts` runs first and
// leaves them ~1h ahead of real time; a day of headroom clears that without
// needing to be re-tuned when its advance grows.
let VNOW = 0
let previousDateNow: () => number
let previousMode: string | undefined

/** Comfortably past anything an earlier spec left on the shared limiter. */
const SETTLE_MS = 24 * 60 * 60 * 1000

// eslint-disable-next-line @typescript-eslint/no-var-requires
import limitHelper, {
  ADD_ORDER_COST,
  CANCEL_ORDER_COST,
  REST_MAX_COUNTER,
  MATCHING_ENGINE_THRESHOLD,
} from './limit'

/** index.ts:445 */
const KRAKEN_LIMIT_WAIT_ATTEMPTS = 3
/** A realistic Kraken round trip, so the cadence below is comparable to prod. */
const RTT_MS = 150

const PAIR = 'SN64/USD'

/** Current absolute counter values, read back through the published usage. */
function counters() {
  const u = limitHelper.getUsage()
  return {
    rest: (u.find((x) => x.type === 'rest')?.value ?? 0) * REST_MAX_COUNTER,
    engine:
      (u.find((x) => x.type === 'matching_engine')?.value ?? 0) *
      MATCHING_ENGINE_THRESHOLD,
  }
}

/**
 * Faithful copy of `KrakenExchange.checkLimits`' charge loop (index.ts:907-915),
 * instrumented to count how many times each bucket was actually charged for the
 * one call this represents.
 */
async function checkLimits(
  accountKey: string,
  kind: 'add' | 'cancel' | 'rest',
) {
  let restCharges = 0
  let engineCharges = 0

  const charge = async () => {
    const before = counters()
    const wait =
      kind === 'rest'
        ? await limitHelper.addRestCall(false, accountKey)
        : await limitHelper.addOrderCall(PAIR, kind, accountKey)
    const after = counters()
    // A charge is an INCREASE. Decay only ever lowers a counter, and the clock
    // does not advance inside a charge, so any increase is this call's own.
    if (after.rest - before.rest > 1e-6) restCharges++
    if (after.engine - before.engine > 1e-6) engineCharges++
    return wait
  }

  let waitTime = await charge()
  for (
    let attempt = 0;
    waitTime > 0 && attempt < KRAKEN_LIMIT_WAIT_ATTEMPTS;
    attempt++
  ) {
    VNOW += waitTime // the real `await sleep(waitTime)`
    waitTime = await charge()
  }
  return { restCharges, engineCharges }
}

/**
 * Run `n` order calls back to back on a fresh account key and report the
 * per-call charge counts once the buckets have reached steady state (the first
 * calls run free off the initial burst allowance and are not representative).
 */
async function steadyState(kind: 'add' | 'cancel', accountKey: string) {
  const N = 120
  const SETTLE = 60
  let rest = 0
  let engine = 0
  const gaps: number[] = []
  let last = VNOW

  for (let i = 0; i < N; i++) {
    const c = await checkLimits(accountKey, kind)
    VNOW += RTT_MS
    if (i >= SETTLE) {
      rest += c.restCharges
      engine += c.engineCharges
      gaps.push(VNOW - last)
    }
    last = VNOW
  }

  const n = N - SETTLE
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    restPerCall: rest / n,
    enginePerCall: engine / n,
    medianGapMs: sorted[Math.floor(sorted.length / 2)],
  }
}

/**
 * The reporter's shape: a 48-order grid teardown. `cancelOrder({symbol,
 * newClientOrderId})` resolves the txid with `getOrder` (index.ts:2877) and only
 * then cancels, so a single cancelled order is TWO private-REST calls.
 */
async function teardownSeconds(accountKey: string, orders = 48) {
  const t0 = VNOW
  for (let i = 0; i < orders; i++) {
    await checkLimits(accountKey, 'rest') // getOrder — resolve the txid
    VNOW += RTT_MS
    await checkLimits(accountKey, 'cancel') // CancelOrder
    VNOW += RTT_MS
  }
  return (VNOW - t0) / 1000
}

function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    if (actual !== want) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

let keySeq = 0
/** A fresh, never-seen account key so each case starts from an empty bucket. */
const freshKey = () => `spec012-acct-${++keySeq}`

describe('spec 012 — Kraken order calls charge both buckets atomically', () => {
  before(() => {
    previousDateNow = Date.now
    previousMode = process.env.KRAKEN_PER_ACCOUNT_LIMITS
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'true'
    VNOW = Date.now() + SETTLE_MS
    ;(Date as any).now = () => VNOW
  })

  after(() => {
    // Drain every counter this file charged before handing the clock back:
    // `getUsage` is what applies decay, and it has to be asked in both modes
    // because each one reads a different set of entries. Then give back both
    // globals this suite borrowed (spec 018 §4.4).
    VNOW += SETTLE_MS
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'true'
    limitHelper.getUsage()
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'false'
    limitHelper.getUsage()
    // `process.env.X = undefined` stores the literal string 'undefined', which
    // is not what this suite found — delete the key instead when it was unset.
    if (previousMode === undefined) delete process.env.KRAKEN_PER_ACCOUNT_LIMITS
    else process.env.KRAKEN_PER_ACCOUNT_LIMITS = previousMode
    ;(Date as any).now = previousDateNow
  })

  // §1.1 — one SENT call spends exactly one token in each bucket.
  describe('§1.1 a sent order call spends exactly one token per bucket', () => {
    let cancel: Awaited<ReturnType<typeof steadyState>>
    let add: Awaited<ReturnType<typeof steadyState>>

    before(async () => {
      cancel = await steadyState('cancel', freshKey())
      VNOW += 60 * 60 * 1000 // let every bucket drain between cases
      add = await steadyState('add', freshKey())
      VNOW += 60 * 60 * 1000
    })

    // Pre-fix these are 1.70 and 2.00 respectively (spec §1.2): the re-ask loop
    // re-charges whichever bucket admitted while the other one was refusing.
    expect(
      'cancel: REST charges per sent call is exactly 1',
      () => cancel.restPerCall,
      1,
    )
    expect(
      'cancel: matching-engine charges per sent call is exactly 1',
      () => cancel.enginePerCall,
      1,
    )
    expect(
      'add: REST charges per sent call is exactly 1',
      () => add.restPerCall,
      1,
    )
    expect(
      'add: matching-engine charges per sent call is exactly 1',
      () => add.enginePerCall,
      1,
    )
  })

  // The fix must not loosen either budget: the cadence may never outrun what
  // the slower of the two buckets can sustain for a single charge per call.
  describe('§1.1 neither budget is loosened', () => {
    let cancel: Awaited<ReturnType<typeof steadyState>>
    let add: Awaited<ReturnType<typeof steadyState>>

    before(async () => {
      cancel = await steadyState('cancel', freshKey())
      VNOW += 60 * 60 * 1000
      add = await steadyState('add', freshKey())
      VNOW += 60 * 60 * 1000
    })

    // Intermediate REST decay is 0.5/s => one token can be spent every 2000ms;
    // the matching engine decays 2.34/s => CANCEL_ORDER_COST costs 3419ms.
    const restFloorMs = 1000 / 0.5
    const cancelEngineFloorMs = Math.ceil((CANCEL_ORDER_COST / 2.34) * 1000)
    const addEngineFloorMs = Math.ceil((ADD_ORDER_COST / 2.34) * 1000)

    expect(
      'cancel cadence still respects the slower of the two budgets',
      () =>
        cancel.medianGapMs >=
        Math.max(restFloorMs, cancelEngineFloorMs) - RTT_MS,
      true,
    )
    expect(
      'add cadence still respects the slower of the two budgets',
      () => add.medianGapMs >= Math.max(restFloorMs, addEngineFloorMs) - RTT_MS,
      true,
    )
  })

  // §2.2 — the reporter's own shape. Pre-fix this harness reproduces the
  // reported sweep at 180.3s; the fix must measurably shorten it without
  // exceeding either budget.
  describe('§2.2 the 48-order teardown the bug reports', () => {
    let seconds: number

    before(async () => {
      VNOW += 60 * 60 * 1000
      seconds = await teardownSeconds(freshKey())
      VNOW += 60 * 60 * 1000
    })

    it('48-order teardown is shorter than the 180.3s this harness measured pre-fix', () => {
      if (!(seconds < 180)) {
        throw new Error(
          `48-order teardown took ${seconds.toFixed(1)}s, want < 180s (pre-fix: 180.3s)`,
        )
      }
      // Reported for the record — the residual is Kraken's real REST budget
      // spent at two calls per cancelled order (spec §4.2), not something this
      // fix can remove.
      // eslint-disable-next-line no-console
      console.log(`      → 48-order teardown: ${seconds.toFixed(1)}s`)
    })
  })

  // The legacy global counter must get the same guarantee — it is what runs
  // whenever KRAKEN_PER_ACCOUNT_LIMITS is not 'true', which is the default.
  describe('§1.1 the legacy global counter is fixed too', () => {
    let cancel: Awaited<ReturnType<typeof steadyState>>

    before(async () => {
      process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'false'
      VNOW += 60 * 60 * 1000
      cancel = await steadyState('cancel', freshKey())
      process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'true'
    })

    expect(
      'global mode, cancel: REST charges per sent call is exactly 1',
      () => cancel.restPerCall,
      1,
    )
    expect(
      'global mode, cancel: matching-engine charges per sent call is exactly 1',
      () => cancel.enginePerCall,
      1,
    )
  })
})
