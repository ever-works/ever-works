import { Module } from '@nestjs/common';
import { ItemsGeneratorController } from './items-generator.controller';
import { ItemsGeneratorService } from './items-generator.service';

@Module({
  controllers: [ItemsGeneratorController],
  providers: [ItemsGeneratorService],
})
export class ItemsGeneratorModule {}
