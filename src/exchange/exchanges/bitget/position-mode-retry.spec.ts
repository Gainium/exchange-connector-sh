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
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/bitget/position-mode-retry.spec.ts
 *
 * No network / auth needed — the exchange REST client is stubbed.
 */
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

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(
      actual,
    )} want ${JSON.stringify(want)}`,
  )
}

const shape = (o?: SentOrder) =>
  o && {
    side: o.side,
    tradeSide: o.tradeSide,
    reduceOnly: o.reduceOnly,
  }

async function run() {
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
    const { ex, sent } = stubAccount('hedge')
    const res = await ex.futures_openOrder({
      symbol: 'ARBUSDT',
      side: c.side,
      quantity: 322.4,
      price: 0.0776,
      newClientOrderId: 'CMB-BO-test',
      type: 'LIMIT',
      reduceOnly: c.reduceOnly,
      positionSide: PositionSide.BOTH,
    })
    expect(`hedge account / ${c.label}: attempts`, sent.length, 2)
    expect(`hedge account / ${c.label}: first is one-way`, shape(sent[0]), {
      side: c.side === 'BUY' ? 'buy' : 'sell',
      tradeSide: undefined,
      reduceOnly: undefined,
    })
    expect(`hedge account / ${c.label}: retry`, shape(sent[1]), c.want)
    // Same clientOid on both attempts — Bitget dedups on it, so a retry after
    // a rejection can never become a second live order.
    expect(
      `hedge account / ${c.label}: clientOid reused`,
      sent[1]?.clientOid,
      'CMB-BO-test',
    )
    expect(
      `hedge account / ${c.label}: order accepted`,
      res.status,
      StatusEnum.ok,
    )
  }

  // 5) Mirror direction: account is one-way, the bot cached hedge.
  {
    const { ex, sent } = stubAccount('one-way')
    const res = await ex.futures_openOrder({
      symbol: 'ARBUSDT',
      side: 'BUY',
      quantity: 1,
      price: 1,
      newClientOrderId: 'D-BO-test',
      type: 'LIMIT',
      reduceOnly: false,
      positionSide: PositionSide.LONG,
    })
    expect('one-way account / hedge order: attempts', sent.length, 2)
    expect('one-way account / hedge order: retry', shape(sent[1]), {
      side: 'buy',
      tradeSide: undefined,
      reduceOnly: undefined,
    })
    expect('one-way account / hedge order: accepted', res.status, StatusEnum.ok)
  }

  // 6) Mode already matches — no extra round trip.
  {
    const { ex, sent } = stubAccount('hedge')
    const res = await ex.futures_openOrder({
      symbol: 'ARBUSDT',
      side: 'BUY',
      quantity: 1,
      price: 1,
      newClientOrderId: 'D-BO-ok',
      type: 'LIMIT',
      reduceOnly: false,
      positionSide: PositionSide.LONG,
    })
    expect('matching mode: single attempt', sent.length, 1)
    expect('matching mode: accepted', res.status, StatusEnum.ok)
  }

  // 7) An unrelated rejection must NOT be re-sent in the other mode.
  {
    const { ex, sent } = stubAccount('hedge')
    ex.orderClient.futuresSubmitOrder = async (payload: SentOrder) => {
      sent.push({ ...payload })
      throw {
        code: 200,
        message: 'OK',
        body: { code: '43012', msg: 'Insufficient balance' },
      }
    }
    const res = await ex.futures_openOrder({
      symbol: 'ARBUSDT',
      side: 'BUY',
      quantity: 1,
      price: 1,
      newClientOrderId: 'D-BO-poor',
      type: 'LIMIT',
      reduceOnly: false,
      positionSide: PositionSide.LONG,
    })
    expect('unrelated error: single attempt', sent.length, 1)
    expect('unrelated error: still fails', res.status, StatusEnum.notok)
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll assertions passed')
}

void run()
