import { IdMute, IdMutex } from '../../../utils/mutex'

const mutex = new IdMutex()

class BitgetLimits {
  static instance: BitgetLimits

  static getInstance() {
    if (!BitgetLimits.instance) {
      BitgetLimits.instance = new BitgetLimits()
    }
    return BitgetLimits.instance
  }

  private limitsMap: Map<string, { count: number; time: number }> = new Map()

  private limitsTimeFrame = 1000

  private requests = { count: 0, time: 0 }

  private requestLimit = 6000

  private requestsTimeFrame = 60 * 1000

  private multiplier = 1.2

  @IdMute(mutex, () => 'bitget')
  public async addLimit(data?: { name: string; count: number }) {
    const time = +new Date()
    if (time - this.requests.time > 60 * 1000) {
      this.requests.time = time - (time % this.requestsTimeFrame)
      this.requests.count = 1
    } else {
      this.requests.count++
      if (this.requests.count * this.multiplier > this.requestLimit) {
        return this.requestsTimeFrame - (time % this.requestsTimeFrame)
      }
    }
    if (data) {
      const limit = this.limitsMap.get(data.name) ?? { count: 0, time: 0 }
      if (time - limit.time > this.limitsTimeFrame) {
        limit.time = time
        limit.count = 1
        this.limitsMap.set(data.name, limit)
        return 0
      } else {
        limit.count += 1
        this.limitsMap.set(data.name, limit)
        if (limit.count * this.multiplier > data.count) {
          return Math.max(0, limit.time + this.limitsTimeFrame - time)
        }
        return 0
      }
    }
    return 0
  }

  @IdMute(mutex, () => 'bitget')
  public async fillLimits() {
    const time = +new Date()
    for (const value of this.limitsMap.keys()) {
      this.limitsMap.set(value, {
        count: Infinity,
        time,
      })
    }
  }

  public getLimits() {
    return [
      {
        type: 'requests',
        value: this.requests.count / this.requestLimit,
      },
    ]
  }
}

export default BitgetLimits
