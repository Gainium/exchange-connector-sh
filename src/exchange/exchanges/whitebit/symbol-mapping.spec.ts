process.env.NODE_ENV = 'testing'

/**
 * Unit-level check for WhiteBit symbol mapping — spec 002 §2.4.
 *
 * WhiteBit's Market Info endpoint returns spot AND perpetual markets in ONE
 * list, disambiguated only by a `_PERP` suffix:
 *
 *   spot  `BTC_USDT` = `{BASE}_{QUOTE}`
 *   perp  `BTC_PERP` = `{BASE}_PERP`   — no quote segment at all
 *
 * Two failure modes this pins down, both silent:
 *
 *  1. A naive `replace('_','-')` turns `BTC_PERP` into the pair `BTC-PERP`,
 *     which exists nowhere else on the platform — the bot would look up prices,
 *     fees and precision for a market that does not exist.
 *  2. Splitting the combined list on anything other than the suffix puts perp
 *     markets in the spot universe (or vice versa), so `whitebit` would offer
 *     perps and `whitebitUsdm` would try to open positions on spot pairs.
 *
 * Symbol mapping is documented in the integration runbook as the #1 source of
 * post-launch bugs, which is why the round trip is asserted in both directions
 * for both variants.
 *
 * Run: `npm test` (mocha).
 *
 * No network — the mapper is fed a fixed Market Info fixture.
 */
import { describe, it } from 'mocha'
import {
  isWhitebitPerpMarket,
  splitWhitebitMarkets,
  whitebitMarketToPair,
  WhitebitSymbolMapper,
  WHITEBIT_PERP_SUFFIX,
} from './symbolMapper'

function expect(label: string, actual: unknown, want: unknown) {
  it(label, () => {
    if (actual !== want) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

function check(label: string, ok: boolean, detail = '') {
  it(label, () => {
    if (!ok) throw new Error(detail ? `${label} :: ${detail}` : label)
  })
}

/**
 * A trimmed Market Info response: spot and perps interleaved, exactly as
 * WhiteBit returns them. `ETH_BTC` is here on purpose — a non-USDT spot pair
 * proves the spot branch reads the quote off the payload rather than assuming.
 */
const MARKETS = [
  { name: 'BTC_USDT', stock: 'BTC', money: 'USDT', type: 'spot' },
  { name: 'BTC_PERP', stock: 'BTC', money: 'USDT', type: 'futures' },
  { name: 'ETH_USDT', stock: 'ETH', money: 'USDT', type: 'spot' },
  { name: 'ETH_PERP', stock: 'ETH', money: 'USDT', type: 'futures' },
  { name: 'ETH_BTC', stock: 'ETH', money: 'BTC', type: 'spot' },
  { name: 'SOL_PERP', stock: 'SOL', money: 'USDT', type: 'futures' },
]

describe('WhiteBit symbol mapping (spec 002 §2.4)', () => {
  describe('the suffix is the discriminator', () => {
    expect('the suffix constant', WHITEBIT_PERP_SUFFIX, '_PERP')
    check('BTC_PERP is a perp', isWhitebitPerpMarket('BTC_PERP'))
    check('BTC_USDT is not a perp', !isWhitebitPerpMarket('BTC_USDT'))
    // `PERP_USDT` would be a spot market for a token called PERP. Only a
    // trailing `_PERP` counts, never a substring match.
    check('PERP_USDT is not a perp', !isWhitebitPerpMarket('PERP_USDT'))
    check('empty string is not a perp', !isWhitebitPerpMarket(''))
  })

  describe('splitting one combined list into two universes', () => {
    const { spot, usdm } = splitWhitebitMarkets(MARKETS)

    expect('spot count', spot.length, 3)
    expect('usdm count', usdm.length, 3)
    check(
      'no perp leaked into spot',
      spot.every((m) => !m.name.endsWith('_PERP')),
      spot.map((m) => m.name).join(','),
    )
    check(
      'every usdm entry is a perp',
      usdm.every((m) => m.name.endsWith('_PERP')),
      usdm.map((m) => m.name).join(','),
    )
    expect(
      'spot names',
      spot.map((m) => m.name).join(','),
      'BTC_USDT,ETH_USDT,ETH_BTC',
    )
    expect(
      'usdm names',
      usdm.map((m) => m.name).join(','),
      'BTC_PERP,ETH_PERP,SOL_PERP',
    )
    expect('empty input is safe', splitWhitebitMarkets([]).spot.length, 0)
    expect(
      'undefined input is safe',
      splitWhitebitMarkets(undefined).usdm.length,
      0,
    )
  })

  describe('normalizing a market into a Gainium pair', () => {
    expect(
      'spot: BTC_USDT -> BTC-USDT',
      whitebitMarketToPair(MARKETS[0]),
      'BTC-USDT',
    )
    // The one that matters: the venue leaves the quote implicit on a perp, so
    // it has to be recovered from the payload — NOT from the symbol.
    expect(
      'perp: BTC_PERP -> BTC-USDT (never BTC-PERP)',
      whitebitMarketToPair(MARKETS[1]),
      'BTC-USDT',
    )
    expect(
      'non-USDT spot quote is read, not assumed',
      whitebitMarketToPair(MARKETS[4]),
      'ETH-BTC',
    )
    expect(
      'perp with no payload quote falls back to USDT',
      whitebitMarketToPair({ name: 'DOGE_PERP' }),
      'DOGE-USDT',
    )
    expect(
      'spot with no payload assets falls back to the name',
      whitebitMarketToPair({ name: 'XRP_USDT' }),
      'XRP-USDT',
    )
    expect(
      'empty name yields empty pair',
      whitebitMarketToPair({ name: '' }),
      '',
    )
  })

  describe('the spot mapper instance', () => {
    WhitebitSymbolMapper.resetInstancesForTests()
    const mapper = WhitebitSymbolMapper.getSpotInstance()
    const { spot } = splitWhitebitMarkets(MARKETS)
    mapper.updateMaps(
      spot.map((m) => ({ pair: whitebitMarketToPair(m), code: m.name })),
    )

    expect('variant', mapper.getVariant(), 'spot')
    check('initialized after updateMaps', mapper.getIsInitialized())
    expect(
      'toWhitebitSymbol: BTC-USDT -> BTC_USDT',
      mapper.toWhitebitSymbol('BTC-USDT'),
      'BTC_USDT',
    )
    expect(
      'toOurSymbol: BTC_USDT -> BTC-USDT',
      mapper.toOurSymbol('BTC_USDT'),
      'BTC-USDT',
    )
    expect(
      'round trip via the venue form',
      mapper.toOurSymbol(mapper.toWhitebitSymbol('ETH-BTC')),
      'ETH-BTC',
    )
    expect('known pair count', mapper.knownPairs().length, 3)
    check(
      'the spot mapper knows no perp market',
      !mapper.knownWhitebitSymbols().some((s) => s.endsWith('_PERP')),
      mapper.knownWhitebitSymbols().join(','),
    )
    // An unlisted market still derives correctly rather than hanging (Kraken's
    // mapper sleeps and recurses when uninitialized; the derivation here is
    // exact for every market WhiteBit lists).
    expect(
      'unknown spot pair derives',
      mapper.toWhitebitSymbol('ADA-USDT'),
      'ADA_USDT',
    )
    expect('empty input is safe', mapper.toWhitebitSymbol(''), '')
  })

  describe('the usdm mapper instance', () => {
    WhitebitSymbolMapper.resetInstancesForTests()
    const mapper = WhitebitSymbolMapper.getUsdmInstance()
    const { usdm } = splitWhitebitMarkets(MARKETS)
    mapper.updateMaps(
      usdm.map((m) => ({ pair: whitebitMarketToPair(m), code: m.name })),
    )

    expect('variant', mapper.getVariant(), 'usdm')
    expect(
      'toWhitebitSymbol: BTC-USDT -> BTC_PERP',
      mapper.toWhitebitSymbol('BTC-USDT'),
      'BTC_PERP',
    )
    expect(
      'toOurSymbol: BTC_PERP -> BTC-USDT',
      mapper.toOurSymbol('BTC_PERP'),
      'BTC-USDT',
    )
    expect(
      'round trip',
      mapper.toOurSymbol(mapper.toWhitebitSymbol('SOL-USDT')),
      'SOL-USDT',
    )
    // The same normalized pair maps to a different venue symbol per variant —
    // which is exactly why the mapper is one cached singleton PER VARIANT.
    expect(
      'unknown perp derives with the suffix, not the quote',
      mapper.toWhitebitSymbol('DOGE-USDT'),
      'DOGE_PERP',
    )
    expect('known pair count', mapper.knownPairs().length, 3)
  })

  describe('the two singletons are independent', () => {
    WhitebitSymbolMapper.resetInstancesForTests()
    const spotMapper = WhitebitSymbolMapper.getSpotInstance()
    const usdmMapper = WhitebitSymbolMapper.getUsdmInstance()
    const { spot, usdm } = splitWhitebitMarkets(MARKETS)
    spotMapper.updateMaps(
      spot.map((m) => ({ pair: whitebitMarketToPair(m), code: m.name })),
    )
    usdmMapper.updateMaps(
      usdm.map((m) => ({ pair: whitebitMarketToPair(m), code: m.name })),
    )

    check('they are different objects', spotMapper !== usdmMapper)
    check(
      'getSpotInstance is cached',
      WhitebitSymbolMapper.getSpotInstance() === spotMapper,
    )
    check(
      'getUsdmInstance is cached',
      WhitebitSymbolMapper.getUsdmInstance() === usdmMapper,
    )
    expect(
      'BTC-USDT resolves to spot on the spot mapper',
      spotMapper.toWhitebitSymbol('BTC-USDT'),
      'BTC_USDT',
    )
    expect(
      'and to the perp on the usdm mapper',
      usdmMapper.toWhitebitSymbol('BTC-USDT'),
      'BTC_PERP',
    )
  })
})
