process.env.NODE_ENV = 'testing'

/**
 * Bitget Unified Trading Account (v3) support, and Reality stock tokens.
 *
 * A unified account is refused by every classic v2 private endpoint, and
 * Reality tokens (rAAPL…) can only be traded from one. The adapter now picks
 * v2 or v3 per key; public market data stays on v2.
 *
 * Run: `npm test` (mocha). No network — both REST clients are stubbed with
 * bodies shaped like the venue's (the custom client throws
 * `{ code, message, body: { code, msg } }` for any non-'00000' body).
 */
import { beforeEach, describe, it } from 'mocha'
import {
  ExchangeIntervals,
  Futures,
  MarginType,
  PositionSide,
  StatusEnum,
} from '../../types'
import BitgetExchange from './index'
import {
  COINM_PERP_NEEDS_UTA,
  REALITY_NEEDS_UTA,
  UTA_COINM_UNSUPPORTED,
  UTA_MISSING_PERMISSIONS,
  accountModeFromSettings,
  clearAccountModeCache,
  convertUtaAssets,
  convertUtaOrder,
  aggregateCandles,
  realityBaseInterval,
  realityGranularity,
  setRealitySymbols,
} from './uta'

const UNIFIED_REFUSAL =
  'you are in unified account mode, and the classic account api is not supported at this time'

const bitgetError = (code: string, msg: string) => ({
  code: 400,
  message: 'Bad Request',
  body: { code, msg },
})

function eq(label: string, actual: unknown, want: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

const orderRow = (o: Record<string, unknown>) => ({
  orderId: '1',
  clientOid: 'c1',
  category: 'SPOT',
  symbol: 'RAAPLUSDT',
  orderType: 'limit',
  side: 'buy',
  price: '330.5',
  qty: '0.1',
  cumExecQty: '0',
  cumExecValue: '0',
  avgPrice: '0',
  orderStatus: 'live',
  feeDetail: [],
  createdTime: '1789000000000',
  updatedTime: '1789000001000',
  ...o,
})

/** A connector whose v3 client is `v3` and whose classic client is `v2`. */
function stub(
  futures: Futures,
  v3: Record<string, (...a: any[]) => any>,
  v2: Record<string, (...a: any[]) => any> = {},
) {
  const ex = new BitgetExchange(futures, 'key', 's', 'p') as any
  ex.checkLimits = async () => undefined
  ex.orderClient = v3
  ex.client = v2
  return ex
}

const unified = {
  getAccountSettingsV3: async () => ({
    data: { accountMode: 'unified', holdMode: 'hedge_mode' },
  }),
}

describe('bitget UTA — account mode', () => {
  beforeEach(() => clearAccountModeCache())

  it('reads unified/hybrid/upgrading as UTA and switching as classic', () => {
    eq('unified', accountModeFromSettings({ accountMode: 'unified' }), 'uta')
    eq('hybrid', accountModeFromSettings({ accountMode: 'hybrid' }), 'uta')
    eq(
      'upgrading',
      accountModeFromSettings({ accountMode: 'upgrading' }),
      'uta',
    )
    eq(
      'switching',
      accountModeFromSettings({ accountMode: 'switching' }),
      'classic',
    )
    eq('empty', accountModeFromSettings({}), undefined)
  })

  it('a unified account is served from v3 assets', async () => {
    const ex = stub(Futures.null, {
      ...unified,
      getAccountAssetsV3: async () => ({
        data: {
          assets: [
            { coin: 'USDT', balance: '100', available: '80', locked: '20' },
            { coin: 'rAAPL', balance: '0.5', available: '0.5', locked: '0' },
          ],
        },
      }),
    })
    const res = await ex.getBalance()
    eq('status', res.status, StatusEnum.ok)
    eq('assets', res.data, [
      { asset: 'USDT', free: 80, locked: 20 },
      { asset: 'rAAPL', free: 0.5, locked: 0 },
    ])
  })

  it('a classic refusal flips an undetermined key to v3 and retries there', async () => {
    let classicCalls = 0
    const ex = stub(
      Futures.null,
      {
        // transport failure: settles nothing
        getAccountSettingsV3: async () => {
          throw new Error('socket hang up (no body)')
        },
        getAccountAssetsV3: async () => ({
          data: { assets: [{ coin: 'USDT', balance: '5', available: '5' }] },
        }),
      },
      {
        getSpotAccountAssets: async () => {
          classicCalls++
          throw bitgetError('40084', UNIFIED_REFUSAL)
        },
      },
    )
    const res = await ex.getBalance()
    eq('status', res.status, StatusEnum.ok)
    eq('assets', res.data, [{ asset: 'USDT', free: 5, locked: 0 }])
    eq('classic tried once', classicCalls, 1)
    // the flip is remembered: no further classic call
    await ex.getBalance()
    eq('classic not retried', classicCalls, 1)
  })

  it('a classic account keeps the classic path', async () => {
    const ex = stub(
      Futures.null,
      {
        getAccountSettingsV3: async () => {
          throw bitgetError('40085', 'not a unified account')
        },
      },
      {
        getSpotAccountAssets: async () => ({
          code: '00000',
          data: [{ coin: 'BTC', available: '1', locked: '0', frozen: '0' }],
        }),
      },
    )
    const res = await ex.getBalance()
    eq('assets', res.data, [{ asset: 'BTC', free: 1, locked: 0 }])
  })
})

describe('bitget UTA — orders', () => {
  beforeEach(() => clearAccountModeCache())

  it('spot limit order on a Reality token goes to v3 place-order', async () => {
    const sent: any[] = []
    const ex = stub(Futures.null, {
      ...unified,
      placeOrderV3: async (p: any) => {
        sent.push(p)
        return { data: { orderId: '1', clientOid: p.clientOid } }
      },
      getOrderInfoV3: async () => ({ data: orderRow({}) }),
    })
    const res = await ex.openOrder({
      symbol: 'RAAPLUSDT',
      side: 'BUY',
      quantity: 0.1,
      price: 330.5,
      newClientOrderId: 'c1',
      type: 'LIMIT',
    })
    eq('status', res.status, StatusEnum.ok)
    eq('payload', sent[0], {
      category: 'SPOT',
      symbol: 'RAAPLUSDT',
      qty: '0.1',
      side: 'buy',
      orderType: 'limit',
      price: '330.5',
      timeInForce: 'gtc',
      clientOid: 'c1',
    })
    eq(
      'order',
      [res.data.status, res.data.type, res.data.side],
      ['NEW', 'LIMIT', 'BUY'],
    )
  })

  it('hedge close-long is sell + posSide long; one-way close is reduceOnly', async () => {
    const sent: any[] = []
    const ex = stub(Futures.usdm, {
      ...unified,
      placeOrderV3: async (p: any) => {
        sent.push(p)
        return { data: { clientOid: p.clientOid } }
      },
      getOrderInfoV3: async () => ({
        data: orderRow({ category: 'USDT-FUTURES', symbol: 'BTCUSDT' }),
      }),
    })
    await ex.openOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      quantity: 0.01,
      price: 60000,
      newClientOrderId: 'h1',
      type: 'LIMIT',
      reduceOnly: true,
      positionSide: PositionSide.LONG,
      marginType: MarginType.ISOLATED,
    })
    await ex.openOrder({
      symbol: 'BTCUSDC',
      side: 'BUY',
      quantity: 0.01,
      price: 60000,
      newClientOrderId: 'o1',
      type: 'LIMIT',
      reduceOnly: true,
      positionSide: PositionSide.BOTH,
    })
    eq(
      'hedge',
      [
        sent[0].category,
        sent[0].side,
        sent[0].posSide,
        sent[0].reduceOnly,
        sent[0].marginMode,
      ],
      ['USDT-FUTURES', 'sell', 'long', undefined, 'isolated'],
    )
    eq(
      'one-way',
      [
        sent[1].category,
        sent[1].side,
        sent[1].posSide,
        sent[1].reduceOnly,
        sent[1].marginMode,
      ],
      ['USDC-FUTURES', 'buy', undefined, 'yes', 'crossed'],
    )
  })

  it('a classic account picking a Reality token is told it needs UTA', async () => {
    setRealitySymbols(['RAAPLUSDT'])
    let placed = false
    const ex = stub(
      Futures.null,
      {
        getAccountSettingsV3: async () => {
          throw bitgetError('40085', 'not a unified account')
        },
      },
      {},
    )
    ex.orderClient.spotSubmitOrder = async () => {
      placed = true
    }
    const res = await ex.openOrder({
      symbol: 'RAAPLUSDT',
      side: 'BUY',
      quantity: 10,
      price: 330,
      newClientOrderId: 'c2',
      type: 'MARKET',
    })
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, REALITY_NEEDS_UTA)
    eq('not placed', placed, false)
  })

  // Superseded by spec 014: the unified line now carries the inverse
  // perpetuals, and an inverse account's balance is read from it like any
  // other. Only the classic delivery contracts stay off it.
  it('a unified inverse account reads its margin coins from v3', async () => {
    const ex = stub(Futures.coinm, {
      ...unified,
      getAccountAssetsV3: async () => ({
        data: {
          assets: [
            { coin: 'BTC', balance: '0.5', available: '0.25', locked: '0.25' },
          ],
        },
      }),
    })
    const res = await ex.getBalance()
    eq('status', res.status, StatusEnum.ok)
    eq('assets', res.data, [{ asset: 'BTC', free: 0.25, locked: 0.25 }])
  })
})

describe('bitget UTA — conversions', () => {
  it('market order price is the average fill; fees come from feeDetail', () => {
    const o = convertUtaOrder(
      orderRow({
        orderType: 'market',
        price: '0',
        avgPrice: '331.2',
        orderStatus: 'filled',
        cumExecQty: '0.03',
        cumExecValue: '9.936',
        feeDetail: [{ feeCoin: 'rAAPL', fee: '-0.00003' }],
      }) as any,
    )
    eq(
      'fields',
      [
        o.price,
        o.status,
        o.type,
        o.executedQty,
        o.cummulativeQuoteQty,
        o.feePaid,
        o.feeAsset,
      ],
      ['331.2', 'FILLED', 'MARKET', '0.03', '9.936', '0.00003', 'RAAPL'],
    )
    eq('spot has no position side', o.positionSide, undefined)
  })

  it('futures orders carry position side from holdMode/posSide', () => {
    const hedge = convertUtaOrder(
      orderRow({
        category: 'USDT-FUTURES',
        holdMode: 'hedge_mode',
        posSide: 'short',
        side: 'buy',
        reduceOnly: 'YES',
        orderStatus: 'cancelled',
      }) as any,
    )
    const oneWay = convertUtaOrder(
      orderRow({
        category: 'USDT-FUTURES',
        holdMode: 'one_way_mode',
        posSide: 'long',
        orderStatus: 'partially_filled',
      }) as any,
    )
    eq(
      'hedge',
      [hedge.positionSide, hedge.side, hedge.reduceOnly, hedge.status],
      ['SHORT', 'BUY', true, 'CANCELED'],
    )
    eq(
      'one-way',
      [oneWay.positionSide, oneWay.status],
      ['BOTH', 'PARTIALLY_FILLED'],
    )
  })

  it('free + locked is the balance, and futures keeps only margin coins', () => {
    eq(
      'partition',
      convertUtaAssets(
        [
          { coin: 'USDT', balance: '1000', available: '600', locked: '50' },
          { coin: 'BTC', balance: '1', available: '1' },
        ],
        ['USDT', 'USDC'],
      ),
      [{ asset: 'USDT', free: 600, locked: 400 }],
    )
  })

  it('Reality candles come from a UTC-aligned native interval', () => {
    eq(
      'base',
      [
        ExchangeIntervals.oneM,
        ExchangeIntervals.threeM,
        ExchangeIntervals.thirtyM,
        ExchangeIntervals.twoH,
        ExchangeIntervals.fourH,
        ExchangeIntervals.eightH,
        ExchangeIntervals.oneD,
        ExchangeIntervals.oneW,
      ].map((i) => [realityBaseInterval(i), realityGranularity(i)]),
      [
        ['1m', '1min'],
        ['1m', '1min'],
        ['15m', '15min'],
        ['1h', '1h'],
        ['4h', '4h'],
        ['4h', '4h'],
        ['4h', '4h'],
        ['4h', '4h'],
      ],
    )
  })

  it('aggregates 4h candles into UTC days and Monday weeks', () => {
    const H4 = 4 * 60 * 60 * 1000
    // Monday 2026-09-14 00:00 UTC
    const monday = Date.UTC(2026, 8, 14)
    const bars = [...Array(18).keys()].map((k) => ({
      time: monday - 2 * H4 + k * H4, // starts Sunday 16:00 (mid-day)
      open: `${100 + k}`,
      high: `${110 + k}`,
      low: `${90 + k}`,
      close: `${101 + k}`,
      volume: '1',
    }))
    const days = aggregateCandles(bars, 24 * 60 * 60 * 1000)
    const DAY = 24 * 60 * 60 * 1000
    // Sunday 16:00–24:00 is a partial first day and is dropped.
    eq(
      'days',
      days.map((d) => [d.time, d.open, d.high, d.low, d.close, d.volume]),
      [
        [monday, '102', '117', '92', '108', '6'],
        [monday + DAY, '108', '123', '98', '114', '6'],
        [monday + 2 * DAY, '114', '127', '104', '118', '4'],
      ],
    )
    const weeks = aggregateCandles(bars, 7 * 24 * 60 * 60 * 1000, true)
    eq(
      'week start',
      weeks.map((w) => w.time),
      [monday],
    )
  })
})

describe('bitget spot exchange info — Reality tokens are listed as stocks', () => {
  it('lists rTokens with assetClass stock and keeps other stock rows out', async () => {
    const ex = stub(
      Futures.null,
      {
        getInstrumentsV3: async () => ({
          code: '00000',
          data: [
            { symbol: 'RAAPLUSDT', symbolType: 'stock', isReality: 'yes' },
            { symbol: 'PREOPAIUSDT', symbolType: 'stock', isReality: 'no' },
            { symbol: 'BTCUSDT', symbolType: 'crypto', isReality: 'no' },
          ],
        }),
      },
      {
        getSpotTicker: async () => ({ code: '00000', data: [] }),
        getSpotSymbolInfo: async () => ({
          code: '00000',
          data: ['RAAPLUSDT', 'PREOPAIUSDT', 'BTCUSDT'].map((symbol) => ({
            symbol,
            status: 'online',
            baseCoin: symbol.replace('USDT', ''),
            quoteCoin: 'USDT',
            minTradeAmount: '0',
            maxTradeAmount: '0',
            quantityPrecision: '4',
            quotePrecision: '6',
            minTradeUSDT: '10',
            orderQuantity: '200',
            pricePrecision: '2',
            makerFeeRate: '0.001',
            takerFeeRate: '0.001',
            sellLimitPriceRatio: '0.1',
            buyLimitPriceRatio: '0.1',
          })),
        }),
      },
    )
    const res = await ex.getAllExchangeInfo()
    eq(
      'pairs',
      res.data.map((p: any) => [p.pair, p.assetClass]),
      [
        ['RAAPLUSDT', 'stock'],
        ['BTCUSDT', 'crypto'],
      ],
    )
  })
})

describe('bitget UTA — fees', () => {
  beforeEach(() => clearAccountModeCache())

  /** Spot pairs for a listing, shaped as `getSpotSymbolInfo` returns them. */
  const spotSymbols = (symbols: string[]) =>
    symbols.map((symbol) => ({
      symbol,
      status: 'online',
      baseCoin: symbol.replace('USDT', ''),
      quoteCoin: 'USDT',
      minTradeAmount: '0',
      maxTradeAmount: '0',
      quantityPrecision: '4',
      quotePrecision: '6',
      minTradeUSDT: '10',
      orderQuantity: '200',
      pricePrecision: '2',
      makerFeeRate: '0.001',
      takerFeeRate: '0.001',
      sellLimitPriceRatio: '0.1',
      buyLimitPriceRatio: '0.1',
    }))

  it('stops the classic fee fan-out at the first refusal and answers from v3', async () => {
    const symbols = Array.from({ length: 24 }, (_, i) => `C${i}USDT`)
    let tradeRateCalls = 0
    const ex = stub(
      Futures.null,
      {
        // transport failure: the mode is undetermined, so classic runs first
        getAccountSettingsV3: async () => {
          throw new Error('socket hang up (no body)')
        },
        getInstrumentsV3: async () => ({ code: '00000', data: [] }),
        getAllFeeRatesV3: async () => ({
          code: '00000',
          data: symbols.map((symbol) => ({
            symbol,
            makerFeeRate: '0.0002',
            takerFeeRate: '0.0004',
          })),
        }),
      },
      {
        getSpotTicker: async () => ({ code: '00000', data: [] }),
        getSpotSymbolInfo: async () => ({
          code: '00000',
          data: spotSymbols(symbols),
        }),
        getTradeRate: async () => {
          tradeRateCalls++
          throw bitgetError('40084', UNIFIED_REFUSAL)
        },
      },
    )

    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.ok)
    eq('pairs priced', res.data.length, symbols.length)
    eq('v3 rates', res.data[0], {
      pair: 'C0USDT',
      maker: 0.0002,
      taker: 0.0004,
    })
    // one chunk of 8, not one refused call per listed pair
    if (tradeRateCalls > 8) {
      throw new Error(`classic fan-out kept going: ${tradeRateCalls} calls`)
    }
  })

  it("a key without the unified permissions is told to edit it, not Bitget's wording", async () => {
    const ex = stub(Futures.null, {
      ...unified,
      getAllFeeRatesV3: async () => {
        throw bitgetError(
          '40014',
          'incorrect permissions, need uta manage read or uta manage write permissions',
        )
      },
      getInstrumentsV3: async () => ({ code: '00000', data: [] }),
    })
    ex.spot_getAllExchangeInfo = async () =>
      ex.returnGood(ex.getEmptyTimeProfile())([
        { pair: 'BTCUSDT', makerFee: 0.001, takerFee: 0.001 },
      ])
    const res = await ex.getAllUserFees()
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, UTA_MISSING_PERMISSIONS)
  })
})

/**
 * Spec 014 — Bitget's inverse perpetuals live only on the unified line, under
 * a `_CM` name, sized in whole 1-USD contracts. The platform keeps its own
 * name and its own unit (the base coin) on both sides of that boundary.
 */
describe('bitget UTA — inverse perpetuals', () => {
  beforeEach(() => clearAccountModeCache())

  const perpInstrument = {
    symbol: 'BTCUSD_CM',
    category: 'COIN-FUTURES',
    baseCoin: 'BTC',
    quoteCoin: 'USD',
    symbolType: 'crypto',
    type: 'perpetual',
    status: 'online',
    minOrderQty: '1',
    minOrderAmount: '5',
    pricePrecision: '1',
    priceMultiplier: '0.1',
    quantityPrecision: '0',
    makerFeeRate: '0.0002',
    takerFeeRate: '0.0006',
    sellLimitPriceRatio: '0.05',
    buyLimitPriceRatio: '0.05',
    maxProductOrderNum: '400',
    maxSymbolOrderNum: '',
    minLeverage: '1',
    maxLeverage: '125',
  }

  const deliveryContract = {
    symbol: 'BTCUSDU26',
    symbolStatus: 'normal',
    baseCoin: 'BTC',
    quoteCoin: 'USD',
    minTradeNum: '0.001',
    volumePlace: '3',
    sizeMultiplier: '0.001',
    minTradeUSDT: '5',
    maxSymbolOrderNum: '200',
    pricePlace: '1',
    priceEndStep: '1',
    minLever: '1',
    maxLever: '50',
    makerFeeRate: '0.0002',
    takerFeeRate: '0.0006',
    sellLimitPriceRatio: '0.05',
    buyLimitPriceRatio: '0.05',
    supportMarginCoins: ['BTC'],
  }

  const perpOrder = (o: Record<string, unknown> = {}) => ({
    orderId: '9',
    clientOid: 'c9',
    category: 'COIN-FUTURES',
    symbol: 'BTCUSD_CM',
    orderType: 'limit',
    side: 'buy',
    price: '80000',
    qty: '800',
    cumExecQty: '0',
    cumExecValue: '0',
    avgPrice: '0',
    orderStatus: 'live',
    holdMode: 'one_way_mode',
    feeDetail: [],
    createdTime: '1789900000000',
    updatedTime: '1789900001000',
    ...o,
  })

  it('lists inverse perpetuals from v3 beside the classic delivery contracts', async () => {
    const ex = stub(
      Futures.coinm,
      {
        getInstrumentsV3: async () => ({
          code: '00000',
          data: [
            perpInstrument,
            { ...perpInstrument, symbol: 'OLDUSD_CM', status: 'offline' },
          ],
        }),
      },
      {
        getFuturesContractConfig: async () => ({
          code: '00000',
          data: [deliveryContract],
        }),
      },
    )
    const res = await ex.getAllExchangeInfo()
    eq('status', res.status, StatusEnum.ok)
    eq(
      'pairs',
      res.data.map((p: any) => p.pair),
      ['BTCUSDU26', 'BTCUSD'],
    )
    const perp = res.data[1]
    eq('margined in the coin', perp.marginCoins, ['BTC'])
    eq('venue minimum notional', perp.quoteAsset.minAmount, 5)
    // a base step of 0 would read as "whole coins only" downstream
    eq('base step', perp.baseAsset.step, 0.00000001)
    eq('price step', perp.priceMultiplier.decimals, 0.1)
  })

  it('sends a perpetual as _CM, sized in whole 1-USD contracts', async () => {
    let placed: Record<string, string> = {}
    const ex = stub(Futures.coinm, {
      ...unified,
      placeOrderV3: async (o: Record<string, string>) => {
        placed = o
        return { data: { clientOid: 'c9' } }
      },
      getOrderInfoV3: async () => ({ data: perpOrder() }),
    })
    const res = await ex.openOrder({
      symbol: 'BTCUSD',
      side: 'BUY',
      quantity: 0.01,
      price: 80000,
      type: 'LIMIT',
      newClientOrderId: 'c9',
    })
    eq('category', placed.category, 'COIN-FUTURES')
    eq('venue symbol', placed.symbol, 'BTCUSD_CM')
    eq('contracts', placed.qty, '800')
    eq('status', res.status, StatusEnum.ok)
    // and the answer comes back in the platform's own name and unit
    eq('pair', res.data.symbol, 'BTCUSD')
    eq('base quantity', res.data.origQty, '0.01')
  })

  it('a market order with no price of its own is sized from the venue', async () => {
    let placed: Record<string, string> = {}
    const ex = stub(Futures.coinm, {
      ...unified,
      getTickersV3: async () => ({
        code: '00000',
        data: [{ symbol: 'BTCUSD_CM', lastPrice: '50000' }],
      }),
      placeOrderV3: async (o: Record<string, string>) => {
        placed = o
        return { data: { clientOid: 'c9' } }
      },
      getOrderInfoV3: async () => ({
        data: perpOrder({ orderType: 'market', price: '0', qty: '500' }),
      }),
    })
    const res = await ex.openOrder({
      symbol: 'BTCUSD',
      side: 'SELL',
      quantity: 0.01,
      price: 0,
      type: 'MARKET',
      newClientOrderId: 'c9',
    })
    eq('contracts', placed.qty, '500')
    eq('status', res.status, StatusEnum.ok)
  })

  it('reads quantity back in base, from whichever unit the venue agrees with', async () => {
    const ex = stub(Futures.coinm, {
      ...unified,
      // the venue's own figures say this qty is the base coin:
      // 0.01 * 80000 === 800
      getOrderInfoV3: async () => ({
        data: perpOrder({
          qty: '0.01',
          cumExecQty: '0.01',
          cumExecValue: '800',
          avgPrice: '80000',
          orderStatus: 'filled',
        }),
      }),
    })
    const res = await ex.getOrder({ symbol: 'BTCUSD', orderId: '9' })
    eq('left alone', res.data.executedQty, '0.01')
    eq('pair', res.data.symbol, 'BTCUSD')

    const contracts = stub(Futures.coinm, {
      ...unified,
      // and here they say it is contracts: 800 / 80000 === 0.01
      getOrderInfoV3: async () => ({
        data: perpOrder({
          qty: '800',
          cumExecQty: '800',
          cumExecValue: '0.01',
          avgPrice: '80000',
          orderStatus: 'filled',
        }),
      }),
    })
    const res2 = await contracts.getOrder({ symbol: 'BTCUSD', orderId: '9' })
    eq('converted', res2.data.executedQty, '0.01')
    eq('traded notional', res2.data.cummulativeQuoteQty, '800')
  })

  it('positions come back in the base coin, under the platform name', async () => {
    const ex = stub(Futures.coinm, {
      ...unified,
      getCurrentPositionsV3: async () => ({
        data: [
          {
            symbol: 'BTCUSD_CM',
            posSide: 'long',
            holdMode: 'one_way_mode',
            marginMode: 'crossed',
            positionBalance: '0.01',
            total: '800',
            leverage: '10',
            avgPrice: '80000',
            unrealisedPnl: '0.0001',
            updatedTime: '1789900001000',
          },
        ],
      }),
    })
    const res = await ex.futures_getPositions('BTCUSD')
    eq('pair', res.data[0].symbol, 'BTCUSD')
    eq('size in base', res.data[0].positionAmt, '0.01')
  })

  it('a delivery contract stays off the unified line', async () => {
    const ex = stub(Futures.coinm, {
      ...unified,
      placeOrderV3: async () => {
        throw new Error('the delivery contract must never be sent to v3')
      },
    })
    const res = await ex.openOrder({
      symbol: 'BTCUSDU26',
      side: 'BUY',
      quantity: 0.01,
      price: 80000,
      type: 'LIMIT',
    })
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, UTA_COINM_UNSUPPORTED)
  })

  it('a classic key is told the perpetual needs a unified account', async () => {
    const ex = stub(
      Futures.coinm,
      {
        getAccountSettingsV3: async () => {
          throw bitgetError('40085', 'not a unified account')
        },
      },
      {
        placeFuturesOrder: async () => {
          throw new Error('classic cannot carry a perpetual any more')
        },
      },
    )
    const res = await ex.openOrder({
      symbol: 'BTCUSD',
      side: 'BUY',
      quantity: 0.01,
      price: 80000,
      type: 'LIMIT',
    })
    eq('status', res.status, StatusEnum.notok)
    eq('reason', res.reason, COINM_PERP_NEEDS_UTA)
  })

  it('candles come from v3, on the UTC-aligned granularity', async () => {
    const asked: Record<string, string>[] = []
    const ex = stub(Futures.coinm, {
      ...unified,
      getCandlesV3: async (params: Record<string, string>) => {
        asked.push(params)
        return {
          code: '00000',
          data: [
            ['1789862400000', '80000', '81000', '79000', '80500', '1', '2'],
          ],
        }
      },
    })
    const res = await ex.getCandles('BTCUSD', ExchangeIntervals.oneD)
    eq('symbol', asked[0].symbol, 'BTCUSD_CM')
    eq('granularity', asked[0].interval, '1Dutc')
    eq('category', asked[0].category, 'COIN-FUTURES')
    eq('candle', res.data[0], {
      time: 1789862400000,
      open: '80000',
      high: '81000',
      low: '79000',
      close: '80500',
      volume: '2',
    })
  })
})
