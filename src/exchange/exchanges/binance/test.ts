process.env.NODE_ENV = 'testing'

import { ExchangeDomain, ExchangeIntervals, Futures } from '../../types'
import BinanceExchange from './index'

const count = 300

let i = 0

;(async () => {
  for (const _ of [...Array(count).keys()]) {
    const t = new BinanceExchange(ExchangeDomain.com, Futures.usdm, '', '')
    t.futures_getCandles(
      'BTCUSDT',
      ExchangeIntervals.oneM,
      undefined,
      undefined,
      1000,
    ).then((res) => {
      i++
      console.log(res.status, res.reason, `(${i}/${count})`)
    })
  }
})()
