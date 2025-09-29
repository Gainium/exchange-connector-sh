process.env.NODE_ENV = 'testing'

import HyperliquidExchange from './index'
import { Futures } from '../../types'

let ind = 0

const count = 1

;(async () => {
  for (const i of [...Array(count).keys()]) {
    const t = new HyperliquidExchange(Futures.null, '', '')
    t.getAllExchangeInfo().then((res) => {
      ind++
      if (res.status === 'NOTOK') {
        console.log(`${i} (${ind}) / ${count} | error`)
        console.log(res.reason)
      } else {
        console.log(`${i} (${ind}) / ${count} | done`)
        res.data.map((r) => console.log(r))
      }
    })
  }
})()
