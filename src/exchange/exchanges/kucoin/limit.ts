import { IdMute, IdMutex } from '../../../utils/mutex'

export enum LimitType {
  spot = 'spot',
  futures = 'futures',
  management = 'management',
  public = 'public',
}

const mutex = new IdMutex()

class KucoinLimits {
  static instance: KucoinLimits

  static getInstance() {
    if (!KucoinLimits.instance) {
      KucoinLimits.instance = new KucoinLimits()
    }
    return KucoinLimits.instance
  }

  private limitsMap: Map<LimitType, { weight: number; time: number }> =
    new Map()

  private limitFrames: {
    [key in LimitType]: { weight: number; period: number }
  } = {
    [LimitType.spot]: { weight: 3000, period: 30 * 1000 },
    [LimitType.futures]: { weight: 2000, period: 30 * 1000 },
    [LimitType.management]: { weight: 2000, period: 30 * 1000 },
    [LimitType.public]: { weight: 2000, period: 30 * 1000 },
  }

  private multiplier = 1.2

  get types() {
    return Object.values(LimitType).filter((v) => !!v)
  }

  @IdMute(mutex, () => 'kucoin')
  public async addWeight(type: LimitType, _w: number) {
    const w = _w * this.multiplier
    const time = +new Date()
    const limit = this.limitsMap.get(type) ?? { weight: 0, time: 0 }
    const frame = this.limitFrames[type] ?? { weight: 3000, period: 30 * 1000 }
    const weightFrame = frame.period
    if (time - limit.time > weightFrame) {
      limit.time = time
      limit.weight = w
      this.limitsMap.set(type, limit)
      return 0
    } else {
      limit.weight += w
      this.limitsMap.set(type, limit)
      if (limit.weight > frame.weight) {
        return Math.max(0, limit.time + weightFrame - time)
      }
      return 0
    }
  }

  @IdMute(mutex, () => 'kucoin')
  public async fillLimits() {
    const time = +new Date()
    for (const value of this.types) {
      this.limitsMap.set(value, {
        weight: this.limitFrames[value]?.weight ?? Infinity,
        time,
      })
    }
  }

  public getLimits() {
    let maxUsage = 0
    let currentUsage = 0
    const time = +new Date()
    for (const value of this.types) {
      maxUsage += this.limitFrames[value].weight ?? 0
    }
    for (const [type, value] of this.limitsMap.entries()) {
      currentUsage +=
        time - value.time > this.limitFrames[type].period ? 0 : value.weight
    }
    return [
      {
        type: 'usage',
        value: currentUsage / maxUsage,
      },
    ]
  }
}

export default KucoinLimits
