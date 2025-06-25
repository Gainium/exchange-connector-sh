let privateMethodCount = 0
let lastPrivateMethodTime = 0
let publicMethodCount = 0
let lastPublicMethodTime = 0

const privateMethodFrame = 1000
const privateMethodFrameCount = 10
const publicMethodFrame = 1000
const publicMethodFrameCount = 30

const method = (type: 'private' | 'public' = 'private') => {
  const priv = type === 'private'
  const time = new Date().getTime()
  if (
    time - (priv ? lastPrivateMethodTime : lastPublicMethodTime) >
    (priv ? privateMethodFrame : publicMethodFrame)
  ) {
    if (priv) {
      privateMethodCount = 1
      lastPrivateMethodTime = time - (time % privateMethodFrame)
    } else {
      publicMethodCount = 1
      lastPublicMethodTime = time - (time % publicMethodFrame)
    }
    return 0
  } else {
    if (priv) {
      privateMethodCount++
      if (privateMethodCount > privateMethodFrameCount) {
        return privateMethodFrame - (time % privateMethodFrame)
      }
    } else {
      publicMethodCount++
      if (publicMethodCount > publicMethodFrameCount) {
        return publicMethodFrame - (time % publicMethodFrame)
      }
    }
    return 0
  }
}

const privateMethod = () => method('private')
const publicMethod = () => method('public')

const getUsage = () => {
  const time = +new Date()
  let privateUsage = 1
  let publicUsage = 1
  if (time - lastPrivateMethodTime > privateMethodFrame) {
    privateUsage = 0
  } else {
    privateUsage = privateMethodCount / privateMethodFrameCount
  }
  if (time - lastPublicMethodTime > publicMethodFrame) {
    publicUsage = 0
  } else {
    publicUsage = publicMethodCount / publicMethodFrameCount
  }
  return [
    { type: 'private', value: privateUsage },
    { type: 'public', value: publicUsage },
  ]
}

export default {
  privateMethod,
  publicMethod,
  getUsage,
}
