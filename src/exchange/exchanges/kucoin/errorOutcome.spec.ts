/**
 * Spec 029 — a KuCoin call whose every attempt was definitively refused is
 * reported as a definitive refusal, not as an unknown outcome.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import assert from 'assert'
import { describe, it } from 'mocha'
import {
  exhaustedKucoinReason,
  isAmbiguousKucoinFailure,
  noteKucoinAttempt,
} from './errorOutcome'

const PREFIX = 'Exchange connector | '
const insufficient = {
  message: 'Balance insufficient!',
  code: '200004',
  response: {},
}

describe('KuCoin error outcome (spec 029)', () => {
  it('§1 a definitive venue refusal is not ambiguous', () => {
    assert.strictEqual(isAmbiguousKucoinFailure(insufficient), false)
    assert.strictEqual(
      isAmbiguousKucoinFailure({
        message: 'Too many requests',
        code: '429000',
        response: {},
      }),
      false,
    )
  })

  it('§2 transport failures and 5xx are ambiguous', () => {
    assert.strictEqual(
      isAmbiguousKucoinFailure({ message: 'Request Timeout' }),
      true,
    )
    assert.strictEqual(
      isAmbiguousKucoinFailure({ message: 'fetch failed' }),
      true,
    )
    assert.strictEqual(
      isAmbiguousKucoinFailure({ message: 'x', code: '503000', response: {} }),
      true,
    )
    assert.strictEqual(
      isAmbiguousKucoinFailure({ message: 'x', code: '524' }),
      true,
    )
    assert.strictEqual(isAmbiguousKucoinFailure({ message: 'no answer' }), true)
  })

  it('§3 ten refusals in a row come back WITHOUT the transport prefix', () => {
    const call = {}
    for (let i = 0; i < 10; i++) noteKucoinAttempt(call, insufficient)
    assert.strictEqual(
      exhaustedKucoinReason(call, insufficient, PREFIX),
      'Balance insufficient! | 200004',
    )
  })

  it('§4 one ambiguous attempt keeps the prefix, even if later attempts were refusals', () => {
    // A timeout that may have landed, then "insufficient" because it DID land
    // and took the balance: the outcome is unknown and main-app must ask.
    const call = {}
    noteKucoinAttempt(call, { message: 'Request Timeout' })
    noteKucoinAttempt(call, insufficient)
    assert.strictEqual(
      exhaustedKucoinReason(call, insufficient, PREFIX),
      'Exchange connector | Balance insufficient! | 200004',
    )
  })

  it('§5 calls do not share state', () => {
    const a = {}
    const b = {}
    noteKucoinAttempt(a, { message: 'Request Timeout' })
    noteKucoinAttempt(b, insufficient)
    assert.strictEqual(
      exhaustedKucoinReason(b, insufficient, PREFIX),
      'Balance insufficient! | 200004',
    )
  })
})
