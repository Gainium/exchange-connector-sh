process.env.NODE_ENV = 'testing'

/**
 * Unit-level cover for the Kraken Futures execution-price reader.
 *
 * `futures_getAvgFillPrice` calls `/derivatives/api/v3/fills` and used to
 * swallow every failure with a bare `catch { return null }`, so a key that is
 * not permitted to read fills degraded silently: the order was recorded at its
 * LIMIT price, which for a MARKET order erases all slippage. Measured against
 * recorded history, a small but material share of Kraken futures MARKET orders
 * were priced tens of basis points away from what the venue actually charged —
 * and every one of those had no average fill price resolved.
 *
 * The fix is to stop depending on that endpoint for the common case: Kraken
 * attaches exact `EXECUTION` events to the submit and cancel responses, and
 * this reader turns them into a size-weighted average. This spec pins that
 * reader and the permanent-vs-transient failure classification.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — both units under test are pure.
 */
import { describe, it } from 'mocha'
import { Futures } from '../../types'
import KrakenExchange, { isKrakenPermanentAuthFailure } from './index'

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

describe('fill-price', () => {
  const orderJson = (over: Record<string, unknown> = {}) => ({
    orderId: 'a2704204-0452-4579-bbc1-c22327c2dd13',
    cliOrdId: 'D-TP-K759dVXOwvpaICs9d5C4PAqeDTsA1U',
    type: 'mkt',
    symbol: 'PF_XBTUSD',
    side: 'sell',
    quantity: 3,
    filled: 0,
    limitPrice: 100,
    reduceOnly: false,
    timestamp: '2026-08-06T15:31:16Z',
    lastUpdateTimestamp: '2026-08-06T15:31:26Z',
    ...over,
  })

  const execution = (price: number, amount: number, id: string) => ({
    type: 'EXECUTION',
    executionId: id,
    price,
    amount,
    orderPriorEdit: orderJson(),
    orderPriorExecution: orderJson(),
  })

  // --- a market order that walked the book ------------------------------------
  // 1 @ 100 + 2 @ 130 = 360 / 3 = 120. Recording this at the order's limit price
  // would book it at 100 and overstate the proceeds of the close by 20%.
  const walked = ex.futures_readExecutionPrice([
    execution(100, 1, 'e1'),
    execution(130, 2, 'e2'),
  ])
  check('walked book sums the quantity', walked.executedQty, 3)
  check('walked book is size-weighted, not a mean', walked.avgPrice, 120)

  // --- a single clean fill -----------------------------------------------------
  const single = ex.futures_readExecutionPrice([execution(64795, 0.0003, 'e1')])
  check('single fill quantity', single.executedQty, 0.0003)
  check('single fill price', single.avgPrice, 64795)

  // --- nothing executed --------------------------------------------------------
  // A limit order that only rested. This MUST report zero rather than a price, or
  // the placement path would overwrite a real order with an invented fill.
  check(
    'a resting limit order reports no execution',
    ex.futures_readExecutionPrice([{ type: 'PLACE', order: orderJson() }]),
    { executedQty: 0 },
  )
  check('no events at all', ex.futures_readExecutionPrice([]), {
    executedQty: 0,
  })
  check('undefined events', ex.futures_readExecutionPrice(undefined), {
    executedQty: 0,
  })

  // --- non-execution events must not be counted -------------------------------
  check(
    'PLACE alongside EXECUTION counts only the execution',
    ex.futures_readExecutionPrice([
      { type: 'PLACE', order: orderJson() },
      execution(50, 2, 'e1'),
    ]),
    { executedQty: 2, avgPrice: 50 },
  )

  // --- zero-amount executions must not divide by zero -------------------------
  check(
    'zero-amount executions report nothing rather than NaN',
    ex.futures_readExecutionPrice([execution(100, 0, 'e1')]),
    { executedQty: 0 },
  )

  // --- failure classification --------------------------------------------------
  // Kraken refuses a key that lacks the query-trades permission at HTTP 200 with
  // an application-layer error, so it cannot be recognised by status code alone.
  check(
    'authenticationError is permanent',
    isKrakenPermanentAuthFailure('authenticationError'),
    true,
  )
  check(
    'transport 401 is permanent',
    isKrakenPermanentAuthFailure('Request failed with status code 401'),
    true,
  )
  check(
    'rate limiting is NOT permanent',
    isKrakenPermanentAuthFailure('Request failed with status code 429'),
    false,
  )
  check(
    'a gateway error is NOT permanent',
    isKrakenPermanentAuthFailure('Request failed with status code 502'),
    false,
  )
  check(
    'a timeout is NOT permanent',
    isKrakenPermanentAuthFailure('timeout of 10000ms exceeded'),
    false,
  )
})
