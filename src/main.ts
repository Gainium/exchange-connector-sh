import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import 'dotenv/config'
import { Logger } from '@nestjs/common'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(process.env.APP_PORT || 80)
}

process.on('SIGUSR2', async () => {
  Logger.log('SIGUSR2 signal received. Creating heap dump')
  ;(await import('v8')).writeHeapSnapshot()
})

bootstrap()
