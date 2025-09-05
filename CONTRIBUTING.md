# Contributing to Exchange Connector

Thank you for your interest in contributing to the Exchange Connector service! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Adding New Exchanges](#adding-new-exchanges)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Process](#pull-request-process)
- [Exchange Implementation Guidelines](#exchange-implementation-guidelines)

## Development Setup

### Prerequisites

- Node.js 18+
- npm 8+
- TypeScript 5.8+
- Git

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd exchange-connector-sh
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   ```bash
   cp .env.sample .env
   # Edit .env with your configuration
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run in development mode**
   ```bash
   npm run start:dev
   ```

### Available Scripts

```bash
# Development
npm run start              # Start application
npm run start:dev          # Start in watch mode
npm run start:prod         # Start in production mode
npm run build              # Build TypeScript

# Code Quality
npm run lint               # Run ESLint and TypeScript checks
npm run lint:fix           # Fix ESLint issues
npm run format             # Format code with Prettier

# Testing
npm test                   # Run unit tests
npm run test:e2e           # Run end-to-end tests
npm run test:cov           # Run tests with coverage

# Exchange-specific testing
npm run binance:test       # Test Binance integration
npm run bybit:test         # Test Bybit integration
npm run bitget:test        # Test Bitget integration
npm run kucoin:test        # Test KuCoin integration
npm run okx:test           # Test OKX integration
npm run coinbase:test      # Test Coinbase integration

# Maintenance
npm run fullInit           # Full initialization with dependencies
```

## Project Structure

```
exchange-connector-sh/
├── src/
│   ├── main.ts                    # Application entry point
│   ├── app.module.ts              # NestJS app module
│   ├── exchange/
│   │   ├── abstractExchange.ts    # Base exchange interface
│   │   ├── exchange.controller.ts # REST API endpoints
│   │   ├── exchange.service.ts    # Exchange service logic
│   │   ├── types.ts              # Common type definitions
│   │   └── exchanges/            # Exchange implementations
│   │       ├── binance/          # Binance implementation
│   │       ├── bybit/            # Bybit implementation
│   │       ├── bitget/           # Bitget implementation
│   │       ├── kucoin/           # KuCoin implementation
│   │       ├── okx/              # OKX implementation
│   │       └── coinbase/         # Coinbase implementation
│   └── utils/                    # Utility functions
│       ├── crypto.ts             # Cryptographic utilities
│       ├── math.ts               # Mathematical helpers
│       ├── redis.ts              # Redis utilities
│       ├── limit.ts              # Rate limiting
│       ├── mutex.ts              # Mutex utilities
│       ├── sleepUtils.ts         # Sleep/delay utilities
│       └── watchdog.ts           # Monitoring utilities
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc.js
└── README.md
```

### Key Components

- **AbstractExchange**: Base class defining the exchange interface
- **Exchange Service**: Orchestrates exchange operations
- **Exchange Controller**: HTTP API endpoints
- **Exchange Implementations**: Specific exchange integrations
- **Utility Modules**: Shared functionality across exchanges

## Adding New Exchanges

### Step 1: Create Exchange Directory

```bash
mkdir src/exchange/exchanges/new-exchange
cd src/exchange/exchanges/new-exchange
```

### Step 2: Implement Required Files

Create the following files in your exchange directory:

#### `index.ts` - Main Exchange Implementation

```typescript
import AbstractExchange, { Exchange } from '../../abstractExchange'
import type {
  BaseReturn,
  CandleResponse,
  CommonOrder,
  ExchangeInfo,
  FreeAsset,
  // ... other required types
} from '../../types'

class NewExchange extends AbstractExchange implements Exchange {
  constructor() {
    super('NewExchange')
    // Initialize exchange-specific configuration
  }

  // Implement all required methods from Exchange interface
  async getBalance(): Promise<BaseReturn<FreeAsset>> {
    // Implementation
  }

  async openOrder(order: {...}): Promise<BaseReturn<CommonOrder>> {
    // Implementation
  }

  // ... implement all other required methods
}

export default NewExchange
```

#### `limit.ts` - Rate Limiting Configuration

```typescript
import { ExchangeLimitUsage } from '../../types'

const limitHelper = {
  getUsage(endpoint: string): ExchangeLimitUsage {
    // Return rate limit information for different endpoints
    return {
      weight: 1,
      type: 'REQUEST_WEIGHT',
      intervalNum: 60,
      interval: 'SECOND',
      count: 1200
    }
  }
}

export default limitHelper
```

#### `test.ts` - Exchange Testing

```typescript
import NewExchange from './index'

async function testNewExchange() {
  const exchange = new NewExchange()
  
  try {
    // Test balance retrieval
    const balance = await exchange.getBalance()
    console.log('Balance test:', balance)
    
    // Test other methods
    // ...
    
  } catch (error) {
    console.error('Test failed:', error)
  }
}

testNewExchange()
```

### Step 3: Update Exchange Service

Add your exchange to the service registry in `exchange.service.ts`:

```typescript
import NewExchange from './exchanges/new-exchange'

// Add to exchange factory
private createExchange(exchangeName: string): Exchange {
  switch (exchangeName.toLowerCase()) {
    case 'new-exchange':
      return new NewExchange()
    // ... other cases
    default:
      throw new Error(`Unsupported exchange: ${exchangeName}`)
  }
}
```

### Step 4: Add Package Dependencies

If your exchange requires specific npm packages:

```bash
npm install exchange-specific-package
```

Update `package.json` and add corresponding test script:

```json
{
  "scripts": {
    "new-exchange:test": "ts-node -r dotenv/config --files --project tsconfig.json ./src/exchange/exchanges/new-exchange/test.ts"
  }
}
```

## Coding Standards

### TypeScript Guidelines

- **Strict Mode**: Always use TypeScript strict mode
- **Type Safety**: Prefer explicit types over `any`
- **Interface Implementation**: All exchanges must implement the `Exchange` interface
- **Error Handling**: Use the standardized `ReturnGood<T>` and `ReturnBad` patterns

```typescript
// ✅ Good - Using standardized return types
async getBalance(): Promise<BaseReturn<FreeAsset>> {
  const timeProfile = this.startTimeProfile()
  try {
    const balance = await this.api.getBalance()
    return this.returnGood(timeProfile, this.getUsage('balance'))(balance)
  } catch (error) {
    return this.returnBad(timeProfile, this.getUsage('balance'))(error)
  }
}

// ❌ Bad - Direct return without standardization
async getBalance(): Promise<any> {
  return await this.api.getBalance()
}
```

### Code Style

- **ESLint**: Follow the project's ESLint configuration
- **Prettier**: Use Prettier for consistent formatting
- **Naming**: Use descriptive names following exchange conventions
- **Comments**: Document complex exchange-specific logic

### Exchange Consistency

All exchange implementations must follow the parent `AbstractExchange` pattern:

```typescript
class YourExchange extends AbstractExchange implements Exchange {
  constructor() {
    super('YourExchangeName')
    // Initialize exchange client
  }

  // Override all required Exchange interface methods
  // Use consistent error handling and return types
  // Implement proper rate limiting
  // Follow the same parameter naming conventions
}
```

## Testing Guidelines

### Unit Tests

Create comprehensive tests for each exchange method:

```typescript
describe('NewExchange', () => {
  let exchange: NewExchange

  beforeEach(() => {
    exchange = new NewExchange()
  })

  it('should get balance successfully', async () => {
    const result = await exchange.getBalance()
    expect(result.status).toBe(StatusEnum.success)
    expect(result.data).toHaveProperty('assets')
  })

  it('should handle API errors gracefully', async () => {
    // Mock API error
    const result = await exchange.getBalance()
    expect(result.status).toBe(StatusEnum.error)
  })
})
```

### Integration Tests

Test against exchange sandboxes when available:

```typescript
// Use exchange testnet/sandbox environments
const exchange = new NewExchange({
  sandbox: true,
  apiKey: process.env.SANDBOX_API_KEY,
  apiSecret: process.env.SANDBOX_API_SECRET
})
```

### Manual Testing

Use the provided test scripts:

```bash
# Test your exchange implementation
npm run new-exchange:test
```

## Pull Request Process

### Before Submitting

1. **Code Quality Checks**
   ```bash
   npm run lint
   npm run build
   ```

2. **Testing**
   ```bash
   npm test
   npm run new-exchange:test
   ```

3. **Documentation**
   - Update README.md if adding new features
   - Add JSDoc comments for public methods
   - Include usage examples

### PR Requirements

1. **Exchange Interface Compliance**: All methods from `Exchange` interface must be implemented
2. **Error Handling**: Use standardized return patterns
3. **Rate Limiting**: Implement proper rate limit handling
4. **Testing**: Include test files and verify against exchange testnet
5. **Documentation**: Document exchange-specific configuration

### PR Template

```markdown
## Description
Brief description of the exchange implementation

## Exchange Details
- Exchange Name: [Exchange Name]
- API Version: [Version]
- Supported Features: [List features]
- Sandbox Available: [Yes/No]

## Testing
- [ ] All interface methods implemented
- [ ] Rate limiting properly configured
- [ ] Error handling follows patterns
- [ ] Manual testing completed
- [ ] Integration tests pass

## Documentation
- [ ] JSDoc comments added
- [ ] README updated if needed
- [ ] Configuration documented
```

## Exchange Implementation Guidelines

### Required Methods

All exchanges must implement these core methods:

- `getBalance()` - Get user balance
- `openOrder()` - Create new order
- `getOrder()` - Get order details
- `cancelOrder()` - Cancel existing order
- `getAllOrders()` - Get order history
- `getLatestPrice()` - Get current price
- `getAllPrices()` - Get all prices
- `getExchangeInfo()` - Get exchange metadata
- `getUserFees()` - Get user fee structure

### Error Handling Pattern

```typescript
async someMethod(): Promise<BaseReturn<SomeType>> {
  const timeProfile = this.startTimeProfile()
  const usage = limitHelper.getUsage('someEndpoint')
  
  try {
    const result = await this.exchangeApi.someCall()
    const mappedResult = this.mapToStandardFormat(result)
    return this.returnGood(timeProfile, usage)(mappedResult)
  } catch (error) {
    return this.returnBad(timeProfile, usage)(error as Error)
  }
}
```

### Rate Limiting

Implement rate limiting using the limit helper:

```typescript
// In limit.ts
const limitHelper = {
  getUsage(endpoint: string): ExchangeLimitUsage {
    const limits = {
      'balance': { weight: 5, count: 1200, interval: 'MINUTE' },
      'order': { weight: 1, count: 1200, interval: 'MINUTE' },
      'price': { weight: 1, count: 1200, interval: 'MINUTE' }
    }
    return limits[endpoint] || { weight: 1, count: 1200, interval: 'MINUTE' }
  }
}
```

### Data Mapping

Map exchange-specific data to common formats:

```typescript
private mapOrderToCommon(exchangeOrder: ExchangeOrderType): CommonOrder {
  return {
    orderId: exchangeOrder.id,
    clientOrderId: exchangeOrder.clientId,
    symbol: exchangeOrder.symbol,
    side: this.mapSide(exchangeOrder.side),
    type: this.mapOrderType(exchangeOrder.type),
    quantity: parseFloat(exchangeOrder.quantity),
    price: parseFloat(exchangeOrder.price),
    status: this.mapStatus(exchangeOrder.status),
    // ... other fields
  }
}
```

### Configuration

Support both live and sandbox environments:

```typescript
constructor(config?: ExchangeConfig) {
  super('ExchangeName')
  
  this.client = new ExchangeClient({
    apiKey: process.env.EXCHANGE_API_KEY,
    apiSecret: process.env.EXCHANGE_API_SECRET,
    sandbox: config?.sandbox || process.env.NODE_ENV !== 'production'
  })
}
```

## Getting Help

- **Architecture Questions**: Consult with the core team
- **Exchange-Specific Issues**: Check exchange documentation
- **Implementation Problems**: Review existing exchange implementations
- **Testing Issues**: Use sandbox environments when available

## Recognition

Contributors will be acknowledged in:
- Project documentation
- Release notes for significant contributions
- Internal team recognition

Thank you for contributing to the Exchange Connector service!