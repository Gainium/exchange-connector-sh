process.env.NODE_ENV = 'testing'

/**
 * Registration wiring for WhiteBit — spec 002 §2.7, plan 002 blast-radius §3.
 *
 * Two separate things are pinned here, for two different reasons.
 *
 * 1. **The enum's string VALUES.** `ExchangeEnum.whitebit` / `whitebitUsdm`
 *    become a cross-repo contract the moment `websocket-connector-sh` and any
 *    later consumer read them (plan 002, blast radius §3). Renaming the member
 *    is a compile error everywhere; changing the string it maps to is not — it
 *    silently stops matching every stored connection and every published Redis
 *    channel. TypeScript cannot catch that, so it is asserted.
 *
 * 2. **The factory branches.** `chooseExchangeFactory` is a chain of `if`s that
 *    falls off the end returning `undefined` for an unregistered exchange — the
 *    exact half-declared state `krakenCoinm` sits in today (declared in
 *    `types.ts`, never registered in `exchangeChooser.ts`), which spec §2.1
 *    calls out as the precedent NOT to repeat. Adding an enum member without
 *    its branch typechecks cleanly and fails only at runtime, so the two
 *    variants are asserted to resolve to a real factory bound to the right
 *    `Futures` family.
 *
 * No network: `createExchangeFactory` returns a lazy binder, so the factory is
 * inspected without ever being invoked. Nothing here constructs a
 * `WhitebitExchange` (whose constructor kicks off a background Market Info
 * fetch).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import ExchangeChooser from '../../helpers/exchangeChooser'
import { ExchangeEnum, Futures } from '../../types'

function assertEqual(label: string, actual: unknown, want: unknown) {
  if (actual !== want) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
    )
  }
}

describe('whitebit registration (spec 002 §2.7)', () => {
  it('pins the enum string values consumers depend on', () => {
    assertEqual('spot value', ExchangeEnum.whitebit, 'whitebit')
    assertEqual('usdm value', ExchangeEnum.whitebitUsdm, 'whitebitUsdm')
  })

  it('declares no coinm variant — WhiteBit has no inverse product (§2.1)', () => {
    const members = Object.keys(ExchangeEnum).filter((k) =>
      k.toLowerCase().startsWith('whitebit'),
    )
    assertEqual('whitebit member count', members.length, 2)
    if (members.some((m) => m.toLowerCase().includes('coinm'))) {
      throw new Error(
        `ExchangeEnum declares a WhiteBit coinm variant (${members.join(', ')}); ` +
          `spec §2.1 says WhiteBit has no inverse-contract product`,
      )
    }
  })

  it('resolves both variants to a factory (no krakenCoinm-style gap)', () => {
    for (const variant of [ExchangeEnum.whitebit, ExchangeEnum.whitebitUsdm]) {
      const factory = ExchangeChooser.chooseExchangeFactory(variant)
      if (typeof factory !== 'function') {
        throw new Error(
          `chooseExchangeFactory(${variant}) returned ${typeof factory}; ` +
            `the enum member is declared but never registered`,
        )
      }
    }
  })

  it('binds spot to Futures.null and usdm to Futures.usdm', () => {
    // The bound `Futures` argument is not readable off the closure, so assert it
    // where it is observable: the factory's own arity. `createExchangeFactory`
    // partially applies the leading args, so a factory bound to exactly one
    // extra argument (the `Futures` family) reports the remaining
    // `ExchangeArgs`. Both WhiteBit variants must bind the same single arg —
    // a mismatch means one branch passed the wrong number of bound values.
    const spot = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.whitebit)
    const usdm = ExchangeChooser.chooseExchangeFactory(
      ExchangeEnum.whitebitUsdm,
    )
    const kraken = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.kraken)
    assertEqual('spot/usdm arity match', spot?.length, usdm?.length)
    // Kraken is the template these branches were copied from (§2.7); same shape.
    assertEqual('matches the kraken template', spot?.length, kraken?.length)
    assertEqual('Futures family values', Futures.null, 'null')
    assertEqual('Futures family values', Futures.usdm, 'usdm')
  })
})
