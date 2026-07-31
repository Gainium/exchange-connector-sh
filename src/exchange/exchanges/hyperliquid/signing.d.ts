/**
 * Type shim for `@nktkas/hyperliquid/signing`.
 *
 * The subpath is a real, supported entry in the package's `exports` map (it
 * resolves at runtime under CommonJS), but this repo compiles with TypeScript's
 * classic `node` module resolution, which predates `exports` and so cannot see
 * it. Rather than switch the whole submodule's resolution mode — a change that
 * would ripple through every service embedding `core/` — we declare just the
 * one function we use.
 *
 * `getWalletAddress` is the SDK's own signer-address derivation, i.e. exactly
 * the function that decides which address signs an order. Using it (instead of
 * re-implementing secp256k1 → keccak here) is what guarantees our
 * "is this the master key?" check matches what actually happens on the wire.
 */
declare module '@nktkas/hyperliquid/signing' {
  export function getWalletAddress(wallet: unknown): Promise<`0x${string}`>
}
