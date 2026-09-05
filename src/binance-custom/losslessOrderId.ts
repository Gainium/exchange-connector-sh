/**
 * Binance issues exchange order ids as JSON *numbers*. USDM futures ids are now
 * routinely 19 digits (e.g. 8389766269723522123), which is far above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). `JSON.parse` has no representation for
 * such an integer, so it silently returns the nearest IEEE-754 double and the low
 * digits are gone: 8389766269723522123 comes back as 8389766269723522000.
 *
 * axios's default `transformResponse` is a bare `JSON.parse`, and the vendor
 * `binance` client does not override it — so every REST response reaching this
 * connector had already lost those digits before any of our code ran. Because the
 * rounding is many-to-one, distinct venue orders collapse onto one id (spec 004 §2.1:
 * 60 groups / 63 filled rows / 5 users on production).
 *
 * The digits only exist in the raw response text, so the repair has to happen before
 * `JSON.parse` sees them: quote the id so it survives as a string. See
 * `specs/004.binance-order-id-precision-loss.md`.
 */

/**
 * Object keys whose value is a venue-issued integer id that can exceed 2^53 and
 * must therefore be preserved as text.
 *
 * Deliberately narrow. Widening this retypes a field from number to string for
 * every consumer of `BaseReturn<T>`, which is the most load-bearing contract on the
 * platform — add a key only with the consumers checked. `orderId` is safe because
 * both `convertOrder` and `futures_convertOrder` already stringify it and
 * `CommonOrder.orderId` is already typed `string | number`.
 */
const UNSAFE_INT_KEYS = new Set(['orderId'])

/** Digits `0`-`9`. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * Index just past the JSON string literal that starts at `start` (which must be the
 * opening quote), honouring backslash escapes. Returns `raw.length` for an
 * unterminated literal, so a truncated body degrades to "no rewrite" rather than
 * looping.
 */
function endOfStringLiteral(raw: string, start: number): number {
  let i = start + 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') return i + 1
    i += 1
  }
  return raw.length
}

/** Index of the next character that is not JSON insignificant whitespace. */
function skipWhitespace(raw: string, start: number): number {
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1
      continue
    }
    return i
  }
  return i
}

/**
 * Rewrite `"orderId": <huge integer>` as `"orderId": "<huge integer>"` in raw JSON
 * text, so `JSON.parse` yields the exact digits instead of a rounded double.
 *
 * The scan is string-literal aware: it always jumps over a complete string literal,
 * so digits appearing *inside* a value (a `clientOrderId`, a Binance error `msg`)
 * are never touched (spec 004 §4.4). Only a literal that is followed by `:` counts
 * as a key.
 *
 * Ids at or below `Number.MAX_SAFE_INTEGER` are left as JSON numbers (§4.2), which
 * makes this a no-op for the overwhelming majority of orders and keeps their type
 * exactly as it is today.
 */
export function quoteUnsafeIntegerIds(raw: string): string {
  let out = ''
  let copiedTo = 0
  let i = 0

  while (i < raw.length) {
    if (raw[i] !== '"') {
      i += 1
      continue
    }

    const literalEnd = endOfStringLiteral(raw, i)
    const afterLiteral = skipWhitespace(raw, literalEnd)

    // Not a key (no `:` follows) — it was a string value. Skipping the whole
    // literal is what keeps its contents out of reach of this rewrite.
    if (raw[afterLiteral] !== ':') {
      i = literalEnd
      continue
    }

    const key = raw.slice(i + 1, literalEnd - 1)
    if (!UNSAFE_INT_KEYS.has(key)) {
      i = literalEnd
      continue
    }

    const valueStart = skipWhitespace(raw, afterLiteral + 1)
    let digitsEnd = valueStart
    while (digitsEnd < raw.length && isDigit(raw.charCodeAt(digitsEnd))) {
      digitsEnd += 1
    }

    // Only a bare run of digits qualifies. Anything else (an already-quoted id, a
    // negative placeholder such as -1, null, a nested object) is left alone.
    if (digitsEnd === valueStart) {
      i = literalEnd
      continue
    }

    const digits = raw.slice(valueStart, digitsEnd)
    if (Number.isSafeInteger(Number(digits))) {
      i = digitsEnd
      continue
    }

    out += raw.slice(copiedTo, valueStart) + '"' + digits + '"'
    copiedTo = digitsEnd
    i = digitsEnd
  }

  if (copiedTo === 0) return raw
  return out + raw.slice(copiedTo)
}

/**
 * Drop-in replacement for axios's default `transformResponse` that keeps Binance
 * order ids exact.
 *
 * Mirrors axios's own contract: non-string payloads pass through untouched, and a
 * body that is not JSON (an HTML error page from a proxy, an empty body) is returned
 * as-is rather than throwing (§4.5). Binance error bodies still parse to an object,
 * which the vendor client needs in order to read `code`/`msg` (§4.6).
 */
export function parseBinanceResponse(data: unknown): unknown {
  if (typeof data !== 'string' || data.length === 0) return data
  try {
    return JSON.parse(quoteUnsafeIntegerIds(data))
  } catch {
    return data
  }
}
