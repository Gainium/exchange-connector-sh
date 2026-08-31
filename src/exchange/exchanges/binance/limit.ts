import 'dotenv/config'
import { MainClient } from 'binance'
import { getBinanceBase } from '../../helpers/exchaneUtils'
import { ExchangeDomain } from '../../types'
import { Logger } from '@nestjs/common'
import { IdMute, IdMutex } from '../../../utils/mutex'

const isNewLimit = () => +new Date() >= 1692921600000

let weight = 0
let lastWeightTime = 0
let binanceRequest = false
let weightCountWhileRequest = 0

let usdmWeight = 0
let usdmLastWeightTime = 0
let usdmBinanceRequest = false
let usdmWeightCountWhileRequest = 0

let coinmWeight = 0
let coinmLastWeightTime = 0
let coinmBinanceRequest = false
let coinmWeightCountWhileRequest = 0

let weightUS = 0
let lastWeightTimeUS = 0
let binanceRequestUS = false
let weightCountWhileRequestUS = 0

/**
 * Raw-request budget, tracked PER ENDPOINT FAMILY.
 *
 * This used to be ONE `rawCount`/`rawLastTime` pair shared by
 * `addRawSpotRequest`, `addRawUsdmRequest` and `addRawCoinmRequest` — three
 * byte-identical functions mutating the same two variables. Spot, USD-M and
 * COIN-M therefore competed for a single 1800/min allowance and reset each
 * other's window, so futures traffic throttled spot placement and vice versa,
 * for no venue reason at all: they are three different hosts
 * (api/fapi/dapi.binance.com) metered separately by Binance.
 *
 * Measured from Binance's own `exchangeInfo` on 2026-08-31:
 *   spot  api  — REQUEST_WEIGHT 6000/min, RAW_REQUESTS 300000 per 5 MINUTE
 *   usdm  fapi — REQUEST_WEIGHT 2400/min, no RAW_REQUESTS limit published
 *   coinm dapi — REQUEST_WEIGHT 2400/min, no RAW_REQUESTS limit published
 * i.e. the shared 1800/min was ~3% of spot's real raw ceiling and was also
 * being charged against two hosts that publish no raw limit whatsoever.
 * `rawLimit` is left at 1800 PER FAMILY here: this counter is a backstop
 * against a runaway request loop, not a model of the venue's limit (the weight
 * budget is that), and raising it is a separate decision from fixing the
 * sharing. See the CHANGELOG entry.
 */
type RawFamily = 'com' | 'usdm' | 'coinm'
const rawState: Record<RawFamily, { count: number; lastTime: number }> = {
  com: { count: 0, lastTime: 0 },
  usdm: { count: 0, lastTime: 0 },
  coinm: { count: 0, lastTime: 0 },
}

/**
 * Hand back a raw slot taken by `addRawRequest` for a call that then got parked
 * by the weight budget and so never reached Binance. Not mutex-guarded, exactly
 * as the shared-counter version was not: it is a synchronous decrement with no
 * await inside it.
 */
const refundRawSlot = (family: RawFamily) => {
  rawState[family].count--
}

const orderFrame = 11000
const orderCountInFrame = 80
const weightFrame = 60000
const weightInFrameUs = () => (isNewLimit() ? 4500 : 950)
const weightInFrameCom = () => (isNewLimit() ? 4500 : 950)

const usdmOrderFrame = 10000
const usdmOrderCountInFrame = 250
const usdmWeightFrame = 60000
const usdmWeightInFrame = 2000

const coinmOrderFrame = 60000
const coinmOrderCountInFrame = 1000
const coinmWeightFrame = 60000
const coinmWeightInFrame = 2000

const rawLimit = 1800
const rawTimeframe = 60 * 1000

/**
 * Share of a minute's weight budget that NON-ORDER requests may spend. The
 * remainder is reserved for placing and cancelling orders.
 *
 * A refused request is not dropped, it is parked until the weight window
 * rolls over — `weightFrame - (time % weightFrame)`, i.e. the top of the next
 * minute — because that is when Binance itself resets the counter. With one
 * undifferentiated budget that makes a user's order placement wait behind the
 * background reads that happened to arrive first, and they vastly outnumber
 * it: on 2026-08-30 a connector logged 2,000 parked Binance calls in 4h of
 * which 1,403 were `getOrder` and only 197 `openOrder`. Grid bots on
 * binanceUsdm could then only place in the first ~10s of each minute — the
 * fresh budget was gone by second 10 — so a filled grid level waited up to
 * 3 minutes for its replacement (bug #583, community thread 5093).
 *
 * Reserving headroom is what makes the ordering right: reads are backstops
 * (reconcile lookups, candles, balances) and can afford the deferral, an
 * order cannot. It does not raise the total we send Binance.
 */
const requestWeightShare = 0.85

/**
 * The weight ceiling this caller may spend against. Orders get the whole
 * budget; everything else stops at {@link requestWeightShare} of it.
 */
const weightCapFor = (budget: number, isOrder: boolean) =>
  isOrder ? budget : budget * requestWeightShare

let bannedTimeUs = 0
let bannedTimeCoinm = 0
let bannedTimeUsdm = 0
let bannedTimeCom = 0

const mutex = new IdMutex()

type UserOrder = { count: number; lastTime: number }
type Type = 'us' | 'com' | 'usdm' | 'coinm'

class RawClass {
  static instance: RawClass

  static getInstance() {
    if (!RawClass.instance) {
      RawClass.instance = new RawClass()
    }
    return RawClass.instance
  }

  private usersOrders: Map<Type, Map<string, UserOrder>> = new Map()
  /**
   * Charge one raw request against `family`'s own budget. The mutex key is
   * scoped to the family too — a single global lock over three now-independent
   * counters would serialise spot behind futures while protecting nothing.
   */
  @IdMute(mutex, (family: RawFamily) => `${family}addRaw`)
  async addRawRequest(family: RawFamily, isOrder = false) {
    const s = rawState[family]
    const time = new Date().getTime()
    if (time - s.lastTime > rawTimeframe) {
      s.count = 1
      s.lastTime = time - (time % rawTimeframe)
      return 0
    }
    s.count++
    if (s.count > weightCapFor(rawLimit, isOrder)) {
      // Parked, so never sent: give the slot back. Same reserve as the
      // per-domain weight budgets — orders spend the whole budget, reads stop
      // at `requestWeightShare` of it.
      s.count--
      return rawTimeframe - (time % rawTimeframe)
    }
    return 0
  }
  @IdMute(mutex, () => 'binance')
  async checkBannedTime(type: Type) {
    if (type === 'us') {
      if (bannedTimeUs && bannedTimeUs > new Date().getTime()) {
        return bannedTimeUs - new Date().getTime()
      } else {
        bannedTimeUs = 0
      }
      return 0
    }
    if (type === 'com') {
      if (bannedTimeCom && bannedTimeCom > new Date().getTime()) {
        return bannedTimeCom - new Date().getTime()
      } else {
        bannedTimeCom = 0
      }
      return 0
    }
    if (type === 'usdm') {
      if (bannedTimeUsdm && bannedTimeUsdm > new Date().getTime()) {
        return bannedTimeUsdm - new Date().getTime()
      } else {
        bannedTimeUsdm = 0
      }
      return 0
    }
    if (type === 'coinm') {
      if (bannedTimeCoinm && bannedTimeCoinm > new Date().getTime()) {
        return bannedTimeCoinm - new Date().getTime()
      } else {
        bannedTimeCoinm = 0
      }
      return 0
    }
  }

  @IdMute(mutex, (type: Type) => `${type}addOrder`)
  async addOrder(type: Type, key: string) {
    const byType = this.usersOrders.get(type) ?? new Map<string, UserOrder>()
    const byKey = byType.get(key) ?? { count: 0, lastTime: 0 }
    const time = new Date().getTime()
    const frame =
      type === 'us' || type === 'com'
        ? orderFrame
        : type === 'usdm'
          ? usdmOrderFrame
          : coinmOrderFrame
    const count =
      type === 'us' || type === 'com'
        ? orderCountInFrame
        : type === 'usdm'
          ? usdmOrderCountInFrame
          : coinmOrderCountInFrame
    if (time - byKey.lastTime > frame) {
      byKey.count = 1
      byKey.lastTime = time - (time % frame)
      byType.set(key, byKey)
      this.usersOrders.set(type, byType)
      return 0
    } else {
      byKey.count++
      byType.set(key, byKey)
      this.usersOrders.set(type, byType)
      if (byKey.count > count) {
        return frame - (time % frame)
      }
      return 0
    }
  }
}

const Raw = RawClass.getInstance()

const setBannedTime = (time: number, type: 'us' | 'com' | 'usdm' | 'coinm') => {
  if (type === 'us') {
    bannedTimeUs = Math.max(bannedTimeUs, time)
  }
  if (type === 'com') {
    bannedTimeCom = Math.max(bannedTimeCom, time)
  }
  if (type === 'usdm') {
    bannedTimeUsdm = Math.max(bannedTimeUsdm, time)
  }
  if (type === 'coinm') {
    bannedTimeCoinm = Math.max(bannedTimeCoinm, time)
  }
}

const addOrder = async (key: string) => {
  const weightData = await addWeight(1, true)

  if (weightData > 0) {
    return weightData
  }
  return await Raw.addOrder('com', key)
}

const addOrderUsdm = async (key: string) => {
  const weightData = await addWeightUsdm(1, true)

  if (weightData > 0) {
    return weightData
  }
  return await Raw.addOrder('usdm', key)
}

const addOrderCoinm = async (key: string) => {
  const weightData = await addWeightCoinm(1, true)

  if (weightData > 0) {
    return weightData
  }
  return await Raw.addOrder('coinm', key)
}

const multiplier = 1.2

let weightQueueCounter = 0

const weightQueueCounterInc = 1

const addWeight = async (_w: number, isOrder = false) => {
  const banned = await Raw.checkBannedTime('com')
  if (banned) {
    return banned
  }
  const raw = await Raw.addRawRequest('com', isOrder)
  if (raw) {
    return raw
  }
  const w = _w * multiplier
  const time = new Date().getTime()
  if (time - lastWeightTime > weightFrame) {
    lastWeightTime = time - (time % weightFrame)
    weight = w
    if (binanceRequest) {
      weightCountWhileRequest = w
    }
    weightQueueCounter = 0
    return 0
  } else {
    weight += w
    if (binanceRequest) {
      weightCountWhileRequest += w
    }
    if (weight > weightCapFor(weightInFrameCom(), isOrder)) {
      refundRawSlot('com')
      // Parked, so it never reaches Binance and must not be charged for. The
      // raw slot was already handed back above; the weight was not, so the
      // counter tracked ATTEMPTS instead of what we actually sent — and every
      // parked attempt inflated it further, which both keeps the window shut
      // longer than the venue does and reports a usage figure above 1.0 on the
      // `exchangeLimits` channel the balancer routes by (240% was observed).
      weight -= w
      if (binanceRequest) {
        weightCountWhileRequest -= w
      }
      const wait = weightFrame - (time % weightFrame) + weightQueueCounter
      weightQueueCounter += weightQueueCounterInc
      return wait
    }
    weightQueueCounter = 0
    return 0
  }
}

let weightQueueCounterUsdm = 0

const weightQueueCounterIncUsdm = 1

const addWeightUsdm = async (_w: number, isOrder = false) => {
  const banned = await Raw.checkBannedTime('usdm')
  if (banned) {
    return banned
  }
  const raw = await Raw.addRawRequest('usdm', isOrder)
  if (raw) {
    return raw
  }
  const w = _w * multiplier
  const time = new Date().getTime()
  if (time - usdmLastWeightTime > usdmWeightFrame) {
    usdmLastWeightTime = time - (time % usdmWeightFrame)
    usdmWeight = w
    if (usdmBinanceRequest) {
      usdmWeightCountWhileRequest = w
    }
    weightQueueCounterUsdm = 0
    return 0
  } else {
    usdmWeight += w
    if (usdmBinanceRequest) {
      usdmWeightCountWhileRequest += w
    }
    if (usdmWeight > weightCapFor(usdmWeightInFrame, isOrder)) {
      refundRawSlot('usdm')
      // See `addWeight`: a parked request is not a sent request.
      usdmWeight -= w
      if (usdmBinanceRequest) {
        usdmWeightCountWhileRequest -= w
      }
      const wait =
        usdmWeightFrame - (time % usdmWeightFrame) + weightQueueCounterUsdm
      weightQueueCounterUsdm += weightQueueCounterIncUsdm
      return wait
    }
    weightQueueCounterUsdm = 0
    return 0
  }
}

let weightQueueCounterCoinm = 0

const weightQueueCounterIncCoinm = 1

const addWeightCoinm = async (_w: number, isOrder = false) => {
  const banned = await Raw.checkBannedTime('coinm')
  if (banned) {
    return banned
  }
  const raw = await Raw.addRawRequest('coinm', isOrder)
  if (raw) {
    return raw
  }
  const w = _w * multiplier
  const time = new Date().getTime()
  if (time - coinmLastWeightTime > coinmWeightFrame) {
    coinmLastWeightTime = time - (time % coinmWeightFrame)
    coinmWeight = w
    if (coinmBinanceRequest) {
      coinmWeightCountWhileRequest = w
    }
    weightQueueCounterCoinm = 0
    return 0
  } else {
    coinmWeight += w
    if (coinmBinanceRequest) {
      coinmWeightCountWhileRequest += w
    }
    if (coinmWeight > weightCapFor(coinmWeightInFrame, isOrder)) {
      refundRawSlot('coinm')
      // See `addWeight`: a parked request is not a sent request.
      coinmWeight -= w
      if (coinmBinanceRequest) {
        coinmWeightCountWhileRequest -= w
      }
      const wait =
        coinmWeightFrame - (time % coinmWeightFrame) + weightQueueCounterCoinm
      weightQueueCounterCoinm += weightQueueCounterIncCoinm
      return wait
    }
    weightQueueCounterCoinm = 0
    return 0
  }
}

let weightQueueCounterUs = 0

const weightQueueCounterIncUs = 1

const addOrderUS = async (key: string) => {
  const weightData = await addWeightUS(1, true)

  if (weightData > 0) {
    return weightData
  }
  return await Raw.addOrder('us', key)
}

const addWeightUS = async (w: number, isOrder = false) => {
  const banned = await Raw.checkBannedTime('us')
  if (banned) {
    return banned
  }
  const time = new Date().getTime()
  if (time - lastWeightTimeUS > weightFrame) {
    lastWeightTimeUS = time - (time % weightFrame)
    weightUS = w
    if (binanceRequestUS) {
      weightCountWhileRequestUS = w
    }
    weightQueueCounterUs = 0
    return 0
  } else {
    weightUS += w
    if (binanceRequestUS) {
      weightCountWhileRequestUS += w
    }
    if (weightUS > weightCapFor(weightInFrameUs(), isOrder)) {
      // See `addWeight`: a parked request is not a sent request.
      weightUS -= w
      if (binanceRequestUS) {
        weightCountWhileRequestUS -= w
      }
      const wait = weightFrame - (time % weightFrame) + weightQueueCounterUs
      weightQueueCounterUs += weightQueueCounterIncUs
      return wait
    }
    weightQueueCounterUs = 0
    return 0
  }
}

const setLimits = (data: { orderCount10s?: string; usedWeight1m?: string }) => {
  const time = new Date().getTime()
  const weightInput = parseFloat(data.usedWeight1m || '0')
  weight = weightInput + weightCountWhileRequest
  lastWeightTime = time - (time % weightFrame)
}

const setLimitsUsdm = (data: {
  orderCount10s?: string
  usedWeight1m?: string
}) => {
  const time = new Date().getTime()
  const weightInput = parseFloat(data.usedWeight1m || '0')
  usdmWeight = weightInput + usdmWeightCountWhileRequest
  usdmLastWeightTime = time - (time % usdmWeightFrame)
}

const setLimitsCoinm = (data: {
  orderCount10s?: string
  usedWeight1m?: string
}) => {
  const time = new Date().getTime()
  const weightInput = parseFloat(data.usedWeight1m || '0')
  coinmWeight = weightInput + coinmWeightCountWhileRequest
  coinmLastWeightTime = time - (time % coinmWeightFrame)
}

const setLimitsUS = (data: {
  orderCount10s?: string
  usedWeight1m?: string
}) => {
  const time = new Date().getTime()
  const weightInput = parseFloat(data.usedWeight1m || '0')
  weightUS = weightInput + weightCountWhileRequestUS
  lastWeightTimeUS = time - (time % weightFrame)
}

const getLimitsFromBinance = async () => {
  binanceRequest = true
  try {
    const binance = new MainClient({
      baseUrl: getBinanceBase(ExchangeDomain.com),
    })
    await binance.getServerTime()
    binanceRequest = false
    setLimits({
      orderCount10s: binance
        .getRateLimitStates()
        ['x-mbx-order-count-10s'].toString(),
      usedWeight1m: binance
        .getRateLimitStates()
        ['x-mbx-used-weight-1m'].toString(),
    })
  } catch {
    Logger.warn('Error connecting Binance')
  }
}

const getUsdmLimitsFromBinance = async () => {
  usdmBinanceRequest = true
  try {
    const binance = new MainClient()
    await binance.getServerTime()
    usdmBinanceRequest = false
    setLimitsUsdm({
      orderCount10s: binance
        .getRateLimitStates()
        ['x-mbx-order-count-10s'].toString(),
      usedWeight1m: binance
        .getRateLimitStates()
        ['x-mbx-used-weight-1m'].toString(),
    })
  } catch {
    Logger.warn('Error connecting Binance USDM')
  }
}

const getCoinmLimitsFromBinance = async () => {
  coinmBinanceRequest = true
  try {
    const binance = new MainClient()
    await binance.getServerTime()
    coinmBinanceRequest = false
    setLimitsCoinm({
      orderCount10s: binance
        .getRateLimitStates()
        ['x-mbx-order-count-10s'].toString(),
      usedWeight1m: binance
        .getRateLimitStates()
        ['x-mbx-used-weight-1m'].toString(),
    })
  } catch {
    Logger.warn('Error connecting Binance COINM')
  }
}

const getLimitsFromBinanceUS = async () => {
  binanceRequestUS = true
  try {
    const binance = new MainClient({
      baseUrl: getBinanceBase(ExchangeDomain.us),
    })
    await binance.getServerTime()
    binanceRequestUS = false
    setLimitsUS({
      orderCount10s: binance
        .getRateLimitStates()
        ['x-mbx-order-count-10s'].toString(),
      usedWeight1m: binance
        .getRateLimitStates()
        ['x-mbx-used-weight-1m'].toString(),
    })
  } catch {
    Logger.warn('Error connecting Binance US')
  }
}

getLimitsFromBinance()
getLimitsFromBinanceUS()
getUsdmLimitsFromBinance()
getCoinmLimitsFromBinance()

const getLimits = () => ({
  weight,
  lastWeightTime,
})

const getUsage = () => {
  const time = +new Date()
  let weightUsage = 1
  if (time - lastWeightTime > weightFrame) {
    weightUsage = 0
  } else {
    weightUsage = weight / weightInFrameCom()
  }
  let weightUsageUs = 1
  if (time - lastWeightTimeUS > weightFrame) {
    weightUsageUs = 0
  } else {
    weightUsageUs = weightUS / weightInFrameUs()
  }
  let usdmWeightUsage = 1
  if (time - usdmLastWeightTime > usdmWeightFrame) {
    usdmWeightUsage = 0
  } else {
    usdmWeightUsage = usdmWeight / usdmWeightInFrame
  }
  let coinmWeightUsage = 1
  if (time - coinmLastWeightTime > coinmWeightFrame) {
    coinmWeightUsage = 0
  } else {
    coinmWeightUsage = coinmWeight / usdmWeightInFrame
  }
  return [
    { type: 'weight', value: weightUsage },
    { type: 'weightUS', value: weightUsageUs },
    { type: 'usdmWeight', value: usdmWeightUsage },
    { type: 'coinmWeight', value: coinmWeightUsage },
  ]
}

export default {
  addOrder,
  addWeight,
  addOrderUS,
  addWeightUS,
  setLimits,
  setLimitsUS,
  getLimits,
  getUsage,
  addOrderUsdm,
  addWeightUsdm,
  setLimitsUsdm,
  addOrderCoinm,
  addWeightCoinm,
  setLimitsCoinm,
  setBannedTime,
}
