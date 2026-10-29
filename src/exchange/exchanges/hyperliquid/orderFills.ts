/**
 * Collect one order's fills from Hyperliquid's account-wide fill history.
 *
 * `getOrder` takes an order's executed size from the order struct
 * (`origSz - sz`) but its price and fee from `userFillsByTime`, filtered by
 * oid. That endpoint returns at most `HL_FILLS_PAGE_LIMIT` fills per response
 * for the whole account, so on a busy account the window between an order's
 * placement and its last status change can hold more fills than one page and
 * this order's fills can be cut off. Summing a cut-off list under-reports the
 * fee and prices the order off a subset of its fills.
 *
 * So the window is read page by page (each next page starts at the newest
 * fill time seen, with fills deduplicated by `tid` because the boundary
 * millisecond is returned twice) until the order's fills add up to its
 * executed size, a page comes back short, or `maxPages` is reached.
 * `complete` says whether the fills found account for the executed size;
 * callers must not present a fee summed over an incomplete list as final.
 *
 * Pure apart from `fetchPage` — exercised by `order-fills.spec.ts`.
 */
export const HL_FILLS_PAGE_LIMIT = 2000

export type HlOrderFill = {
  oid: number
  tid: number
  time: number
  sz: string
  px: string
  fee: string
  feeToken: string
}

export async function collectOrderFills<F extends HlOrderFill>(params: {
  oid: number
  startTime: number
  executedSz: number
  fetchPage: (startTime: number) => Promise<readonly F[]>
  maxPages?: number
}): Promise<{ fills: F[]; filledSz: number; complete: boolean }> {
  const { oid, executedSz, fetchPage, maxPages = 5 } = params
  const fills: F[] = []
  const seen = new Set<number>()
  // Sizes are decimal strings summed as floats.
  const tolerance = Math.max(Math.abs(executedSz) * 1e-9, 1e-12)
  let filledSz = 0
  let startTime = params.startTime

  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(startTime)
    for (const f of batch) {
      if (f.oid !== oid || seen.has(f.tid)) {
        continue
      }
      seen.add(f.tid)
      fills.push(f)
      filledSz += +f.sz
    }
    if (filledSz >= executedSz - tolerance) {
      break
    }
    if (batch.length < HL_FILLS_PAGE_LIMIT) {
      break
    }
    const newest = batch.reduce((acc, f) => Math.max(acc, f.time), startTime)
    if (newest <= startTime) {
      // A full page within one millisecond: the window cannot be advanced.
      break
    }
    startTime = newest
  }

  return {
    fills,
    filledSz,
    complete: Math.abs(filledSz - executedSz) <= tolerance,
  }
}
