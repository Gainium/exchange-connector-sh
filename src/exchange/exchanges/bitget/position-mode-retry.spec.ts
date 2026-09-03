process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #333 — Bitget bots stuck on "the order type for
 * unilateral position must also be the unilateral position type".
 *
 * main-app picks the position-mode form of an order from the `hedge` flag it
 * read when the BOT loaded (`this.hedge` → `positionSide`). When that reading
 * is wrong — the user changed the mode mid-session, or the bot never read it
 * at all — every order goes out in the wrong form and Bitget rejects all of
 * them (code 40774) until the bot happens to reload. Bybit already self-heals
 * the same mismatch ("position idx not match position mode", bybit/index.ts
 * openOrder); this asserts Bitget now does too.
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the exchange REST client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { Futures, PositionSide, StatusEnum } from '../../types'
import BitgetExchange from './index'

const BITGET_40774 =
  'The order type for unilateral position must also be the unilateral position type.'

type SentOrder = {
  side?: string
  tradeSide?: string
  reduceOnly?: string
  clientOid?: string
}

/**
 * A Bitget account fixed in `accountMode`, which rejects any order whose shape
 * belongs to the other mode exactly as the venue does — the custom rest client
 * throws `{ body: { code, msg } }` for every non-'00000' body.
 */
function stubAccount(accountMode: 'hedge' | 'one-way') {
  const ex = new BitgetExchange(Futures.usdm, 'k', 's', 'p') as any
  const sent: SentOrder[] = []
  ex.orderClient = {
    futuresSubmitOrder: async (payload: SentOrder) => {
      sent.push({ ...payload })
      const payloadMode = payload.tradeSide === undefined ? 'one-way' : 'hedge'
      if (payloadMode !== accountMode) {
        throw {
          code: 200,
          message: 'OK',
          body: { code: '40774', msg: BITGET_40774 },
        }
      }
      return {
        code: '00000',
        msg: 'success',
        data: { clientOid: payload.clientOid },
      }
    },
  }
  ex.futures_getOrder = async () => ({
    status: StatusEnum.ok,
    data: { clientOrderId: 'placed' },
  })
  return { ex, sent }
}

function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const shape = (o?: SentOrder) =>
  o && {
    side: o.side,
    tradeSide: o.tradeSide,
    reduceOnly: o.reduceOnly,
  }

describe('bitget position-mode-retry', () => {
  // 1..4) The reported failure: the account is in HEDGE mode but the bot's
  //       cached mode is one-way, so main-app sends positionSide BOTH. Each
  //       of the four order roles must be re-sent as the right hedge order.
  const hedgeCases: {
    label: string
    side: 'BUY' | 'SELL'
    reduceOnly: boolean
    want: SentOrder
  }[] = [
    {
      label: 'open long (BUY)',
      side: 'BUY',
      reduceOnly: false,
      want: { side: 'buy', tradeSide: 'open', reduceOnly: 'NO' },
    },
    {
      label: 'close long (SELL reduceOnly)',
      side: 'SELL',
      reduceOnly: true,
      want: { side: 'buy', tradeSide: 'close', reduceOnly: 'YES' },
    },
    {
      label: 'open short (SELL)',
      side: 'SELL',
      reduceOnly: false,
      want: { side: 'sell', tradeSide: 'open', reduceOnly: 'NO' },
    },
    {
      label: 'close short (BUY reduceOnly)',
      side: 'BUY',
      reduceOnly: true,
      want: { side: 'sell', tradeSide: 'close', reduceOnly: 'YES' },
    },
  ]

  for (const c of hedgeCases) {
    describe(`hedge account / ${c.label}`, () => {
      let sent: SentOrder[]
      let res: { status: string }

      before(async () => {
        const stub = stubAccount('hedge')
        sent = stub.sent
        res = await stub.ex.futures_openOrder({
          symbol: 'ARBUSDT',
          side: c.side,
          quantity: 322.4,
          price: 0.0776,
          newClientOrderId: 'CMB-BO-test',
          type: 'LIMIT',
          reduceOnly: c.reduceOnly,
          positionSide: PositionSide.BOTH,
        })
      })

      expect('attempts', () => sent.length, 2)
      expect('first is one-way', () => shape(sent[0]), {
        side: c.side === 'BUY' ? 'buy' : 'sell',
        tradeSide: undefined,
        reduceOnly: undefined,
      })
      expect('retry', () => shape(sent[1]), c.want)
      // Same clientOid on both attempts — Bitget dedups on it, so a retry
      // after a rejection can never become a second live order.
      expect('clientOid reused', () => sent[1]?.clientOid, 'CMB-BO-test')
      expect('order accepted', () => res.status, StatusEnum.ok)
    })
  }

  // 5) Mirror direction: account is one-way, the bot cached hedge.
  describe('one-way account / hedge order', () => {
    let sent: SentOrder[]
    let res: { status: string }

    before(async () => {
      const stub = stubAccount('one-way')
      sent = stub.sent
      res = await stub.ex.futures_openOrder({
        symbol: 'ARBUSDT',
        side: 'BUY',
        quantity: 1,
        price: 1,
        newClientOrderId: 'D-BO-test',
        type: 'LIMIT',
        reduceOnly: false,
        positionSide: PositionSide.LONG,
      })
    })

    expect('attempts', () => sent.length, 2)
    expect('retry', () => shape(sent[1]), {
      side: 'buy',
      tradeSide: undefined,
      reduceOnly: undefined,
    })
    expect('accepted', () => res.status, StatusEnum.ok)
  })

  // 6) Mode already matches — no extra round trip.
  describe('matching mode', () => {
    let sent: SentOrder[]
    let res: { status: string }

    before(async () => {
      const stub = stubAccount('hedge')
      sent = stub.sent
      res = await stub.ex.futures_openOrder({
        symbol: 'ARBUSDT',
        side: 'BUY',
        quantity: 1,
        price: 1,
        newClientOrderId: 'D-BO-ok',
        type: 'LIMIT',
        reduceOnly: false,
        positionSide: PositionSide.LONG,
      })
    })

    expect('single attempt', () => sent.length, 1)
    expect('accepted', () => res.status, StatusEnum.ok)
  })

  // 7) An unrelated rejection must NOT be re-sent in the other mode.
  describe('unrelated error', () => {
    let sent: SentOrder[]
    let res: { status: string }

    before(async () => {
      const stub = stubAccount('hedge')
      sent = stub.sent
      stub.ex.orderClient.futuresSubmitOrder = async (payload: SentOrder) => {
        sent.push({ ...payload })
        throw {
          code: 200,
          message: 'OK',
          body: { code: '43012', msg: 'Insufficient balance' },
        }
      }
      res = await stub.ex.futures_openOrder({
        symbol: 'ARBUSDT',
        side: 'BUY',
        quantity: 1,
        price: 1,
        newClientOrderId: 'D-BO-poor',
        type: 'LIMIT',
        reduceOnly: false,
        positionSide: PositionSide.LONG,
      })
    })

    expect('single attempt', () => sent.length, 1)
    expect('still fails', () => res.status, StatusEnum.notok)
  })
})
