process.env.NODE_ENV = 'testing'

/**
 * Retry/backoff log lines name the account by a fingerprint of its API key,
 * never by the key itself.
 *
 * Every case drives a real adapter error handler with an error that reaches
 * the branch that logs, and captures what it hands to `Logger`. `sleep` is
 * stubbed so the 11s/60s backoffs don't run. SYNTHETIC key material only —
 * this file is committed to a public repo.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { Logger } from '@nestjs/common'
import { ExchangeDomain, Futures } from '../types'
import BybitExchange from './bybit'
import BitgetExchange from './bitget'
import BinanceExchange from './binance'
import { keyFingerprint } from '../../utils/keyFingerprint'

const FAKE_KEY = 'FAKEAPIKEYAAAA1111'
const FAKE_SECRET = 'FAKEAPISECRETBBBB2222'
const FINGERPRINT = `key#${keyFingerprint(FAKE_KEY)}`

/** Run `handle(err)` with Logger and sleep stubbed; return every logged line. */
async function linesFor(
  ex: any,
  handler: string,
  err: unknown,
  attempts = 1,
): Promise<string[]> {
  const lines: string[] = []
  const levels = ['log', 'warn', 'error', 'debug', 'verbose'] as const
  const orig = levels.map((l) => (Logger as any)[l])
  levels.forEach((l) => {
    ;(Logger as any)[l] = (...args: unknown[]) =>
      lines.push(args.map(String).join(' '))
  })
  const sleepMod = require('../../utils/sleepUtils')
  const origSleep = sleepMod.sleep
  sleepMod.sleep = async () => {}
  try {
    const timeProfile = { ...ex.getEmptyTimeProfile(), attempts }
    await ex[handler](async function retried() {
      return {}
    }, timeProfile)(err)
  } finally {
    sleepMod.sleep = origSleep
    levels.forEach((l, i) => ((Logger as any)[l] = orig[i]))
  }
  return lines
}

const cases: {
  label: string
  make: () => any
  handler: string
  err: unknown
  attempts?: number
  line: string
}[] = [
  {
    label: 'bybit "Too many visits"',
    make: () => new BybitExchange(Futures.usdm, FAKE_KEY, FAKE_SECRET),
    handler: 'handleBybitErrors',
    err: Object.assign(new Error('Too many visits'), { code: 10006 }),
    line: 'Bybit Too many visits wait',
  },
  {
    label: 'bitget "Too many visits"',
    make: () => new BitgetExchange(Futures.usdm, FAKE_KEY, FAKE_SECRET, 'pass'),
    handler: 'handleBitgetErrors',
    err: Object.assign(new Error('Too many visits'), { code: 429 }),
    line: 'Bitget Too many visits wait',
  },
  {
    label: 'bitget "too many requests" on a retry',
    make: () => new BitgetExchange(Futures.usdm, FAKE_KEY, FAKE_SECRET, 'pass'),
    handler: 'handleBitgetErrors',
    err: Object.assign(new Error('Too many requests'), { code: 0 }),
    attempts: 2,
    line: 'Bitget too many requests wait',
  },
  {
    label: 'bitget 403 block',
    make: () => new BitgetExchange(Futures.usdm, FAKE_KEY, FAKE_SECRET, 'pass'),
    handler: 'handleBitgetErrors',
    err: Object.assign(new Error('blocked'), { code: 403, response: 'x' }),
    line: 'Bitget 403 block wait',
  },
  {
    label: 'binance -1015 order-rate limit',
    make: () =>
      new BinanceExchange(
        ExchangeDomain.com,
        Futures.null,
        FAKE_KEY,
        FAKE_SECRET,
      ),
    handler: 'handleBinanceErrors',
    err: Object.assign(new Error('Too many new orders'), {
      code: -1015,
      response: 'x',
    }),
    line: 'Too many new order',
  },
]

describe('retry log lines fingerprint the API key', () => {
  for (const c of cases) {
    describe(c.label, () => {
      let lines: string[] = []
      let line: string | undefined

      it('reaches the logging branch', async () => {
        lines = await linesFor(c.make(), c.handler, c.err, c.attempts)
        line = lines.find((l) => l.includes(c.line))
        if (!line) {
          throw new Error(`no "${c.line}" line; logged ${lines.length} line(s)`)
        }
      })

      it('names the account by fingerprint', () => {
        if (!line?.includes(FINGERPRINT)) {
          throw new Error(`expected ${FINGERPRINT} in: ${line}`)
        }
      })

      it('never logs the key or the secret', () => {
        const leaked = lines.filter(
          (l) => l.includes(FAKE_KEY) || l.includes(FAKE_SECRET),
        )
        if (leaked.length) {
          throw new Error(`${leaked.length} line(s) carried key material`)
        }
      })
    })
  }

  it('fingerprints the same key the way the Kraken adapter does', () => {
    // djb2, base36 — kept in step with `hashKrakenKey` so one account reads
    // the same across venues. Reference value computed independently.
    let h = 5381
    for (const ch of FAKE_KEY) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
    if (keyFingerprint(FAKE_KEY) !== (h >>> 0).toString(36)) {
      throw new Error('fingerprint diverged from the djb2/base36 scheme')
    }
  })
})
