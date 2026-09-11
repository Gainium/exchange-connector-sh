import { ArgumentsHost, Catch, HttpServer } from '@nestjs/common'
import { IntrinsicException } from '@nestjs/common/exceptions/intrinsic.exception'
import { AbstractHttpAdapter, BaseExceptionFilter } from '@nestjs/core'
import { REDACTED, isSecretKey, redactSecrets } from './redact'

/**
 * Global exception filter: strips credentials from an unhandled exception
 * before Nest logs it.
 *
 * Nest's default handler logs anything that is not an `HttpException` with
 * `logger.error(exception)` — `util.inspect` of the raw value, five levels
 * deep. An exchange SDK error that escapes a controller is exactly the kind of
 * object `redact.ts` exists for:
 *   - `bybit-api` throws `{ ..., requestOptions: this.options }`, and
 *     `this.options` is where the client's `key` and `secret` live;
 *   - `@siebly/kraken-api` blanks the option names it owns but carries the
 *     signed request, `API-Key` header included;
 *   - a request that never got a response is rethrown as the raw AxiosError,
 *     whose `request` is the live ClientRequest — and its `_header` is the
 *     literal outbound header block, a credential in a field that is not named
 *     like one.
 *
 * The HTTP answer is unchanged: Nest's own reply logic still runs, on a
 * sanitized copy that keeps `statusCode` and `message`, so a caller gets the
 * same status and body as before. Only what reaches the log differs.
 */

const MAX_DEPTH = 6

/**
 * Reduce a thrown value to plain data that is safe to inspect.
 *
 * Plain objects, arrays and errors are walked. Any other class instance —
 * sockets, agents, ClientRequests — is replaced by its class name, because
 * name-based redaction cannot see a credential inside a field like `_header`.
 * The exception is a value that serializes itself through `toJSON`
 * (AxiosHeaders, Date): that serialization is walked instead.
 */
const toPlainData = (value: unknown): unknown => {
  const seen = new WeakSet<object>()

  const walk = (val: unknown, depth: number): unknown => {
    if (val === null || typeof val !== 'object') return val
    if (depth > MAX_DEPTH) return '[Truncated]'
    if (seen.has(val)) return '[Circular]'
    seen.add(val)

    if (Array.isArray(val)) return val.map((v) => walk(v, depth + 1))

    const out: Record<string, unknown> = {}
    if (val instanceof Error) {
      out.name = val.name
      out.message = val.message
      out.stack = val.stack
    } else {
      const proto = Object.getPrototypeOf(val)
      if (proto !== Object.prototype && proto !== null) {
        const toJSON = (val as { toJSON?: unknown }).toJSON
        if (typeof toJSON === 'function') {
          try {
            return walk(toJSON.call(val), depth)
          } catch {
            // fall through to the class-name placeholder
          }
        }
        return `[${proto?.constructor?.name || 'Object'}]`
      }
    }
    for (const [k, v] of Object.entries(val)) {
      out[k] = isSecretKey(k) ? REDACTED : walk(v, depth + 1)
    }
    return out
  }

  return walk(value, 0)
}

/**
 * The value to hand Nest's logger in place of `exception`. An Error stays a
 * native Error with its original prototype, message and stack, so the log line
 * still reads `AxiosError: connect ETIMEDOUT ...` followed by the trace; only
 * its own properties are replaced by their redacted plain-data form.
 */
export const toLoggableException = (exception: unknown): unknown => {
  // Nest deliberately never logs these; keep the instance so it still can't.
  if (exception instanceof IntrinsicException) return exception

  const data = redactSecrets(toPlainData(exception), MAX_DEPTH)
  if (
    !(exception instanceof Error) ||
    data === null ||
    typeof data !== 'object'
  ) {
    return data
  }

  const { name, message, stack, ...props } = data as Record<string, unknown>
  const copy = new Error(exception.message)
  Object.setPrototypeOf(copy, Object.getPrototypeOf(exception))
  Object.defineProperty(copy, 'name', {
    value: exception.name,
    configurable: true,
    writable: true,
    enumerable: false,
  })
  copy.stack = exception.stack
  return Object.assign(copy, props)
}

@Catch()
export class RedactingExceptionFilter extends BaseExceptionFilter {
  handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: AbstractHttpAdapter | HttpServer,
  ): void {
    super.handleUnknownError(
      toLoggableException(exception),
      host,
      applicationRef,
    )
  }
}
