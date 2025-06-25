import { Module } from '@nestjs/common'
import { ExchangeModule } from './exchange/exchange.module'
import { HealthModule } from './health/health.module'

@Module({
  imports: [HealthModule, ExchangeModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
