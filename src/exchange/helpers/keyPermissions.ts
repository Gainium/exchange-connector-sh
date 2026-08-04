import { KeyPermissions, PermissionState } from '../types'

/**
 * Withdrawal-permission detection for exchange API keys.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gainium needs read + trade and nothing else. Withdrawal is never required for
 * any feature we ship. Until this module existed nothing ever asked whether a
 * stored key could withdraw, so "our keys cannot move funds out" was an
 * assumption rather than an observed fact. This makes it an observed, recorded
 * fact, per key, refreshed on a schedule.
 *
 * DESIGN NOTES
 * ------------
 * 1. **Declared permissions beat capability probes.** Where an exchange states
 *    what a key may do (Binance `apiRestrictions`, Bybit `query-api`, KuCoin
 *    `user/api-key`, OKX `account/config`, Coinbase `key_permissions`) we read
 *    that field. Poking a withdrawal-adjacent endpoint and inferring from the
 *    result is unreliable, and we have measured it: KuCoin's
 *    `/api/v1/withdrawals/quotas` returns `isWithdrawEnabled: true` and OKX's
 *    max-withdrawal returns `code: 0` for keys that demonstrably cannot
 *    withdraw — those endpoints describe the *account*, not the *key*.
 *    Only Kraken, which declares nothing, is probed (see `krakenWithdrawState`).
 *
 * 2. **`unknown` is a first-class answer.** A parser that does not recognise
 *    what it is looking at must say `unknown`, never `no`. A false `no` is
 *    worse than no answer at all: it is a safety claim we cannot back. Callers
 *    are required to treat `unknown` as "take no action".
 *
 * 3. **Nothing here rejects anything.** These functions report; policy (reject
 *    a brand-new connection vs. merely flag an existing one) lives in main-app,
 *    which is the only side that knows whether a connection is new. Rejecting
 *    here would fail re-verification for every already-connected user.
 */

/** The user-facing text for a key that carries withdrawal permission. */
export const withdrawalRejectionMessage = (exchange?: string): string =>
  `This API key has withdrawal permission enabled. Gainium never needs ` +
  `withdrawal permission — it only reads your account and places trades. ` +
  `Please recreate the key${exchange ? ` on ${exchange}` : ''} with ` +
  `read and trade access only, then add it again.`

export const unknownPermissions = (detail?: string): KeyPermissions => ({
  withdraw: 'unknown',
  transfer: 'unknown',
  ipRestricted: 'unknown',
  detail,
  checkedAt: +new Date(),
})

const state = (value: boolean | undefined | null): PermissionState =>
  value === true ? 'yes' : value === false ? 'no' : 'unknown'

/**
 * Resolves the IP-binding state from an exchange's declared allowlist.
 *
 * **A declared allowlist can only ever prove the positive.** A populated list
 * names the bound addresses, so it answers `'yes'`. Everything else — empty,
 * absent, or an explicit `'*'` wildcard — answers `'unknown'`. This helper
 * never returns `'no'`, and that is deliberate.
 *
 * The reason is that Bybit, OKX and Bitget all offer a "connect a third-party
 * app" flow, which provisions the key and configures its IP binding **on the
 * exchange's side, where it does not appear in the key's own allowlist**. Such
 * a key is genuinely bound and still answers `10003`/`10010 Unmatched IP` from
 * an address outside its binding — while reporting either nothing or a
 * wildcard here. Gainium's own connection guides steer users into that flow, so
 * these are the common case rather than an edge case.
 *
 * A wildcard is therefore **not** the exchange stating "any IP"; it is the
 * exchange stating "nothing in this key's own allowlist", which is equally true
 * of a third-party-bound key. Measured on Bybit: after an earlier revision
 * treated `['*']` as a reliable negative, 441 of 443 re-probed credentials came
 * back `'no'` — i.e. the change accomplished nothing for the exchange that
 * motivated it, because Bybit emits `['*']` and not `[]`.
 *
 * The cost is real: `ipRestricted` is now effectively binary, `'yes'` or
 * `'unknown'`, and no key can be declared unprotected from this field alone.
 * Determining that requires the two-sided capability probe (call from a
 * whitelisted egress IP and from an unpublished one, and compare). This helper
 * reports only what the exchange actually told us, per the module's standing
 * rule: a parser that cannot tell must answer `unknown`, never `no`. A false
 * `'no'` reports a protected key as exposed.
 */
const ipState = (
  ips: string[] | undefined,
): { ipRestricted: PermissionState; ips?: string[] } => {
  if (!Array.isArray(ips)) {
    return { ipRestricted: 'unknown' }
  }
  const bound = ips
    .map((i) => `${i}`.trim())
    .filter((i) => i && i !== '*')
  return bound.length
    ? { ipRestricted: 'yes', ips: bound }
    : { ipRestricted: 'unknown', ips: bound }
}

/** Case-insensitive membership over a permission vocabulary. */
const has = (tokens: string[], needle: string): boolean =>
  tokens.some((t) => `${t}`.toLowerCase().includes(needle.toLowerCase()))

// ── Binance ──────────────────────────────────────────────────────────────────
// GET /sapi/v1/account/apiRestrictions (the `binance` lib's
// getApiKeyPermissions). Declares both withdrawal and IP binding outright.
// `enableInternalTransfer` / `permitsUniversalTransfer` are the same class of
// fund-movement capability as Bybit's universal-transfer, so they feed
// `transfer` rather than being ignored.
export const parseBinanceRestrictions = (
  res: unknown,
): KeyPermissions | null => {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !('enableWithdrawals' in r)) {
    return null
  }
  const withdraw = state(r.enableWithdrawals as boolean)
  const transfer =
    r.enableInternalTransfer === true || r.permitsUniversalTransfer === true
      ? 'yes'
      : r.enableInternalTransfer === false &&
          r.permitsUniversalTransfer === false
        ? 'no'
        : 'unknown'
  return {
    withdraw,
    transfer,
    // Binance states the fact but not the addresses.
    ipRestricted: state(r.ipRestrict as boolean),
    detail: `enableWithdrawals=${r.enableWithdrawals} enableInternalTransfer=${r.enableInternalTransfer} permitsUniversalTransfer=${r.permitsUniversalTransfer} ipRestrict=${r.ipRestrict}`,
    checkedAt: +new Date(),
  }
}

// ── Bybit ────────────────────────────────────────────────────────────────────
// GET /v5/user/query-api. Withdrawal lives in the `Wallet` permission group as
// the literal `"Withdraw"` (master accounts only); `AccountTransfer` and the
// SubMemberTransfer variants are the separate internal-transfer capability,
// which can move balances between a user's own accounts without any withdrawal
// right. The common real-world shape is
// `Wallet: ["AccountTransfer","SubMemberTransferList"]` — transfer yes,
// withdraw no.
export const parseBybitApiKey = (result: unknown): KeyPermissions | null => {
  const r = result as Record<string, any> | null
  if (!r || typeof r !== 'object' || !r.permissions) {
    return null
  }
  const groups = r.permissions as Record<string, unknown>
  const wallet = Array.isArray(groups.Wallet) ? (groups.Wallet as string[]) : []
  // Scan every group, not just Wallet: Bybit has moved permissions between
  // groups before, and a withdrawal token anywhere is still withdrawal.
  const allTokens = Object.values(groups)
    .filter((v): v is string[] => Array.isArray(v))
    .flat()
  return {
    withdraw: has(allTokens, 'withdraw') ? 'yes' : 'no',
    transfer: has(wallet, 'transfer') ? 'yes' : 'no',
    ...ipState(r.ips as string[]),
    detail: `Wallet=[${wallet.join(',')}] readOnly=${r.readOnly}`,
    checkedAt: +new Date(),
  }
}

// ── KuCoin ───────────────────────────────────────────────────────────────────
// GET /api/v1/user/api-key → `permission` is a comma-separated list such as
// "General, Spot, Futures". The optional `ipWhitelist` is not in the typed
// client but is present on the wire, so it is read defensively.
export const parseKucoinApiKey = (data: unknown): KeyPermissions | null => {
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || typeof d.permission !== 'string') {
    return null
  }
  const tokens = (d.permission as string)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!tokens.length) {
    return null
  }
  const whitelist =
    typeof d.ipWhitelist === 'string' && d.ipWhitelist.trim()
      ? d.ipWhitelist
          .split(',')
          .map((i) => i.trim())
          .filter(Boolean)
      : undefined
  return {
    withdraw: has(tokens, 'withdraw') ? 'yes' : 'no',
    transfer: has(tokens, 'transfer') ? 'yes' : 'no',
    ...(whitelist
      ? { ipRestricted: 'yes' as PermissionState, ips: whitelist }
      : // Absent field ≠ "no allowlist" — KuCoin omits it entirely on some key
        // versions, so we must not claim the key is unrestricted.
        { ipRestricted: 'unknown' as PermissionState }),
    detail: `permission=${tokens.join(',')}`,
    checkedAt: +new Date(),
  }
}

// ── OKX ──────────────────────────────────────────────────────────────────────
// GET /api/v5/account/config → `perm` is comma-separated
// ("read_only,trade[,withdraw]"); `ip` is a comma-separated allowlist.
// Typical real value on a Gainium-connected key: "read_only,trade".
export const parseOkxAccountConfig = (
  config: unknown,
): KeyPermissions | null => {
  const c = config as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || typeof c.perm !== 'string') {
    return null
  }
  const tokens = (c.perm as string)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!tokens.length) {
    return null
  }
  // Same as Bitget: OKX's "Linking third-party apps" flow configures the IP
  // binding on OKX's side, so a bound key reports an empty `ip`. Empty and
  // absent both resolve to 'unknown'.
  const ips =
    typeof c.ip === 'string'
      ? c.ip
          .split(',')
          .map((i) => i.trim())
          .filter(Boolean)
      : undefined
  return {
    withdraw: has(tokens, 'withdraw') ? 'yes' : 'no',
    // OKX folds internal transfers into `trade`/`withdraw` rather than
    // declaring them, so we genuinely cannot tell.
    transfer: 'unknown',
    ...ipState(ips),
    detail: `perm=${tokens.join(',')}`,
    checkedAt: +new Date(),
  }
}

// ── Bitget ───────────────────────────────────────────────────────────────────
// GET /api/v2/spot/account/info → `authorities` is a list of short codes and
// `ips` a comma-separated string. Bitget does not publish the full code
// vocabulary; the codes observed on real trade-only keys are
// ["coow","cpow","stow","smow"] (contract/spot order + position write).
//
// Because the vocabulary is undocumented we refuse to guess: a list made
// entirely of codes we recognise as non-withdrawal yields `no`, an explicit
// withdrawal code yields `yes`, and anything containing a code we do not know
// yields `unknown`. Claiming `no` off an unrecognised token would be exactly
// the kind of unearned safety assurance this whole feature exists to remove.
//
// The vocabulary seen on live keys is
// `chow,coow,cpow,p2pw,pllw,smow,stow,taxw,ttow,wtow`. The IP-binding evidence
// below rules `wtow` and `chow` OUT as withdrawal, but ruling a code out is not
// the same as knowing what it grants, so they stay off this list too and their
// keys resolve to `unknown`. That is deliberate: this list is a positive safety
// claim ("these codes cannot withdraw"), and it may only be extended from
// meaning, never from a correlation. Adding them would reclassify barely any
// keys anyway, and `unknown` already rejects nobody.
const BITGET_KNOWN_NON_WITHDRAW = [
  'coow', // contract order write
  'cpow', // contract position write
  'stow', // spot trade order write
  'smow', // spot margin order write
  'readonly',
  'read_only',
  'trade',
  'contract_trade',
  'spot_trade',
  'margin_trade',
  'copytrading',
  'earn',
]
// `wtow` was listed here on nothing but a guess at what the code expands to,
// and the guess was wrong. Bitget makes IP-binding mandatory on any
// withdrawal-enabled key, so a genuine withdrawal code must correlate
// POSITIVELY with the presence of an allowlist. Reviewing the authority sets
// actually returned by live keys, every code in the observed vocabulary
// correlates NEGATIVELY: keys carrying `wtow` are markedly LESS likely to be
// IP-bound than keys without it, and `chow` — the other plausible on-chain
// candidate — behaves the same way. Both are therefore ruled out. The observed
// codes cluster into a single "tick everything" bundle that is almost never
// IP-bound, which means the real withdrawal code has not appeared in practice
// at all.
//
// This guess was not free: `wtow` is common on real Bitget keys, and main-app
// refuses a new connection on `withdraw === 'yes'`, so a large share of
// legitimate Bitget connections were turned away citing a permission the key
// did not have.
//
// `wdow` is likewise unverified and has never matched a live key. It is kept
// only as an inert hedge; do not read it as evidence that such a code exists.
// Nothing may be added here without an observed key that actually carries the
// permission.
const BITGET_WITHDRAW_CODES = ['withdraw', 'wdow']
const BITGET_TRANSFER_CODES = ['transfer', 'trow']

export const parseBitgetAccountInfo = (
  data: unknown,
): KeyPermissions | null => {
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || !Array.isArray(d.authorities)) {
    return null
  }
  const tokens = (d.authorities as unknown[])
    .map((a) => `${a}`.trim().toLowerCase())
    .filter(Boolean)
  if (!tokens.length) {
    return null
  }
  // `ips` is a comma-separated string when present. Neither absent nor blank is
  // evidence the key is unbound — Bitget's third-party-app flow binds on its
  // own side, so a bound key reports nothing here. Both resolve to 'unknown'.
  const ips =
    typeof d.ips === 'string'
      ? d.ips
          .split(',')
          .map((i) => i.trim())
          .filter(Boolean)
      : undefined
  const isWithdraw = (t: string) =>
    BITGET_WITHDRAW_CODES.some((c) => t.includes(c))
  const isTransfer = (t: string) =>
    BITGET_TRANSFER_CODES.some((c) => t.includes(c))
  const recognised = (t: string) =>
    isWithdraw(t) ||
    isTransfer(t) ||
    BITGET_KNOWN_NON_WITHDRAW.some((c) => t === c || t.includes(c))

  const withdraw: PermissionState = tokens.some(isWithdraw)
    ? 'yes'
    : tokens.every(recognised)
      ? 'no'
      : 'unknown'
  const transfer: PermissionState = tokens.some(isTransfer)
    ? 'yes'
    : tokens.every(recognised)
      ? 'no'
      : 'unknown'
  return {
    withdraw,
    transfer,
    ...ipState(ips),
    detail: `authorities=${tokens.join(',')}`,
    checkedAt: +new Date(),
  }
}

// ── Coinbase ─────────────────────────────────────────────────────────────────
// GET /api/v3/brokerage/key_permissions → { can_view, can_trade, can_transfer }.
// Coinbase exposes no IP-binding field.
export const parseCoinbaseKeyPermissions = (
  res: unknown,
): KeyPermissions | null => {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || typeof r.can_transfer !== 'boolean') {
    return null
  }
  return {
    // Coinbase does not separate "move between portfolios" from "send out" —
    // can_transfer covers sends, so it is the withdrawal signal.
    withdraw: state(r.can_transfer as boolean),
    transfer: state(r.can_transfer as boolean),
    ipRestricted: 'unknown',
    detail: `can_view=${r.can_view} can_trade=${r.can_trade} can_transfer=${r.can_transfer}`,
    checkedAt: +new Date(),
  }
}

// ── Kraken ───────────────────────────────────────────────────────────────────
// Kraken publishes no endpoint that describes a key's own permissions, so it is
// the one venue we must probe. `POST /0/private/WithdrawMethods` requires BOTH
// "Funds permissions - Query" AND "Funds permissions - Withdraw"; it only lists
// methods and moves nothing.
//
// The two-permission requirement means a bare "denied" is ambiguous, so the
// caller must first establish that Query works (`queryFundsOk`, in practice the
// Balance call verification already makes). Without that we cannot distinguish
// "no withdrawal" from "no funds-query at all", and must answer `unknown`.
export const isKrakenPermissionDenied = (s: string): boolean =>
  /EGeneral\s*:?\s*Permission denied/i.test(s)

export const krakenWithdrawState = (args: {
  queryFundsOk: boolean
  /** true when WithdrawMethods returned a result rather than an error */
  withdrawMethodsOk: boolean
  /** the error text, when it errored */
  error?: string
}): KeyPermissions => {
  const { queryFundsOk, withdrawMethodsOk, error } = args
  if (withdrawMethodsOk) {
    return {
      withdraw: 'yes',
      transfer: 'unknown',
      ipRestricted: 'unknown',
      detail: 'WithdrawMethods succeeded',
      checkedAt: +new Date(),
    }
  }
  if (error && isKrakenPermissionDenied(error) && queryFundsOk) {
    return {
      withdraw: 'no',
      transfer: 'unknown',
      ipRestricted: 'unknown',
      detail: 'WithdrawMethods denied while funds-query works',
      checkedAt: +new Date(),
    }
  }
  return unknownPermissions(
    error
      ? `Kraken withdrawal permission indeterminate: ${error}`
      : 'Kraken withdrawal permission indeterminate',
  )
}
