import {
  DerivativesClient as DerivativesClientBase,
  FuturesGetCandlesParams,
} from '@siebly/kraken-api'
import { Method } from 'axios'
import { serializeParams, hashMessage, neverGuard } from './SpotClient'

//@ts-expect-error overriding protected method
export class DerivativesClient extends DerivativesClientBase {
  constructor(
    restClientOptions?: ConstructorParameters<typeof DerivativesClientBase>[0],
    networkOptions?: ConstructorParameters<typeof DerivativesClientBase>[1],
  ) {
    super(restClientOptions, networkOptions)
  }

  override getCandles(params: FuturesGetCandlesParams) {
    const { tickType, symbol, resolution, ...otherParams } = params
    return this.get(
      `api/charts/v1/${tickType}/${symbol}/${resolution}`,
      otherParams,
    )
  }

  override async signRequest<T = any>(
    data: T,
    endpoint: string,
    method: Method,
    signMethod: any,
  ): Promise<T> {
    //@ts-expect-error overriding protected method
    const timestamp = this.getSignTimestampMs()

    const res: any = {
      originalParams: { ...data },
      //@ts-expect-error overriding protected method
      requestData: data?.body || {},
      //@ts-expect-error overriding protected method
      requestQuery: data?.query || {},
      sign: '',
      timestamp,
      recvWindow: 0,
      serializedParams: '',
      queryParamsWithSign: '',
    }
    //@ts-expect-error overriding protected method
    if (!this.hasValidCredentials()) {
      return res
    }
    //@ts-expect-error overriding protected method
    const strictParamValidation = this.options.strictParamValidation
    const encodeQueryStringValues = true

    if (signMethod === 'kraken') {
      // Don't prefix with ? as part of sign. Prefix after sign
      const prefixWith = ''
      // Array values are repeated into key value pairs
      // E.g. orderIds:[1,2] becomes orderIds=1&orderIds=2
      const repeatArrayValuesAsKVPairs = true

      const clientType = this.getClientType()

      switch (clientType) {
        case 'main': {
          // Set default nonce, if not set yet
          if (!Array.isArray(res.requestData)) {
            if (!(res.requestData as any)?.nonce) {
              res.requestData = {
                //@ts-expect-error overriding protected method
                nonce: this.getNextRequestNonce(),
                ...res.requestData,
              }
            }
          }

          // Allow nonce override in reuqest
          // Should never fallback to new nonce, since it's pre-set above with default val
          const nonce =
            //@ts-expect-error overriding protected method
            (res.requestData as any)?.nonce || this.getNextRequestNonce()

          const serialisedParams = serializeParams(
            method === 'GET' ? res.requestQuery : res.requestData,
            strictParamValidation,
            encodeQueryStringValues,
            prefixWith,
            repeatArrayValuesAsKVPairs,
          )

          const serialisedQueryParams = serializeParams(
            res.requestQuery,
            strictParamValidation,
            encodeQueryStringValues,
            prefixWith,
            repeatArrayValuesAsKVPairs,
          )

          // for spot, serialise GET params, use JSON for POST
          const signRequestParams =
            method === 'GET'
              ? serialisedParams
              : JSON.stringify(res.requestData)

          const signEndpoint = endpoint
          const signInput = `${nonce}${signRequestParams}`

          // Only sign when no access token is provided
          if (!this.hasAccessToken()) {
            try {
              const signMessageInput =
                signEndpoint +
                (await hashMessage(signInput, 'binary', 'SHA-256'))

              // node:crypto equivalent
              // const sign = createHmac(
              //   'sha512',
              //   Buffer.from(this.apiSecret!, 'base64'),
              // )
              //   .update(signMessage, 'binary')
              //   .digest('base64');
              //@ts-expect-error overriding protected method
              const sign = await this.signMessage(
                signMessageInput,
                //@ts-expect-error overriding protected method
                this.apiSecret!,
                'base64',
                'SHA-512',
                {
                  isSecretB64Encoded: true,
                  isInputBinaryString: true,
                },
              )

              res.sign = sign
            } catch (error) {
              // Check if this is a base64 decoding error (invalid API credentials)
              if (
                error instanceof Error &&
                (error.name === 'InvalidCharacterError' ||
                  error.message?.includes('Invalid character'))
              ) {
                const credentialError = new Error(
                  'Failed to sign request: Invalid API credentials detected.\n\n' +
                    '⚠️  PLEASE CHECK YOUR API KEY AND SECRET:\n' +
                    '   - Ensure your API Secret is a valid base64-encoded string\n' +
                    '   - Kraken provides API secrets in base64 format\n\n' +
                    `Original error: ${error.message}\n` +
                    `Stack trace: ${error.stack}`,
                )
                credentialError.name = 'InvalidCredentialsError'
                throw credentialError
              }
              // Re-throw other errors as-is
              throw error
            }
          }

          // ONLY the query params. The rest goes in the body, if there is a body.
          res.queryParamsWithSign = serialisedQueryParams

          break
        }
        case 'derivatives': {
          const serialisedQueryParams = serializeParams(
            res.requestQuery,
            strictParamValidation,
            encodeQueryStringValues,
            prefixWith,
            repeatArrayValuesAsKVPairs,
          )

          const serialisedBodyParams = serializeParams(
            res.requestData,
            strictParamValidation,
            encodeQueryStringValues,
            prefixWith,
            repeatArrayValuesAsKVPairs,
          )

          const signEndpoint = endpoint.replace('/derivatives', '')

          const nonce = '' //this.getNextRequestNonce();

          const signInput = `${serialisedQueryParams}${serialisedBodyParams}${nonce}${signEndpoint}`

          // Only sign when no access token is provided
          if (!this.hasAccessToken()) {
            const signMessageInput = await hashMessage(
              signInput,
              'binary',
              'SHA-256',
            )

            // node:crypto equivalent
            // const sign = createHmac(
            //   'sha512',
            //   Buffer.from(this.apiSecret!, 'base64'),
            // )
            //   .update(signMessage, 'binary')
            //   .digest('base64');
            //@ts-expect-error overriding protected method
            const sign = await this.signMessage(
              signMessageInput,
              //@ts-expect-error overriding protected method
              this.apiSecret!,
              'base64',
              'SHA-512',
              {
                isSecretB64Encoded: true,
                isInputBinaryString: true,
              },
            )

            res.sign = sign
          }

          res.queryParamsWithSign = serialisedQueryParams

          // Submitted as query string in form body
          res.requestData = serialisedBodyParams

          break
        }
      }
      return res
    }

    console.error(
      new Date(),
      neverGuard(signMethod, `Unhandled sign method: "${signMethod}"`),
    )

    return res
  }
}
