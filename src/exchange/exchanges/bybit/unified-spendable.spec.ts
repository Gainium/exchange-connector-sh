process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/052.bybit-unified-free-ignores-account-available.md`.
 *
 * On a unified account Bybit accepts a new order only while its margin fits
 * in the account-level `totalAvailableBalance`, which nets out open
 * positions' unrealized loss. `free` was `walletBalance - (locked + order IM +
 * position IM)`, which does not, and is the whole wallet when the per-coin
 * margin fields come back empty.
 *
 * Run: `npm test` (mocha). No network — the REST client is stubbed.
 */
import { describe, it } from 'mocha'
import { Futures, StatusEnum } from '../../types'
import BybitExchange from './index'

type Row = Record<string, unknown>

function stub(futures: Futures | null, list: Row[], accountType = 6) {
  const ex = new BybitExchange(futures as Futures, 'k', 's') as any
  ex.checkLimits = async () => undefined
  ex.getAccountType = async () => ({ status: StatusEnum.ok, data: accountType })
  ex.client = {
    getWalletBalance: async () => ({
      retCode: 0,
      retMsg: 'OK',
      result: { list },
    }),
  }
  return ex
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-8
function check(label: string, actual: number, want: number) {
  if (!near(actual, want))
    throw new Error(`${label}: got ${actual}, want ${want}`)
}

async function row(ex: any, asset = 'USDT') {
  const res = await ex.getBalance()
  if (res.status !== StatusEnum.ok) {
    throw new Error(`expected OK, got ${res.status} ${res.reason}`)
  }
  const b = res.data.find((r: { asset: string }) => r.asset === asset)
  if (!b) throw new Error(`no ${asset} row returned`)
  return b as { free: number; locked: number }
}

/**
 * Losing unified account:
 *   walletBalance 10000, position IM 7000, unrealized PnL -1500
 *   venue's available = (10000 - 1500) - 7000 = 1500 USD
 */
const usdtCoin = (over: Row = {}): Row => ({
  coin: 'USDT',
  walletBalance: '10000',
  equity: '8500',
  usdValue: '8500',
  locked: '0',
  totalOrderIM: '0',
  totalPositionIM: '7000',
  unrealisedPnl: '-1500',
  free: '',
  ...over,
})
const unified = (coin: Row[], over: Row = {}): Row => ({
  accountType: 'UNIFIED',
  totalAvailableBalance: '1500',
  coin,
  ...over,
})

describe('bybit getBalance — unified free is what the venue lets the account spend', () => {
  it('§1.1 losing positions: free is totalAvailableBalance, not wallet - margin', async () => {
    const b = await row(stub(Futures.usdm, [unified([usdtCoin()])]))
    // Before the fix: free = 10000 - 7000 = 3000.
    check('free', b.free, 1500)
  })

  it('§1.1 empty per-coin margin fields: free is still the venue figure', async () => {
    const b = await row(
      stub(Futures.usdm, [
        unified([usdtCoin({ totalPositionIM: '', totalOrderIM: '' })], {
          totalAvailableBalance: '200',
        }),
      ]),
    )
    // Before the fix: free = the whole wallet balance, 10000.
    check('free', b.free, 200)
  })

  it('§1.1 the spot leg reads the same unified wallet and gets the same cap', async () => {
    const b = await row(stub(null, [unified([usdtCoin()])]))
    check('free', b.free, 1500)
  })

  it('§1.2 free + locked stays the wallet balance', async () => {
    const b = await row(stub(Futures.usdm, [unified([usdtCoin()])]))
    check('total', b.free + b.locked, 10000)
  })

  it('§1.3 a venue figure above wallet - margin never raises free', async () => {
    const b = await row(
      stub(Futures.usdm, [
        unified([usdtCoin()], { totalAvailableBalance: '9000' }),
      ]),
    )
    check('free', b.free, 3000)
    check('locked', b.locked, 7000)
  })

  it('§1.4 missing figure: free unchanged', async () => {
    const b = await row(
      stub(Futures.usdm, [
        unified([usdtCoin()], { totalAvailableBalance: '' }),
      ]),
    )
    check('free', b.free, 3000)
  })

  it('§1.4 non-stable coin: free unchanged', async () => {
    const btc = usdtCoin({
      coin: 'BTC',
      walletBalance: '1',
      equity: '1',
      usdValue: '90000',
      totalPositionIM: '0',
    })
    const b = await row(stub(null, [unified([btc])]), 'BTC')
    check('free', b.free, 1)
  })

  it('§1.4 classic CONTRACT account: free unchanged', async () => {
    const b = await row(
      stub(
        Futures.usdm,
        [{ ...unified([usdtCoin()]), accountType: 'CONTRACT' }],
        1,
      ),
    )
    check('free', b.free, 3000)
  })

  it('§1.4 negative venue figure clamps free to 0', async () => {
    const b = await row(
      stub(Futures.usdm, [
        unified([usdtCoin()], { totalAvailableBalance: '-50' }),
      ]),
    )
    check('free', b.free, 0)
    check('locked', b.locked, 10000)
  })

  it('§1.4 USD price comes from usdValue / equity', async () => {
    const b = await row(
      stub(Futures.usdm, [
        unified([usdtCoin({ usdValue: '8075' })], {
          totalAvailableBalance: '950',
        }),
      ]),
    )
    // price 8075 / 8500 = 0.95 → 950 USD = 1000 USDT
    check('free', b.free, 1000)
  })
})
