/**
 * Credential redaction for anything that gets serialized into a log line.
 *
 * Exchange SDKs routinely staple the *request* they just made onto the error
 * they throw, and the signed request carries live credentials. `@siebly/kraken-api`
 * is the worst offender: `parseException()` blanks the `APIKey` option but
 * spreads `options.headers` verbatim, so the real `API-Key` / `API-Sign` headers
 * ride along inside `error.requestParams.options.headers` — right next to the
 * field it *did* redact. Our own `bybit-custom` / `bitget-custom` clients do the
 * same with `requestOptions: this.options`, which is where `key`/`secret` live.
 *
 * Those objects then reach `JSON.stringify` in an error log and land in the pm2
 * logs, which are retained for days, gzipped, shipped around and read by agents
 * and log-triage jobs. Redacting at the *serialization* boundary is what makes
 * this safe regardless of which SDK field a future log line happens to print:
 * never `JSON.stringify` an exchange error (or anything derived from one) —
 * use `safeStringify`.
 */

export const REDACTED = '[REDACTED]'

/** Lowercase, strip separators, so `API-Key`, `api_key` and `APIKey` all collapse. */
const normalize = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]/g, '')

/**
 * Matched as a *suffix* so every vendor prefix is covered by one entry:
 * `OK-ACCESS-KEY`, `KC-API-KEY`, `X-MBX-APIKEY`, `CB-ACCESS-SIGN` and friends
 * all reduce to one of these without needing an exchange-by-exchange list.
 */
const SECRET_SUFFIXES = [
  'apikey',
  'apisign',
  'apisecret',
  'apipass',
  'apipassphrase',
  'accesskey',
  'accesssign',
  'accesspassphrase',
  'privatekey',
  'secretkey',
  'signature',
  'passphrase',
  'password',
  'secret',
  'authorization',
  'cookie',
  'token',
]

/** Bare names that are credentials on their own but too short to suffix-match safely. */
const SECRET_EXACT = new Set([
  'key',
  'sign',
  'auth',
  'wallet', // Hyperliquid: the signer's private key is passed as `wallet`
  'credentials',
])

export const isSecretKey = (key: string): boolean => {
  const k = normalize(key)
  return SECRET_EXACT.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s))
}

/**
 * Deep-copy `value` with every credential-shaped property replaced by
 * `[REDACTED]`. Cycle-safe and depth-limited so a stray axios/socket object
 * can't hang or blow the stack on the logging path.
 */
export const redactSecrets = (value: unknown, maxDepth = 6): unknown => {
  const seen = new WeakSet<object>()

  const walk = (val: unknown, depth: number): unknown => {
    if (val === null || typeof val !== 'object') return val
    if (depth > maxDepth) return '[Truncated]'
    if (seen.has(val)) return '[Circular]'
    seen.add(val)

    if (Array.isArray(val)) return val.map((v) => walk(v, depth + 1))

    const out: Record<string, unknown> = {}
    // Error's `name`/`message` are non-enumerable, so a plain key walk turns a
    // real Error into `{}` — the exact reason a fallback `JSON.stringify(e)`
    // reads as empty in the logs today.
    if (val instanceof Error) {
      out.name = val.name
      out.message = val.message
    }
    for (const [k, v] of Object.entries(val)) {
      out[k] = isSecretKey(k) ? REDACTED : walk(v, depth + 1)
    }
    return out
  }

  return walk(value, 0)
}

/** `JSON.stringify` with credentials stripped. Never throws. */
export const safeStringify = (value: unknown, maxDepth = 6): string => {
  try {
    return JSON.stringify(redactSecrets(value, maxDepth)) ?? String(value)
  } catch {
    return String(value)
  }
}
