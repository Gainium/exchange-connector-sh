import { IdMute, IdMutex } from '../../../utils/mutex'

const mutex = new IdMutex()

const limitsMap: Map<
  string,
  { frame: number; frameCount: number; usedCount: number; lastTime: number }
> = new Map()

const weightQueueCounter = new Map<string, number>()

class Limit {
  @IdMute(mutex, () => 'okxLimit')
  async addMethod(id: string, frame: number, frameCount: number) {
    const time = +new Date()
    if (!limitsMap.has(id)) {
      limitsMap.set(id, {
        frame,
        frameCount,
        usedCount: 1,
        lastTime: time,
      })
      weightQueueCounter.set(id, 0)
      return 0
    } else {
      const limit = limitsMap.get(id)
      if (time - limit.lastTime > frame) {
        limit.usedCount = 1
        limit.lastTime = time
        weightQueueCounter.set(id, 0)
        return 0
      } else {
        limit.usedCount++
        if (limit.usedCount > frameCount) {
          const weight = weightQueueCounter.get(id) || 0
          weightQueueCounter.set(id, weight + 1)
          return frame + weight
        }
      }
    }
    return 0
  }
}

const getUsage = () => {
  const time = +new Date()
  let score = 0
  for (const [_, limit] of limitsMap) {
    if (time - limit.lastTime > limit.frame) {
      score += 0
    } else {
      score += limit.usedCount / limit.frameCount
    }
  }
  return [{ type: 'total', value: score }]
}

export default {
  Limit,
  getUsage,
}
