process.env.NODE_ENV = 'testing'

/**
 * `getOrder` sums an order's fee and average price over the fills
 * `userFillsByTime` returns for it, and takes the executed size from the order
 * struct. That endpoint returns at most 2000 fills per response for the whole
 * account, so the order's fills could be cut off and the fee under-reported
 * as if it were final.
 *
 * Asserted here: the window is paged until the fills cover the executed size,
 * boundary fills are not counted twice, and a list that still falls short is
 * reported as incomplete.
 *
 * Run: `npm test` (mocha). No network: `fetchPage` is a fake.
 */
import { describe, it } from 'mocha'
import {
  collectOrderFills,
  HL_FILLS_PAGE_LIMIT,
  type HlOrderFill,
} from './orderFills'

const OID = 42

function fill(tid: number, time: number, sz: string, oid = OID): HlOrderFill {
  return { oid, tid, time, sz, px: '100', fee: '0.01', feeToken: 'USDC' }
}

/** A full page of other orders' fills, ending with `tail`. */
function fullPage(firstTid: number, time: number, tail: HlOrderFill[] = []) {
  const others = Array.from(
    { length: HL_FILLS_PAGE_LIMIT - tail.length },
    (_, i) => fill(firstTid + i, time, '1', 7),
  )
  return [...others, ...tail]
}

function check(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

describe('hyperliquid order fills', () => {
  it('one short page covering the executed size is complete', async () => {
    const calls: number[] = []
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.3,
      fetchPage: async (t) => {
        calls.push(t)
        return [
          fill(1, 1001, '0.1'),
          fill(2, 1002, '0.2'),
          fill(3, 1002, '5', 9),
        ]
      },
    })
    check('pages read', calls, [1000])
    check('fills kept', r.fills.length, 2)
    check('complete', r.complete, true)
  })

  it('pages past a full first page to find the rest of the fills', async () => {
    const calls: number[] = []
    const pages = [
      fullPage(100, 1500, [fill(1, 2000, '0.1')]),
      // The boundary millisecond comes back again on the next page.
      [fill(1, 2000, '0.1'), fill(2, 2500, '0.2')],
    ]
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.3,
      fetchPage: async (t) => {
        calls.push(t)
        return pages[calls.length - 1] ?? []
      },
    })
    check('pages read', calls, [1000, 2000])
    check('boundary fill counted once', r.fills.length, 2)
    check('filled size', +r.filledSz.toFixed(8), 0.3)
    check('complete', r.complete, true)
  })

  it('stops paging once the executed size is covered', async () => {
    let calls = 0
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.1,
      fetchPage: async () => {
        calls++
        return fullPage(100, 1500, [fill(1, 2000, '0.1')])
      },
    })
    check('pages read', calls, 1)
    check('complete', r.complete, true)
  })

  it('a list that still falls short is incomplete', async () => {
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.3,
      fetchPage: async () => [fill(1, 1001, '0.1')],
    })
    check('fills kept', r.fills.length, 1)
    check('incomplete', r.complete, false)
  })

  it('gives up on a full page it cannot advance past', async () => {
    let calls = 0
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.3,
      fetchPage: async () => {
        calls++
        return fullPage(100, 1000)
      },
    })
    check('pages read', calls, 1)
    check('incomplete', r.complete, false)
  })

  it('bounds the number of pages', async () => {
    let calls = 0
    const r = await collectOrderFills({
      oid: OID,
      startTime: 1000,
      executedSz: 0.3,
      maxPages: 3,
      fetchPage: async () => {
        calls++
        return fullPage(calls * 10_000, 1000 + calls)
      },
    })
    check('pages read', calls, 3)
    check('incomplete', r.complete, false)
  })
})
