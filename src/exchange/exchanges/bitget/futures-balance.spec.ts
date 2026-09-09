process.env.NODE_ENV = 'testing'

/**
 * Unit-level repro for bug #594 — a Bitget USDT-M connection whose portfolio
 * Total is far larger than the wallet balance the venue reports.
 *
 * Spec: `specs/006.bitget-futures-balance-double-counts-position-margin.md`.
 *
 * `free`/`locked` are a PARTITION of one wallet balance everywhere else in
 * this connector (Bybit `walletBalance - locked` / `locked`, Binance
 * `maxWithdrawAmount` / `walletBalance - maxWithdrawAmount`), and every
 * consumer renders `free + locked` as the account total. Bitget's `available`
 * is not net of the margin backing a CROSSED position, so reading it as
 * `free` and then adding the position margin as `locked` counts that margin
 * twice (§1.2).
 *
 * Run: `npm test` (mocha).
 *
 * No network / auth needed — the REST client is stubbed with the account
 * bodies below.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'

/** One `/api/v2/mix/account/accounts` row, all-strings as the venue sends it. */
type AccountRow = Record<string, string>

/**
 * A USDT-M connector whose account endpoint answers with `rows` for the
 * USDT-FUTURES product type and nothing for USDC-FUTURES.
 */
function stubAccounts(rows: AccountRow[]) {
  const ex = new BitgetExchange(Futures.usdm, 'k', 's', 'p') as any
  ex.checkLimits = async () => undefined
  ex.client = {
    getFuturesAccountAssets: async ({ productType }: { productType: string }) =>
      productType === 'USDT-FUTURES'
        ? { code: '00000', msg: 'success', data: rows }
        : { code: '00000', msg: 'success', data: [] },
  }
  return ex
}

const usdt = (r: { asset: string; free: number; locked: number }[]) =>
  r.find((b) => b.asset === 'USDT')

/** Rounded to 8dp — the fixtures are exact, this only absorbs FP noise. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-8

function check(label: string, actual: number, want: number) {
  if (!near(actual, want)) {
    throw new Error(`${label}: got ${actual}, want ${want}`)
  }
}

/**
 * §2.1 — three CROSSED positions open. Shaped exactly like the reported
 * account: `available` is (all but a rounding sliver of) the wallet balance
 * even though 4,000 of it is backing the positions, and the venue's own
 * spendable figure is nowhere near it.
 *
 *   wallet balance  5000      = accountEquity 4800 - unrealizedPL (-200)
 *   crossedMargin   4000      (the three positions)
 *   locked             0.21   (venue-frozen)
 *   available       4999.79   = wallet balance - locked, margin NOT netted out
 */
const CROSSED: AccountRow = {
  marginCoin: 'USDT',
  locked: '0.21',
  available: '4999.79',
  crossedMaxAvailable: '799.79',
  isolatedMaxAvailable: '799.79',
  maxTransferOut: '799.79',
  accountEquity: '4800',
  usdtEquity: '4800',
  unrealizedPL: '-200',
  crossedMargin: '4000',
  isolatedMargin: '0',
}

/** An ISOLATED position of the same size, same wallet balance. */
const ISOLATED: AccountRow = {
  ...CROSSED,
  crossedMargin: '0',
  isolatedMargin: '4000',
}

/** Nothing open: the venue's own idle-account shape (§2.3). */
const FLAT: AccountRow = {
  marginCoin: 'USDT',
  locked: '0',
  available: '5000',
  crossedMaxAvailable: '5000',
  isolatedMaxAvailable: '5000',
  maxTransferOut: '5000',
  accountEquity: '5000',
  usdtEquity: '5000',
  unrealizedPL: '0',
  crossedMargin: '0',
  isolatedMargin: '0',
}

describe('bitget futures_getBalance — free + locked is the wallet balance', () => {
  it('§1.1 crossed margin: the total is the wallet balance, not wallet + margin', async () => {
    const ex = stubAccounts([CROSSED])
    const res = await ex.futures_getBalance()
    if (res.status !== StatusEnum.ok) {
      throw new Error(`expected OK, got ${res.status} ${res.reason}`)
    }
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    // The defect: before the fix this is 4999.79 + 4000 = 8999.79, i.e. 1.8x
    // the balance the venue holds.
    check('free + locked', b.free + b.locked, 5000)
    check('locked', b.locked, 4000.21)
    check('free', b.free, 999.79)
  })

  it('§1.1 isolated margin: same invariant, whichever mode the margin is in', async () => {
    const ex = stubAccounts([ISOLATED])
    const res = await ex.futures_getBalance()
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    check('free + locked', b.free + b.locked, 5000)
    check('locked', b.locked, 4000.21)
  })

  it('§3 a flat account is unchanged: free = the whole balance, locked = 0', async () => {
    const ex = stubAccounts([FLAT])
    const res = await ex.futures_getBalance()
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    check('free', b.free, 5000)
    check('locked', b.locked, 0)
  })

  it('§3 no balance is invented or lost when the equity fields are absent', async () => {
    // Older/other product types may not carry accountEquity. Falling back to
    // `available + locked` keeps the account visible instead of reporting a
    // zero balance, which reads as "everything was withdrawn".
    const ex = stubAccounts([
      {
        marginCoin: 'USDT',
        locked: '0.21',
        available: '4999.79',
        crossedMargin: '4000',
        isolatedMargin: '0',
      },
    ])
    const res = await ex.futures_getBalance()
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    check('free + locked', b.free + b.locked, 5000)
  })

  it('§3 margin fields the venue omits never turn a balance into NaN', async () => {
    const ex = stubAccounts([
      {
        marginCoin: 'USDT',
        locked: '0',
        available: '5000',
        accountEquity: '5000',
        unrealizedPL: '0',
      },
    ])
    const res = await ex.futures_getBalance()
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    if (!Number.isFinite(b.free) || !Number.isFinite(b.locked)) {
      throw new Error(`non-finite balance: free=${b.free} locked=${b.locked}`)
    }
    check('free', b.free, 5000)
    check('locked', b.locked, 0)
  })

  it('§1.1 free never goes negative when the margin exceeds the balance', async () => {
    const ex = stubAccounts([
      {
        marginCoin: 'USDT',
        locked: '0',
        available: '5000',
        accountEquity: '5000',
        unrealizedPL: '0',
        crossedMargin: '6000',
        isolatedMargin: '0',
      },
    ])
    const res = await ex.futures_getBalance()
    const b = usdt(res.data)
    if (!b) throw new Error('no USDT row returned')
    check('free', b.free, 0)
    check('locked', b.locked, 5000)
  })
})
