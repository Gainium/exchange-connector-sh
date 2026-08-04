process.env.NODE_ENV = 'testing'

/**
 * Unit tests for withdrawal-permission detection.
 *
 * Context: Gainium needs read + trade and never withdrawal, but nothing used to
 * check that a stored key actually respects that. These parsers turn it from an
 * assumption into an enforced property, so their failure modes matter as much
 * as their happy paths.
 *
 * The fixtures marked REAL are verbatim response fragments captured from live
 * exchange accounts, not shapes invented from documentation — several vendors'
 * docs disagree with what their API actually returns. Keys and account
 * identifiers are stripped.
 *
 * The rule under test throughout: a parser that does not understand what it is
 * looking at must answer `unknown`, never `no`. A false `no` is a safety claim
 * we cannot back, and is worse than admitting ignorance.
 *
 * Run: npx ts-node --files --project tsconfig.json \
 *        src/exchange/helpers/keyPermissions.spec.ts
 *
 * No network / auth needed — every parser is pure.
 */
import {
  isKrakenPermissionDenied,
  krakenWithdrawState,
  parseBinanceRestrictions,
  parseBitgetAccountInfo,
  parseBybitApiKey,
  parseCoinbaseKeyPermissions,
  parseKucoinApiKey,
  parseOkxAccountConfig,
  unknownPermissions,
  withdrawalRejectionMessage,
} from './keyPermissions'
import { KeyPermissions } from '../types'

let failures = 0
function expect(label: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(want)}`,
  )
}

/** Parsers stamp `checkedAt`; compare everything else. */
const shape = (p: KeyPermissions | null) =>
  p === null
    ? null
    : {
        withdraw: p.withdraw,
        transfer: p.transfer,
        ipRestricted: p.ipRestricted,
        ips: p.ips,
      }

function main() {
  // ── Binance ───────────────────────────────────────────────────────────────
  // REAL: the apiRestrictions shape returned across live Binance keys.
  // Trade-only keys come back enableWithdrawals=false.
  expect(
    'binance: trade-only key (the real shape)',
    shape(
      parseBinanceRestrictions({
        ipRestrict: true,
        enableReading: true,
        enableWithdrawals: false,
        enableInternalTransfer: false,
        permitsUniversalTransfer: false,
        enableSpotAndMarginTrading: true,
        enableFutures: true,
      }),
    ),
    { withdraw: 'no', transfer: 'no', ipRestricted: 'yes', ips: undefined },
  )
  expect(
    'binance: withdrawal-enabled key is caught',
    shape(
      parseBinanceRestrictions({
        ipRestrict: false,
        enableWithdrawals: true,
        enableInternalTransfer: false,
        permitsUniversalTransfer: false,
      }),
    ),
    { withdraw: 'yes', transfer: 'no', ipRestricted: 'no', ips: undefined },
  )
  expect(
    'binance: universal transfer alone counts as transfer',
    parseBinanceRestrictions({
      ipRestrict: true,
      enableWithdrawals: false,
      enableInternalTransfer: false,
      permitsUniversalTransfer: true,
    })?.transfer,
    'yes',
  )
  expect(
    'binance: unrelated payload is not guessed at',
    parseBinanceRestrictions({ some: 'other endpoint' }),
    null,
  )
  expect('binance: null response', parseBinanceRestrictions(null), null)

  // ── Bybit ─────────────────────────────────────────────────────────────────
  // REAL: `Wallet: ["AccountTransfer","SubMemberTransferList"]` is the most
  // common permission set on live Bybit keys — Bybit only offers the Withdraw
  // checkbox once a key is IP-bound, so the everyday key cannot withdraw but
  // CAN move balances between the user's own accounts. transfer=yes,
  // withdraw=no is therefore the shape that matters most here.
  expect(
    'bybit: the common real key — transfer yes, withdraw no',
    shape(
      parseBybitApiKey({
        readOnly: 0,
        ips: ['*'],
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'SubMemberTransferList'],
          Options: [],
          Derivatives: [],
          CopyTrading: [],
          BlockTrade: [],
          Exchange: [],
          NFT: [],
          Affiliate: [],
        },
      }),
    ),
    { withdraw: 'no', transfer: 'yes', ipRestricted: 'unknown', ips: [] },
  )
  expect(
    'bybit: Withdraw in the Wallet group is caught',
    shape(
      parseBybitApiKey({
        readOnly: 0,
        ips: ['18.181.170.164', '13.212.45.47'],
        permissions: {
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'Withdraw'],
        },
      }),
    ),
    {
      withdraw: 'yes',
      transfer: 'yes',
      ipRestricted: 'yes',
      ips: ['18.181.170.164', '13.212.45.47'],
    },
  )
  expect(
    'bybit: a Withdraw token outside Wallet is still caught',
    parseBybitApiKey({
      ips: [],
      permissions: { Spot: ['SpotTrade'], Exchange: ['Withdraw'] },
    })?.withdraw,
    'yes',
  )
  // A wildcard is NOT proof the key is unrestricted, and it is not one IP
  // literally named "*" either. Bybit emits ["*"] for keys bound through its
  // third-party-app flow, where the binding lives on Bybit's side and never
  // appears in the key's own allowlist — such a key reports ["*"] here and
  // still answers 10010 Unmatched IP from an unpublished address. Measured:
  // when this returned 'no', 441 of 443 re-probed credentials were labelled
  // unprotected while bound.
  expect(
    'bybit: ["*"] is unknown — it is absence of a local allowlist, not proof of none',
    parseBybitApiKey({ ips: ['*'], permissions: { Wallet: [] } })?.ipRestricted,
    'unknown',
  )
  expect(
    'okx: a "*" allowlist is likewise unknown',
    parseOkxAccountConfig({ perm: 'read_only,trade', ip: '*' })?.ipRestricted,
    'unknown',
  )
  // Bybit reports `ips: []` for keys bound through its third-party-app flow,
  // where the addresses live on Bybit's side rather than in the key's own
  // allowlist. Such a key reads empty here and still answers `10010 Unmatched
  // IP` from an address outside its binding — so empty cannot mean unbound.
  // A wrong 'no' here reports a protected key as exposed.
  expect(
    'bybit: an EMPTY allowlist is unknown, not "unrestricted"',
    parseBybitApiKey({ ips: [], permissions: { Wallet: [] } })?.ipRestricted,
    'unknown',
  )
  expect(
    'bybit: a missing ips field is likewise unknown',
    parseBybitApiKey({ permissions: { Wallet: [] } })?.ipRestricted,
    'unknown',
  )
  expect(
    'bybit: a populated allowlist is still a reliable positive',
    parseBybitApiKey({ ips: ['1.2.3.4'], permissions: { Wallet: [] } })
      ?.ipRestricted,
    'yes',
  )
  expect(
    'bybit: missing permissions block',
    parseBybitApiKey({ readOnly: 0 }),
    null,
  )

  // ── KuCoin ────────────────────────────────────────────────────────────────
  expect(
    'kucoin: trade-only permission string',
    shape(parseKucoinApiKey({ permission: 'General, Spot, Futures' })),
    { withdraw: 'no', transfer: 'no', ipRestricted: 'unknown', ips: undefined },
  )
  expect(
    'kucoin: Withdraw in the permission string',
    parseKucoinApiKey({ permission: 'General, Spot, Withdraw' })?.withdraw,
    'yes',
  )
  expect(
    'kucoin: ipWhitelist is read when present',
    shape(
      parseKucoinApiKey({
        permission: 'General, Spot',
        ipWhitelist: '1.2.3.4,5.6.7.8',
      }),
    ),
    {
      withdraw: 'no',
      transfer: 'no',
      ipRestricted: 'yes',
      ips: ['1.2.3.4', '5.6.7.8'],
    },
  )
  expect(
    'kucoin: an ABSENT ipWhitelist is unknown, not "unrestricted"',
    parseKucoinApiKey({ permission: 'General, Spot' })?.ipRestricted,
    'unknown',
  )
  expect(
    'kucoin: empty permission string is not read as "no permissions"',
    parseKucoinApiKey({ permission: '' }),
    null,
  )
  expect('kucoin: wrong payload', parseKucoinApiKey({ uid: 1 }), null)

  // ── OKX ───────────────────────────────────────────────────────────────────
  // REAL: perm="read_only,trade" captured from a live key. OKX's
  // max-withdrawal endpoint returns code:0 against this same key — which is why
  // the declared `perm` is authoritative and a capability probe is not.
  expect(
    'okx: the real perm string',
    shape(parseOkxAccountConfig({ perm: 'read_only,trade', ip: '' })),
    { withdraw: 'no', transfer: 'unknown', ipRestricted: 'unknown', ips: [] },
  )
  expect(
    'okx: withdraw in perm is caught',
    parseOkxAccountConfig({ perm: 'read_only,trade,withdraw' })?.withdraw,
    'yes',
  )
  expect(
    'okx: ip allowlist is captured',
    shape(
      parseOkxAccountConfig({ perm: 'read_only,trade', ip: '1.2.3.4,5.6.7.8' }),
    ),
    {
      withdraw: 'no',
      transfer: 'unknown',
      ipRestricted: 'yes',
      ips: ['1.2.3.4', '5.6.7.8'],
    },
  )
  expect('okx: missing perm', parseOkxAccountConfig({ acctLv: '2' }), null)

  // ── Bitget ────────────────────────────────────────────────────────────────
  // REAL: authorities=["coow","cpow","stow","smow"] and a comma-separated `ips`
  // string, captured verbatim from a live account.
  expect(
    'bitget: the real trade-only authorities (all recognised, none withdrawal)',
    shape(
      parseBitgetAccountInfo({
        authorities: ['coow', 'cpow', 'stow', 'smow'],
        ips: '78.128.60.89,62.84.191.108',
      }),
    ),
    {
      withdraw: 'no',
      transfer: 'no',
      ipRestricted: 'yes',
      ips: ['78.128.60.89', '62.84.191.108'],
    },
  )
  expect(
    'bitget: an explicit withdraw authority is caught',
    parseBitgetAccountInfo({ authorities: ['stow', 'withdraw'], ips: '' })
      ?.withdraw,
    'yes',
  )
  // The important one. Bitget does not publish its authority vocabulary, so an
  // unrecognised code must NOT be silently scored as "no withdrawal".
  expect(
    'bitget: an UNRECOGNISED authority yields unknown, never "no"',
    parseBitgetAccountInfo({ authorities: ['stow', 'zzqq'], ips: '' })
      ?.withdraw,
    'unknown',
  )
  // REGRESSION. `wtow` was guessed to be a withdrawal code and is not. It is
  // common on real Bitget keys, and because main-app rejects a new connection
  // on `withdraw === 'yes'`, legitimate Bitget connections were refused for a
  // permission their key never had. The "tick everything" bundle below is the
  // most common real authority set.
  expect(
    'bitget: the "tick everything" bundle is NOT withdrawal (wtow regression)',
    parseBitgetAccountInfo({
      authorities: [
        'chow',
        'coow',
        'cpow',
        'p2pw',
        'pllw',
        'smow',
        'stow',
        'taxw',
        'ttow',
        'wtow',
      ],
      ips: '',
    })?.withdraw,
    // Not 'yes' — and not 'no' either: p2pw/pllw/taxw/ttow/chow/wtow are ruled
    // out as withdrawal but their actual meaning is still unknown.
    'unknown',
  )
  expect(
    'bitget: wtow alone no longer forces a withdrawal verdict',
    parseBitgetAccountInfo({ authorities: ['stow', 'wtow'], ips: '' })
      ?.withdraw,
    'unknown',
  )
  expect(
    'bitget: chow is not treated as an on-chain/withdrawal code',
    parseBitgetAccountInfo({ authorities: ['chow', 'coow', 'stow'], ips: '' })
      ?.withdraw,
    'unknown',
  )
  // Bitget, like Bybit and OKX, provisions keys through a "connect a
  // third-party app" flow that binds the IPs on its own side — so a genuinely
  // bound key reports no allowlist here. Neither an absent nor a blank field is
  // evidence the key is unrestricted.
  expect(
    'bitget: a MISSING ips field is unknown, not "unrestricted"',
    parseBitgetAccountInfo({ authorities: ['coow', 'cpow'] })?.ipRestricted,
    'unknown',
  )
  expect(
    'bitget: a present-but-blank ips field is ALSO unknown, not "unrestricted"',
    parseBitgetAccountInfo({ authorities: ['coow', 'cpow'], ips: '' })
      ?.ipRestricted,
    'unknown',
  )
  expect(
    'okx: a MISSING ip field is unknown, not "unrestricted"',
    parseOkxAccountConfig({ perm: 'read_only,trade' })?.ipRestricted,
    'unknown',
  )
  expect(
    'okx: a present-but-blank ip is ALSO unknown (third-party-app binding)',
    parseOkxAccountConfig({ perm: 'read_only,trade', ip: '' })?.ipRestricted,
    'unknown',
  )
  expect(
    'okx: a populated allowlist is still a reliable positive',
    parseOkxAccountConfig({ perm: 'read_only,trade', ip: '1.2.3.4' })
      ?.ipRestricted,
    'yes',
  )
  expect(
    'bitget: empty authorities is not read as "no permissions"',
    parseBitgetAccountInfo({ authorities: [], ips: '' }),
    null,
  )
  expect(
    'bitget: missing authorities',
    parseBitgetAccountInfo({ userId: '1' }),
    null,
  )

  // ── Coinbase ──────────────────────────────────────────────────────────────
  expect(
    'coinbase: view+trade only',
    shape(
      parseCoinbaseKeyPermissions({
        can_view: true,
        can_trade: true,
        can_transfer: false,
      }),
    ),
    { withdraw: 'no', transfer: 'no', ipRestricted: 'unknown', ips: undefined },
  )
  expect(
    'coinbase: can_transfer is the withdrawal signal',
    parseCoinbaseKeyPermissions({
      can_view: true,
      can_trade: true,
      can_transfer: true,
    })?.withdraw,
    'yes',
  )
  expect(
    'coinbase: legacy-key error payload',
    parseCoinbaseKeyPermissions({ error: 'unauthorized' }),
    null,
  )

  // ── Kraken ────────────────────────────────────────────────────────────────
  // Kraken declares nothing, so it is probed. WithdrawMethods needs BOTH
  // funds-query and funds-withdraw, so a denial only proves "no withdrawal"
  // once funds-query is known to work.
  expect(
    'kraken: WithdrawMethods succeeded → key can withdraw',
    krakenWithdrawState({ queryFundsOk: true, withdrawMethodsOk: true })
      .withdraw,
    'yes',
  )
  expect(
    'kraken: denied while funds-query works → no withdrawal',
    krakenWithdrawState({
      queryFundsOk: true,
      withdrawMethodsOk: false,
      error: 'EGeneral:Permission denied',
    }).withdraw,
    'no',
  )
  expect(
    'kraken: denied WITHOUT working funds-query is ambiguous → unknown',
    krakenWithdrawState({
      queryFundsOk: false,
      withdrawMethodsOk: false,
      error: 'EGeneral:Permission denied',
    }).withdraw,
    'unknown',
  )
  expect(
    'kraken: a rate limit is not evidence of anything',
    krakenWithdrawState({
      queryFundsOk: true,
      withdrawMethodsOk: false,
      error: 'EGeneral:Too many requests',
    }).withdraw,
    'unknown',
  )
  expect(
    'kraken: a network error is not evidence of anything',
    krakenWithdrawState({
      queryFundsOk: true,
      withdrawMethodsOk: false,
      error: 'socket hang up',
    }).withdraw,
    'unknown',
  )
  expect(
    'kraken: permission-denied matcher tolerates spacing',
    [
      isKrakenPermissionDenied('EGeneral:Permission denied'),
      isKrakenPermissionDenied('EGeneral : Permission denied'),
      isKrakenPermissionDenied('EAPI:Invalid key'),
    ],
    [true, true, false],
  )

  // ── Cross-cutting guarantees ──────────────────────────────────────────────
  expect('unknown helper is fully unknown', shape(unknownPermissions('x')), {
    withdraw: 'unknown',
    transfer: 'unknown',
    ipRestricted: 'unknown',
    ips: undefined,
  })
  expect(
    'every parser returns null (not a false "no") on junk',
    [
      parseBinanceRestrictions('nope'),
      parseBybitApiKey('nope'),
      parseKucoinApiKey('nope'),
      parseOkxAccountConfig('nope'),
      parseBitgetAccountInfo('nope'),
      parseCoinbaseKeyPermissions('nope'),
    ],
    [null, null, null, null, null, null],
  )
  expect(
    'every parser survives undefined',
    [
      parseBinanceRestrictions(undefined),
      parseBybitApiKey(undefined),
      parseKucoinApiKey(undefined),
      parseOkxAccountConfig(undefined),
      parseBitgetAccountInfo(undefined),
      parseCoinbaseKeyPermissions(undefined),
    ],
    [null, null, null, null, null, null],
  )
  // The message is what the user actually has to act on, so it must name the
  // fix rather than just refusing.
  const msg = withdrawalRejectionMessage('Binance')
  expect(
    'rejection message tells the user what to do',
    [
      msg.includes('withdrawal permission'),
      msg.includes('Binance'),
      msg.toLowerCase().includes('trade'),
    ],
    [true, true, true],
  )

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}

main()
