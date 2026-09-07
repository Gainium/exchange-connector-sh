process.env.NODE_ENV = 'testing'

/**
 * Claus #551 — "unsupported wallet for signing typed data" killed every write
 * a Hyperliquid connection attempted (set leverage, cancel, place order) while
 * the connection itself looked perfectly healthy.
 *
 * WHY IT COULD HAPPEN
 * -------------------
 * The HL credential is a raw secp256k1 private key handed straight to the SDK
 * as `wallet`. The SDK dispatches on shape and accepts only `0x` + 64 hex (or
 * bare 64 hex); anything else falls through every branch and throws — but ONLY
 * when something signs. Balance, positions and open orders are info requests
 * keyed on the public *address*, so they never sign: verification passed, the
 * dashboard showed a connected account, and the credential failed for the
 * first time inside a live bot.
 *
 * TWO FIXES, BOTH ASSERTED HERE
 * -----------------------------
 *   1. `normalizeHlPrivateKey` — a valid key wearing whitespace (a trailing
 *      newline from a password manager, a wrapped paste) or an uppercase `0X`
 *      prefix is a key the SDK simply cannot see. Normalize those instead of
 *      failing; asserted end-to-end through `getKeyPermissions`, which derives
 *      the signer with the SDK's own `getWalletAddress`.
 *   2. `checkSigningKey()` — for a secret that is genuinely not a key, fail at
 *      verify time with an instruction, so it can never be saved and then take
 *      out every bot on the connection.
 *
 * Run: `npm test` (mocha).
 *
 * Offline: key derivation is local and no info/exchange call is made.
 */
import { describe, it, before } from 'mocha'
import { Futures } from '../../types'
import HyperliquidExchange from './index'

// Standard secp256k1 test vector, and the address it derives to.
const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'
const ITS_ADDRESS = '0x14791697260e4c9a71f18484c9f997b308e59325'
const OTHER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

/** The SDK's own wording, which bot-error rules match on. Must survive. */
const SDK_MESSAGE = 'unsupported wallet for signing typed data'

/** `getActual` is evaluated lazily, inside the it(), after `before()` has run. */
function expect(label: string, getActual: () => unknown, want: unknown) {
  it(label, () => {
    const actual = getActual()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (!ok) {
      throw new Error(
        `${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
      )
    }
  })
}

const clientFor = (secret: string, address = OTHER_ADDRESS) =>
  new HyperliquidExchange(Futures.usdm, address, secret)

const signable = (secret: string) => clientFor(secret).checkSigningKey()

describe('hyperliquid signing key', () => {
  describe('a valid key wearing extra characters is normalized, not rejected', () => {
    // Each of these IS the test vector above; the SDK rejects all of them.
    const wrapped: Record<string, string> = {
      'trailing newline': `${PRIVATE_KEY}\n`,
      'leading and trailing spaces': `  ${PRIVATE_KEY}  `,
      'wrapped across lines': `${PRIVATE_KEY.slice(0, 34)}\n${PRIVATE_KEY.slice(34)}`,
      'uppercase 0X prefix': `0X${PRIVATE_KEY.slice(2)}`,
      'no 0x prefix': PRIVATE_KEY.slice(2),
      'uppercase hex body': `0x${PRIVATE_KEY.slice(2).toUpperCase()}`,
    }

    const ok: Record<string, boolean> = {}
    // The signer the SDK derives from what we actually hand it. `withdraw:
    // 'yes'` means it derived to ITS_ADDRESS, i.e. the normalized key signs as
    // the very key the user pasted — not merely "some valid key".
    const derived: Record<string, unknown> = {}

    before(async () => {
      for (const [label, secret] of Object.entries(wrapped)) {
        ok[label] = (await signable(secret)).ok
        derived[label] = (
          await clientFor(secret, ITS_ADDRESS).getKeyPermissions()
        ).withdraw
      }
    })

    for (const label of Object.keys(wrapped)) {
      expect(`${label}: accepted as signable`, () => ok[label], true)
      expect(
        `${label}: derives to the key's own address`,
        () => derived[label],
        'yes',
      )
    }
  })

  describe('a secret that is not a key is refused at verify time', () => {
    const bad: Record<string, string> = {
      // One character dropped / added on paste.
      'short by one': PRIVATE_KEY.slice(0, -1),
      'long by one': `${PRIVATE_KEY}a`,
      // The classic swap: the wallet ADDRESS pasted into the key field.
      'an address, not a key': ITS_ADDRESS,
      'not hex at all': 'my-hyperliquid-api-wallet',
      // Out of the curve order — hex-shaped, still unusable.
      'all zeros': `0x${'0'.repeat(64)}`,
      empty: '',
      'whitespace only': '   \n',
    }

    const results: Record<string, { ok: boolean; reason?: string }> = {}

    before(async () => {
      for (const [label, secret] of Object.entries(bad)) {
        results[label] = await signable(secret)
      }
    })

    for (const label of Object.keys(bad)) {
      expect(`${label}: refused`, () => results[label].ok, false)
      expect(
        `${label}: says what to paste instead`,
        () => /64-character private key/.test(results[label].reason ?? ''),
        true,
      )
    }

    // The reason is quoted to the user by main-app, which truncates a connector
    // reason at 300 characters — the actionable half must survive that.
    expect(
      'the reason fits inside the message the user is shown',
      () => (results['not hex at all'].reason ?? '').length <= 300,
      true,
    )

    // Bot-error rules match on the SDK's own wording. Keep it verbatim so the
    // verify-time rejection and the (now unreachable) runtime failure classify
    // as the same fault.
    expect(
      'the reason still contains the SDK wording rules match on',
      () => (results['not hex at all'].reason ?? '').includes(SDK_MESSAGE),
      true,
    )

    // A missing secret is a different sentence — there is nothing to re-check.
    expect(
      'a missing key says it is missing',
      () => /missing/i.test(results.empty.reason ?? ''),
      true,
    )
  })

  describe('the good case is untouched', () => {
    let plain: { ok: boolean; reason?: string }
    before(async () => {
      plain = await signable(PRIVATE_KEY)
    })
    expect('a well-formed key verifies', () => plain.ok, true)
    expect('and carries no reason', () => plain.reason, undefined)
  })
})
