import Redis from 'ioredis'

// Two clients: one for normal GETs, one dedicated to SUBSCRIBE.
// ioredis requires a dedicated client for subscription mode because
// the connection enters a state where regular commands aren't allowed.
//
// Both are lazily created on first use so plain unit/integration runs
// that don't touch admin-config don't spin up a Redis connection.

let cmd: Redis | null = null
let sub: Redis | null = null

function build(role: 'cmd' | 'sub'): Redis {
  const client = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  })
  client.on('error', (err) => {
    // Keep noise low — the adminConfig sync logs at its own layer.
    if (process.env.NODE_ENV !== 'production') {
      console.error(`redis ${role} error`, err.message)
    }
  })
  return client
}

export function getRedis(): Redis {
  if (!cmd) cmd = build('cmd')
  return cmd
}

export function getRedisSubscriber(): Redis {
  if (!sub) sub = build('sub')
  return sub
}
