process.env.NODE_ENV = 'testing'

import { Hyperliquid } from 'hyperliquid'
//let ind = 0

const count = 1

;(async () => {
  for (const i of [...Array(count).keys()]) {
    const sdk = new Hyperliquid({ enableWs: false })
    const assets = await sdk.info.spot.getSpotMeta(true)
    console.log(i, JSON.stringify(assets, null, 2))
  }
})()
