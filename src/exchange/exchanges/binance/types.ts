/**
 * Local definition of SymbolFilterType to avoid runtime issues with const enum from binance-api-node
 * This enum provides the same values as the const enum but is available at runtime
 */
export enum SymbolFilterType {
  PRICE_FILTER = 'PRICE_FILTER',
  PERCENT_PRICE = 'PERCENT_PRICE',
  LOT_SIZE = 'LOT_SIZE',
  MARKET_LOT_SIZE = 'MARKET_LOT_SIZE',
  MIN_NOTIONAL = 'MIN_NOTIONAL',
  NOTIONAL = 'NOTIONAL',
  MAX_NUM_ORDERS = 'MAX_NUM_ORDERS',
  MAX_ALGO_ORDERS = 'MAX_ALGO_ORDERS',
  ICEBERG_PARTS = 'ICEBERG_PARTS',
  MAX_NUM_ICEBERG_ORDERS = 'MAX_NUM_ICEBERG_ORDERS',
  MAX_POSITION = 'MAX_POSITION',
}
