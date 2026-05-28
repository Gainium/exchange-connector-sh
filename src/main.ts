import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import 'dotenv/config'
import { Logger } from '@nestjs/common'
import { isAdminConfigEnabled, startAdminConfigSync } from './utils/adminConfig'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // Self-hosted only — admin-sh pushes enabled-exchanges config into
  // Redis and we filter routing accordingly. Cloud builds leave the
  // flag unset, so startAdminConfigSync hard-bails before touching
  // Redis and the guard in exchange.service stays inert.
  if (isAdminConfigEnabled()) {
    const log = new Logger('admin-config')
    await startAdminConfigSync({
      log: (msg, extra) =>
        log.log(`${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`),
    })
  }

  await app.listen(process.env.APP_PORT || 80)
}

process.on('SIGUSR2', async () => {
  Logger.log('SIGUSR2 signal received. Creating heap dump')
  ;(await import('v8')).writeHeapSnapshot()
})

bootstrap()
