export const convertNumberToString = (number: number): string => {
  if (`${number}`.indexOf('e') !== -1) {
    const [num, precision] = `${number}`.split('e')
    if (+precision > 0) {
      return `${num}${'0'.repeat(+precision)}`
    }
    let add = 0
    if (num.indexOf('.') !== -1) {
      const [_, dec] = num.split('.')
      add = dec.length
    }
    return number.toFixed(+precision * -1 + add).replace(/0*$/, '')
  }
  return `${number}`
}

const convertFromExponential = (num: number | string, precision = 2) => {
  return Number(num).toFixed(Math.min(precision, 20)).replace(/0*$/, '')
}

export const round = (
  _num: number,
  precision = 2,
  down = false,
  up = false,
) => {
  let num = `${_num}`
  if (`${_num}`.indexOf('e') !== -1) {
    num = convertFromExponential(_num, precision + 2)
  }
  const intPart = num.split('.')[0]
  if ((intPart?.length ?? 0) + precision > 20) {
    precision = 20 - intPart.length
  }
  if (down) {
    return Number(Math.floor(Number(num + 'e' + precision)) + 'e-' + precision)
  }
  if (up) {
    return Number(Math.ceil(Number(num + 'e' + precision)) + 'e-' + precision)
  }
  return Number(Math.round(Number(num + 'e' + precision)) + 'e-' + precision)
}
