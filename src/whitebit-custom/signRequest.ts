import { createHmac } from 'crypto'

/**
 * WhiteBit's signed-request scheme (spec 002 §2.5), hand-rolled.
 *
 * No npm WhiteBit client exists worth wrapping (unlike Kraken's
 * `@siebly/kraken-api`), so this is the whole of the auth layer. It needs
 * nothing beyond Node's built-in `crypto` — see spec §2.9.
 *
 * The scheme:
 *
 *   body      = { request: '<path>', nonce: '<ms epoch>', [nonceWindow], ...params }
 *   payload   = base64(JSON.stringify(body))
 *   signature = hex(HMAC_SHA512(payload, secret))
 *
 *   headers   = Content-Type: application/json
 *               X-TXC-APIKEY:    <key>
 *               X-TXC-PAYLOAD:   <payload>
 *               X-TXC-SIGNATURE: <signature>
 *
 * The signature is taken over the **base64 payload string**, not over the raw
 * JSON — and the exact JSON string that was encoded is what must be sent as the
 * request body. Re-serializing the object at send time would be a bug waiting
 * to happen (key order, number formatting), so {@link signWhitebitRequest}
 * returns the body string it signed and the caller sends that verbatim.
 */

export type WhitebitSignedRequest = {
  /**
   * The exact JSON body string that was signed. Send this verbatim — do NOT
   * re-serialize the parameter object, or the signature stops matching the body.
   */
  body: string
  /** Ready-to-send headers, including `Content-Type`. */
  headers: Record<string, string>
  /** The base64 payload, exposed for tests and diagnostics. */
  payload: string
  /** The hex signature, exposed for tests and diagnostics. */
  signature: string
}

/**
 * Drop keys whose value is `undefined`.
 *
 * `JSON.stringify` already omits them, but doing it explicitly keeps the signed
 * body identical to the object a caller can reason about, and mirrors the
 * lesson `kraken-custom`'s `serializeParams` learned the hard way (bug #383):
 * callers build fixed-shape request objects, so an unused option is a present
 * key holding `undefined`, and it must be indistinguishable from absent.
 */
function withoutUndefined(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!params) {
    return out
  }
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'undefined') {
      out[k] = v
    }
  }
  return out
}

/**
 * Build the signed body + headers for one WhiteBit private request.
 *
 * Pure and deterministic: same inputs (including `nonce`) always produce the
 * same payload and signature, which is what makes it unit-testable with no
 * network — see `signRequest.spec.ts`.
 *
 * @param input.path   The request path, e.g. `/api/v4/trade-account/balance`.
 *                     WhiteBit requires it duplicated inside the body as
 *                     `request`, and signs it along with everything else.
 * @param input.nonce  Milliseconds since epoch, strictly increasing per API key
 *                     (see `./nonce.ts`). Serialized as a string, which is the
 *                     form WhiteBit's own examples use.
 * @param input.nonceWindow Opt-in wider nonce acceptance window. Only emitted
 *                     when explicitly `true` — an absent key and `false` are
 *                     different bodies and therefore different signatures.
 */
export function signWhitebitRequest(input: {
  path: string
  key: string
  secret: string
  nonce: string | number
  params?: Record<string, unknown>
  nonceWindow?: boolean
}): WhitebitSignedRequest {
  const { path, key, secret, nonce, params, nonceWindow } = input

  const bodyObject: Record<string, unknown> = {
    request: path,
    nonce: String(nonce),
    ...(nonceWindow === true ? { nonceWindow: true } : {}),
    ...withoutUndefined(params),
  }

  const body = JSON.stringify(bodyObject)
  const payload = Buffer.from(body).toString('base64')
  const signature = createHmac('sha512', secret).update(payload).digest('hex')

  return {
    body,
    payload,
    signature,
    headers: {
      'Content-Type': 'application/json',
      'X-TXC-APIKEY': key,
      'X-TXC-PAYLOAD': payload,
      'X-TXC-SIGNATURE': signature,
    },
  }
}
