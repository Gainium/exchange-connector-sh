process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #366 — the Kraken Futures phantom order.
 *
 * `getOrderStatus` answers about orders that are open, or were filled or
 * cancelled in the last 5 seconds. For an id outside that window it still
 * returns an ELEMENT, carrying no usable `status`. `getOrder` fed that through
 * as `orderInfo.status || 'NEW'`, so "Kraken does not know this order" was
 * reported to main-app as "resting on the book".
 *
 * Production consequence (order GRID-RO-1w23…/a26e32f1-…, bot 6a63da97…):
 * every cancel came back `notFound` -> `Unknown order`, main-app's
 * `_handleUnknownOrder` re-read the order here and got a SUCCESSFUL `NEW`,
 * which clears its `canceledMap` retry counter — so the 5-attempt force-cancel
 * written for exactly this case was never reached. The order stayed NEW in
 * Mongo from 2026-08-05 while the bot re-attempted the cancel ~4x/day.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/kraken/phantom-order-status.spec.ts
 *
 * No network / auth needed — the Kraken client is stubbed.
 */
import { Futures } from '../../types'
import KrakenExchange from './index'

let failures = 0
function check(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

const CLI_ORD_ID = 'GRID-RO-1w23pKyQy1PG9uMLMiXWu5yVNZP'
const ORDER_ID = 'a26e32f1-4d4e-4d28-8e80-6a0dd9a7b3ec'

/**
 * A connector wired to a stubbed Kraken. `getOrderEvents` records whether the
 * history fallback was reached — that is how we tell "we believed the phantom"
 * from "we went and looked".
 */
function makeExchange(
  statusElement: unknown,
  historyElements: unknown[] = [],
  statusResult: 'success' | 'error' = 'success',
) {
  const ex: any = new KrakenExchange(Futures.usdm, '', '')
  const calls = { getOrderStatus: 0, getOrderEvents: 0 }
  // Keep the test hermetic: no rate-limit store, no symbol-mapper bootstrap.
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async () => 'PF_XBTUSD'
  ex.derivativesClient = {
    getOrderStatus: async () => {
      calls.getOrderStatus++
      return {
        result: statusResult,
        orders: statusElement === null ? [] : [statusElement],
      }
    },
    getOrderEvents: async () => {
      calls.getOrderEvents++
      return { elements: historyElements }
    },
  }
  return { ex, calls }
}

const restingOrder = (over: Record<string, unknown> = {}) => ({
  type: 'ORDER',
  orderId: ORDER_ID,
  cliOrdId: CLI_ORD_ID,
  symbol: 'PF_XBTUSD',
  side: 'buy',
  quantity: 0.0007,
  filled: 0,
  limitPrice: 64289,
  reduceOnly: false,
  timestamp: '2026-08-05T14:57:27Z',
  lastUpdateTimestamp: '2026-08-05T14:57:27Z',
  ...over,
})

async function run() {
  // --- the bug ------------------------------------------------------------
  // Kraken returns an element for an id it no longer tracks, with no status.
  // Pre-fix this resolved OK/NEW and the history was never consulted.
  {
    const { ex, calls } = makeExchange({
      order: restingOrder(),
      status: undefined,
    })
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check(
      'statusless element -> not reported as live',
      res.data?.status,
      undefined,
    )
    check('statusless element -> NOTOK', res.status, 'NOTOK')
    check('statusless element -> history consulted', calls.getOrderEvents, 1)
  }

  // Same, spelled as Kraken's explicit not-found marker.
  {
    const { ex, calls } = makeExchange({
      order: restingOrder(),
      status: 'NOT_FOUND',
    })
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check('NOT_FOUND -> not reported as live', res.data?.status, undefined)
    check('NOT_FOUND -> history consulted', calls.getOrderEvents, 1)
  }

  // --- no regression: a genuinely resting order is still NEW, in one call --
  {
    const { ex, calls } = makeExchange({
      order: restingOrder(),
      status: 'ENTERED_BOOK',
    })
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check('ENTERED_BOOK -> OK', res.status, 'OK')
    check('ENTERED_BOOK -> NEW', res.data?.status, 'NEW')
    check('ENTERED_BOOK -> no extra history call', calls.getOrderEvents, 0)
  }

  // A resting-but-filled order must still derive FILLED (forum #4924).
  {
    const { ex } = makeExchange({
      order: restingOrder({ filled: 0.0007 }),
      status: 'ENTERED_BOOK',
    })
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check('ENTERED_BOOK + fully filled -> FILLED', res.data?.status, 'FILLED')
  }

  // A terminal cancel is still read straight from the status element.
  {
    const { ex, calls } = makeExchange({
      order: restingOrder(),
      status: 'CANCELLED',
    })
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check('CANCELLED -> CANCELED', res.data?.status, 'CANCELED')
    check('CANCELLED -> no extra history call', calls.getOrderEvents, 0)
  }

  // --- the fallback still resolves what it can ----------------------------
  // A phantom whose cancellation IS in history now reconciles to CANCELED
  // instead of being reported as NEW forever.
  {
    const { ex } = makeExchange({ order: restingOrder(), status: undefined }, [
      {
        uid: 'e1',
        timestamp: 1785941900000,
        event: {
          OrderCancelled: {
            order: {
              uid: ORDER_ID,
              clientId: CLI_ORD_ID,
              tradeable: 'PF_XBTUSD',
              quantity: '0.0007',
              filled: '0',
              limitPrice: '64289',
              orderType: 'lmt',
              direction: 'buy',
            },
          },
        },
      },
    ])
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check(
      'phantom with cancel in history -> CANCELED',
      res.data?.status,
      'CANCELED',
    )
  }

  // --- bug #408: the OrderPlaced half of the same lie ---------------------
  // The #375 fix stopped `getOrderStatus` reporting a phantom as NEW, but the
  // fallback it hands control to reads a historical `OrderPlaced` — "this
  // order was accepted, once" — as though it were a live snapshot, and hands
  // main-app the same OK/NEW. `getOrderStatus` has ALREADY said it does not
  // know the id, so an old OrderPlaced with no fills is not evidence the order
  // is resting; it is the record of how the phantom was born.
  //
  // Production (bot 6a63da97…, order GRID-RO-9BQqa08…/a27a9229-…): 7 cancels
  // over 18h, each logging `Send cancel request … Order not found` ->
  // `Send request to unknow order` -> `Real order … status: NEW`, which clears
  // `canceledMap` so the 5-attempt force-cancel is never reached.
  {
    const { ex } = makeExchange({ order: restingOrder(), status: undefined }, [
      {
        uid: 'e1',
        timestamp: +new Date() - 6 * 60 * 60 * 1000,
        event: {
          OrderPlaced: {
            order: {
              uid: ORDER_ID,
              clientId: CLI_ORD_ID,
              tradeable: 'PF_XBTUSD',
              quantity: '0.0007',
              filled: '0',
              limitPrice: '64289',
              orderType: 'lmt',
              direction: 'buy',
            },
          },
        },
      },
    ])
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check(
      'stale OrderPlaced -> not reported as live',
      res.data?.status,
      undefined,
    )
    check('stale OrderPlaced -> NOTOK', res.status, 'NOTOK')
    check(
      'stale OrderPlaced -> reason is a definitive not-found',
      /\border not found\b/.test(`${res.reason ?? ''}`.toLowerCase()),
      true,
    )
  }

  // Propagation lag is NOT a phantom: an order placed seconds ago may not be
  // in `getOrderStatus` yet, and answering "not found" there would let
  // main-app force-cancel an order that is about to appear on the book.
  {
    const { ex } = makeExchange({ order: restingOrder(), status: undefined }, [
      {
        uid: 'e1',
        timestamp: +new Date() - 3000,
        event: {
          OrderPlaced: {
            order: {
              uid: ORDER_ID,
              clientId: CLI_ORD_ID,
              tradeable: 'PF_XBTUSD',
              quantity: '0.0007',
              filled: '0',
              limitPrice: '64289',
              orderType: 'lmt',
              direction: 'buy',
            },
          },
        },
      },
    ])
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check('just-placed OrderPlaced -> still NEW', res.data?.status, 'NEW')
  }

  // Fills are real evidence about the order regardless of age — a stale
  // OrderPlaced carrying a fill must still reconcile, not be dropped.
  {
    const { ex } = makeExchange({ order: restingOrder(), status: undefined }, [
      {
        uid: 'e1',
        timestamp: +new Date() - 6 * 60 * 60 * 1000,
        event: {
          OrderPlaced: {
            order: {
              uid: ORDER_ID,
              clientId: CLI_ORD_ID,
              tradeable: 'PF_XBTUSD',
              quantity: '0.0007',
              filled: '0.0003',
              limitPrice: '64289',
              orderType: 'lmt',
              direction: 'buy',
            },
          },
        },
      },
    ])
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check(
      'stale OrderPlaced with fills -> PARTIALLY_FILLED',
      res.data?.status,
      'PARTIALLY_FILLED',
    )
  }

  // A `getOrderStatus` call that did not come back `success` is a failed
  // request, not an answer about the order. It must NOT be escalated into a
  // definitive not-found — that is the "transient failure rendered as a
  // definitive negative" mistake, and here it would force-cancel a live order.
  {
    const { ex } = makeExchange(
      null,
      [
        {
          uid: 'e1',
          timestamp: +new Date() - 6 * 60 * 60 * 1000,
          event: {
            OrderPlaced: {
              order: {
                uid: ORDER_ID,
                clientId: CLI_ORD_ID,
                tradeable: 'PF_XBTUSD',
                quantity: '0.0007',
                filled: '0',
                limitPrice: '64289',
                orderType: 'lmt',
                direction: 'buy',
              },
            },
          },
        },
      ],
      'error',
    )
    const res = await ex.getOrder({
      symbol: 'BTC-USD',
      newClientOrderId: CLI_ORD_ID,
    })
    check(
      'status view did not answer -> not a phantom',
      res.data?.status,
      'NEW',
    )
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

void run()
