process.env.NODE_ENV = 'testing'

/**
 * Kraken futures `getCandles` asks the charts API for TRADE candles.
 *
 * It used to ask for `mark` candles: mark prices with a volume of 0 on every
 * bar. The live price connector archives `candles_trade_*` (trade) candles, so
 * each futures series mixed two price sources and volume-based indicators read
 * 0 wherever the archive had been backfilled through here.
 *
 * Run: `npm test` (mocha). No network / auth — the derivatives client is stubbed.
 */
import { describe, it } from 'mocha'
import { ExchangeIntervals, Futures } from '../../types'
import KrakenExchange from './index'

describe('Kraken futures getCandles', () => {
  it('requests trade candles and keeps their volume', async () => {
    const ex: any = new KrakenExchange(Futures.usdm, '', '')
    const calls: any[] = []
    ex.toKrakenSymbol = async () => 'PF_XBTUSD'
    ex.checkLimits = async () => undefined
    ex.derivativesClient = {
      getCandles: async (params: any) => {
        calls.push(params)
        return {
          candles: [
            {
              time: 1700002800000,
              open: '35629',
              high: '35695',
              low: '35528',
              close: '35568',
              volume: '81.3541',
            },
          ],
        }
      },
    }
    const res = await ex.getCandles(
      'BTC-USD',
      ExchangeIntervals.oneH,
      1700002800000,
      1700006400000,
    )
    if (calls.length !== 1 || calls[0].tickType !== 'trade') {
      throw new Error(
        `tickType: got ${JSON.stringify(calls[0]?.tickType)} want "trade"`,
      )
    }
    if (calls[0].symbol !== 'PF_XBTUSD' || calls[0].resolution !== '1h') {
      throw new Error(`request: ${JSON.stringify(calls[0])}`)
    }
    if (res.data?.[0]?.volume !== '81.3541') {
      throw new Error(`volume: got ${JSON.stringify(res.data?.[0])}`)
    }
  })
})
