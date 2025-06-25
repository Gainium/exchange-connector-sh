import { Module } from '@nestjs/common'
import { ExchangeController } from './exchange.controller'
import { ExchangeService } from './exchange.service'

@Module({
  controllers: [ExchangeController],
  providers: [ExchangeService],
  exports: [ExchangeService],
})
export class ExchangeModule {}
