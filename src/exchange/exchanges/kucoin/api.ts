import Kucoin from '@gainium/kucoin-api'

const kucoin = new Kucoin()

const getWSKucoin = async () => {
  return kucoin.getWsUrl('public')
}

const methods = {
  getWSKucoin: getWSKucoin,
}

export default methods
