process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/051.bitget-futures-free-ignores-cross-unrealized-loss.md`.
 *
 * In cross margin mode Bitget accepts a new order only up to its own
 * `crossedMaxAvailable`, which already subtracts the unrealized loss of the
 * open cross positions. `free` was derived as `wallet balance - committed`
 * and never subtracted that loss, so a bot with losing cross positions saw a
 * free balance far above what the venue would let it spend: it sent safety
 * orders, the venue refused them, and the refusal message quoted that `free`
 * next to a much smaller required amount.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BitgetExchange from './index'

type AccountRow = Record<string, string>

function stub(futures: Futures, productType: string, rows: AccountRow[]) {
  const ex = new BitgetExchange(futures, 'k', 's', 'p') as any
  ex.checkLimits = async () => undefined
  ex.client = {
    getFuturesAccountAssets: async (p: { productType: string }) => ({
      code: '00000',
      msg: 'success',
      data: p.productType === productType ? rows : [],
    }),
  }
  return ex
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-8
function check(label: string, actual: number, want: number) {
  if (!near(actual, want)) {
    throw new Error(`${label}: got ${actual}, want ${want}`)
  }
}

async function usdt(rows: AccountRow[]) {
  const res = await stub(
    Futures.usdm,
    'USDT-FUTURES',
    rows,
  ).futures_getBalance()
  if (res.status !== StatusEnum.ok) {
    throw new Error(`expected OK, got ${res.status} ${res.reason}`)
  }
  const b = res.data.find((r: { asset: string }) => r.asset === 'USDT')
  if (!b) throw new Error('no USDT row returned')
  return b as { free: number; locked: number }
}

/**
 * §2.1 — cross positions in loss:
 *   wallet balance    10000 = accountEquity 8500 - unrealizedPL (-1500)
 *   crossedMargin      7000
 *   venue's spendable   800 (crossedMaxAvailable)
 * The order the bot wants to place needs 935.
 */
const LOSING_CROSS: AccountRow = {
  marginCoin: 'USDT',
  locked: '0',
  available: '10000',
  crossedMaxAvailable: '800',
  isolatedMaxAvailable: '800',
  maxTransferOut: '800',
  accountEquity: '8500',
  usdtEquity: '8500',
  unrealizedPL: '-1500',
  crossedMargin: '7000',
  isolatedMargin: '0',
}

describe('bitget futures_getBalance — free is what the venue lets the account spend', () => {
  it('§1.1 losing cross positions: free is the venue figure, not wallet - margin', async () => {
    const b = await usdt([LOSING_CROSS])
    // Before the fix: free = 10000 - 7000 = 3000, three times the 935 order
    // the venue refuses.
    check('free', b.free, 800)
    if (b.free >= 935) {
      throw new Error(
        `free ${b.free} would let a 935 order through that the venue refuses`,
      )
    }
  })

  it('§1.2 the partition still holds: free + locked is the wallet balance', async () => {
    const b = await usdt([LOSING_CROSS])
    check('free + locked', b.free + b.locked, 10000)
    check('locked', b.locked, 9200)
  })

  it('§1.3 a venue figure above ours never raises free (profit, or a looser mode)', async () => {
    const b = await usdt([
      {
        ...LOSING_CROSS,
        crossedMaxAvailable: '4500',
        accountEquity: '11500',
        unrealizedPL: '1500',
      },
    ])
    check('free', b.free, 3000)
    check('free + locked', b.free + b.locked, 10000)
  })

  it('§1.4 venue figure missing or unreadable: free falls back to wallet - committed', async () => {
    for (const v of [undefined, '', 'abc']) {
      const row = { ...LOSING_CROSS } as AccountRow
      if (v === undefined) delete row.crossedMaxAvailable
      else row.crossedMaxAvailable = v
      const b = await usdt([row])
      check(`free (crossedMaxAvailable=${v})`, b.free, 3000)
    }
  })

  it('§1.4 a negative venue figure clamps free to 0, never below', async () => {
    const b = await usdt([{ ...LOSING_CROSS, crossedMaxAvailable: '-50' }])
    check('free', b.free, 0)
    check('free + locked', b.free + b.locked, 10000)
  })
})

describe('bitget futures_getBalance — inverse (COIN-M) is out of scope', () => {
  it('§3 coin-m free is not capped by crossedMaxAvailable (spec 011 anchor kept)', async () => {
    const ex = stub(Futures.coinm, 'COIN-FUTURES', [
      {
        marginCoin: 'BTC',
        locked: '0',
        available: '0.01',
        crossedMaxAvailable: '0.001',
        accountEquity: '0.01',
        unrealizedPL: '0',
        crossedMargin: '0',
        isolatedMargin: '0',
      },
    ])
    const res = await ex.futures_getBalance()
    const b = res.data.find((r: { asset: string }) => r.asset === 'BTC')
    check('free', b.free, 0.01)
  })
})
