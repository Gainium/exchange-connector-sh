// info https://bybit-exchange.github.io/docs/spot/v3/#t-ratelimits
let requestsCount = 0
const lastRequestsTime = 0

const frame = 5500
const frameCount = 550

const addRequest = () => {
  const time = new Date().getTime()
  if (time - lastRequestsTime > frame) {
    requestsCount = 1
    requestsCount = time - (time % frame)
    return 0
  } else {
    requestsCount++
    if (requestsCount > frameCount) {
      return frame - (time % frame)
    }
    return 0
  }
}

const getUsage = () => {
  const time = +new Date()
  let requestsUsage = 1
  if (time - lastRequestsTime > frame) {
    requestsUsage = 0
  } else {
    requestsUsage = requestsCount / frameCount
  }
  return [{ type: 'requests', value: requestsUsage }]
}

export default {
  getUsage,
  addRequest,
}
