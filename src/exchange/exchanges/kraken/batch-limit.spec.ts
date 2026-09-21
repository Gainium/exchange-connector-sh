process.env.NODE_ENV = 'testing'

/**
 * The limiter's BULK entry point — `addOrderBatchCall` — and the age-scaled
 * cancel cost it is fed.
 *
 * Two things separate a batch call from a single one, and both are Kraken's
 * (https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits,
 * https://docs.kraken.com/api/docs/guides/spot-ratelimits):
 *
 *  - **REST is one call.** A batch of 50 ids costs the per-key counter the same
 *    +1 as a batch of 2. That counter is the binding constraint — 20 tokens
 *    refilling at 0.5/s — so charging per order would give back the entire
 *    saving.
 *  - **A batch cancel may take the matching-engine counter past its
 *    threshold.** Kraken accepts it; the counter simply overshoots and the next
 *    calls on that pair wait. The ordinary predicted-counter check therefore
 *    cannot be used for it: a batch of 46 fresh orders costs 46 x 8 = 368
 *    against a threshold of 125, so `counter + cost <= threshold` is false at
 *    every counter value, no amount of waiting makes it true, and the call
 *    would never be admitted at all.
 *
 * Driven against the real `limit.ts` under a virtual clock — no wall-clock
 * sleeping, no network. Counters are read back through the published `getUsage`
 * ratios, the way `order-call-atomicity.spec.ts` does; every case first jumps
 * the clock an hour so anything another case (or another spec file) left behind
 * has decayed to zero and the account under test is the one the ratios describe.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import limitHelper, {
  krakenCancelCostForAge,
  CANCEL_ORDER_COST,
  REST_MAX_COUNTER,
  MATCHING_ENGINE_THRESHOLD,
} from './limit'

// ── virtual clock ───────────────────────────────────────────────────────────
// `limit.ts` reads Date.now() directly for decay; "waiting" is advancing VNOW.
//
// The limiter is a process-wide singleton shared with every other spec file,
// and its decay only ever runs FORWARD — a counter is decayed, and its
// timestamp moved, only when time has passed since it was last touched. So this
// clock is deliberately modest and tidy in both directions:
//
//  - it STARTS a few minutes after whatever clock is current when these cases
//    begin, so every counter an earlier spec left behind decays to zero and the
//    account under test is the one the published ratios describe;
//  - it advances in small steps and the counters are drained on the way out, so
//    a later spec's own clock is still ahead of anything left here — otherwise
//    its buckets would never refill. `order-call-atomicity.spec.ts` is such a
//    spec, and it is the reason the steps below are minutes rather than hours.
let VNOW = 0
let previousDateNow: () => number
let previousMode: string | undefined

/** Long enough for any counter in the module to decay to zero: the matching
 *  engine sheds 2.34/s and the REST bucket at least 0.33/s. */
const SETTLE_MS = 5 * 60 * 1000
/** Let every counter in the module — ours and any other spec's — decay away. */
const drain = () => {
  VNOW += SETTLE_MS
}

let seq = 0
const freshKey = () => `batch-limit-acct-${++seq}`
const freshPair = () => `BL${++seq}/USD`

/** Current counter values, read back through the published usage ratios. */
function counters() {
  const u = limitHelper.getUsage()
  return {
    rest: (u.find((x) => x.type === 'rest')?.value ?? 0) * REST_MAX_COUNTER,
    engine:
      (u.find((x) => x.type === 'matching_engine')?.value ?? 0) *
      MATCHING_ENGINE_THRESHOLD,
  }
}

/** Spend REST tokens until the budget refuses one. Returns how many it took. */
async function saturateRest(accountKey: string): Promise<number> {
  for (let spent = 0; spent <= REST_MAX_COUNTER + 5; spent++) {
    if ((await limitHelper.addRestCall(false, accountKey)) > 0) {
      return spent
    }
  }
  throw new Error('REST budget never refused a call')
}

describe('kraken bulk rate limiting', () => {
  before(() => {
    previousDateNow = Date.now
    previousMode = process.env.KRAKEN_PER_ACCOUNT_LIMITS
    VNOW = Date.now() + SETTLE_MS
    ;(Date as any).now = () => VNOW
  })

  after(() => {
    // Drain every counter this file touched — `getUsage` is what applies decay
    // to each tracked entry, and it has to be asked in both modes because each
    // one reads a different set of them.
    drain()
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'true'
    limitHelper.getUsage()
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = 'false'
    limitHelper.getUsage()
    // …and hand back the regime this file found, for the same reason.
    process.env.KRAKEN_PER_ACCOUNT_LIMITS = previousMode
    ;(Date as any).now = previousDateNow
  })

  // ── the cost table ────────────────────────────────────────────────────────
  describe('krakenCancelCostForAge', () => {
    // Kraken's published ladder, verbatim: < 5s +8, < 10s +6, < 15s +5,
    // < 45s +4, < 90s +2, < 300s +1, and nothing at all from 300s.
    const table: Array<[number, number]> = [
      [0, 8],
      [4.999, 8],
      [5, 6],
      [9.999, 6],
      [10, 5],
      [14.999, 5],
      [15, 4],
      [44.999, 4],
      [45, 2],
      [89.999, 2],
      [90, 1],
      [299.999, 1],
      [300, 0],
      [86400, 0],
    ]

    for (const [age, cost] of table) {
      it(`an order resting ${age}s costs ${cost}`, () => {
        assert.strictEqual(krakenCancelCostForAge(age), cost)
      })
    }

    it('an age it cannot know costs the worst case, never nothing', () => {
      // An unreadable `opentm` must not be a way to under-charge the budget, so
      // anything that is not a usable age — including an infinite one, which no
      // real timestamp produces — is charged as if the order were seconds old.
      for (const age of [NaN, -1, Infinity as number]) {
        assert.strictEqual(
          krakenCancelCostForAge(age),
          CANCEL_ORDER_COST,
          `age ${age}`,
        )
      }
    })

    it('a grid order that has rested for minutes is free, as Kraken says', () => {
      // This is the whole reason the ladder is worth reading: charging the flat
      // < 5s worst case for orders that have rested for hours is load Kraken
      // never asked for.
      assert.strictEqual(krakenCancelCostForAge(30 * 60), 0)
    })
  })

  // ── the batch call itself ─────────────────────────────────────────────────
  for (const perAccount of ['true', 'false'] as const) {
    const mode =
      perAccount === 'true'
        ? 'per-account counters'
        : 'the legacy global counter'

    describe(`${mode}`, () => {
      before(() => {
        process.env.KRAKEN_PER_ACCOUNT_LIMITS = perAccount
      })

      describe('a batch cancel costing more than the threshold', () => {
        const key = freshKey()
        const pair = freshPair()
        // 46 orders resting under 5 seconds: the shape of a deal close that
        // has just placed its orders. 368 against a threshold of 125.
        const engineCost = 46 * krakenCancelCostForAge(0)
        let admitted: number
        let nextWait: number
        let afterWaiting: number

        before(async () => {
          drain()
          admitted = await limitHelper.addOrderBatchCall(
            pair,
            'cancel',
            engineCost,
            key,
          )
          nextWait = await limitHelper.addOrderBatchCall(pair, 'cancel', 8, key)
          VNOW += nextWait
          afterWaiting = await limitHelper.addOrderBatchCall(
            pair,
            'cancel',
            8,
            key,
          )
        })

        it('is admitted — Kraken accepts it, so refusing it is our invention', () => {
          assert.ok(engineCost > MATCHING_ENGINE_THRESHOLD, `${engineCost}`)
          assert.strictEqual(admitted, 0)
        })

        it('spends the full cost, so the next call on the pair waits', () => {
          // The overshoot is the point: it delays what follows by as long as
          // Kraken's own counter will, instead of pretending it never happened.
          assert.ok(nextWait > 0, `${nextWait}`)
          assert.ok(
            nextWait > ((engineCost - MATCHING_ENGINE_THRESHOLD) / 2.34) * 1000,
            `${nextWait}`,
          )
        })

        it('and is admitted again once the counter has decayed', () => {
          assert.strictEqual(afterWaiting, 0)
        })
      })

      describe('REST is charged once, whatever the batch carries', () => {
        const key = freshKey()
        const pair = freshPair()
        let restDelta: number
        let remainingRestCalls: number

        before(async () => {
          drain()
          const before = counters()
          await limitHelper.addOrderBatchCall(pair, 'cancel', 46 * 8, key)
          restDelta = counters().rest - before.rest
          remainingRestCalls = await saturateRest(key)
        })

        it('spends exactly one REST token', () => {
          assert.ok(
            Math.abs(restDelta - 1) < 1e-6,
            `REST delta ${restDelta}, want 1`,
          )
        })

        it('leaves the rest of the bucket for everything else', () => {
          // 46 orders through the single-order path would have spent 46 tokens
          // out of 20 — i.e. the account would be parked for a minute and a half
          // before the last of them was even sent.
          assert.strictEqual(remainingRestCalls, REST_MAX_COUNTER - 1)
        })
      })

      describe('when the matching-engine budget refuses', () => {
        const key = freshKey()
        const pair = freshPair()
        let wait: number
        let restDelta: number
        let engineDelta: number

        before(async () => {
          drain()
          // Fill the pair's counter to just under the threshold, then ask for
          // an add batch that cannot fit under it.
          await limitHelper.addOrderBatchCall(pair, 'add', 120, key)
          const before = counters()
          wait = await limitHelper.addOrderBatchCall(pair, 'add', 15, key)
          const after = counters()
          restDelta = after.rest - before.rest
          engineDelta = after.engine - before.engine
        })

        it('defers the call', () => {
          assert.ok(wait > 0, `${wait}`)
        })

        it('charges neither budget — a deferred call was never sent', () => {
          assert.ok(Math.abs(restDelta) < 1e-6, `REST delta ${restDelta}`)
          assert.ok(Math.abs(engineDelta) < 1e-6, `engine delta ${engineDelta}`)
        })
      })

      describe('when the REST budget refuses', () => {
        const key = freshKey()
        const pair = freshPair()
        let wait: number
        let restDelta: number
        let engineDelta: number

        before(async () => {
          drain()
          await saturateRest(key)
          const before = counters()
          wait = await limitHelper.addOrderBatchCall(pair, 'cancel', 40, key)
          const after = counters()
          restDelta = after.rest - before.rest
          engineDelta = after.engine - before.engine
        })

        it('defers the call', () => {
          assert.ok(wait > 0, `${wait}`)
        })

        it('charges neither budget', () => {
          assert.ok(Math.abs(restDelta) < 1e-6, `REST delta ${restDelta}`)
          assert.ok(Math.abs(engineDelta) < 1e-6, `engine delta ${engineDelta}`)
        })
      })

      describe('an add batch is still held to the ordinary threshold', () => {
        const key = freshKey()
        const pair = freshPair()
        let overThreshold: number
        let withinThreshold: number

        before(async () => {
          drain()
          // Kraken caps a batch at 15 orders at +1 each, so this never happens
          // in practice — but the predicted check is what an add is admitted on
          // and it must stay that way: an add Kraken WOULD reject over the
          // threshold must not be sent.
          overThreshold = await limitHelper.addOrderBatchCall(
            pair,
            'add',
            MATCHING_ENGINE_THRESHOLD + 1,
            key,
          )
          withinThreshold = await limitHelper.addOrderBatchCall(
            pair,
            'add',
            15,
            key,
          )
        })

        it('defers a batch that would overshoot', () => {
          assert.ok(overThreshold > 0, `${overThreshold}`)
        })

        it('admits one that fits', () => {
          assert.strictEqual(withinThreshold, 0)
        })
      })
    })
  }
})
