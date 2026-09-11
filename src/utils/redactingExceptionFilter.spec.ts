process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for `redactingExceptionFilter.ts`: an exchange SDK error
 * that escapes a controller must not reach the error log with its credentials.
 *
 * Boots real Nest HTTP apps, throws the shapes the SDKs actually throw, and
 * captures what Nest writes to stderr — the bytes a process manager keeps. A
 * control app WITHOUT the filter serves the same routes and must leak, so a
 * Nest or SDK change that would make this check vacuous fails here instead of
 * passing quietly.
 *
 * SYNTHETIC key material only — this file is committed to a public repo.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it, before, after } from 'mocha'
import {
  Controller,
  Get,
  HttpException,
  INestApplication,
  Module,
} from '@nestjs/common'
import { HttpAdapterHost, NestFactory } from '@nestjs/core'
import { AxiosError, AxiosHeaders } from 'axios'
import { RestClientV5 } from 'bybit-api'
import { RedactingExceptionFilter } from './redactingExceptionFilter'

const FAKE_KEY = 'FAKEKEYAAAA1111'
const FAKE_SECRET = 'FAKESECRETBBBB2222'
const FAKE_SIGN = 'FAKESIGNCCCC3333'
const FAKES = [FAKE_KEY, FAKE_SECRET, FAKE_SIGN]

/**
 * Thrown by the stock `bybit-api` client itself for a non-2xx answer, built
 * with the options `BybitExchange` passes it.
 */
function bybitError(): unknown {
  const client = new RestClientV5({
    key: FAKE_KEY,
    secret: FAKE_SECRET,
    testnet: false,
    recv_window: 30000,
    baseUrl: 'https://api.bybit.com',
  })
  try {
    ;(client as any).parseException({
      response: {
        status: 401,
        statusText: 'API key is invalid.',
        data: '',
        headers: {},
      },
    })
  } catch (e) {
    return e
  }
  throw new Error('bybit-api parseException no longer throws')
}

/** `@siebly/kraken-api` parseException shape for a rejected private call. */
function krakenError(): unknown {
  return {
    code: 200,
    message: 'OK',
    body: { error: ['EGeneral:Temporary lockout'] },
    requestOptions: {
      apiKey: 'omittedFromError',
      apiSecret: 'omittedFromError',
    },
    requestParams: {
      method: 'POST',
      endpoint: '0/private/QueryOrders',
      options: {
        headers: {
          'API-Key': FAKE_KEY,
          'API-Sign': FAKE_SIGN,
          APIKey: 'omittedFromError',
        },
      },
    },
  }
}

/**
 * Stands in for node's ClientRequest — the filter prunes by class, so any
 * non-plain instance takes the same branch the real one does.
 */
class ClientRequest {
  _header = `POST /0/private/QueryOrders HTTP/1.1\r\nAPI-Key: ${FAKE_KEY}\r\nAPI-Sign: ${FAKE_SIGN}\r\n\r\n`
}

/** A request that never got a response: SDKs rethrow the raw AxiosError. */
function transportError(): unknown {
  const config = {
    url: 'https://api.kraken.com/0/private/QueryOrders',
    method: 'post',
    headers: new AxiosHeaders({ 'API-Key': FAKE_KEY, 'API-Sign': FAKE_SIGN }),
  }
  return new AxiosError(
    'connect ETIMEDOUT 192.0.2.1:443',
    'ETIMEDOUT',
    config as any,
    new ClientRequest(),
  )
}

@Controller()
class ThrowingController {
  @Get('bybit')
  bybit() {
    throw bybitError()
  }

  @Get('kraken')
  kraken() {
    return Promise.reject(krakenError())
  }

  @Get('transport')
  transport() {
    throw transportError()
  }

  @Get('http')
  http() {
    throw new HttpException('Exchange is not supported', 200)
  }
}

@Module({ controllers: [ThrowingController] })
class ThrowingModule {}

async function boot(withFilter: boolean): Promise<INestApplication> {
  const app = await NestFactory.create(ThrowingModule, { logger: ['error'] })
  if (withFilter) {
    app.useGlobalFilters(
      new RedactingExceptionFilter(app.get(HttpAdapterHost).httpAdapter),
    )
  }
  await app.listen(0, '127.0.0.1')
  return app
}

/** Request `path` and return the response plus everything written to stderr meanwhile. */
async function hit(app: INestApplication, path: string) {
  const chunks: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const res = await fetch(`${await app.getUrl()}/${path}`)
    const body = await res.text()
    await new Promise((resolve) => setImmediate(resolve))
    return {
      status: res.status,
      body,
      log: chunks.join('').replace(/\x1b\[[0-9;]*m/g, ''),
    }
  } finally {
    process.stderr.write = write
  }
}

const leaked = (log: string) => FAKES.filter((s) => log.includes(s)).length

describe('RedactingExceptionFilter', () => {
  let control: INestApplication
  let filtered: INestApplication

  before(async () => {
    control = await boot(false)
    filtered = await boot(true)
  })

  after(async () => {
    await control?.close()
    await filtered?.close()
  })

  const cases: { route: string; keeps: string[] }[] = [
    { route: 'bybit', keeps: ['API key is invalid.', 'api.bybit.com'] },
    {
      route: 'kraken',
      keeps: ['EGeneral:Temporary lockout', '0/private/QueryOrders'],
    },
    // `transportError` is the stack frame — proves the trace survives.
    {
      route: 'transport',
      keeps: ['AxiosError: connect ETIMEDOUT', 'transportError', 'ETIMEDOUT'],
    },
  ]

  for (const { route, keeps } of cases) {
    describe(`an escaped ${route} error`, () => {
      it('leaks credentials without the filter (control)', async () => {
        const { log } = await hit(control, route)
        if (!leaked(log)) {
          throw new Error(
            `control logged no credential — the check below would be vacuous`,
          )
        }
      })

      it('logs no credential with the filter', async () => {
        const { log } = await hit(filtered, route)
        const n = leaked(log)
        if (n) throw new Error(`${n} synthetic credential(s) reached the log`)
        if (!log.includes('[REDACTED]')) {
          throw new Error('expected a [REDACTED] marker in the logged error')
        }
      })

      it('keeps the diagnostic content', async () => {
        const { log } = await hit(filtered, route)
        const missing = keeps.filter((k) => !log.includes(k))
        if (missing.length) {
          throw new Error(`logged error lost: ${missing.join(', ')}`)
        }
      })

      it('answers the caller exactly as Nest does without it', async () => {
        const a = await hit(control, route)
        const b = await hit(filtered, route)
        if (a.status !== b.status || a.body !== b.body) {
          throw new Error(
            `response changed: ${a.status} ${a.body} -> ${b.status} ${b.body}`,
          )
        }
      })
    })
  }

  it('leaves an HttpException answer untouched', async () => {
    const a = await hit(control, 'http')
    const b = await hit(filtered, 'http')
    if (a.status !== 200 || a.status !== b.status || a.body !== b.body) {
      throw new Error(
        `response changed: ${a.status} ${a.body} -> ${b.status} ${b.body}`,
      )
    }
  })
})
