/**
 * OKX trading fee rate of one pair (spec 055).
 *
 * `/api/v5/account/trade-fee` answers a `feeGroup` list, one rate per
 * instrument fee group, and every instrument names its `groupId`. The
 * top-level `maker`/`taker` OKX deprecated with that change is the rate of the
 * USDT spot pairs only, so it is the fallback for a pair whose group we cannot
 * resolve, never the answer for every pair. OKX states a commission as a
 * NEGATIVE rate (positive = rebate); the returned rate is the cost, negated.
 */
export type OkxFeeRow = {
  maker?: string
  taker?: string
  feeGroup?: { groupId?: string | number; maker?: string; taker?: string }[]
}

const cost = (rate: unknown): number | null => {
  if (rate === undefined || rate === null || `${rate}`.trim() === '') {
    return null
  }
  const n = +`${rate}` * -1
  return Number.isFinite(n) ? n + 0 : null
}

export function okxFeeRateFor(
  row: OkxFeeRow | undefined,
  groupId?: string | number,
): { maker: number; taker: number } {
  if (groupId !== undefined && groupId !== null && `${groupId}` !== '') {
    const group = row?.feeGroup?.find((g) => `${g?.groupId}` === `${groupId}`)
    const maker = cost(group?.maker)
    const taker = cost(group?.taker)
    if (maker !== null && taker !== null) {
      return { maker, taker }
    }
  }
  return { maker: cost(row?.maker) ?? 0, taker: cost(row?.taker) ?? 0 }
}
