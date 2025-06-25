process.env.NODE_ENV = 'testing'

import { Futures } from '../../types'
import KucoinApi from './index'

let ind = 0

const count = 1

const test = async () => {
  for (const i of [...Array(count).keys()]) {
    const t = new KucoinApi(Futures.usdm, '', '', '')
    await t.getAllExchangeInfo().then((res) => {
      ind++
      if (res.status === 'NOTOK') {
        console.log(`${i} (${ind}) / ${count} | error`)
        console.log(res)
      } else {
        console.log(`${i} (${ind}) / ${count} | done`)
        console.log(res.data.find((d) => d.pair === 'BTCUSDT'))
      }
    })
  }
}

test()
