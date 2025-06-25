process.env.NODE_ENV = 'testing'

import OKXExchange from './index'
import { ExchangeIntervals, Futures, OKXSource } from '../../types'

let ind = 0

const count = 50

let done = 0
let error = 0
;(async () => {
  for (const i of [...Array(count).keys()]) {
    const t = new OKXExchange(
      Futures.null,
      '',
      '',
      '',
      undefined,
      undefined,
      OKXSource.com,
    )

    t.getCandles(
      'INJ-USDT',
      ExchangeIntervals.fiveM,
      1741003323000,
      +new Date(),
      100,
    ).then((res) => {
      ind++
      if (res.status === 'NOTOK') {
        console.log(`${i} (${ind}) / ${count} | error`)
        console.log(res)
        error++
        console.log(`done: ${done} | error: ${error}`)
      } else {
        console.log(`${i} (${ind}) / ${count} | done`)
        done++
        console.log(`done: ${done} | error: ${error}`)
      }
    })
  }
})()
