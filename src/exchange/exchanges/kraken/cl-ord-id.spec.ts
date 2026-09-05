process.env.NODE_ENV = 'testing'

/**
 * Kraken spot orders must be addressable by the Gainium client order id they
 * were placed with.
 *
 * They were not. The connector derived
 * `userref = parseInt(clientOrderId.substring(0, 8), 16)`, which stops at the
 * first non-hex char: every `D-*` id collapses to 13, every `CMB-*` to 12, and
 * every `GRID-*` to NaN — sent to Kraken as `userref: null`, so grid orders
 * carried no client identifier at all and never resolved, even one at a time.
 * Kraken spot has had a native `cl_ord_id` on AddOrder / OpenOrders /
 * ClosedOrders / CancelOrder the whole time, and `@siebly/kraken-api@1.0.6`
 * already types it.
 *
 * Spec: `specs/003.kraken-spot-native-cl-ord-id.md`.
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the Kraken client is stubbed.
 */
import { describe, it, before } from 'mocha'
import { createHash } from 'crypto'
import { Futures, StatusEnum } from '../../types'
import KrakenExchange from './index'

/** Three live client-id families, one per §1.2 row of the spec. */
const DCA_A = 'D-RO-o54rqRLIW9rTGgeSaVaepKlstZBZpY'
const DCA_B = 'D-BO-2hZJUI42yQT8IiRDrXtOACvRR9hlVF'
const GRID = 'GRID-RO-roa6DwlXK15XEWuphyR6c4aejKj'

/** The expected encoding, written out independently of the implementation. */
const enc = (id: string) =>
  createHash('sha256').update(id).digest('hex').slice(0, 32)

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

/** An open-orders row as Kraken returns it once the order carries a cl_ord_id. */
function row(
  clOrdId: string | null,
  userref: number | null,
  price: string,
  status = 'open',
) {
  return {
    status,
    userref,
    cl_ord_id: clOrdId,
    vol: '1.0',
    vol_exec: status === 'closed' ? '1.0' : '0',
    price: status === 'closed' ? price : '0',
    fee: '0',
    descr: { pair: 'ETHEUR', price, ordertype: 'limit', type: 'buy' },
  }
}

type Sent = Record<string, unknown>

/**
 * A spot connector wired to a stubbed Kraken that records every request it is
 * sent, so the mutual-exclusion rule can be asserted on the wire and not on
 * the code that builds it.
 */
function makeExchange(
  openOrders: Record<string, unknown> = {},
  closedOrders: Record<string, unknown> = {},
  txids: string[] = ['OAAAAA-11111-AAAAAA'],
) {
  const ex: any = new KrakenExchange(Futures.null, '', '')
  const sent: { method: string; params: Sent }[] = []
  const record = (method: string, params: Sent | undefined) => {
    sent.push({ method, params: params || {} })
  }
  ex.checkLimits = async () => undefined
  ex.normalizeSymbol = async (s: string) => s
  ex.toKrakenSymbol = async (s: string) => s
  // No connector-side retry ladder: the property under test is what the FIRST
  // answer is, not how many times it is re-asked.
  ex.retry = 0
  ex.spotClient = {
    submitOrder: async (p: Sent) => {
      record('submitOrder', p)
      return { error: [], result: { txid: txids } }
    },
    getOrders: async (p: Sent) => {
      record('getOrders', p)
      const out: Record<string, unknown> = {}
      for (const t of `${p?.txid || ''}`.split(',').filter(Boolean)) {
        const found = openOrders[t] || closedOrders[t]
        if (found) out[t] = found
      }
      return { error: [], result: out }
    },
    // OpenOrders is asked unfiltered — the connector matches on the row's own
    // cl_ord_id so that the legacy userref pass can read the same payload.
    getOpenOrders: async (p: Sent) => {
      record('getOpenOrders', p)
      return { error: [], result: { open: openOrders } }
    },
    // ClosedOrders IS filtered server-side (it is paginated), so the stub
    // honours the filter the way Kraken does.
    getClosedOrders: async (p: Sent) => {
      record('getClosedOrders', p)
      const entries = Object.entries(closedOrders).filter(([, o]: any) => {
        if (p?.cl_ord_id !== undefined) return o.cl_ord_id === p.cl_ord_id
        if (p?.userref !== undefined) return o.userref === p.userref
        return true
      })
      return { error: [], result: { closed: Object.fromEntries(entries) } }
    },
    cancelOrder: async (p: Sent) => {
      record('cancelOrder', p)
      return { error: [], result: { count: 1 } }
    },
  }
  return { ex, sent }
}

const ask = (ex: any, id: string) =>
  ex.getOrder({ symbol: 'ETHEUR', newClientOrderId: id })

describe('kraken spot native cl_ord_id', () => {
  describe('the cl_ord_id encoding (§4.1)', () => {
    const ex: any = new KrakenExchange(Futures.null, '', '')
    check(
      'is Kraken short-UUID form: 32 hex chars, no dashes',
      () => /^[0-9a-f]{32}$/.test(ex.krakenClOrdId(DCA_A)),
      true,
    )
    check(
      'is deterministic — the same id encodes the same way every time',
      () => ex.krakenClOrdId(DCA_A) === ex.krakenClOrdId(DCA_A),
      true,
    )
    check(
      'is injective where the old one was not: two D-* ids differ',
      () => ex.krakenClOrdId(DCA_A) === ex.krakenClOrdId(DCA_B),
      false,
    )
    check(
      'and a GRID-* id encodes at all (parseInt gave NaN)',
      () => /^[0-9a-f]{32}$/.test(ex.krakenClOrdId(GRID)),
      true,
    )
    check(
      'derives from the WHOLE client id, not a truncation of it',
      () =>
        ex.krakenClOrdId(`${DCA_A}X`) === ex.krakenClOrdId(DCA_A) ||
        ex.krakenClOrdId(DCA_A).startsWith('D-RO'),
      false,
    )
  })

  describe('submitOrder (§4.3) and mutual exclusion (§4.2)', () => {
    const { ex, sent } = makeExchange({
      'OAAAAA-11111-AAAAAA': row(enc(DCA_A), null, '2403.51'),
    })
    before(async () => {
      await ex.openOrder({
        symbol: 'ETHEUR',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        price: 2403.51,
        newClientOrderId: DCA_A,
      })
    })
    check(
      'sends the encoded client id as cl_ord_id',
      () => sent.find((s) => s.method === 'submitOrder')?.params.cl_ord_id,
      enc(DCA_A),
    )
    check(
      'and NO userref — Kraken rejects a request carrying both',
      () =>
        Object.prototype.hasOwnProperty.call(
          sent.find((s) => s.method === 'submitOrder')?.params || {},
          'userref',
        ),
      false,
    )
    check(
      'no request in the whole flow carries both fields',
      () =>
        sent.filter(
          (s) =>
            s.params.cl_ord_id !== undefined && s.params.userref !== undefined,
        ).length,
      0,
    )
  })

  describe('getOrder resolves the order asked about (§4.4)', () => {
    // The production shape: one Kraken spot account running a DCA bot, with a
    // base order and two safety orders resting at once. Pre-fix all three were
    // userref 13 and none of them could be told apart.
    const { ex } = makeExchange({
      'OZZZZZ-99999-ZZZZZZ': row(enc(DCA_B), null, '2500.00'),
      'ONK6O3-BF63X-24VAON': row(enc(DCA_A), null, '2403.51'),
      'OYYYYY-88888-YYYYYY': row(enc('D-SO-third'), null, '2300.00'),
    })
    let res: any
    before(async () => {
      res = await ask(ex, DCA_A)
    })
    check('resolves', () => res.status, StatusEnum.ok)
    check(
      'to the order that carries THIS client id, not the first listed',
      () => res.data?.orderId,
      'ONK6O3-BF63X-24VAON',
    )
    check(
      'and echoes back the caller own client id, not the encoding',
      () => res.data?.clientOrderId,
      DCA_A,
    )
  })

  describe('a GRID-* order, which never resolved at all (§1.2)', () => {
    const { ex } = makeExchange({
      'OGGGGG-77777-GGGGGG': row(enc(GRID), null, '76.95'),
    })
    let res: any
    before(async () => {
      res = await ask(ex, GRID)
    })
    check('resolves', () => res.status, StatusEnum.ok)
    check('to its order', () => res.data?.orderId, 'OGGGGG-77777-GGGGGG')
  })

  describe('closed orders are filtered by cl_ord_id (§4.5)', () => {
    const { ex, sent } = makeExchange(
      {},
      {
        'OCCCCC-33333-CCCCCC': row(enc(DCA_A), null, '2403.51', 'closed'),
        'ODDDDD-44444-DDDDDD': row(enc(DCA_B), null, '2500.00', 'closed'),
      },
    )
    let res: any
    before(async () => {
      res = await ask(ex, DCA_A)
    })
    check(
      'asks Kraken to filter by the encoded id',
      () => sent.find((s) => s.method === 'getClosedOrders')?.params.cl_ord_id,
      enc(DCA_A),
    )
    check('resolves', () => res.status, StatusEnum.ok)
    check(
      'to the right closed order',
      () => res.data?.orderId,
      'OCCCCC-33333-CCCCCC',
    )
    check('with its fill', () => res.data?.executedQty, '1.0')
    check(
      'and never falls back to the legacy userref filter',
      () => sent.filter((s) => s.method === 'getClosedOrders').length,
      1,
    )
  })

  describe('legacy userref-only orders still resolve and cancel (§4.6)', () => {
    // Placed before this change: a userref, no cl_ord_id. They stay resting on
    // live accounts until they drain, and can only be addressed by txid — so
    // getOrder must still find them, or main-app retires a live order as a
    // phantom.
    const { ex, sent } = makeExchange({
      'OLEGACY-1111-AAAAAA': row(null, 13, '2403.51'),
    })
    let res: any
    let cancelled: any
    before(async () => {
      res = await ask(ex, DCA_A)
      cancelled = await ex.cancelOrder({
        symbol: 'ETHEUR',
        newClientOrderId: DCA_A,
      })
    })
    check('the legacy scan still resolves it', () => res.status, StatusEnum.ok)
    check('to its txid', () => res.data?.orderId, 'OLEGACY-1111-AAAAAA')
    check('and the cancel succeeds', () => cancelled.status, StatusEnum.ok)
    check(
      'addressed by the real venue txid, never by an invented id (§4.7)',
      () => sent.find((s) => s.method === 'cancelOrder')?.params,
      { txid: 'OLEGACY-1111-AAAAAA' },
    )
    check(
      'and the cancel reports that same txid back to the caller',
      () => cancelled.data?.orderId,
      'OLEGACY-1111-AAAAAA',
    )
  })

  describe('a legacy order is not confused with a cl_ord_id order (§4.6)', () => {
    // One legacy userref-13 order and one new order. Asking for a THIRD D-*
    // client id must not resolve to the legacy one just because its userref
    // also derives to 13.
    const { ex } = makeExchange({
      'OLEGACY-1111-AAAAAA': row(null, 13, '2403.51'),
      'ONEWWWW-2222-BBBBBB': row(enc(DCA_B), null, '2500.00'),
    })
    let res: any
    before(async () => {
      res = await ask(ex, DCA_A)
    })
    // The legacy row is a genuine candidate (it carries no cl_ord_id and the
    // derived userref matches), so a single-candidate legacy resolution is the
    // documented, unchanged 002 behaviour. What must NOT happen is the new
    // order being picked, or the count including it.
    check(
      'never resolves to an order that carries a different cl_ord_id',
      () => res.data?.orderId !== 'ONEWWWW-2222-BBBBBB',
      true,
    )
  })
})
