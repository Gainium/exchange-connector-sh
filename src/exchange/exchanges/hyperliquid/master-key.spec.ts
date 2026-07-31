process.env.NODE_ENV = 'testing'

/**
 * Hyperliquid has no permissioned API key — the credential IS a wallet private
 * key — so the withdrawal question becomes "whose key is this?".
 *
 * An **API (agent) wallet** can only trade; HL blocks it from withdrawing or
 * transferring. The **master** key can do everything. `getAccountRole()`
 * already guards the *address* field against agent/master confusion, but the
 * `secret` was never validated: nothing stopped a user pasting their master
 * private key, which hands Gainium a credential with full withdrawal power —
 * exactly the exposure the withdrawal-permission work exists to remove.
 *
 * `getKeyPermissions()` derives the signer from the secret using the SDK's own
 * `getWalletAddress` (the same derivation used when signing an order) and
 * compares it with the account address.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/exchanges/hyperliquid/master-key.spec.ts
 *
 * Offline: derivation is local, and no info/exchange call is made.
 */
import { Futures } from '../../types'
import HyperliquidExchange from './index'

// Standard secp256k1 test vector. This private key derives to this address —
// asserted below rather than assumed, so a broken derivation cannot silently
// make every key look like an agent key (which would fail open).
const PRIVATE_KEY =
  '0x0123456789012345678901234567890123456789012345678901234567890123'
const ITS_ADDRESS = '0x14791697260e4c9a71f18484c9f997b308e59325'
const OTHER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

const permissionsFor = (address: string, secret: string) =>
  new HyperliquidExchange(Futures.usdm, address, secret).getKeyPermissions()

async function main() {
  // The dangerous case: secret derives to the account itself → master key.
  const master = await permissionsFor(ITS_ADDRESS, PRIVATE_KEY)
  expect(
    'master private key is flagged as withdrawal-capable',
    master.withdraw,
    'yes',
  )
  expect('master private key can also transfer', master.transfer, 'yes')
  expect(
    'master key detail explains why',
    master.detail?.includes('master account private key'),
    true,
  )

  // Case-insensitive: HL addresses are frequently EIP-55 checksummed in the UI,
  // and a case mismatch must not read as "different address" (fail-open).
  const checksummed = await permissionsFor(
    '0x14791697260E4c9A71f18484C9f997B308e59325',
    PRIVATE_KEY,
  )
  expect(
    'checksummed account address still matches its own key',
    checksummed.withdraw,
    'yes',
  )

  // The correct setup: an agent key signing for a different master account.
  const agent = await permissionsFor(OTHER_ADDRESS, PRIVATE_KEY)
  expect('agent wallet key cannot withdraw', agent.withdraw, 'no')
  expect('agent wallet key cannot transfer', agent.transfer, 'no')
  expect('agent key detail explains why', agent.detail?.includes('agent'), true)

  // HL credentials are bearer keys — there is no IP allowlist to report.
  expect('hyperliquid keys are never IP-bound', agent.ipRestricted, 'no')

  // Failure modes must answer `unknown`, never `no`. A `no` here would be an
  // unearned "this key is safe".
  const badSecret = await permissionsFor(ITS_ADDRESS, 'not-a-private-key')
  expect('undecodable secret → unknown', badSecret.withdraw, 'unknown')
  expect(
    'undecodable secret says so',
    badSecret.detail?.includes('underivable'),
    true,
  )

  const noAddress = await permissionsFor('', PRIVATE_KEY)
  expect('missing account address → unknown', noAddress.withdraw, 'unknown')

  const emptySecret = await permissionsFor(ITS_ADDRESS, '')
  expect('empty secret → unknown', emptySecret.withdraw, 'unknown')

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main()
