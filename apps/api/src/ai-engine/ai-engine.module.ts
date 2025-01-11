import { Module } from '@nestjs/common';
import { AiEngineService } from './ai-engine.service';

@Module({
  providers: [AiEngineService],
  exports: [AiEngineService],
})
export class AiEngineModule {}
