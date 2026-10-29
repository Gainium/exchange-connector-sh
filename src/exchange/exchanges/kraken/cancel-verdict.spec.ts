process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for the Kraken Futures cancel/fill race.
 *
 * `cancelOrderByOrderIdAndSymbol` used to ignore `cancelStatus` entirely and
 * return a hand-built order with `status: 'CANCELED'`, `side: 'BUY'` and no
 * executed quantity. Kraken states the outcome explicitly — `cancelled`,
 * `filled` or `notFound` — so an order that had already executed was reported
 * to main-app as dead: the position stayed on the venue with no take-profit and
 * no stop-loss, and the deal was short by the filled size.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — it exercises the pure verdict reader.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import KrakenExchange from './index'

const ex: any = new KrakenExchange(Futures.usdm, '', '')

function check(label: string, actual: unknown, want: unknown) {
  it(label, () => {
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

describe('cancel-verdict', () => {
  const orderJson = (over: Record<string, unknown> = {}) => ({
    orderId: 'a2704204-0452-4579-bbc1-c22327c2dd13',
    cliOrdId: 'D-BO-K759dVXOwvpaICs9d5C4PAqeDTsA1U',
    type: 'lmt',
    symbol: 'PF_XBTUSD',
    side: 'sell',
    quantity: 0.0003,
    filled: 0,
    limitPrice: 64795,
    reduceOnly: false,
    timestamp: '2026-08-06T15:31:16Z',
    lastUpdateTimestamp: '2026-08-06T15:31:26Z',
    ...over,
  })

  // --- the bug: a cancel that lost the race against a fill --------------------
  // This is Andreas' order. Pre-fix this returned CANCELED / executedQty 0 and
  // 0.0003 BTC of real position was dropped on the floor.
  const raced = ex.futures_readCancelOutcome({
    status: 'filled',
    cliOrdId: 'D-BO-K759dVXOwvpaICs9d5C4PAqeDTsA1U',
    orderEvents: [
      {
        type: 'EXECUTION',
        executionId: 'e1',
        price: 64795,
        amount: 0.0003,
        orderPriorEdit: orderJson(),
        orderPriorExecution: orderJson(),
      },
    ],
  })
  check('raced fill is not treated as unknown', raced.unknown, false)
  check(
    'raced fill reports FILLED',
    ex.futures_deriveOrderStatus(
      raced.rawStatus,
      raced.executedQty,
      raced.origQty,
    ),
    'FILLED',
  )
  check('raced fill keeps the executed quantity', raced.executedQty, 0.0003)
  check('raced fill keeps the execution price', raced.avgPrice, 64795)
  check('raced fill keeps the real side', raced.side, 'sell')
  check(
    'raced fill keeps the client order id',
    raced.clientOrderId,
    'D-BO-K759dVXOwvpaICs9d5C4PAqeDTsA1U',
  )

  // --- size-weighted average across several executions ------------------------
  const multi = ex.futures_readCancelOutcome({
    status: 'filled',
    orderEvents: [
      {
        type: 'EXECUTION',
        executionId: 'a',
        price: 100,
        amount: 1,
        orderPriorEdit: orderJson({ quantity: 3 }),
        orderPriorExecution: orderJson({ quantity: 3 }),
      },
      {
        type: 'EXECUTION',
        executionId: 'b',
        price: 200,
        amount: 3,
        orderPriorEdit: orderJson({ quantity: 3 }),
        orderPriorExecution: orderJson({ quantity: 3 }),
      },
    ],
  })
  check('multi-execution quantity is summed', multi.executedQty, 4)
  check('multi-execution price is size-weighted', multi.avgPrice, 175)

  // --- a genuine cancel still preserves a PARTIAL fill ------------------------
  const partial = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [
      {
        type: 'CANCEL',
        uid: 'u1',
        order: orderJson({ quantity: 0.001, filled: 0.0004 }),
      },
    ],
  })
  check('partial cancel is not unknown', partial.unknown, false)
  check('partial cancel keeps the filled part', partial.executedQty, 0.0004)
  check(
    'partial cancel still reports CANCELED',
    ex.futures_deriveOrderStatus(
      partial.rawStatus,
      partial.executedQty,
      partial.origQty,
    ),
    'CANCELED',
  )

  // --- fills made BEFORE the cancel batch are kept ----------------------------
  // `orderPriorExecution.filled` is what had filled before the execution in
  // this batch. Pre-fix only the batch's executions were counted, so an order
  // that was already part-filled lost its earlier fills.
  const execution = (amount: number, priorFilled: number, price = 100) => ({
    type: 'EXECUTION',
    executionId: `x${priorFilled}`,
    price,
    amount,
    orderPriorEdit: orderJson({ quantity: 0.25, filled: priorFilled }),
    orderPriorExecution: orderJson({ quantity: 0.25, filled: priorFilled }),
  })

  const batchOnly = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [execution(0.05, 0)],
  })
  check('batch-only fill is counted', batchOnly.executedQty, 0.05)
  check('batch-only fill keeps its price', batchOnly.avgPrice, 100)

  const priorOnly = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [
      {
        type: 'CANCEL',
        uid: 'u1',
        order: orderJson({ quantity: 0.25, filled: 0.17 }),
      },
    ],
  })
  check('prior-only fill is counted', priorOnly.executedQty, 0.17)

  const priorPlusBatch = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [execution(0.05, 0.17)],
  })
  check(
    'prior fill + batch execution are added',
    +priorPlusBatch.executedQty.toFixed(8),
    0.22,
  )
  check(
    'prior fill + batch execution still reports CANCELED',
    ex.futures_deriveOrderStatus(
      priorPlusBatch.rawStatus,
      priorPlusBatch.executedQty,
      priorPlusBatch.origQty,
    ),
    'CANCELED',
  )
  check(
    'batch price is not used for a fill that started before the batch',
    priorPlusBatch.avgPrice,
    undefined,
  )

  const priorCompletes = ex.futures_readCancelOutcome({
    status: 'filled',
    orderEvents: [execution(0.08, 0.17)],
  })
  check(
    'prior fill + completing execution = full quantity',
    +priorCompletes.executedQty.toFixed(8),
    0.25,
  )
  check(
    'prior fill + completing execution reports FILLED',
    ex.futures_deriveOrderStatus(
      priorCompletes.rawStatus,
      priorCompletes.executedQty,
      priorCompletes.origQty,
    ),
    'FILLED',
  )

  // A post-execution snapshot that already includes the batch is not added
  // on top of it.
  const noDoubleCount = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [
      execution(0.05, 0.17),
      {
        type: 'CANCEL',
        uid: 'u1',
        order: orderJson({ quantity: 0.25, filled: 0.22 }),
      },
    ],
  })
  check(
    'snapshot that includes the batch is not double counted',
    +noDoubleCount.executedQty.toFixed(8),
    0.22,
  )

  // --- an ordinary, untouched cancel ------------------------------------------
  const plain = ex.futures_readCancelOutcome({
    status: 'cancelled',
    orderEvents: [{ type: 'CANCEL', uid: 'u1', order: orderJson() }],
  })
  check('plain cancel is not unknown', plain.unknown, false)
  check('plain cancel has no fill', plain.executedQty, 0)
  check(
    'plain cancel reports CANCELED',
    ex.futures_deriveOrderStatus(
      plain.rawStatus,
      plain.executedQty,
      plain.origQty,
    ),
    'CANCELED',
  )
  check('plain cancel reads the side off the order', plain.side, 'sell')

  // --- the cases we must NOT guess at -----------------------------------------
  check(
    'notFound is unknown',
    ex.futures_readCancelOutcome({ status: 'notFound' }).unknown,
    true,
  )
  check(
    'missing cancelStatus is unknown',
    ex.futures_readCancelOutcome(undefined).unknown,
    true,
  )
  check(
    'filled with no quantities is unknown, never a phantom fill',
    ex.futures_readCancelOutcome({ status: 'filled', orderEvents: [] }).unknown,
    true,
  )
})
