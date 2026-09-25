/**
 * Which KuCoin failures leave the venue's state UNKNOWN.
 *
 * `handleKucoinErrors` retries some definitive answers on purpose — `200004`
 * (Balance insufficient) among them, because a balance freed by a cancel a
 * moment ago can take a beat to show. When the retries run out it used to
 * prefix the reason with `exchangeProblems` ("Exchange connector | ") in every
 * case. main-app reads that prefix as "the outcome is unknown" and re-resolves
 * and re-sends the order, then leaves its row NEW forever — a refused order
 * that never reached the venue shows as resting. Spec 029.
 *
 * The prefix is only honest when at least one attempt failed in a way that
 * could have landed: a transport failure or a 5xx. A run of definitive
 * refusals — every attempt answered, every answer "no" — is itself definitive.
 */

/** Codes KuCoin (or its edge) answers with when the request may have landed. */
const AMBIGUOUS_CODES = new Set([
  '500',
  '502',
  '503',
  '504',
  '520',
  '524',
  '530',
  '500000',
  '503000',
  '-104',
])

const AMBIGUOUS_MESSAGES = [
  'timeout',
  'fetch failed',
  'socket hang up',
  'econnreset',
  'etimedout',
  'internal error',
  'client network socket disconnected',
]

export const isAmbiguousKucoinFailure = (e: {
  message?: string
  code?: string | number
  response?: unknown
}): boolean => {
  const code = `${e.code ?? ''}`
  if (AMBIGUOUS_CODES.has(code)) {
    return true
  }
  const message = `${e.message ?? ''}`.toLowerCase()
  if (AMBIGUOUS_MESSAGES.some((m) => message.indexOf(m) !== -1)) {
    return true
  }
  // No response and no venue code: nothing answered at all.
  return !e.response && !code
}

/**
 * Remembers, per call, whether any attempt so far was ambiguous. Keyed by the
 * call's `timeProfile`, which the retry loop hands to every attempt unchanged.
 */
const ambiguousCalls = new WeakSet<object>()

export const noteKucoinAttempt = (
  call: object | undefined,
  e: Parameters<typeof isAmbiguousKucoinFailure>[0],
) => {
  if (call && isAmbiguousKucoinFailure(e)) {
    ambiguousCalls.add(call)
  }
}

/** The reason to report once the retries are spent. */
export const exhaustedKucoinReason = (
  call: object | undefined,
  e: { message?: string; code?: string | number },
  transportPrefix: string,
): string => {
  const reason = `${e.message} | ${e.code}`
  return call && ambiguousCalls.has(call)
    ? `${transportPrefix}${reason}`
    : reason
}
