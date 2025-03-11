import { Module } from '@nestjs/common';
import { AiEngineService } from './ai-engine.service';
import { Agent } from './agent';
import { AiController } from './ai.controller';

@Module({
  providers: [AiEngineService, Agent],
  exports: [AiEngineService],
  controllers: [AiController],
})
export class AiEngineModule {}
