process.env.NODE_ENV = 'testing'

import CoinbaseExchange from './index'
import { CoinbaseKeysType, Futures } from '../../types'

let ind = 0

const count = 1

;(async () => {
  for (const i of [...Array(count).keys()]) {
    const t = new CoinbaseExchange(
      Futures.null,
      undefined,
      undefined,
      undefined,
      undefined,
      CoinbaseKeysType.legacy,
    )
    await t.getAllPrices().then((res) => {
      ind++
      if (res.status === 'NOTOK') {
        console.log(`${i} (${ind}) / ${count} | error`)
        console.log(res)
      } else {
        console.log(`${i} (${ind}) / ${count} | done`)
        console.log(res, res.data.length)
      }
    })
  }
})()
