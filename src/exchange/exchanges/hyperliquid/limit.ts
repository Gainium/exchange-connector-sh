import 'dotenv/config'

let weight = 0
let lastWeightTime = 0

const weightFrame = 60000
const weightInFrame = 1200

const multiplier = 1.2

let weightQueueCounter = 0

const weightQueueCounterInc = 1

const addWeight = async (_w: number) => {
  const w = _w * multiplier
  const time = new Date().getTime()
  if (time - lastWeightTime > weightFrame) {
    lastWeightTime = time - (time % weightFrame)
    weight = w
    weightQueueCounter = 0
    return 0
  } else {
    weight += w
    if (weight > weightInFrame) {
      const wait = weightFrame - (time % weightFrame) + weightQueueCounter
      weightQueueCounter += weightQueueCounterInc
      return wait
    }
    weightQueueCounter = 0
    return 0
  }
}

const getLimits = () => ({
  weight,
  lastWeightTime,
})

const getUsage = () => {
  const time = +new Date()
  let weightUsage = 1
  if (time - lastWeightTime > weightFrame) {
    weightUsage = 0
  } else {
    weightUsage = weight / weightInFrame
  }
  return [{ type: 'weight', value: weightUsage }]
}

export default {
  addWeight,
  getLimits,
  getUsage,
}
