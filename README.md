# Exchange Connector

## Overview

The **Exchange Connector** service provides a unified API for interacting with various cryptocurrency exchanges. It simplifies the integration process by offering a consistent interface for managing market data, orders, and user accounts across different platforms including Binance, Bybit, Bitget, KuCoin, OKX, and Coinbase.

## Features

- **Market Data**: Retrieve latest prices, all prices, and exchange information.
- **Order Management**: Create, fetch, and cancel orders.
- **User Management**: Handle user balances and fees.
- **Multi-Exchange Support**: Seamlessly switch between supported exchanges.

## Configuration

Configuration can be managed through environment variables. Setup includes parameters like API keys, environment modes (live/sandbox), and service endpoints.

Refer to the `.env.sample` for more details.

## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Support

This project is part of the Gainium suite and is maintained by the Gainium team. For contributions or support inquiries, please contact the maintainers.
