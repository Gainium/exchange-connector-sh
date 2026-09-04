import axios, { AxiosInstance } from 'axios'
import { signWhitebitRequest } from './signRequest'
import { nextWhitebitNonce } from './nonce'

/**
 * Minimal, hand-rolled WhiteBit REST client (spec 002 §2.5).
 *
 * There is no npm WhiteBit client worth wrapping — unlike Kraken, whose
 * `src/kraken-custom/` sibling directory extends `@siebly/kraken-api` rather
 * than reimplementing it. So this is the whole transport: a public `GET` for
 * `/api/v1/public/*` and `/api/v4/public/*`, and a signed `POST` for everything
 * private. It deliberately knows nothing about markets, orders or balances —
 * response shaping belongs to the adapter (`exchange/exchanges/whitebit`), and
 * keeping it out of here is what lets the signer be tested with no network.
 *
 * WhiteBit currently serves one host (`api.whitebit.com`); the `.eu` toggle its
 * docs used to carry is disabled, so there is no host-selection design here —
 * see spec §2.9. `baseUrl` stays overridable for tests and for the day that
 * changes.
 */

/** WhiteBit's only live API host (spec §2.9 — no `.eu`/host selection in v1). */
export const WHITEBIT_BASE_URL = 'https://whitebit.com'

export type WhitebitClientOptions = {
  apiKey?: string
  apiSecret?: string
  baseUrl?: string
  /** Request timeout in ms. */
  timeout?: number
}

/**
 * An error carrying WhiteBit's own rejection detail.
 *
 * WhiteBit answers a rejected request with a non-2xx status and a JSON body of
 * `{ code, message, errors: { <field>: [<reason>, …] } }`, and the useful part
 * is almost always inside `errors` — a bare `message` is usually just
 * "Validation failed". Interpolating the raw object renders `[object Object]`
 * and destroys the only diagnostic the response carried; that exact failure
 * mode was fixed for Binance in 1.20.18 and is not being re-introduced here.
 */
export class WhitebitApiError extends Error {
  /** WhiteBit's numeric error code, when the body carried one. */
  code?: number
  /** HTTP status, when the failure was a transport-level one. */
  httpStatus?: number

  constructor(message: string, code?: number, httpStatus?: number) {
    super(message)
    this.name = 'WhitebitApiError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** Render WhiteBit's error body into something a human can act on. */
function describeWhitebitError(status: number | undefined, data: any): string {
  if (typeof data === 'string' && data) {
    return data
  }
  const bits: string[] = []
  if (data?.message) {
    bits.push(String(data.message))
  }
  if (data?.errors && typeof data.errors === 'object') {
    for (const [field, reasons] of Object.entries(data.errors)) {
      const text = Array.isArray(reasons) ? reasons.join(', ') : String(reasons)
      bits.push(`${field}: ${text}`)
    }
  }
  if (!bits.length && data && typeof data === 'object') {
    // Last resort. Never `JSON.stringify` a thrown SDK error object directly —
    // but this is the *response body*, which carries no credentials.
    try {
      bits.push(JSON.stringify(data).slice(0, 500))
    } catch {
      /* ignore */
    }
  }
  if (!bits.length) {
    bits.push(status ? `HTTP ${status}` : 'WhiteBit request failed')
  }
  return bits.join(' | ')
}

export class WhitebitClient {
  private http: AxiosInstance
  private apiKey: string
  private apiSecret: string

  constructor(options: WhitebitClientOptions = {}) {
    this.apiKey = options.apiKey ?? ''
    this.apiSecret = options.apiSecret ?? ''
    this.http = axios.create({
      baseURL: options.baseUrl ?? WHITEBIT_BASE_URL,
      timeout: options.timeout ?? 30_000,
      // Never let axios throw its own opaque error before we have read the body.
      validateStatus: () => true,
    })
  }

  /** Whether this client can sign — i.e. whether private calls are possible. */
  hasCredentials(): boolean {
    return !!this.apiKey && !!this.apiSecret
  }

  /**
   * Unauthenticated `GET`. Used for markets, tickers, candles, trades and
   * funding history — everything `additionalApis.ts` reaches with empty
   * credentials.
   */
  async publicGet<T = any>(
    path: string,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const params: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(query ?? {})) {
      if (typeof v !== 'undefined' && v !== null) {
        params[k] = v
      }
    }
    const res = await this.http.get(path, { params })
    if (res.status < 200 || res.status >= 300) {
      throw new WhitebitApiError(
        describeWhitebitError(res.status, res.data),
        res.data?.code,
        res.status,
      )
    }
    return res.data as T
  }

  /**
   * Signed `POST`. The signed body string is sent verbatim (see
   * {@link signWhitebitRequest}) — re-serializing the object here would
   * invalidate the signature.
   */
  async privatePost<T = any>(
    path: string,
    params?: Record<string, unknown>,
    options?: { nonceWindow?: boolean },
  ): Promise<T> {
    if (!this.hasCredentials()) {
      throw new WhitebitApiError('WhiteBit API credentials are not configured')
    }

    const signed = signWhitebitRequest({
      path,
      key: this.apiKey,
      secret: this.apiSecret,
      nonce: nextWhitebitNonce(this.apiKey),
      params,
      nonceWindow: options?.nonceWindow,
    })

    const res = await this.http.post(path, signed.body, {
      headers: signed.headers,
      // The body is already a JSON string; stop axios re-encoding it.
      transformRequest: [(data) => data],
    })

    if (res.status < 200 || res.status >= 300) {
      throw new WhitebitApiError(
        describeWhitebitError(res.status, res.data),
        res.data?.code,
        res.status,
      )
    }
    return res.data as T
  }
}

export default WhitebitClient
