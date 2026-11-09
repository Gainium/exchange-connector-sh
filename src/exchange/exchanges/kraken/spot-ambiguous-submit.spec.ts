process.env.NODE_ENV = 'testing'

/**
 * A spot AddOrder answered with an ambiguous error (`EGeneral:Expired request`,
 * `EService:Deadline elapsed`) may or may not have been placed. `openOrder`
 * must find out before answering:
 * - the order exists → return it (never place it twice);
 * - it is absent on every read → re-send it exactly once;
 * - a read fails → return the original error, never re-send blind.
 *
 * Run: `npm test` (mocha). No network / auth — the Kraken client is stubbed.
 * Real 1s settle sleeps: each ambiguous case takes ~3s.
 */
import { describe, it, before } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

const CLIENT_ID = 'D-RO-FQhmcONfQlHVB'
const PLACED = 'OAAAAA-11111-AAAAAA'
const RESENT = 'OBBBBB-22222-BBBBBB'

function check(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const row = (status: string, volExec = '0') => ({
  status,
  cl_ord_id: CLIENT_ID,
  userref: 0,
  vol: '11.66950456',
  vol_exec: volExec,
  price: '0',
  fee: '0',
  descr: { pair: 'ZECEUR', price: '961.532', ordertype: 'limit', type: 'buy' },
})

type Answer = () => unknown
const expired: Answer = () => ({
  error: ['EGeneral:Expired request'],
  result: undefined,
})
const accepted: Answer = () => ({ error: [], result: { txid: [RESENT] } })

function makeExchange(opts: {
  submits: Answer[]
  open?: Answer
  closed?: Answer
}) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const calls = { submitOrder: 0, getOpenOrders: 0, getClosedOrders: 0 }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async (s: string) => s
  ex.retry = 0
  ex.spotClient = {
    submitOrder: async () => {
      const answer = opts.submits[calls.submitOrder++] ?? expired
      return answer()
    },
    // Read-back of an accepted re-send.
    getOrders: async ({ txid }: { txid: string }) => ({
      error: [],
      result: { [txid]: row('open') },
    }),
    getOpenOrders: async () => {
      calls.getOpenOrders++
      return opts.open ? opts.open() : { error: [], result: { open: {} } }
    },
    getClosedOrders: async () => {
      calls.getClosedOrders++
      return opts.closed ? opts.closed() : { error: [], result: { closed: {} } }
    },
  }
  return { ex, calls }
}

const place = (ex: any, newClientOrderId: string | undefined = CLIENT_ID) =>
  ex.openOrder({
    symbol: 'ZEC-EUR',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 11.66950456,
    price: 961.532,
    newClientOrderId,
  })

describe('kraken spot openOrder: ambiguous submit errors', () => {
  describe('expired, but the order WAS placed and rests', () => {
    const { ex, calls } = makeExchange({
      submits: [expired],
      open: () => ({ error: [], result: { open: { [PLACED]: row('open') } } }),
    })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('succeeds', () => res.status, StatusEnum.ok)
    check('returns the placed order', () => res.data?.orderId, PLACED)
    check('keeps the client id', () => res.data?.clientOrderId, CLIENT_ID)
    check('never re-sends', () => calls.submitOrder, 1)
  })

  describe('expired, but the order WAS placed and already filled', () => {
    const { ex, calls } = makeExchange({
      submits: [expired],
      closed: () => ({
        error: [],
        result: { closed: { [PLACED]: row('closed', '11.66950456') } },
      }),
    })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('succeeds', () => res.status, StatusEnum.ok)
    check('returns the filled order', () => res.data?.orderId, PLACED)
    check('with its fill', () => res.data?.executedQty, '11.66950456')
    check('never re-sends', () => calls.submitOrder, 1)
  })

  describe('expired, and the order is absent on every read', () => {
    const { ex, calls } = makeExchange({ submits: [expired, accepted] })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('succeeds', () => res.status, StatusEnum.ok)
    check('returns the re-sent order', () => res.data?.orderId, RESENT)
    check('re-sends exactly once', () => calls.submitOrder, 2)
    check('read open orders three times', () => calls.getOpenOrders, 3)
  })

  describe('expired twice', () => {
    const { ex, calls } = makeExchange({ submits: [expired, expired] })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('fails', () => res.status, StatusEnum.notok)
    check('re-sends only once', () => calls.submitOrder, 2)
  })

  describe('expired, and the lookup itself fails', () => {
    const { ex, calls } = makeExchange({
      submits: [expired, accepted],
      open: () => ({ error: ['EAPI:Invalid nonce'], result: undefined }),
    })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('returns the original error', () => res.status, StatusEnum.notok)
    check('never re-sends blind', () => calls.submitOrder, 1)
  })

  describe('deadline elapsed, thrown as a body error', () => {
    const { ex, calls } = makeExchange({
      submits: [
        () => {
          throw Object.assign(new Error('Request failed'), {
            body: { error: ['EService:Deadline elapsed'] },
          })
        },
      ],
      open: () => ({ error: [], result: { open: { [PLACED]: row('open') } } }),
    })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('is recognised and resolved', () => res.data?.orderId, PLACED)
    check('never re-sends', () => calls.submitOrder, 1)
  })

  describe('a definite rejection is not touched', () => {
    const { ex, calls } = makeExchange({
      submits: [
        () => ({ error: ['EOrder:Insufficient funds'], result: undefined }),
      ],
    })
    let res: any
    before(async () => {
      res = await place(ex)
    })
    check('fails', () => res.status, StatusEnum.notok)
    check('no lookups', () => calls.getOpenOrders + calls.getClosedOrders, 0)
    check('no re-send', () => calls.submitOrder, 1)
  })

  describe('no client id to look up by', () => {
    const { ex, calls } = makeExchange({ submits: [expired, accepted] })
    let res: any
    before(async () => {
      res = await place(ex, '')
    })
    check('fails as before', () => res.status, StatusEnum.notok)
    check('no re-send', () => calls.submitOrder, 1)
  })
})
