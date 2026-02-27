process.env.NODE_ENV = 'testing'

import * as fs from 'fs'
import * as path from 'path'
import { ExchangeIntervals, Futures } from '../../types'
import KrakenExchange from './index'

const CHECKPOINT_FILE = path.join(__dirname, '.test-checkpoint.txt')

// Helper to add delay between operations
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface TestMethod {
  name: string
  client: 'spot' | 'futures'
  fn: (exchange: KrakenExchange) => Promise<any>
  requiresAuth: boolean
}

// Get test mode from command line arguments
const args = process.argv.slice(2)
const mode = args[0]?.toLowerCase() || 'public' // 'public', 'private', or 'orders'

// Public test methods (no authentication required)
const publicTests: TestMethod[] = [
  // Spot client tests
  {
    name: 'latestPrice',
    client: 'spot',
    fn: (ex) => ex.latestPrice('BTCUSDT'),
    requiresAuth: false,
  },
  {
    name: 'getAllPrices',
    client: 'spot',
    fn: (ex) => ex.getAllPrices(),
    requiresAuth: false,
  },
  {
    name: 'getExchangeInfo',
    client: 'spot',
    fn: (ex) => ex.getExchangeInfo('BTCUSDT'),
    requiresAuth: false,
  },
  {
    name: 'getAllExchangeInfo',
    client: 'spot',
    fn: (ex) => ex.getAllExchangeInfo(),
    requiresAuth: false,
  },
  {
    name: 'getCandles',
    client: 'spot',
    fn: (ex) =>
      ex.getCandles(
        'BTCUSDT',
        ExchangeIntervals.oneM,
        undefined,
        undefined,
        10,
      ),
    requiresAuth: false,
  },
  // Futures client tests (use Kraken futures symbol format: PF_XBTUSD)
  {
    name: 'latestPrice',
    client: 'futures',
    fn: (ex) => ex.latestPrice('PF_XBTUSD'),
    requiresAuth: false,
  },
  {
    name: 'getAllPrices',
    client: 'futures',
    fn: (ex) => ex.getAllPrices(),
    requiresAuth: false,
  },
  {
    name: 'getExchangeInfo',
    client: 'futures',
    fn: (ex) => ex.getExchangeInfo('PF_XBTUSD'),
    requiresAuth: false,
  },
  {
    name: 'getAllExchangeInfo',
    client: 'futures',
    fn: (ex) => ex.getAllExchangeInfo(),
    requiresAuth: false,
  },
  {
    name: 'getCandles',
    client: 'futures',
    fn: (ex) =>
      ex.getCandles(
        'PF_XBTUSD',
        ExchangeIntervals.oneM,
        undefined,
        undefined,
        10,
      ),
    requiresAuth: false,
  },
]

// Private test methods (require authentication)
const privateTests: TestMethod[] = [
  // Spot client tests
  {
    name: 'getBalance',
    client: 'spot',
    fn: (ex) => ex.getBalance(),
    requiresAuth: true,
  },
  {
    name: 'getUid',
    client: 'spot',
    fn: (ex) => ex.getUid(),
    requiresAuth: true,
  },
  {
    name: 'getUserFees',
    client: 'spot',
    fn: (ex) => ex.getUserFees('BTCUSDT'),
    requiresAuth: true,
  },
  {
    name: 'getAllUserFees',
    client: 'spot',
    fn: (ex) => ex.getAllUserFees(),
    requiresAuth: true,
  },
  {
    name: 'getAllOpenOrders',
    client: 'spot',
    fn: (ex) => ex.getAllOpenOrders('BTCUSDT', false),
    requiresAuth: true,
  },
  // Futures client tests (use Kraken futures symbol format: PF_XBTUSD)
  {
    name: 'getBalance',
    client: 'futures',
    fn: (ex) => ex.getBalance(),
    requiresAuth: true,
  },
  {
    name: 'getUid',
    client: 'futures',
    fn: (ex) => ex.getUid(),
    requiresAuth: true,
  },
  {
    name: 'getUserFees',
    client: 'futures',
    fn: (ex) => ex.getUserFees('PF_XBTUSD'),
    requiresAuth: true,
  },
  {
    name: 'getAllUserFees',
    client: 'futures',
    fn: (ex) => ex.getAllUserFees(),
    requiresAuth: true,
  },
  {
    name: 'getAllOpenOrders',
    client: 'futures',
    fn: (ex) => ex.getAllOpenOrders('PF_XBTUSD', false),
    requiresAuth: true,
  },
]

// Order lifecycle tests (require authentication)
const orderTests: TestMethod[] = [
  {
    name: 'orderLifecycle',
    client: 'futures',
    fn: async (ex) => {
      const symbol = 'PF_XBTUSD'
      const clientOrderId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      console.log(
        `\n  📝 Starting order lifecycle test with UID: ${clientOrderId}`,
      )

      // Step 1: Get latest price
      console.log(`  1️⃣  Getting latest price for ${symbol}...`)
      const priceResult = await ex.latestPrice(symbol)
      if (priceResult.status !== 'OK') {
        throw new Error(`Failed to get price: ${priceResult.reason}`)
      }
      const currentPrice = priceResult.data
      console.log(`      Current price: ${currentPrice}`)

      // Step 1.5: Get exchange info for proper order parameters
      console.log(`  📋 Getting exchange info for ${symbol}...`)
      const infoResult = await ex.getExchangeInfo(symbol)
      if (infoResult.status !== 'OK') {
        throw new Error(`Failed to get exchange info: ${infoResult.reason}`)
      }

      const minQty = infoResult.data.baseAsset.minAmount || 1
      const tickSize = infoResult.data.baseAsset.step || 0.5
      console.log(`      Exchange info:`)
      console.log(`        Min quantity: ${minQty}`)
      console.log(`        Tick size: ${tickSize}`)
      console.log(`        Base asset: ${infoResult.data.baseAsset.name}`)
      console.log(`        Quote asset: ${infoResult.data.quoteAsset.name}`)

      // Step 2: Create limit order that won't fill (50% below current price for buy)
      // Round price to tick size
      const rawOrderPrice = currentPrice * 0.5
      const orderPrice = Math.floor(rawOrderPrice / tickSize) * tickSize
      const orderQty = Math.max(minQty, 1)
      console.log(
        `  2️⃣  Creating LIMIT BUY order at ${orderPrice.toFixed(2)} (50% below market)...`,
      )
      console.log(`      Order parameters:`)
      console.log(`        Symbol: ${symbol}`)
      console.log(`        Side: BUY`)
      console.log(`        Type: LIMIT`)
      console.log(`        Price: ${orderPrice}`)
      console.log(`        Quantity: ${orderQty}`)
      console.log(`        Client Order ID: ${clientOrderId}`)

      const createResult = await ex.openOrder({
        symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: orderPrice,
        quantity: orderQty,
        newClientOrderId: clientOrderId,
      })

      if (createResult.status !== 'OK') {
        console.log(`      ❌ Order creation failed:`)
        console.log(`         Reason: ${createResult.reason}`)
        console.log(
          `         Full result: ${JSON.stringify(createResult, null, 2)}`,
        )
        throw new Error(`Failed to create order: ${createResult.reason}`)
      }

      const orderId = createResult.data.orderId
      const returnedClientId = createResult.data.clientOrderId
      console.log(`      Order created - Exchange ID: ${orderId}`)
      console.log(`      Client Order ID: ${returnedClientId}`)

      // Wait a bit for order to be registered
      await sleep(1000)

      // Step 3: Read order back using clientOrderId
      console.log(`  3️⃣  Reading order by client ID ${clientOrderId}...`)
      const getResult = await ex.getOrder({
        symbol,
        newClientOrderId: clientOrderId,
      })

      if (getResult.status !== 'OK') {
        throw new Error(`Failed to get order: ${getResult.reason}`)
      }

      console.log(`      Order status: ${getResult.data.status}`)
      console.log(`      Order price: ${getResult.data.price}`)
      console.log(`      Order quantity: ${getResult.data.origQty}`)

      // Wait before canceling
      await sleep(500)

      // Step 4: Cancel order using clientOrderId
      console.log(`  4️⃣  Canceling order ${clientOrderId}...`)
      const cancelResult = await ex.cancelOrder({
        symbol,
        newClientOrderId: clientOrderId,
      })

      if (cancelResult.status !== 'OK') {
        throw new Error(`Failed to cancel order: ${cancelResult.reason}`)
      }

      console.log(`      Order canceled successfully`)
      console.log(`  ✅ Order lifecycle test completed\n`)

      // Return success result
      return {
        status: 'OK',
        data: {
          clientOrderId,
          orderId,
          price: orderPrice,
          quantity: orderQty,
          lifecycle: 'created -> read -> canceled',
        },
      }
    },
    requiresAuth: true,
  },
]

function loadCheckpoint(): string | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return fs.readFileSync(CHECKPOINT_FILE, 'utf-8').trim()
    }
  } catch (err) {
    console.error('Failed to read checkpoint:', err)
  }
  return null
}

function saveCheckpoint(methodName: string) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, methodName, 'utf-8')
  } catch (err) {
    console.error('Failed to save checkpoint:', err)
  }
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE)
    }
  } catch (err) {
    console.error('Failed to clear checkpoint:', err)
  }
}

function formatDataPreview(data: any): string {
  if (typeof data !== 'object' || data === null) {
    return String(data).substring(0, 100)
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return 'Empty array'
    }

    // Show array length and sample some random elements
    const sampleSize = Math.min(3, data.length)
    const samples: any[] = []

    if (data.length <= 3) {
      // If array is small, show all elements
      samples.push(...data)
    } else {
      // Pick random elements
      const indices = new Set<number>()
      while (indices.size < sampleSize) {
        indices.add(Math.floor(Math.random() * data.length))
      }
      indices.forEach((i) => samples.push(data[i]))
    }

    const samplesStr = samples.map((s) => JSON.stringify(s)).join(', ')
    return `Array(${data.length}) samples: [${samplesStr}]`
  }

  // For objects, show the full object with some truncation
  const jsonStr = JSON.stringify(data, null, 2)
  if (jsonStr.length <= 500) {
    return jsonStr
  }
  return jsonStr.substring(0, 500) + '... (truncated)'
}

async function runTests() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                 Kraken Exchange Test Suite                     ║
╚════════════════════════════════════════════════════════════════╝
`)

  const tests =
    mode === 'orders'
      ? orderTests
      : mode === 'private'
        ? privateTests
        : publicTests
  const isPrivate = mode === 'private' || mode === 'orders'

  console.log(`Mode: ${mode.toUpperCase()}`)
  console.log(`Tests to run: ${tests.length}`)
  console.log(
    `Environment: KRAKEN_ENV=${process.env.KRAKEN_ENV || 'production'}`,
  )

  // Check for credentials if running private tests
  if (isPrivate) {
    if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) {
      console.error(
        '\n❌ Error: Private tests require KRAKEN_API_KEY and KRAKEN_API_SECRET',
      )
      console.error('Please set these environment variables and try again.')
      process.exit(1)
    }
    console.log('Credentials: ✓ Found')
  } else {
    console.log('Credentials: Not required for public tests')
  }

  // Create exchange instances
  const spotExchange = new KrakenExchange(
    Futures.null,
    process.env.KRAKEN_API_KEY || '',
    process.env.KRAKEN_API_SECRET || '',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  )

  const futuresExchange = new KrakenExchange(
    Futures.usdm,
    process.env.KRAKEN_API_KEY || '',
    process.env.KRAKEN_API_SECRET || '',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  )

  // Load checkpoint to resume from last failed test
  const checkpoint = loadCheckpoint()
  const startIndex = checkpoint
    ? tests.findIndex((t) => `${t.client}:${t.name}` === checkpoint)
    : 0

  if (checkpoint) {
    if (startIndex === -1) {
      console.log(
        `\n⚠️  Checkpoint "${checkpoint}" not found, starting from beginning`,
      )
    } else {
      console.log(
        `\n📍 Resuming from checkpoint: ${checkpoint} (${startIndex + 1}/${tests.length})`,
      )
    }
  }

  console.log('\n' + '─'.repeat(64) + '\n')

  let passed = 0
  let failed = 0

  // Run tests sequentially
  for (let i = Math.max(0, startIndex); i < tests.length; i++) {
    const test = tests[i]
    const testNum = i + 1
    const exchange = test.client === 'spot' ? spotExchange : futuresExchange

    console.log(
      `[${testNum}/${tests.length}] Testing: ${test.client}:${test.name}`,
    )

    try {
      const startTime = Date.now()
      const result = await test.fn(exchange)
      const duration = Date.now() - startTime

      if (result.status === 'OK') {
        console.log(`  ✓ Success (${duration}ms)`)
        if (result.data) {
          const dataPreview = formatDataPreview(result.data)
          console.log(`  📊 Data: ${dataPreview}`)
        }
        if (result.usage) {
          console.log(`  📈 Usage: ${JSON.stringify(result.usage)}`)
        }
        passed++
      } else {
        console.log(`  ✗ Failed: ${result.reason}`)
        console.log(`  Duration: ${duration}ms`)
        if (result.error) {
          console.log(`  🔍 Error details:`)
          console.log(`     Code: ${result.error.code || 'N/A'}`)
          console.log(`     Message: ${result.error.message || result.reason}`)
        }
        if (result.data) {
          console.log(
            `  📊 Response data: ${JSON.stringify(result.data, null, 2)}`,
          )
        }
        failed++

        // Save checkpoint on failure
        const checkpointName = `${test.client}:${test.name}`
        saveCheckpoint(checkpointName)
        console.log(
          `  💾 Checkpoint saved. Run again to resume from: ${checkpointName}`,
        )
      }
    } catch (err: any) {
      console.log(`  ✗ Exception: ${err.message}`)
      if (err.stack) {
        console.log(`  Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`)
      }
      failed++

      // Save checkpoint on exception
      const checkpointName = `${test.client}:${test.name}`
      saveCheckpoint(checkpointName)
      console.log(
        `  💾 Checkpoint saved. Run again to resume from: ${checkpointName}`,
      )
      break // Stop execution on first exception
    }

    console.log('')

    // Add a small delay between requests to avoid rate limiting
    if (i < tests.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  console.log('─'.repeat(64))
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                        Test Results                             ║
╚════════════════════════════════════════════════════════════════╝

  Total:  ${tests.length}
  Passed: ${passed} ✓
  Failed: ${failed} ✗
  Success Rate: ${((passed / tests.length) * 100).toFixed(1)}%
`)

  if (failed === 0) {
    console.log('🎉 All tests passed! Clearing checkpoint...\n')
    clearCheckpoint()
  } else {
    console.log(
      '💡 Tip: Run the same command again to resume from the last failed test.\n',
    )
  }

  process.exit(failed > 0 ? 1 : 0)
}

// Show usage if invalid mode
if (mode !== 'public' && mode !== 'private' && mode !== 'orders') {
  console.log(`
Usage: npm run kraken:test [mode]

Modes:
  public   - Test public API methods (no authentication required) [default]
  private  - Test private API methods (requires KRAKEN_API_KEY and KRAKEN_API_SECRET)
  orders   - Test order lifecycle: create -> read -> cancel (requires credentials)

Examples:
  npm run kraken:test           # Run public tests
  npm run kraken:test public    # Run public tests
  npm run kraken:test private   # Run private tests
  npm run kraken:test orders    # Run order lifecycle tests

Environment Variables:
  KRAKEN_API_KEY      - Your Kraken API key (required for private/orders tests)
  KRAKEN_API_SECRET   - Your Kraken API secret (required for private/orders tests)
  KRAKEN_ENV          - 'production' or 'demo' (default: production)
`)
  process.exit(1)
}

runTests().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
